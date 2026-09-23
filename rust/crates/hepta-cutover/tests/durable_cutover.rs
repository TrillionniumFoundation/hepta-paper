use hepta_cutover::{
    DurableCutoverCoordinatorV1, DurableCutoverError, DurableCutoverModeV1, DurableCutoverPhaseV1,
};
use rusqlite::Connection;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-durable-cutover-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("tempdir");
        let path = root.join("native.sqlite");
        let connection = Connection::open(&path).expect("database");
        connection.execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO records VALUES(1,'before');").expect("schema");
        drop(connection);
        Self { root, path }
    }
    fn coordinator(&self) -> DurableCutoverCoordinatorV1 {
        DurableCutoverCoordinatorV1::create(
            &self.path,
            "cutover-test",
            "node",
            "rust",
            DurableCutoverModeV1::LocalDrill,
        )
        .expect("enroll")
    }
    fn shadow(&self, coordinator: &mut DurableCutoverCoordinatorV1) {
        coordinator.quiesce(0).expect("quiesce");
        coordinator
            .backup_restore_drill(
                1,
                &self.root.join("backup.sqlite"),
                &self.root.join("restored.sqlite"),
            )
            .expect("restore drill");
        let comparison = coordinator
            .compare_shadow(
                2,
                "record-output",
                b"{\"value\":\"before\"}",
                b"{\"value\":\"before\"}",
            )
            .expect("shadow");
        assert!(comparison.equal);
        assert!(!comparison.production_qualification);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn backup_shadow_canary_restart_and_rollback_preserve_committed_records() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator();
    let old = coordinator
        .inspect()
        .expect("state")
        .writer_fence()
        .expect("node lease");
    fixture.shadow(&mut coordinator);
    let canary = coordinator
        .start_local_canary(3, vec!["campaign-1".into()])
        .expect("canary");
    let rust = canary.writer_fence().expect("rust lease");
    assert!(matches!(
        coordinator.with_writer(&old, "campaign-1", || Ok(())),
        Err(DurableCutoverError::StaleWriter)
    ));
    assert!(matches!(
        coordinator.with_writer(&rust, "other-campaign", || Ok(())),
        Err(DurableCutoverError::CanaryScopeRejected)
    ));
    coordinator
        .with_writer(&rust, "campaign-1", || {
            let connection = Connection::open(&fixture.path).map_err(|e| e.to_string())?;
            connection
                .execute("INSERT INTO records VALUES(2,'committed-by-rust')", [])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .expect("canary write");
    drop(coordinator);
    let mut restarted = DurableCutoverCoordinatorV1::open(&fixture.path).expect("restart");
    assert_eq!(restarted.inspect().expect("state"), canary);
    restarted.promote_local(4).expect("promote");
    let rolled = restarted.rollback_local(5).expect("rollback");
    assert_eq!(rolled.phase, DurableCutoverPhaseV1::RolledBack);
    assert!(!rolled.production_activation);
    assert!(rolled.generation > rust.generation);
    assert!(matches!(
        restarted.with_writer(&rust, "campaign-1", || Ok(())),
        Err(DurableCutoverError::StaleWriter)
    ));
    assert!(matches!(
        restarted.with_writer(&old, "campaign-1", || Ok(())),
        Err(DurableCutoverError::StaleWriter)
    ));
    let connection = Connection::open(&fixture.path).expect("read");
    assert_eq!(
        connection
            .query_row("SELECT value FROM records WHERE id=2", [], |r| r
                .get::<_, String>(0))
            .expect("committed row"),
        "committed-by-rust"
    );
    restarted.verify_journal().expect("journal");
}

#[test]
fn a_shadow_failure_and_revision_race_cannot_be_promoted() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator();
    fixture.shadow(&mut coordinator);
    let failed = coordinator
        .compare_shadow(3, "mismatch", b"node", b"rust")
        .expect("record failure");
    assert!(!failed.equal);
    assert!(matches!(
        coordinator.start_local_canary(4, vec!["campaign".into()]),
        Err(DurableCutoverError::ShadowMismatch)
    ));
    assert!(matches!(
        coordinator.rollback_local(3),
        Err(DurableCutoverError::RevisionConflict)
    ));
    assert_eq!(coordinator.inspect().expect("state").revision, 4);
    coordinator
        .verify_journal()
        .expect("failed promotion unchanged");
}

#[test]
fn production_enrollment_rejects_local_authority_and_rollback() {
    let fixture = Fixture::new();
    let mut coordinator = DurableCutoverCoordinatorV1::create(
        &fixture.path,
        "production-test",
        "node",
        "rust",
        DurableCutoverModeV1::Production,
    )
    .expect("enroll");
    fixture.shadow(&mut coordinator);
    assert!(matches!(
        coordinator.start_local_canary(3, vec!["campaign".into()]),
        Err(DurableCutoverError::ProductionAuthorityRequired)
    ));
    assert!(matches!(
        coordinator.rollback_local(3),
        Err(DurableCutoverError::ProductionAuthorityRequired)
    ));
    assert_eq!(coordinator.inspect().expect("state").writer_id, None);
}

#[test]
fn replaced_journal_and_deleted_enrollment_fail_closed() {
    let fixture = Fixture::new();
    let coordinator = fixture.coordinator();
    fs::remove_file(format!(
        "{}.rust-cutover.enrolled.json",
        fixture.path.display()
    ))
    .expect("remove marker");
    assert!(coordinator.inspect().is_err());
    assert!(DurableCutoverCoordinatorV1::open(&fixture.path).is_err());
}

#[test]
fn committed_state_without_matching_journal_is_rejected_on_restart() {
    let fixture = Fixture::new();
    let coordinator = fixture.coordinator();
    let mut forged = coordinator.inspect().expect("state");
    drop(coordinator);
    let connection = Connection::open(format!("{}.rust-cutover.sqlite", fixture.path.display()))
        .expect("journal");
    assert!(
        connection
            .execute("DELETE FROM hepta_cutover_journal", [])
            .is_err()
    );
    assert!(
        connection
            .execute("UPDATE hepta_cutover_journal SET event='forged'", [])
            .is_err()
    );
    forged.generation = 9;
    connection
        .execute(
            "UPDATE hepta_cutover_state SET state_json=?1",
            [serde_json::to_string(&forged).expect("state json")],
        )
        .expect("tamper current state");
    drop(connection);
    assert!(matches!(
        DurableCutoverCoordinatorV1::open(&fixture.path),
        Err(DurableCutoverError::JournalCorrupt)
    ));
}

#[test]
fn already_open_coordinator_rejects_state_only_scope_phase_and_version_forgery() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator();
    fixture.shadow(&mut coordinator);
    let canary = coordinator
        .start_local_canary(3, vec!["allowed-campaign".into()])
        .expect("canary");
    let lease = canary.writer_fence().expect("current lease");
    let connection = Connection::open(format!("{}.rust-cutover.sqlite", fixture.path.display()))
        .expect("journal");
    let mut active = canary.clone();
    active.phase = DurableCutoverPhaseV1::Active;
    let mut expanded = canary.clone();
    expanded.canary_scopes.push("unapproved-campaign".into());
    let mut wrong_version = canary.clone();
    wrong_version.version = 2;
    for forged in [active, expanded, wrong_version] {
        connection
            .execute(
                "UPDATE hepta_cutover_state SET state_json=?1",
                [serde_json::to_string(&forged).expect("forged state")],
            )
            .expect("tamper after open");
        let mut invoked = false;
        let result = coordinator.with_writer(&lease, "unapproved-campaign", || {
            invoked = true;
            let database = Connection::open(&fixture.path).map_err(|e| e.to_string())?;
            database
                .execute("INSERT INTO records VALUES(2,'must-not-commit')", [])
                .map_err(|e| e.to_string())?;
            Ok(())
        });
        assert!(matches!(result, Err(DurableCutoverError::JournalCorrupt)));
        assert!(!invoked, "corrupt live state reached application callback");
        assert!(matches!(
            coordinator.promote_local(4),
            Err(DurableCutoverError::JournalCorrupt)
        ));
        assert!(matches!(
            coordinator.inspect(),
            Err(DurableCutoverError::JournalCorrupt)
        ));
    }
    let database = Connection::open(&fixture.path).expect("read database");
    assert_eq!(
        database
            .query_row("SELECT count(*) FROM records", [], |r| r.get::<_, i64>(0))
            .expect("count"),
        1
    );
    connection
        .execute(
            "UPDATE hepta_cutover_state SET state_json=?1",
            [serde_json::to_string(&canary).expect("original state")],
        )
        .expect("restore exact committed state");
    assert!(matches!(
        coordinator.with_writer(&lease, "unapproved-campaign", || Ok(())),
        Err(DurableCutoverError::CanaryScopeRejected)
    ));
    coordinator
        .with_writer(&lease, "allowed-campaign", || Ok(()))
        .expect("original allowed scope");
}

