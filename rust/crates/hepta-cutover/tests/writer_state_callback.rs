use hepta_cutover::{
    DurableCutoverCoordinatorV1 as Coordinator, DurableCutoverError as Error,
    DurableCutoverModeV1 as Mode, DurableCutoverPhaseV1 as Phase, DurableCutoverStateV1 as State,
    DurableCutoverStorageV2 as Storage,
};
use rusqlite::{Connection, ErrorCode};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

static NEXT: AtomicU64 = AtomicU64::new(0);
const SCOPE: &str = "store:automation-reconcile-entrypoint";
struct Fixture {
    root: PathBuf,
    database: PathBuf,
    storage: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-writer-state-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let runtime = root.join("runtime");
        let storage = root.join("storage");
        for directory in [&runtime, &storage] {
            fs::create_dir(directory).unwrap();
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let database = runtime.join("native.sqlite");
        Connection::open(&database).unwrap().execute_batch(
            "CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT NOT NULL); INSERT INTO records VALUES(1,'before');"
        ).unwrap();
        fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).unwrap();
        Self {
            root,
            database,
            storage,
        }
    }
    fn coordinator(&self, external: bool) -> Coordinator {
        Coordinator::create_with_storage_v2(
            &self.database,
            "locked-state",
            "node",
            "rust",
            Mode::LocalDrill,
            if external {
                Storage::ExternalRoot {
                    root: self.storage.clone(),
                }
            } else {
                Storage::AdjacentSidecars
            },
        )
        .unwrap()
    }
    fn canary(&self, coordinator: &mut Coordinator) -> State {
        coordinator.quiesce(0).unwrap();
        coordinator
            .backup_restore_drill(
                1,
                &self.root.join("backup.sqlite"),
                &self.root.join("restore.sqlite"),
            )
            .unwrap();
        coordinator
            .compare_shadow(2, "same-record", b"same", b"same")
            .unwrap();
        coordinator
            .start_local_canary(3, vec![SCOPE.into()])
            .unwrap()
    }
    fn journal(&self) -> PathBuf {
        let marker: serde_json::Value = serde_json::from_slice(
            &fs::read(format!(
                "{}.rust-cutover.enrolled.json",
                self.database.display()
            ))
            .unwrap(),
        )
        .unwrap();
        if marker["version"] == 2 {
            PathBuf::from(marker["storageRoot"].as_str().unwrap())
                .join(marker["storageSlot"].as_str().unwrap())
                .join("journal.sqlite")
        } else {
            PathBuf::from(format!("{}.rust-cutover.sqlite", self.database.display()))
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn callback_sees_latest_durable_state_and_incumbent_phase_behavior() {
    for external in [false, true] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.coordinator(external);
        let planned = coordinator.inspect().unwrap();
        assert_eq!(
            coordinator
                .with_writer_state_v1(&planned.writer_fence().unwrap(), SCOPE, |state| Ok(
                    state.clone()
                ))
                .unwrap(),
            planned
        );
        let canary = fixture.canary(&mut coordinator);
        let lease = canary.writer_fence().unwrap();
        let mut peer = Coordinator::open(&fixture.database).unwrap();
        let active = peer.promote_local(canary.revision).unwrap();
        assert_eq!(active.writer_fence().unwrap(), lease);
        assert!(active.revision > canary.revision);
        // The coordinator was opened before the peer changed the phase and
        // revision. The callback must receive the locked current state, not a
        // caller's earlier snapshot; Active retains incumbent free scope.
        assert_eq!(
            coordinator
                .with_writer_state_v1(&lease, "another-scope", |state| Ok(state.clone()))
                .unwrap(),
            active
        );
        let rolled = peer.rollback_local(active.revision).unwrap();
        assert_eq!(rolled.phase, Phase::RolledBack);
        assert_eq!(
            coordinator
                .with_writer_state_v1(&rolled.writer_fence().unwrap(), SCOPE, |state| Ok(
                    state.clone()
                ))
                .unwrap(),
            rolled
        );
        coordinator
            .with_writer(&rolled.writer_fence().unwrap(), SCOPE, || Ok(()))
            .unwrap();
        coordinator.verify_journal().unwrap();
    }
}

#[test]
fn stale_lease_and_wrong_scope_fail_before_state_callback() {
    for external in [false, true] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.coordinator(external);
        let old = coordinator.inspect().unwrap().writer_fence().unwrap();
        let canary = fixture.canary(&mut coordinator);
        let mut called = false;
        assert!(matches!(
            coordinator.with_writer_state_v1(&old, SCOPE, |_| {
                called = true;
                Ok(())
            }),
            Err(Error::StaleWriter)
        ));
        assert!(!called);
        assert!(matches!(
            coordinator.with_writer_state_v1(
                &canary.writer_fence().unwrap(),
                "wrong-scope",
                |_| {
                    called = true;
                    Ok(())
                }
            ),
            Err(Error::CanaryScopeRejected)
        ));
        assert!(!called);
        assert_eq!(coordinator.inspect().unwrap(), canary);
    }
}

