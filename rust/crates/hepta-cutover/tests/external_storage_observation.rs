use hepta_cutover::{
    DurableCutoverCoordinatorV1 as Coordinator, DurableCutoverError as Error,
    DurableCutoverModeV1 as Mode, DurableCutoverStorageV2 as Storage,
};
use rusqlite::{Connection, ErrorCode};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdout, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
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
            "hepta-storage-observation-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let storage = root.join("storage");
        let runtime = root.join("runtime");
        for path in [&storage, &runtime] {
            fs::create_dir(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let database = runtime.join("native.sqlite");
        let db = Connection::open(&database).unwrap();
        db.execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT NOT NULL); INSERT INTO records VALUES(1,'before');").unwrap();
        db.close().unwrap();
        fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).unwrap();
        Self {
            root,
            database,
            storage,
        }
    }
    fn coordinator(&self, external: bool) -> Coordinator {
        self.coordinator_with_mode(external, Mode::LocalDrill)
    }
    fn coordinator_with_mode(&self, external: bool, mode: Mode) -> Coordinator {
        Coordinator::create_with_storage_v2(
            &self.database,
            "observed-storage",
            "node",
            "rust",
            mode,
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
    fn shadow(&self, coordinator: &mut Coordinator, equal: bool) {
        coordinator.quiesce(0).unwrap();
        coordinator
            .backup_restore_drill(
                1,
                &self.root.join("shadow-backup.sqlite"),
                &self.root.join("shadow-restored.sqlite"),
            )
            .unwrap();
        coordinator
            .compare_shadow(
                2,
                "shadow-observation",
                b"same",
                if equal { b"same" } else { b"different" },
            )
            .unwrap();
    }
    fn marker(&self) -> PathBuf {
        PathBuf::from(format!(
            "{}.rust-cutover.enrolled.json",
            self.database.display()
        ))
    }
    fn journal(&self) -> PathBuf {
        let marker: serde_json::Value =
            serde_json::from_slice(&fs::read(self.marker()).unwrap()).unwrap();
        self.storage
            .join(marker["storageSlot"].as_str().unwrap())
            .join("journal.sqlite")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn probe(path: &Path, busy: bool) {
    // Concurrent builds can unlink the running integration-test binary.
    let output = Command::new("/proc/self/exe")
        .args(["--exact", "storage_observation_lock_child", "--nocapture"])
        .env("HEPTA_STORAGE_OBSERVATION_PROBE", path)
        .env(
            "HEPTA_STORAGE_OBSERVATION_BUSY",
            if busy { "yes" } else { "no" },
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("actual storage observation lock probe")
    );
}
#[test]
fn storage_observation_lock_child() {
    let Some(path) = std::env::var_os("HEPTA_STORAGE_OBSERVATION_PROBE") else {
        return;
    };
    let db = Connection::open(path).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    let result = db.execute_batch("BEGIN IMMEDIATE");
    if std::env::var("HEPTA_STORAGE_OBSERVATION_BUSY").unwrap() == "yes" {
        assert_eq!(
            result.unwrap_err().sqlite_error_code(),
            Some(ErrorCode::DatabaseBusy)
        );
    } else {
        result.unwrap();
        db.execute_batch("ROLLBACK").unwrap();
    }
    println!("actual storage observation lock probe");
}
#[test]
fn storage_observation_wal_holder_child() {
    let Some(path) = std::env::var_os("HEPTA_STORAGE_OBSERVATION_WAL_HOLDER") else {
        return;
    };
    let db = Connection::open(path).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE records SET value='before';",
    )
    .unwrap();
    println!("actual storage observation WAL ready");
    std::io::stdout().flush().unwrap();
    let mut end = [0];
    std::io::stdin().read_exact(&mut end).unwrap();
    db.close().unwrap();
}
struct WalHolder {
    child: Option<Child>,
    stdout: BufReader<ChildStdout>,
}
impl WalHolder {
    fn new(path: &Path) -> Self {
        let mut child = Command::new("/proc/self/exe")
            .args([
                "--exact",
                "storage_observation_wal_holder_child",
                "--nocapture",
            ])
            .env("HEPTA_STORAGE_OBSERVATION_WAL_HOLDER", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert!(stdout.read_line(&mut line).unwrap() > 0);
            if line.contains("actual storage observation WAL ready") {
                break;
            }
        }
        Self {
            child: Some(child),
            stdout,
        }
    }
}
impl Drop for WalHolder {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let _ = child.stdin.take().unwrap().write_all(b"x");
        let mut tail = String::new();
        let _ = self.stdout.read_to_string(&mut tail);
        let status = child.wait().unwrap();
        if !std::thread::panicking() {
            assert!(status.success(), "{tail}");
        }
    }
}

#[test]
fn rejects_adjacent_storage_stale_lease_and_wrong_canary_scope_before_callback() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator(false);
    let lease = coordinator.inspect().unwrap().writer_fence().unwrap();
    assert!(coordinator.external_storage_root_v2().is_none());
    assert!(matches!(
        coordinator.with_writer_state_and_external_storage_v2(
            &lease,
            SCOPE,
            |_, _| -> Result<(), String> {
                panic!("v1 callback must not run");
            }
        ),
        Err(Error::InvalidInput)
    ));
    // Incumbent API still accepts the same original v1 enrollment.
    coordinator
        .with_writer_state_v1(&lease, SCOPE, |_| Ok(()))
        .unwrap();

    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator(true);
    let old = coordinator.inspect().unwrap().writer_fence().unwrap();
    coordinator.quiesce(0).unwrap();
    coordinator
        .backup_restore_drill(
            1,
            &fixture.root.join("backup.sqlite"),
            &fixture.root.join("restore.sqlite"),
        )
        .unwrap();
    coordinator
        .compare_shadow(2, "parity", b"same", b"same")
        .unwrap();
    let canary = coordinator
        .start_local_canary(3, vec![SCOPE.into()])
        .unwrap();
    assert!(matches!(
        coordinator.with_writer_state_and_external_storage_v2(
            &old,
            SCOPE,
            |_, _| -> Result<(), String> {
                panic!("stale callback must not run");
            }
        ),
        Err(Error::StaleWriter)
    ));
    assert!(matches!(
        coordinator.with_writer_state_and_external_storage_v2(
            &canary.writer_fence().unwrap(),
            "wrong",
            |_, _| -> Result<(), String> {
                panic!("wrong scope callback must not run");
            }
        ),
        Err(Error::CanaryScopeRejected)
    ));
    coordinator
        .with_writer_state_and_external_storage_v2(
            &canary.writer_fence().unwrap(),
            SCOPE,
            |state, observation| {
                assert_eq!(state, &canary);
                observation.assert_current().unwrap();
                Ok(())
            },
        )
        .unwrap();
}

