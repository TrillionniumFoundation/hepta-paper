use super::*;
use crate::state_database_inventory::observe_state_database_inventory_v1;
use rusqlite::{Connection, ErrorCode};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::fs::{PermissionsExt, symlink},
    process::{Child, ChildStdout, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    manifest: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(format!(
            "/tmp/hepta-native-transaction-inventory-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let manifest: Value = serde_json::from_slice(
            &fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../paper-core/config/autonomous-research-state-databases.v1.json"),
            )
            .unwrap(),
        )
        .unwrap();
        for definition in manifest["databases"].as_array().unwrap() {
            let path = root.join(definition["relativePath"].as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let database = Connection::open(&path).unwrap();
            database.execute_batch("CREATE TABLE fixture_records(id TEXT PRIMARY KEY,value TEXT); INSERT INTO fixture_records VALUES('record','before'); PRAGMA user_version=7; PRAGMA application_id=24680;").unwrap();
            for object in definition["requiredSchemaObjects"].as_array().unwrap() {
                let (kind, name) = object.as_str().unwrap().split_once(':').unwrap();
                let statement = match kind {
                    "table" => format!("CREATE TABLE \"{name}\"(id TEXT PRIMARY KEY,value TEXT);"),
                    "index" => format!("CREATE INDEX \"{name}\" ON fixture_records(value);"),
                    "trigger" => format!(
                        "CREATE TRIGGER \"{name}\" BEFORE UPDATE ON fixture_records BEGIN SELECT 1; END;"
                    ),
                    "view" => {
                        format!("CREATE VIEW \"{name}\" AS SELECT id,value FROM fixture_records;")
                    }
                    _ => panic!("unexpected required schema object"),
                };
                database.execute_batch(&statement).unwrap();
            }
            database.close().unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        Self { root, manifest }
    }

    fn path(&self, role: &str) -> PathBuf {
        self.root.join(
            self.manifest["databases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["role"] == role)
                .unwrap()["relativePath"]
                .as_str()
                .unwrap(),
        )
    }
    fn other(&self) -> PathBuf {
        self.root.join(
            self.manifest["databases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["role"] != "native-store")
                .unwrap()["relativePath"]
                .as_str()
                .unwrap(),
        )
    }
    fn observe(&self) -> ObservedStateDatabaseInventoryV1 {
        observe_state_database_inventory_v1(&self.root, &self.manifest).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// A distinct OS process is necessary: SQLite's same-process connection
/// bookkeeping can conceal an accidental raw close releasing POSIX locks.
fn probe_lock(path: &Path, expected: &str) {
    let output = Command::new("/proc/self/exe")
        .args([
            "--exact",
            "state_database_inventory::transaction_guard::tests::sqlite_lock_probe_child",
            "--nocapture",
        ])
        .env("HEPTA_TRANSACTION_GUARD_PROBE_PATH", path)
        .env("HEPTA_TRANSACTION_GUARD_PROBE_EXPECTED", expected)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "probe {expected}: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("actual separate-process SQLite probe")
    );
}

#[test]
fn sqlite_lock_probe_child() {
    let Some(path) = std::env::var_os("HEPTA_TRANSACTION_GUARD_PROBE_PATH") else {
        return;
    };
    let database = Connection::open(path).unwrap();
    database.busy_timeout(Duration::ZERO).unwrap();
    let result = database.execute_batch("BEGIN IMMEDIATE");
    match std::env::var("HEPTA_TRANSACTION_GUARD_PROBE_EXPECTED")
        .unwrap()
        .as_str()
    {
        "busy" => assert_eq!(
            result.unwrap_err().sqlite_error_code(),
            Some(ErrorCode::DatabaseBusy)
        ),
        "acquired" => {
            result.unwrap();
            database.execute_batch("ROLLBACK").unwrap();
        }
        expected => panic!("unknown expected lock state {expected}"),
    }
    println!("actual separate-process SQLite probe");
}

#[test]
fn sqlite_wal_fixture_holder_child() {
    let Some(path) = std::env::var_os("HEPTA_TRANSACTION_GUARD_WAL_HOLDER_PATH") else {
        return;
    };
    let database = Connection::open(path).unwrap();
    database.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE fixture_records SET value='committed-wal-baseline'").unwrap();
    println!("actual separate-process WAL fixture ready");
    std::io::stdout().flush().unwrap();
    let mut done = [0u8; 1];
    std::io::stdin().read_exact(&mut done).unwrap();
    database.close().unwrap();
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
                "state_database_inventory::transaction_guard::tests::sqlite_wal_fixture_holder_child",
                "--nocapture",
            ])
            .env("HEPTA_TRANSACTION_GUARD_WAL_HOLDER_PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert_ne!(
                stdout.read_line(&mut line).unwrap(),
                0,
                "WAL fixture exited before readiness"
            );
            if line.contains("actual separate-process WAL fixture ready") {
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
        let mut output = String::new();
        let _ = self.stdout.read_to_string(&mut output);
        let status = child.wait().unwrap();
        if !std::thread::panicking() {
            assert!(status.success(), "WAL fixture failed: {output}");
        }
    }
}

fn allowed_dml_preserves_lock(mode: &str) {
    let fixture = Fixture::new();
    let path = fixture.path("native-store");
    let setup = Connection::open(&path).unwrap();
    setup.execute_batch(&format!("PRAGMA journal_mode={mode}; PRAGMA wal_autocheckpoint=0; UPDATE fixture_records SET value='baseline';")).unwrap();
    setup.close().unwrap();
    let inventory = fixture.observe();
    let guard = inventory.native_store_transaction_guard_v1().unwrap();
    assert_eq!(guard.instance()["role"], "native-store");
    assert_eq!(guard.instance()["instanceId"], "native-store");
    let database = Connection::open(&path).unwrap();
    database
        .execute_batch(&format!(
            "PRAGMA journal_mode={mode}; PRAGMA wal_autocheckpoint=0;"
        ))
        .unwrap();
    database.execute_batch("BEGIN IMMEDIATE").unwrap();
    probe_lock(&path, "busy");
    guard.assert_during_transaction().unwrap();
    probe_lock(&path, "busy");
    database
        .execute_batch("UPDATE fixture_records SET value='first';")
        .unwrap();
    guard.assert_during_transaction().unwrap();
    probe_lock(&path, "busy");
    database
        .execute_batch("UPDATE fixture_records SET value='second';")
        .unwrap();
    guard.assert_during_transaction().unwrap();
    probe_lock(&path, "busy");
    drop(guard);
    probe_lock(&path, "busy");
    database.execute_batch("COMMIT").unwrap();
    probe_lock(&path, "acquired");
    assert_eq!(
        database
            .query_row(
                "SELECT value FROM fixture_records WHERE id='record'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "second"
    );
    database.close().unwrap();
    // Passing the transaction guard never refreshes the old complete proof.
    assert!(inventory.assert_current().is_err());
    let fresh = fixture.observe();
    fresh.assert_current().unwrap();
}

#[test]
fn rollback_journal_target_dml_and_guard_drop_preserve_real_process_lock() {
    allowed_dml_preserves_lock("DELETE");
}

#[test]
fn wal_target_dml_and_guard_drop_preserve_real_process_lock() {
    allowed_dml_preserves_lock("WAL");
}

#[test]
fn existing_wal_and_shm_are_retained_without_releasing_live_sqlite_locks() {
    let fixture = Fixture::new();
    let path = fixture.path("native-store");
    // A separate process owns the preflight WAL connection. Full inventory
    // preflight may open/close raw SHM FDs in this process, so a same-process
    // SQLite connection must only be opened after the guard has been minted.
    let holder = WalHolder::new(&path);
    let inventory = fixture.observe();
    let guard = inventory.native_store_transaction_guard_v1().unwrap();
    assert!(guard.instance()["walFileIdentity"].is_object());
    let database = Connection::open(&path).unwrap();
    database
        .execute_batch("BEGIN IMMEDIATE; UPDATE fixture_records SET value='target-wal-change'")
        .unwrap();
    probe_lock(&path, "busy");
    guard.assert_during_transaction().unwrap();
    probe_lock(&path, "busy");
    drop(guard);
    probe_lock(&path, "busy");
    database.execute_batch("COMMIT").unwrap();
    probe_lock(&path, "acquired");
    database.close().unwrap();
    drop(holder);
}

#[test]
fn persisted_journal_is_held_without_opening_or_closing_its_descriptor() {
    allowed_dml_preserves_lock("PERSIST");
}

#[test]
fn mint_requires_current_complete_inventory() {
    let fixture = Fixture::new();
    let inventory = fixture.observe();
    let database = Connection::open(fixture.other()).unwrap();
    database
        .execute_batch("UPDATE fixture_records SET value='changed-before-mint'")
        .unwrap();
    assert!(inventory.native_store_transaction_guard_v1().is_err());
}

#[test]
fn equal_inventory_report_cannot_replace_guard_origin() {
    let fixture = Fixture::new();
    let inventory = fixture.observe();
    let other = fixture.observe();
    assert_eq!(inventory.value(), other.value());
    let guard = inventory.native_store_transaction_guard_v1().unwrap();
    guard.assert_bound_to(&inventory).unwrap();
    assert!(guard.assert_bound_to(&other).is_err());
    let database = Connection::open(fixture.path("native-store")).unwrap();
    database
        .execute_batch("BEGIN IMMEDIATE; UPDATE fixture_records SET value='during';")
        .unwrap();
    guard.assert_bound_to(&inventory).unwrap();
    assert!(guard.assert_bound_to(&other).is_err());
    probe_lock(&fixture.path("native-store"), "busy");
    database.execute_batch("ROLLBACK;").unwrap();
    database.close().unwrap();
}

#[test]
fn non_target_content_and_new_sidecar_reject_without_releasing_target_lock() {
    for sidecar in [false, true] {
        let fixture = Fixture::new();
        let path = fixture.path("native-store");
        let inventory = fixture.observe();
        let guard = inventory.native_store_transaction_guard_v1().unwrap();
        let database = Connection::open(&path).unwrap();
        database
            .execute_batch("BEGIN IMMEDIATE; UPDATE fixture_records SET value='uncommitted'")
            .unwrap();
        guard.assert_during_transaction().unwrap();
        if sidecar {
            let path = sidecar_path(&fixture.other(), "-wal");
            fs::write(&path, []).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        } else {
            Connection::open(fixture.other())
                .unwrap()
                .execute_batch("UPDATE fixture_records SET value='unrelated-change'")
                .unwrap();
        }
        assert!(guard.assert_during_transaction().is_err());
        probe_lock(&path, "busy");
        database.execute_batch("ROLLBACK").unwrap();
        assert_eq!(
            database
                .query_row(
                    "SELECT value FROM fixture_records WHERE id='record'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "before"
        );
    }
}

#[test]
fn non_target_retained_wal_changes_reject_without_releasing_target_lock() {
    let fixture = Fixture::new();
    let path = fixture.path("native-store");
    let other = fixture.other();
    let holder = WalHolder::new(&other);
    let inventory = fixture.observe();
    let guard = inventory.native_store_transaction_guard_v1().unwrap();
    let observed_other = inventory.value()["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["role"] == "submission-handoff")
        .unwrap();
    assert!(observed_other["walFileIdentity"].is_object());
    let database = Connection::open(&path).unwrap();
    database
        .execute_batch("BEGIN IMMEDIATE; UPDATE fixture_records SET value='uncommitted'")
        .unwrap();
    guard.assert_during_transaction().unwrap();
    let other_writer = Connection::open(&other).unwrap();
    other_writer
        .execute_batch("UPDATE fixture_records SET value='non-target-committed-wal-change'")
        .unwrap();
    other_writer.close().unwrap();
    assert!(guard.assert_during_transaction().is_err());
    probe_lock(&path, "busy");
    database.execute_batch("ROLLBACK").unwrap();
    database.close().unwrap();
    drop(holder);
}

#[test]
fn non_target_path_symlink_hardlink_and_directory_replacements_are_rejected() {
    for kind in ["replacement", "symlink", "hardlink", "directory"] {
        let fixture = Fixture::new();
        let path = fixture.path("native-store");
        let other = fixture.other();
        let inventory = fixture.observe();
        let guard = inventory.native_store_transaction_guard_v1().unwrap();
        let database = Connection::open(&path).unwrap();
        database.execute_batch("BEGIN IMMEDIATE").unwrap();
        match kind {
            "replacement" => {
                fs::rename(&other, other.with_extension("retained")).unwrap();
                fs::write(&other, b"replacement").unwrap();
            }
            "symlink" => {
                let retained = other.with_extension("retained");
                fs::rename(&other, &retained).unwrap();
                symlink(retained, &other).unwrap();
            }
            "hardlink" => fs::hard_link(&other, fixture.root.join("hardlink-alias")).unwrap(),
            "directory" => {
                let parent = other.parent().unwrap();
                let retained = parent.with_extension("retained");
                fs::rename(parent, &retained).unwrap();
                fs::create_dir(parent).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(guard.assert_during_transaction().is_err(), "{kind}");
        // The separate process probes the target only if its directory was not
        // also the deliberately replaced common parent.
        if path.exists() {
            probe_lock(&path, "busy");
        }
        database.execute_batch("ROLLBACK").unwrap();
    }
}

#[test]
fn full_tree_membership_and_blocker_changes_are_rejected() {
    for kind in ["root-sqlite", "nested-sqlite", "nested-symlink"] {
        let fixture = Fixture::new();
        let path = fixture.path("native-store");
        let inventory = fixture.observe();
        let guard = inventory.native_store_transaction_guard_v1().unwrap();
        let database = Connection::open(&path).unwrap();
        database.execute_batch("BEGIN IMMEDIATE").unwrap();
        match kind {
            "root-sqlite" => fs::write(fixture.root.join("unregistered.sqlite"), []).unwrap(),
            "nested-sqlite" => {
                let dir = fixture.root.join("autonomous-research/additional/deep");
                fs::create_dir_all(&dir).unwrap();
                fs::write(dir.join("unregistered.sqlite"), []).unwrap();
            }
            "nested-symlink" => {
                symlink(&path, fixture.root.join("autonomous-research/linked-data")).unwrap()
            }
            _ => unreachable!(),
        }
        assert!(guard.assert_during_transaction().is_err(), "{kind}");
        probe_lock(&path, "busy");
        database.execute_batch("ROLLBACK").unwrap();
    }
}

#[test]
fn target_main_identity_permissions_and_hardlink_changes_are_rejected() {
    for kind in ["replacement", "mode", "hardlink"] {
        let fixture = Fixture::new();
        let path = fixture.path("native-store");
        let inventory = fixture.observe();
        let guard = inventory.native_store_transaction_guard_v1().unwrap();
        let database = Connection::open(&path).unwrap();
        database.execute_batch("BEGIN IMMEDIATE").unwrap();
        let locked_path = match kind {
            "replacement" => {
                let retained = path.with_extension("retained");
                fs::rename(&path, &retained).unwrap();
                // Never read/copy the locked target using a fresh raw FD.
                fs::write(&path, []).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
                retained
            }
            "mode" => {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
                path.clone()
            }
            "hardlink" => {
                fs::hard_link(&path, fixture.root.join("target-alias")).unwrap();
                path.clone()
            }
            _ => unreachable!(),
        };
        assert!(guard.assert_during_transaction().is_err(), "{kind}");
        probe_lock(&locked_path, "busy");
        database.execute_batch("ROLLBACK").unwrap();
    }
}

#[test]
fn target_sidecar_namespace_and_unsafe_new_files_are_rejected() {
    for kind in [
        "unknown-dash-suffix",
        "symlink",
        "hardlink",
        "directory",
        "writable",
    ] {
        let fixture = Fixture::new();
        let path = fixture.path("native-store");
        let inventory = fixture.observe();
        let guard = inventory.native_store_transaction_guard_v1().unwrap();
        let database = Connection::open(&path).unwrap();
        database.execute_batch("BEGIN IMMEDIATE").unwrap();
        let sidecar = sidecar_path(&path, "-wal");
        match kind {
            "unknown-dash-suffix" => fs::write(sidecar_path(&path, "-unexpected"), []).unwrap(),
            "symlink" => symlink(fixture.other(), &sidecar).unwrap(),
            "hardlink" => fs::hard_link(fixture.other(), &sidecar).unwrap(),
            "directory" => fs::create_dir(&sidecar).unwrap(),
            "writable" => {
                fs::write(&sidecar, []).unwrap();
                fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o666)).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(guard.assert_during_transaction().is_err(), "{kind}");
        database.execute_batch("ROLLBACK").unwrap();
    }
}

#[test]
fn safe_new_sidecar_identity_is_latched_and_enrollment_dot_sibling_is_not_authority() {
    let fixture = Fixture::new();
    let path = fixture.path("native-store");
    // This marker is intentionally meaningless data. The local guard must not
    // reject the fixed legitimate name, or claim that its contents grant scope.
    let marker = sidecar_path(&path, ".rust-cutover.enrolled.json");
    fs::write(&marker, b"not an enrollment authority").unwrap();
    let inventory = fixture.observe();
    let guard = inventory.native_store_transaction_guard_v1().unwrap();
    let database = Connection::open(&path).unwrap();
    database.execute_batch("BEGIN IMMEDIATE").unwrap();
    guard.assert_during_transaction().unwrap();
    let sidecar = sidecar_path(&path, "-journal");
    fs::write(&sidecar, []).unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o600)).unwrap();
    guard.assert_during_transaction().unwrap();
    probe_lock(&path, "busy");
    let retained = sidecar.with_extension("retained-journal");
    fs::rename(&sidecar, retained).unwrap();
    fs::write(&sidecar, []).unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(guard.assert_during_transaction().is_err());
    probe_lock(&path, "busy");
    database.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn new_sidecar_cannot_disappear_after_it_has_been_observed() {
    let fixture = Fixture::new();
    let path = fixture.path("native-store");
    let inventory = fixture.observe();
    let guard = inventory.native_store_transaction_guard_v1().unwrap();
    let database = Connection::open(&path).unwrap();
    database.execute_batch("BEGIN IMMEDIATE").unwrap();
    let sidecar = sidecar_path(&path, "-journal");
    fs::write(&sidecar, []).unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o600)).unwrap();
    guard.assert_during_transaction().unwrap();
    fs::remove_file(sidecar).unwrap();
    assert!(guard.assert_during_transaction().is_err());
    probe_lock(&path, "busy");
    database.execute_batch("ROLLBACK").unwrap();
}
