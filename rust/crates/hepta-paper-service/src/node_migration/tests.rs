mod installed_compatibility;
mod invocation;
mod temp {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    pub(super) struct Temp(PathBuf);
    impl Temp {
        pub(super) fn new() -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "hepta-migration-owner-{}-{stamp}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            Self(root)
        }
        pub(super) fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
use super::*;
use std::{os::unix::fs::PermissionsExt, process::Command};

#[test]
fn lease_committed_at_lock_handoff_is_rechecked_before_any_schema_write() {
    let temp = temp::Temp::new();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let path = temp.path().join("paper.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA user_version=1;").unwrap();
    drop(connection);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    migrate_node_store_v1(&path, Some(2)).unwrap();
    let mut observed = false;
    let result = migrate(&path, Some(3), &mut |point, _connection| {
        if point == "before_transaction" {
            observed = true;
            // A separate real SQLite process commits a lease at the handoff.
            // No fake database, response or transaction implementation is used.
            let output = Command::new("python3").args(["-c",
                "import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute(\"INSERT INTO jobs(job_id,deduplication_key,kind,status,spec_json,created_at,updated_at) VALUES ('handoff-job','handoff-dedupe','test','running','{}','now','now')\");c.commit();c.close()"])
                .arg(&path).output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    });
    assert!(observed);
    assert!(
        matches!(result, Err(NodeMigrationError::ActiveLease)),
        "{result:?}"
    );
    let connection = Connection::open(&path).unwrap();
    assert_eq!(
        validate_history(&read_history(&connection).unwrap()).unwrap(),
        2
    );
    assert!(active_leases(&connection).unwrap());
}

fn ready_database() -> (temp::Temp, PathBuf) {
    let temp = temp::Temp::new();
    let path = temp.path().join("paper.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA user_version=1;").unwrap();
    drop(db);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    migrate_node_store_v1(&path, Some(2)).unwrap();
    (temp, path)
}

#[test]
fn writer_remains_excluded_through_admission_commit_and_receipt_hash() {
    let (_temp, path) = ready_database();
    let mut phases = Vec::new();
    let receipt = migrate(&path, Some(3), &mut |point, _connection| {
        if point == "before_transaction" {
            return;
        }
        let output = Command::new("python3")
            .args([
                "-c",
                r#"import sqlite3,sys
c=sqlite3.connect(sys.argv[1],timeout=0)
try:
    c.execute('BEGIN IMMEDIATE')
    print('entered')
    c.rollback()
except sqlite3.OperationalError as error:
    if 'locked' not in str(error): raise
    print('blocked')
finally:
    c.close()
"#,
            ])
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{point}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            "blocked",
            "{point}"
        );
        phases.push(point);
    })
    .unwrap();
    assert_eq!(
        phases,
        [
            "after_admission",
            "after_migration",
            "before_commit",
            "after_commit",
            "after_hash"
        ]
    );
    assert_eq!(receipt.applied_versions, [3]);
    assert_eq!(
        receipt.database_sha256,
        format!(
            "sha256:{}",
            hex::encode(Sha256::digest(fs::read(&path).unwrap()))
        )
    );
    let db = Connection::open(&path).unwrap();
    db.execute_batch("BEGIN IMMEDIATE; ROLLBACK;").unwrap();
}

#[test]
fn precommit_identity_failure_rolls_back_but_postcommit_failure_preserves_applied_history() {
    for phase in ["before_commit", "after_commit", "after_hash"] {
        let (_temp, path) = ready_database();
        let before = fs::read(&path).unwrap();
        let result = migrate(&path, Some(3), &mut |point, _connection| {
            if point == phase {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
            }
        });
        if phase == "before_commit" {
            assert!(
                matches!(result, Err(NodeMigrationError::Identity)),
                "{result:?}"
            );
            assert_eq!(fs::read(&path).unwrap(), before);
        } else {
            assert!(
                matches!(result, Err(NodeMigrationError::OutcomeUnknown)),
                "{result:?}"
            );
        }
        // Only the test restores its own deliberately changed file permissions.
        // The product error path does not repair source identity or erase data.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let retry = migrate_node_store_v1(&path, Some(3)).unwrap();
        if phase == "before_commit" {
            assert_eq!(retry.applied_versions, [3]);
        } else {
            assert!(retry.applied_versions.is_empty());
            assert_eq!(retry.before_version, 3);
        }
    }
}

#[test]
#[ignore = "owned child invoked by the migration crash-boundary regression"]
fn migration_crash_child() {
    let path = PathBuf::from(std::env::var_os("HEPTA_MIGRATION_TEST_DATABASE").unwrap());
    let phase = std::env::var("HEPTA_MIGRATION_TEST_PHASE").unwrap();
    migrate(&path, Some(25), &mut |point, _connection| {
        if point == phase {
            nix::sys::signal::kill(nix::unistd::getpid(), nix::sys::signal::Signal::SIGKILL)
                .unwrap();
        }
    })
    .unwrap();
    panic!("selected migration crash point did not execute");
}

#[test]
fn process_death_preserves_original_evidence_and_private_recovery_distinguishes_commit() {
    use std::os::unix::process::ExitStatusExt;
    use std::time::{Duration, Instant};
    for phase in ["before_commit", "after_commit"] {
        let (_temp, path) = ready_database();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "node_migration::tests::migration_crash_child",
                "--ignored",
                "--nocapture",
            ])
            .env("HEPTA_MIGRATION_TEST_DATABASE", &path)
            .env("HEPTA_MIGRATION_TEST_PHASE", phase)
            .spawn()
            .unwrap();
        let began = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if began.elapsed() > Duration::from_secs(30) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("owned migration child exceeded bound");
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(status.signal(), Some(9), "{phase}");
        let original_bytes = fs::read(&path).unwrap();
        let journal = path.with_file_name("paper.sqlite-journal");
        let journal_bytes = fs::read(&journal).unwrap();
        for _ in 0..2 {
            assert!(matches!(
                migrate_node_store_v1(&path, Some(25)),
                Err(NodeMigrationError::Sidecar)
            ));
            assert_eq!(fs::read(&path).unwrap(), original_bytes);
            assert_eq!(fs::read(&journal).unwrap(), journal_bytes);
        }
        // Recovery is performed only on a separate owned diagnostic copy.
        // The source's crash residue is neither repaired nor removed by migrate.
        let copy = path.with_file_name("diagnostic.sqlite");
        fs::write(&copy, &original_bytes).unwrap();
        fs::write(
            copy.with_file_name("diagnostic.sqlite-journal"),
            &journal_bytes,
        )
        .unwrap();
        let db = Connection::open(&copy).unwrap();
        let version = validate_history(&read_history(&db).unwrap()).unwrap();
        assert_eq!(version, if phase == "before_commit" { 2 } else { 25 });
        assert_eq!(fs::read(&path).unwrap(), original_bytes);
        assert_eq!(fs::read(&journal).unwrap(), journal_bytes);
    }
}