#[test]
fn retained_checks_preserve_target_and_journal_locks_for_delete_and_existing_wal() {
    for wal in [false, true] {
        let fixture = Fixture::new();
        let holder = wal.then(|| WalHolder::new(&fixture.database));
        let mut coordinator = fixture.coordinator(true);
        let state = coordinator.inspect().unwrap();
        let hash = coordinator
            .external_storage_enrollment_hash_v2()
            .unwrap()
            .to_owned();
        assert_eq!(
            coordinator.external_storage_root_v2(),
            Some(fixture.storage.as_path())
        );
        let journal = fixture.journal();
        coordinator
            .with_writer_state_and_external_storage_v2(
                &state.writer_fence().unwrap(),
                SCOPE,
                |actual, observation| {
                    assert_eq!(actual, &state);
                    assert_eq!(observation.external_storage_root_v2(), fixture.storage);
                    assert_eq!(observation.external_storage_enrollment_hash_v2(), hash);
                    let db = Connection::open(&fixture.database).unwrap();
                    db.execute_batch("BEGIN IMMEDIATE; UPDATE records SET value='staged';")
                        .unwrap();
                    for _ in 0..3 {
                        observation.assert_current().unwrap();
                        probe(&fixture.database, true);
                        probe(&journal, true);
                    }
                    db.execute_batch("COMMIT").unwrap();
                    db.close().unwrap();
                    observation.assert_current().unwrap();
                    Ok(())
                },
            )
            .unwrap();
        probe(&fixture.database, false);
        probe(&journal, false);
        drop(coordinator);
        drop(holder);
    }
}

