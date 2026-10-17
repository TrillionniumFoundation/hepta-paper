use super::*;
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        let path = PathBuf::from(format!(
            "/tmp/hepta-schema-normalize-physical-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn database(&self) -> PathBuf {
        self.0.join("candidate.sqlite")
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn replaced_stale_shm_is_restored_without_deleting_foreign_inode() {
    let root = Temporary::new();
    let db = Connection::open(root.database()).unwrap();
    db.execute_batch("CREATE TABLE business(id INTEGER PRIMARY KEY);")
        .unwrap();
    drop(db);
    let path = PathBuf::from(format!("{}-shm", root.database().display()));
    fs::write(&path, b"original ephemeral bytes").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let source =
        SchemaSource::observe(&root.0, Path::new("candidate.sqlite"), "native-store").unwrap();
    let mut foreign_identity = None;
    let result = remove_stale_shm(&source, &mut || Ok(()), &mut |point| {
        assert_eq!(point, "before_stale_shm_quarantine");
        fs::rename(&path, root.0.join("original-held-shm")).unwrap();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.write_all(b"foreign replacement must survive").unwrap();
        file.sync_all().unwrap();
        let metadata = file.metadata().unwrap();
        foreign_identity = Some((metadata.dev(), metadata.ino()));
        Ok(())
    });
    assert_eq!(
        result.unwrap_err().code,
        "autonomous_research_online_schema_transition_stale_shm_cleanup_unsafe"
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        b"foreign replacement must survive"
    );
    let metadata = fs::symlink_metadata(path).unwrap();
    assert_eq!(Some((metadata.dev(), metadata.ino())), foreign_identity);
}
#[test]
fn held_write_lock_child() {
    let Ok(root) = std::env::var("HEPTA_NORMALIZATION_LOCK_CHILD") else {
        return;
    };
    let root = PathBuf::from(root);
    let db = Connection::open(root.join("candidate.sqlite")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE; INSERT INTO business VALUES(2);")
        .unwrap();
    fs::write(root.join("lock-ready"), b"held").unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !root.join("release-lock").exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    db.execute_batch("ROLLBACK;").unwrap();
}
#[test]
fn real_other_process_write_lock_cannot_wait_past_maintenance_lease() {
    let root = Temporary::new();
    let db = Connection::open(root.database()).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE business(id INTEGER PRIMARY KEY); INSERT INTO business VALUES(1);").unwrap();
    drop(db);
    let mut child=Command::new(std::env::current_exe().unwrap()).args(["--exact","state_database_inventory::schema_source::normalization_support::tests::held_write_lock_child","--nocapture"]).env("HEPTA_NORMALIZATION_LOCK_CHILD",&root.0).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.0.join("lock-ready").exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(root.0.join("lock-ready").exists());
    let source =
        SchemaSource::observe(&root.0, Path::new("candidate.sqlite"), "native-store").unwrap();
    let started = Instant::now();
    let result = normalize_step(&source, &mut || Ok(()), &mut |_| Ok(()));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "busy source waited across a short lease"
    );
    assert!(result.is_err());
    fs::write(root.0.join("release-lock"), b"release").unwrap();
    assert!(child.wait().unwrap().success());
    let db = Connection::open(root.database()).unwrap();
    let count: i64 = db
        .query_row("SELECT count(*) FROM business", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn wal_appearing_at_quarantine_checkpoint_preserves_original_shm() {
    let root = Temporary::new();
    let db = Connection::open(root.database()).unwrap();
    db.execute_batch("CREATE TABLE business(id INTEGER PRIMARY KEY);")
        .unwrap();
    drop(db);
    let shm = PathBuf::from(format!("{}-shm", root.database().display()));
    fs::write(&shm, b"original shared memory").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&shm, fs::Permissions::from_mode(0o600)).unwrap();
    let original = fs::metadata(&shm).unwrap();
    let source =
        SchemaSource::observe(&root.0, Path::new("candidate.sqlite"), "native-store").unwrap();
    let wal = PathBuf::from(format!("{}-wal", root.database().display()));
    let result = remove_stale_shm(&source, &mut || Ok(()), &mut |point| {
        assert_eq!(point, "before_stale_shm_quarantine");
        fs::write(&wal, b"new WAL entry").unwrap();
        Ok(())
    });
    assert_eq!(
        result.unwrap_err().code,
        "autonomous_research_online_schema_transition_stale_shm_cleanup_unsafe"
    );
    let current = fs::metadata(&shm).unwrap();
    assert_eq!(
        (current.dev(), current.ino()),
        (original.dev(), original.ino())
    );
    assert_eq!(fs::read(&shm).unwrap(), b"original shared memory");
    assert_eq!(fs::read(&wal).unwrap(), b"new WAL entry");
}
