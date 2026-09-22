use super::*;
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    directory: PathBuf,
    root: PathBuf,
    receipt: PathBuf,
    database: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "hepta-runtime-publication-read-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&directory).expect("create unique owned test directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("private test directory mode");
        let root = directory.join("publication");
        fs::create_dir(&root).expect("create private source parent");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("private mode");
        let receipt = root.join("receipt.json");
        let database = root.join("receipt.json.publication.sqlite");
        Self {
            directory,
            root,
            receipt,
            database,
        }
    }
    fn write(&self, path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).expect("owned fixture bytes");
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).expect("private file mode");
    }
    fn create_schema(&self, sql: &str) {
        let connection = Connection::open(&self.database).expect("owned database");
        connection.execute_batch(sql).expect("fixture schema");
        drop(connection);
        fs::set_permissions(&self.database, fs::Permissions::from_mode(0o600))
            .expect("private database mode");
    }
    fn policy(&self) -> SourcePolicy {
        SourcePolicy::capture(
            &self.receipt,
            paths(&self.receipt).expect("original source policy"),
            private_parent(&self.receipt, false).expect("actual private parent"),
        )
        .expect("source O_PATH pins")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn actual_schema_views_generated_columns_and_duplicate_authority_refuse() {
    let view = Fixture::new();
    view.create_schema("CREATE TABLE marker(value INTEGER); INSERT INTO marker VALUES(0); CREATE VIEW runtime_image_reproducibility_receipt AS SELECT missing_function(value) AS receipt_json FROM marker;");
    assert_eq!(
        read_snapshot(&view.database).err().expect("view refused").0,
        SCHEMA_UNSUPPORTED
    );
    let connection = Connection::open(&view.database).expect("owned verification");
    assert_eq!(
        connection
            .query_row("SELECT value FROM marker", [], |row| row.get::<_, i64>(0))
            .expect("marker"),
        0
    );
    drop(connection);

    let generated = Fixture::new();
    generated.create_schema("CREATE TABLE runtime_image_reproducibility_receipt(singleton_id INTEGER,receipt_json TEXT,receipt_content_hash TEXT,receipt_hash TEXT,issued_at TEXT,expires_at TEXT,publication_generation INTEGER,computed TEXT GENERATED ALWAYS AS (receipt_json) VIRTUAL);");
    assert_eq!(
        read_snapshot(&generated.database)
            .err()
            .expect("generated column refused")
            .0,
        SCHEMA_UNSUPPORTED
    );

    let duplicate = Fixture::new();
    duplicate.create_schema("CREATE TABLE runtime_image_reproducibility_receipt(singleton_id INTEGER,receipt_json TEXT,receipt_content_hash TEXT,receipt_hash TEXT,issued_at TEXT,expires_at TEXT,publication_generation INTEGER); INSERT INTO runtime_image_reproducibility_receipt VALUES(1,'{}','h','h','i','e',1),(1,'{}','h','h','i','e',2);");
    assert_eq!(
        read_snapshot(&duplicate.database)
            .err()
            .expect("duplicate rows refused before hash parsing")
            .0,
        AUTHORITY_INVALID
    );
}

#[test]
fn actual_schema_count_and_row_metadata_limits_refuse() {
    let fixture = Fixture::new();
    let connection = Connection::open(&fixture.database).expect("owned database");
    schema(&connection).expect("unchanged original writer schema");
    drop(connection);
    assert!(
        read_snapshot(&fixture.database)
            .expect("empty original schema")
            .is_none()
    );
    let connection = Connection::open(&fixture.database).expect("owned database");
    for index in 0..MAXIMUM_SCHEMA_ENTRIES {
        connection
            .execute_batch(&format!("CREATE TABLE extra_{index}(value TEXT);"))
            .expect("bounded extra schema");
    }
    drop(connection);
    assert_eq!(
        read_snapshot(&fixture.database)
            .err()
            .expect("129 entries refused")
            .0,
        SCHEMA_UNSUPPORTED
    );

    let wide = Fixture::new();
    wide.create_schema("CREATE TABLE runtime_image_reproducibility_receipt(singleton_id INTEGER,receipt_json TEXT,receipt_content_hash TEXT,receipt_hash TEXT,issued_at TEXT,expires_at TEXT,publication_generation INTEGER); INSERT INTO runtime_image_reproducibility_receipt VALUES(1,'{}',printf('%4097s','x'),'h','i','e',1);");
    assert_eq!(
        read_snapshot(&wide.database)
            .err()
            .expect("metadata too wide")
            .0,
        AUTHORITY_INVALID
    );
}

#[test]
fn retained_source_pins_detect_main_sidecar_and_parent_replacement() {
    let fixture = Fixture::new();
    fixture.write(&fixture.database, b"source");
    let policy = fixture.policy();
    policy
        .assert_current()
        .expect("actual effective UID policy");
    // O_PATH pins carry only the actual identity: source bytes are untouched.
    fixture.write(&fixture.database, b"change");
    assert_eq!(
        policy
            .assert_current()
            .expect_err("same inode bytes changed")
            .0,
        CHANGED
    );
    drop(policy);

    let wal = PathBuf::from(format!("{}-wal", fixture.database.display()));
    fixture.write(&wal, b"original");
    let policy = fixture.policy();
    fs::rename(&wal, fixture.root.join("old-wal")).expect("move original sidecar");
    fixture.write(&wal, b"replaced");
    assert_eq!(
        policy.assert_current().expect_err("replacement sidecar").0,
        CHANGED
    );
    drop(policy);

    let policy = fixture.policy();
    let moved = fixture.root.with_file_name("moved");
    fs::rename(&fixture.root, &moved).expect("move original parent");
    fs::create_dir(&fixture.root).expect("replacement parent");
    fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o700))
        .expect("replacement mode");
    fixture.write(&fixture.database, b"replacement sentinel");
    assert_eq!(
        policy.assert_current().expect_err("parent replacement").0,
        "runtime_reproducibility_receipt_parent_changed"
    );
    assert_eq!(
        fs::read(&fixture.database).expect("replacement bytes"),
        b"replacement sentinel"
    );
}