#[test]
fn marker_alias_rejection_never_closes_live_target_or_journal_shm() {
    for wal in [false, true] {
        for alias in ["target", "journal-shm"] {
            let fixture = Fixture::new();
            let holder = wal.then(|| WalHolder::new(&fixture.database));
            let mut coordinator = fixture.coordinator(true);
            let lease = coordinator.inspect().unwrap().writer_fence().unwrap();
            let journal = fixture.journal();
            let marker = fixture.marker();
            let original_marker = marker.with_extension("original");
            let result: Result<(), Error> = coordinator.with_writer_state_and_external_storage_v2(
                &lease,
                SCOPE,
                |_, observation| {
                    let db = Connection::open(&fixture.database).unwrap();
                    db.execute_batch("BEGIN IMMEDIATE; UPDATE records SET value='staged';")
                        .unwrap();
                    observation.assert_current().unwrap();
                    fs::rename(&marker, &original_marker).unwrap();
                    let alias_path = if alias == "target" {
                        fixture.database.clone()
                    } else {
                        PathBuf::from(format!("{}-shm", journal.display()))
                    };
                    fs::hard_link(alias_path, &marker).unwrap();
                    assert!(observation.assert_current().is_err());
                    probe(&fixture.database, true);
                    probe(&journal, true);
                    fs::remove_file(&marker).unwrap();
                    fs::rename(&original_marker, &marker).unwrap();
                    db.execute_batch("ROLLBACK").unwrap();
                    db.close().unwrap();
                    Err("retain original rich application rejection".into())
                },
            );
            assert!(
                matches!(result, Err(Error::Application(ref message)) if message == "retain original rich application rejection")
            );
            probe(&fixture.database, false);
            probe(&journal, false);
            drop(coordinator);
            drop(holder);
        }
    }
}

#[test]
fn single_link_database_at_marker_is_rejected_without_opening_it() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator(true);
    let lease = coordinator.inspect().unwrap().writer_fence().unwrap();
    let marker = fixture.marker();
    let marker_original = marker.with_extension("original");
    let journal = fixture.journal();
    let result: Result<(), Error> =
        coordinator.with_writer_state_and_external_storage_v2(&lease, SCOPE, |_, observation| {
            let db = Connection::open(&fixture.database).unwrap();
            db.execute_batch("BEGIN IMMEDIATE; UPDATE records SET value='staged';")
                .unwrap();
            // Unlike a two-link alias, this would pass read_marker's initial
            // link-count check. Opening/parsing/closing it as a new observer would
            // release the live main inode's POSIX lock even though parsing fails.
            fs::rename(&marker, &marker_original).unwrap();
            fs::rename(&fixture.database, &marker).unwrap();
            fs::write(&fixture.database, b"replacement target").unwrap();
            fs::set_permissions(&fixture.database, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(observation.assert_current().is_err());
            probe(&marker, true);
            probe(&journal, true);
            fs::remove_file(&fixture.database).unwrap();
            fs::rename(&marker, &fixture.database).unwrap();
            fs::rename(&marker_original, &marker).unwrap();
            db.execute_batch("ROLLBACK").unwrap();
            db.close().unwrap();
            Err("single-link alias rejected".into())
        });
    assert!(
        matches!(result, Err(Error::Application(ref message)) if message == "single-link alias rejected")
    );
    probe(&fixture.database, false);
}

#[test]
fn root_slot_and_marker_changes_reject_using_only_existing_pins() {
    for attack in ["root", "slot", "marker-content"] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.coordinator(true);
        let lease = coordinator.inspect().unwrap().writer_fence().unwrap();
        let journal = fixture.journal();
        let result: Result<(), Error> = coordinator.with_writer_state_and_external_storage_v2(
            &lease,
            SCOPE,
            |_, observation| {
                let db = Connection::open(&fixture.database).unwrap();
                db.execute_batch("BEGIN IMMEDIATE").unwrap();
                if attack == "marker-content" {
                    // This is still the original JSON inode, not a target alias.
                    fs::write(fixture.marker(), b"changed").unwrap();
                } else {
                    let path = if attack == "root" {
                        fixture.storage.clone()
                    } else {
                        journal.parent().unwrap().to_owned()
                    };
                    fs::rename(&path, path.with_extension("retained")).unwrap();
                    fs::create_dir(&path).unwrap();
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
                }
                assert!(observation.assert_current().is_err());
                probe(&fixture.database, true);
                db.execute_batch("ROLLBACK").unwrap();
                db.close().unwrap();
                Err("storage identity changed".into())
            },
        );
        assert!(
            matches!(result, Err(Error::Application(ref message)) if message == "storage identity changed")
        );
    }
}