#[test]
fn already_open_coordinator_rejects_corrupt_tail_hash() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator();
    let lease = coordinator
        .inspect()
        .expect("state")
        .writer_fence()
        .expect("Node lease");
    let connection = Connection::open(format!("{}.rust-cutover.sqlite", fixture.path.display()))
        .expect("journal");
    // Model physical/administrative corruption beyond the append-only trigger.
    connection.execute_batch("DROP TRIGGER hepta_cutover_no_journal_update; UPDATE hepta_cutover_journal SET entry_hash='corrupt' WHERE revision=0;").expect("tamper hash");
    assert!(matches!(
        coordinator.with_writer::<()>(&lease, "campaign", || panic!("must not execute")),
        Err(DurableCutoverError::JournalCorrupt)
    ));
    assert!(matches!(
        coordinator.quiesce(0),
        Err(DurableCutoverError::JournalCorrupt)
    ));
}

#[test]
fn process_worker() {
    let Ok(database) = std::env::var("HEPTA_CUTOVER_CRASH_WORKER") else {
        return;
    };
    let connection =
        Connection::open(format!("{database}.rust-cutover.sqlite")).expect("open worker");
    connection
        .execute_batch("BEGIN IMMEDIATE; UPDATE hepta_cutover_state SET state_json='interrupted';")
        .expect("uncommitted transition");
    println!("READY");
    std::io::stdout().flush().expect("flush");
    let mut byte = [0];
    let _ = std::io::stdin().read(&mut byte);
    panic!("worker must be killed before committing");
}

