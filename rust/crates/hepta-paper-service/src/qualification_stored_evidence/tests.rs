use super::*;
use nix::{sys::stat::Mode, unistd::mkfifo};
use rusqlite::Connection;
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-stored-evidence-files-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("owned root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
        Self { root }
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.root.join(name);
        fs::write(&path, bytes).expect("owned bytes");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("leaf mode");
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn actual_mirror_limits_fifo_symlinks_and_mode_refuse_without_repair() {
    let fixture = Fixture::new();
    let path = fixture.file("mirror", b"{}");
    let file = fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("owned sparse file");
    file.set_len(files::MAXIMUM_RECEIPT_BYTES as u64)
        .expect("exact sparse bound");
    assert_eq!(
        files::Mirror::capture(&path)
            .expect("exact bound")
            .bytes
            .len(),
        files::MAXIMUM_RECEIPT_BYTES
    );
    file.set_len(files::MAXIMUM_RECEIPT_BYTES as u64 + 1)
        .expect("one-byte excess");
    assert_eq!(
        files::Mirror::capture(&path)
            .err()
            .expect("excess rejected")
            .code(),
        "full_research_qualification_pointer_file_invalid"
    );
    drop(file);
    fixture.file("mirror", b"{}");
    let alias = fixture.root.join("alias");
    symlink(&path, &alias).expect("owned leaf alias");
    assert!(files::Mirror::capture(&alias).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o620)).expect("unsafe mode");
    assert!(files::Mirror::capture(&path).is_err());
    let fifo = fixture.root.join("fifo");
    mkfifo(&fifo, Mode::from_bits_truncate(0o600)).expect("owned fifo");
    assert!(files::Mirror::capture(&fifo).is_err());
    assert_eq!(fs::read(&path).expect("unchanged bytes"), b"{}");
}

#[test]
fn completed_mirror_rechecks_parent_leaf_and_same_inode_content_drift() {
    let fixture = Fixture::new();
    let parent = fixture.root.join("parent");
    fs::create_dir(&parent).expect("owned parent");
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).expect("parent mode");
    let path = fixture.file("parent/mirror", b"before");
    let captured = files::Mirror::capture(&path).expect("completed observation");
    let before = fs::metadata(&path).expect("metadata");
    fs::write(&path, b"after!").expect("same length write");
    assert_eq!(fs::metadata(&path).expect("same inode").ino(), before.ino());
    assert!(captured.assert_named_current().is_err());
    let captured = files::Mirror::capture(&path).expect("fresh observation");
    let replacement = fixture.file("replacement", b"after!");
    fs::rename(replacement, &path).expect("replace leaf");
    assert!(captured.assert_named_current().is_err());
    let captured = files::Mirror::capture(&path).expect("fresh replacement");
    fs::rename(&parent, fixture.root.join("old-parent")).expect("replace parent");
    fs::create_dir(&parent).expect("new parent");
    fixture.file("parent/mirror", b"after!");
    assert!(captured.assert_named_current().is_err());
}

#[test]
fn ordinary_table_probe_refuses_target_view_before_business_query() {
    let connection = Connection::open_in_memory().expect("owned private database");
    connection.execute_batch("CREATE TABLE marker(x); CREATE VIEW evidence AS SELECT missing_function() AS state_json;").expect("foreign view fixture");
    let error = sqlite::table(
        &connection,
        "evidence",
        &["state_json"],
        "fixture_database_invalid",
    )
    .expect_err("view refused before SELECT");
    assert_eq!(error.code(), "fixture_database_invalid_schema_unsupported");
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM marker", [], |row| row.get(0))
        .expect("fixture remains readable");
    assert_eq!(count, 0);
}

#[test]
fn real_schema_entry_and_generated_column_profiles_are_bounded() {
    let connection = Connection::open_in_memory().expect("owned database");
    connection.execute_batch("CREATE TABLE evidence(state_json TEXT, generated TEXT GENERATED ALWAYS AS (state_json) VIRTUAL)").expect("actual generated column");
    assert_eq!(
        sqlite::table(
            &connection,
            "evidence",
            &["state_json"],
            "fixture_database_invalid"
        )
        .expect_err("generated column refusal")
        .code(),
        "fixture_database_invalid_schema_unsupported"
    );
    connection
        .execute_batch("DROP TABLE evidence; CREATE TABLE evidence(state_json TEXT);")
        .expect("ordinary table");
    sqlite::table(
        &connection,
        "evidence",
        &["state_json"],
        "fixture_database_invalid",
    )
    .expect("ordinary schema");
    for index in 0..128 {
        connection
            .execute_batch(&format!("CREATE TABLE extra_{index}(value TEXT)"))
            .expect("bounded source-owned schema fixture");
    }
    assert_eq!(
        sqlite::table(
            &connection,
            "evidence",
            &["state_json"],
            "fixture_database_invalid"
        )
        .expect_err("schema count refusal")
        .code(),
        "fixture_database_invalid_schema_unsupported"
    );
}

#[test]
fn ordered_documents_preserve_object_order_but_reject_lossy_scalar_projection() {
    let left = json::Document::parse(
        br#"{"manifest":{"python":1,"pythonGpu":2,"r":3}}"#,
        "fixture_invalid",
    )
    .expect("ordered JSON");
    let right = json::Document::parse(
        br#"{"manifest":{"r":3,"pythonGpu":2,"python":1}}"#,
        "fixture_invalid",
    )
    .expect("reordered JSON");
    assert_eq!(left.value, right.value);
    assert_ne!(left.stringify, right.stringify);
    for raw in [
        br#"{"receipt":1e999}"#.as_slice(),
        br#"{"receipt":"\ud800"}"#.as_slice(),
    ] {
        assert_eq!(
            json::Document::parse(raw, "fixture_invalid")
                .err()
                .expect("lossy scalar rejected")
                .code(),
            "qualification_stored_evidence_json_value_profile_unsupported"
        );
    }
    assert_eq!(
        json::Document::parse(br#"{"\ud800":1}"#, "fixture_invalid")
            .err()
            .expect("lossy key rejected")
            .code(),
        "qualification_stored_evidence_json_key_profile_unsupported"
    );
}