#[test]
fn post_callback_failure_does_not_claim_rollback_of_committed_business_rows() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator(true);
    let lease = coordinator.inspect().unwrap().writer_fence().unwrap();
    let result =
        coordinator.with_writer_state_and_external_storage_v2(&lease, SCOPE, |_, observation| {
            let db = Connection::open(&fixture.database).unwrap();
            db.execute_batch("BEGIN IMMEDIATE; UPDATE records SET value='committed'; COMMIT;")
                .unwrap();
            db.close().unwrap();
            observation.assert_current().unwrap();
            fs::write(fixture.marker(), b"changed after business commit").unwrap();
            Ok("business really committed")
        });
    assert!(matches!(result, Err(Error::IdentityChanged)));
    let db = Connection::open(&fixture.database).unwrap();
    assert_eq!(
        db.query_row("SELECT value FROM records WHERE id=1", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "committed"
    );
}

#[test]
fn callback_unwind_releases_both_real_sqlite_connections() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator(true);
    let state = coordinator.inspect().unwrap();
    let journal = fixture.journal();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: Result<(), Error> = coordinator.with_writer_state_and_external_storage_v2(
            &state.writer_fence().unwrap(),
            SCOPE,
            |_, observation| {
                let db = Connection::open(&fixture.database).unwrap();
                db.execute_batch("BEGIN IMMEDIATE; UPDATE records SET value='uncommitted';")
                    .unwrap();
                observation.assert_current().unwrap();
                probe(&fixture.database, true);
                probe(&journal, true);
                panic!("fixture unwind with borrowed observation");
            },
        );
    }));
    assert!(result.is_err());
    probe(&fixture.database, false);
    probe(&journal, false);
    assert_eq!(coordinator.inspect().unwrap(), state);
}