#[test]
fn actual_effective_uid_source_and_sidecar_policy_rechecks_unsafe_mode() {
    let fixture = Fixture::new();
    fixture.write(&fixture.database, b"source");
    let wal = PathBuf::from(format!("{}-wal", fixture.database.display()));
    fixture.write(&wal, b"sidecar");
    let policy = fixture.policy();
    for source in &policy.sources {
        if let Some((file, metadata)) = &source.held {
            assert_eq!(metadata.uid(), nix::unistd::geteuid().as_raw());
            assert_eq!(
                file.metadata().expect("actual held O_PATH metadata").uid(),
                nix::unistd::geteuid().as_raw()
            );
        }
    }
    fs::set_permissions(&wal, fs::Permissions::from_mode(0o620))
        .expect("owned unsafe sidecar mode");
    assert_eq!(
        policy
            .assert_current()
            .expect_err("held sidecar must retain original effective UID and safe mode")
            .0,
        FILE_INVALID
    );
    drop(policy);
    assert_eq!(
        SourcePin::capture(
            wal.clone(),
            &private_parent(&fixture.receipt, false).expect("parent")
        )
        .err()
        .expect("unsafe sidecar initially refused")
        .0,
        FILE_INVALID
    );
    assert_eq!(fs::read(wal).expect("source unchanged"), b"sidecar");
}

#[test]
fn completed_mirror_is_bounded_rejects_fifo_and_detects_named_drift() {
    let fixture = Fixture::new();
    fixture.write(&fixture.receipt, b"original");
    let parent = private_parent(&fixture.receipt, false).expect("private parent");
    let mirror = Mirror::capture(&fixture.receipt, &parent).expect("completed bytes");
    assert_eq!(mirror.bytes, b"original");
    fixture.write(&fixture.receipt, b"modified");
    assert_eq!(
        mirror
            .assert_current(&fixture.receipt, &parent)
            .expect_err("same-size update")
            .0,
        MIRROR_DRIFT
    );
    fs::remove_file(&fixture.receipt).expect("remove owned mirror");
    nix::unistd::mkfifo(&fixture.receipt, Mode::from_bits_truncate(0o600)).expect("owned FIFO");
    assert!(Mirror::capture(&fixture.receipt, &parent).is_err());
    fs::remove_file(&fixture.receipt).expect("remove FIFO");
    symlink("missing", &fixture.receipt).expect("owned symlink");
    assert!(Mirror::capture(&fixture.receipt, &parent).is_err());
    fs::remove_file(&fixture.receipt).expect("remove symlink");
    fixture.write(&fixture.receipt, b"x");
    let file = fs::OpenOptions::new()
        .write(true)
        .open(&fixture.receipt)
        .expect("owned sparse file");
    file.set_len(MAX + 1).expect("oversized sparse mirror");
    drop(file);
    assert_eq!(
        Mirror::capture(&fixture.receipt, &parent)
            .err()
            .expect("oversize refused")
            .0,
        MIRROR_DRIFT
    );
}
