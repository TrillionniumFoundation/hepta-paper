use super::*;
use rusqlite::{Connection, ErrorCode};
use std::{
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-retained-source-lock-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("scan")).unwrap();
        fs::create_dir(path.join("sql")).unwrap();
        fs::write(path.join("scan/inert.mjs"), "export const inert = 1;").unwrap();
        Self(path)
    }
    fn capture(&self) -> CompleteStaticInputs {
        CompleteStaticInputs::capture(&self.0, &json!({"operations":[]}), &json!({"SCAN_ROOTS":["scan","missing"],"SQL_MIGRATION_ROOT":"sql","PROVENANCE_ONLY_SOURCES":[]})).unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn probe(path: &Path) {
    let output = Command::new("/proc/self/exe")
        .args(["--exact", "online_writer_static::inspection::proof_inputs::retained::tests::separate_process_lock_probe", "--nocapture"])
        .env("HEPTA_RETAINED_SOURCE_LOCK_PATH", path).output().unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("retained source separate-process busy")
    );
}
#[test]
fn separate_process_lock_probe() {
    let Some(path) = std::env::var_os("HEPTA_RETAINED_SOURCE_LOCK_PATH") else {
        return;
    };
    let db = Connection::open(path).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    assert_eq!(
        db.execute_batch("BEGIN IMMEDIATE")
            .unwrap_err()
            .sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy)
    );
    println!("retained source separate-process busy");
}

#[test]
fn complete_retention_keeps_lock_when_source_name_is_replaced_with_database_hardlink() {
    let tree = Tree::new();
    let target = tree.0.join("live.sqlite");
    Connection::open(&target).unwrap().execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO records VALUES(1,'before')").unwrap();
    let inputs = tree.capture();
    let retained = inputs.retain_files().unwrap();
    let db = Connection::open(&target).unwrap();
    db.execute_batch("BEGIN IMMEDIATE; UPDATE records SET value='uncommitted'")
        .unwrap();
    retained.assert_current().unwrap();
    probe(&target);
    // Preserve namespace membership so rejection must inspect the retained
    // regular file identity rather than relying only on directory names.
    fs::remove_file(tree.0.join("scan/inert.mjs")).unwrap();
    fs::hard_link(&target, tree.0.join("scan/inert.mjs")).unwrap();
    assert!(retained.assert_current().is_err());
    probe(&target);
    drop(retained);
    probe(&target);
    db.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn complete_retention_rejects_changed_missing_replaced_added_and_absent_namespace_inputs() {
    for kind in [
        "bytes",
        "missing",
        "replacement",
        "new-module",
        "new-sql",
        "absent-directory",
        "symlink",
        "hardlink",
    ] {
        let tree = Tree::new();
        let inputs = tree.capture();
        let retained = inputs.retain_files().unwrap();
        let source = tree.0.join("scan/inert.mjs");
        match kind {
            "bytes" => fs::write(source, "export const inert = 2;").unwrap(),
            "missing" => fs::remove_file(source).unwrap(),
            "replacement" => {
                fs::remove_file(&source).unwrap();
                fs::write(source, "export const inert = 1;").unwrap();
            }
            "new-module" => {
                fs::write(tree.0.join("scan/new.mjs"), "export const added = 1;").unwrap()
            }
            "new-sql" => fs::write(tree.0.join("sql/001.sql"), "SELECT 1;").unwrap(),
            "absent-directory" => fs::create_dir(tree.0.join("missing")).unwrap(),
            "symlink" => {
                fs::remove_file(&source).unwrap();
                std::os::unix::fs::symlink("/dev/null", source).unwrap();
            }
            "hardlink" => fs::hard_link(source, tree.0.join("extra-link")).unwrap(),
            _ => unreachable!(),
        }
        assert!(retained.assert_current().is_err(), "{kind}");
    }
}

#[test]
fn retaining_changed_source_or_exceeded_limits_fails_before_transaction() {
    let tree = Tree::new();
    let mut inputs = tree.capture();
    inputs.bytes = MAX_BYTES + 1;
    assert!(inputs.retain_files().is_err());
    let inputs = tree.capture();
    fs::write(tree.0.join("scan/inert.mjs"), "export const changed = 1;").unwrap();
    assert!(inputs.retain_files().is_err());
}