#[test]
fn killed_transition_process_recovers_previous_committed_state() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator();
    coordinator.quiesce(0).expect("quiesce");
    let before = coordinator.inspect().expect("state");
    drop(coordinator);
    let mut child = Command::new(std::env::current_exe().expect("exe"))
        .args(["--exact", "process_worker", "--nocapture"])
        .env("HEPTA_CUTOVER_CRASH_WORKER", &fixture.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("worker");
    let mut output = BufReader::new(child.stdout.take().expect("stdout"));
    loop {
        let mut line = String::new();
        assert!(
            output.read_line(&mut line).expect("line") > 0,
            "worker exited before lock"
        );
        if line.trim() == "READY" {
            break;
        }
    }
    child.kill().expect("kill");
    child.wait().expect("wait");
    let recovered = DurableCutoverCoordinatorV1::open(&fixture.path).expect("recover");
    assert_eq!(recovered.inspect().expect("state"), before);
    recovered.verify_journal().expect("intact journal");
}

#[test]
fn node_process_holds_writer_fence_until_actual_native_commit() {
    let fixture = Fixture::new();
    let coordinator = fixture.coordinator();
    drop(coordinator);
    let bridge = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-adapters/migration/rust-cutover-fence.mjs");
    let script = r#"
      import { pathToFileURL } from 'node:url';
      import { DatabaseSync } from 'node:sqlite';
      import { readSync } from 'node:fs';
      const {createRustCutoverFence}=await import(pathToFileURL(process.env.HEPTA_TEST_BRIDGE));
      const fence=createRustCutoverFence({dbPath:process.env.HEPTA_TEST_DATABASE});
      fence.withWrite(()=>{
        process.stdout.write('READY\n');
        readSync(0,Buffer.alloc(1),0,1,null);
        const database=new DatabaseSync(process.env.HEPTA_TEST_DATABASE);
        database.exec("INSERT INTO records VALUES(2,'node-before-handoff')");
        database.close();
      });
      fence.close();
    "#;
    let mut child = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .env("HEPTA_TEST_BRIDGE", bridge)
        .env("HEPTA_TEST_DATABASE", &fixture.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node runtime required for interoperability test");
    let mut output = BufReader::new(child.stdout.take().expect("stdout"));
    let mut line = String::new();
    output.read_line(&mut line).expect("ready");
    assert_eq!(line.trim(), "READY");
    let path = fixture.path.clone();
    let (sender, receiver) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let mut coordinator =
            DurableCutoverCoordinatorV1::open(&path).expect("open concurrent coordinator");
        sender
            .send(coordinator.quiesce(0))
            .expect("send transition");
    });
    assert!(
        receiver.recv_timeout(Duration::from_millis(100)).is_err(),
        "handoff overlapped Node mutation"
    );
    child
        .stdin
        .as_mut()
        .expect("worker stdin")
        .write_all(b"x")
        .expect("release Node commit");
    let state = receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("handoff after write")
        .expect("transition");
    assert_eq!(state.writer_id, None);
    thread.join().expect("thread");
    assert!(child.wait().expect("wait Node").success());
    let connection = Connection::open(&fixture.path).expect("read");
    let count: i64 = connection
        .query_row("SELECT count(*) FROM records", [], |r| r.get(0))
        .expect("rows");
    assert_eq!(count, 2);
}