#[test]
fn stricter_callback_rejection_preserves_state_and_releases_lock() {
    for external in [false, true] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.coordinator(external);
        let canary = fixture.canary(&mut coordinator);
        let lease = canary.writer_fence().unwrap();
        let result = coordinator.with_writer_state_v1(&lease, SCOPE, |state| {
            assert_eq!(state, &canary);
            if state.mode != Mode::Production || !state.production_activation {
                return Err("native_production_authorization_required".into());
            }
            Ok(())
        });
        assert!(
            matches!(result, Err(Error::Application(ref reason)) if reason == "native_production_authorization_required")
        );
        assert_eq!(coordinator.inspect().unwrap(), canary);
        let mut peer = Coordinator::open(&fixture.database).unwrap();
        peer.with_writer_state_v1(&lease, SCOPE, |state| {
            assert_eq!(state, &canary);
            Ok(())
        })
        .unwrap();
        coordinator.with_writer(&lease, SCOPE, || Ok(())).unwrap();
    }
}

#[test]
fn writer_state_process_peer() {
    let Some(database) = std::env::var_os("HEPTA_WRITER_STATE_PEER_DATABASE") else {
        return;
    };
    let journal = std::env::var_os("HEPTA_WRITER_STATE_PEER_JOURNAL").unwrap();
    // Explicitly prove that the first process still owns the journal lock,
    // rather than relying only on scheduling delays in a second process.
    let probe = Connection::open(journal).unwrap();
    probe.busy_timeout(Duration::ZERO).unwrap();
    assert_eq!(
        probe
            .execute_batch("BEGIN IMMEDIATE")
            .unwrap_err()
            .sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy)
    );
    drop(probe);
    let mut coordinator = Coordinator::open(&database).unwrap();
    let lease = coordinator.inspect().unwrap().writer_fence().unwrap();
    println!("LOCK_BUSY_READY");
    std::io::stdout().flush().unwrap();
    coordinator
        .with_writer_state_v1(&lease, SCOPE, |state| {
            assert_eq!(state.phase, Phase::Planned);
            let database = Connection::open(&database).map_err(|cause| cause.to_string())?;
            database
                .execute("INSERT INTO records VALUES(2,'peer-committed')", [])
                .map_err(|cause| cause.to_string())?;
            println!("PEER_COMMITTED");
            std::io::stdout().flush().unwrap();
            Ok(())
        })
        .unwrap();
}

#[test]
fn state_callback_holds_real_cross_process_writer_lock() {
    for external in [false, true] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.coordinator(external);
        let expected = coordinator.inspect().unwrap();
        let lease = expected.writer_fence().unwrap();
        let mut worker = None;
        let mut completion = None;
        let mut reader = None;
        coordinator
            .with_writer_state_v1(&lease, SCOPE, |state| {
                assert_eq!(state, &expected);
                let mut child = Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "writer_state_process_peer", "--nocapture"])
                    .env("HEPTA_WRITER_STATE_PEER_DATABASE", &fixture.database)
                    .env("HEPTA_WRITER_STATE_PEER_JOURNAL", fixture.journal())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap();
                let mut output = BufReader::new(child.stdout.take().unwrap());
                loop {
                    let mut line = String::new();
                    assert!(
                        output.read_line(&mut line).unwrap() > 0,
                        "peer exited before lock probe"
                    );
                    if line.trim() == "LOCK_BUSY_READY" {
                        break;
                    }
                }
                let observer = Coordinator::open(&fixture.database).unwrap();
                assert_eq!(observer.inspect().unwrap(), *state);
                drop(observer);
                let (sender, receiver) = mpsc::channel();
                reader = Some(std::thread::spawn(move || {
                    loop {
                        let mut line = String::new();
                        if output.read_line(&mut line).unwrap() == 0 {
                            break;
                        }
                        if line.trim() == "PEER_COMMITTED" {
                            sender.send(()).unwrap();
                        }
                    }
                }));
                assert!(
                    receiver.recv_timeout(Duration::from_millis(150)).is_err(),
                    "peer writer overlapped the held state callback"
                );
                completion = Some(receiver);
                worker = Some(child);
                Ok(())
            })
            .unwrap();
        completion
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        reader.unwrap().join().unwrap();
        let output = worker.unwrap().wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            Connection::open(&fixture.database)
                .unwrap()
                .query_row("SELECT value FROM records WHERE id=2", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "peer-committed"
        );
        assert_eq!(coordinator.inspect().unwrap(), expected);
    }
}