fn journal_rows(path: &Path) -> Vec<(i64, String, String, String, String, String)> {
    let connection = Connection::open(path).unwrap();
    connection
        .prepare("SELECT revision,event,evidence_json,state_json,previous_hash,entry_hash FROM hepta_cutover_journal ORDER BY revision")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

#[test]
fn production_shadow_observation_reads_latest_locked_state_without_writing_journal() {
    let fixture = Fixture::new();
    let application_before = fs::read(&fixture.database).unwrap();
    let mut coordinator = fixture.coordinator_with_mode(true, Mode::Production);
    fixture.shadow(&mut coordinator, true);
    let mut peer = Coordinator::open(&fixture.database).unwrap();
    peer.compare_shadow(3, "later-peer-case", b"equal", b"equal")
        .unwrap();
    let expected = peer.inspect().unwrap();
    drop(peer);
    let journal = fixture.journal();
    let before = journal_rows(&journal);
    let observed = coordinator
        .with_production_shadow_observation_v2(|actual, observation| {
            assert_eq!(actual, &expected);
            assert!(actual.writer_fence().is_none());
            assert!(!actual.production_activation);
            assert!(actual.activation_receipt_hash.is_none());
            for _ in 0..2 {
                observation.assert_current().unwrap();
                probe(&journal, true);
            }
            Ok(serde_json::to_value(actual).unwrap())
        })
        .unwrap();
    assert_eq!(observed, serde_json::to_value(&expected).unwrap());
    assert_eq!(coordinator.inspect().unwrap(), expected);
    assert_eq!(journal_rows(&journal), before);
    coordinator.verify_journal().unwrap();
    probe(&journal, false);
    drop(coordinator);
    assert_eq!(fs::read(&fixture.database).unwrap(), application_before);
}

#[test]
fn production_shadow_observation_refuses_v1_local_nonshadow_and_failed_comparisons() {
    for (external, mode) in [(false, Mode::Production), (true, Mode::LocalDrill)] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.coordinator_with_mode(external, mode);
        fixture.shadow(&mut coordinator, true);
        let before = coordinator.inspect().unwrap();
        let failure = coordinator
            .with_production_shadow_observation_v2(|_, _| -> Result<(), String> {
                panic!("unsupported enrollment callback must not run");
            })
            .unwrap_err();
        if external {
            assert!(matches!(failure, Error::ProductionAuthorityRequired));
        } else {
            assert!(matches!(failure, Error::InvalidInput));
        }
        assert_eq!(coordinator.inspect().unwrap(), before);
    }
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator_with_mode(true, Mode::Production);
    for phase in ["planned", "quiesced", "backed-up", "mismatch"] {
        let before = coordinator.inspect().unwrap();
        let failure = coordinator
            .with_production_shadow_observation_v2(|_, _| -> Result<(), String> {
                panic!("wrong phase callback must not run");
            })
            .unwrap_err();
        if phase == "mismatch" {
            assert!(matches!(failure, Error::ShadowMismatch));
        } else {
            assert!(matches!(failure, Error::IllegalTransition));
        }
        assert_eq!(coordinator.inspect().unwrap(), before);
        match phase {
            "planned" => {
                coordinator.quiesce(0).unwrap();
            }
            "quiesced" => {
                coordinator
                    .backup_restore_drill(
                        1,
                        &fixture.root.join("backup.sqlite"),
                        &fixture.root.join("restore.sqlite"),
                    )
                    .unwrap();
            }
            "backed-up" => {
                coordinator
                    .compare_shadow(2, "failed", b"one", b"two")
                    .unwrap();
            }
            "mismatch" => {}
            _ => unreachable!(),
        }
    }
}

#[test]
fn production_shadow_marker_alias_rejection_keeps_real_journal_lock_and_rejects_result() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator_with_mode(true, Mode::Production);
    fixture.shadow(&mut coordinator, true);
    let expected = coordinator.inspect().unwrap();
    let journal = fixture.journal();
    let before = journal_rows(&journal);
    let marker = fixture.marker();
    let saved = marker.with_extension("original");
    let failure = coordinator
        .with_production_shadow_observation_v2(|_, observation| {
            observation.assert_current().unwrap();
            fs::rename(&marker, &saved).unwrap();
            fs::hard_link(PathBuf::from(format!("{}-shm", journal.display())), &marker).unwrap();
            assert!(observation.assert_current().is_err());
            probe(&journal, true);
            Ok("must not return diagnostic after marker changed")
        })
        .unwrap_err();
    assert!(matches!(failure, Error::IdentityChanged));
    fs::remove_file(&marker).unwrap();
    fs::rename(&saved, &marker).unwrap();
    assert_eq!(coordinator.inspect().unwrap(), expected);
    assert_eq!(journal_rows(&journal), before);
    probe(&journal, false);
}

#[test]
fn production_shadow_error_and_unwind_release_lock_without_state_transition() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator_with_mode(true, Mode::Production);
    fixture.shadow(&mut coordinator, true);
    let expected = coordinator.inspect().unwrap();
    let journal = fixture.journal();
    let before = journal_rows(&journal);
    let failure = coordinator
        .with_production_shadow_observation_v2(|_, observation| -> Result<(), String> {
            observation.assert_current().unwrap();
            probe(&journal, true);
            Err("original signer diagnostic rejection".into())
        })
        .unwrap_err();
    assert!(
        matches!(failure, Error::Application(ref message) if message == "original signer diagnostic rejection")
    );
    probe(&journal, false);
    let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: Result<(), Error> =
            coordinator.with_production_shadow_observation_v2(|_, observation| {
                observation.assert_current().unwrap();
                probe(&journal, true);
                panic!("diagnostic unwind");
            });
    }));
    assert!(unwind.is_err());
    probe(&journal, false);
    assert_eq!(coordinator.inspect().unwrap(), expected);
    assert_eq!(journal_rows(&journal), before);
}
