use super::*;
use ed25519_dalek::pkcs8::EncodePrivateKey;
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    config: PathBuf,
    state_tree: PathBuf,
    parent: PathBuf,
    database: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-authority-ancestry-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let trust = root.join("trust");
        let state_tree = root.join("state-tree");
        let parent = state_tree.join("level/private");
        fs::create_dir_all(&trust).unwrap();
        fs::create_dir_all(&parent).unwrap();
        for path in [
            &root,
            &trust,
            &state_tree,
            &state_tree.join("level"),
            &parent,
        ] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let key = trust.join("private.pem");
        let pem = SigningKey::from_bytes(&[74; 32])
            .to_pkcs8_pem(Default::default())
            .unwrap();
        fs::write(&key, pem.as_bytes()).unwrap();
        fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();
        let database = parent.join("authority.sqlite");
        let configuration = json!({"version":1,"kind":"HeptaLocalAutonomousResearchStateAuthorityConfiguration","authorityId":"authority:test","keyId":"key:test","scopeId":"scope:test","databaseScopeHash":hash_bytes(b"scope"),"writerManifestHash":hash_bytes(b"writers"),"privateKeyPath":key,"stateDatabasePath":database,"socketPath":parent.join("authority.sock"),"maximumReservationLeaseMs":30000,"maximumObservationAgeMs":30000});
        let config = trust.join("configuration.json");
        fs::write(&config, configuration.to_string()).unwrap();
        fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
        Self {
            root,
            config,
            state_tree,
            parent,
            database,
        }
    }
    fn runtime(&self) -> LocalStateAuthorityRuntimeV1 {
        LocalStateAuthorityRuntimeV1::open(&self.config).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn assert_busy(database: &Path) {
    let output = Command::new("/proc/self/exe")
        .args([
            "--exact",
            "local_state_authority::storage::tests::state_database_ancestry_lock_probe_child",
            "--nocapture",
        ])
        .env("HEPTA_AUTHORITY_ANCESTRY_LOCK_PROBE", database)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("AUTHORITY_ANCESTRY_SQLITE_BUSY"));
}
#[test]
fn state_database_ancestry_lock_probe_child() {
    let Some(path) = std::env::var_os("HEPTA_AUTHORITY_ANCESTRY_LOCK_PROBE") else {
        return;
    };
    let db = Connection::open_with_flags(
        PathBuf::from(path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
    )
    .unwrap();
    db.busy_timeout(std::time::Duration::ZERO).unwrap();
    let err = db.execute_batch("BEGIN IMMEDIATE;").unwrap_err();
    assert_eq!(
        err.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy)
    );
    println!("AUTHORITY_ANCESTRY_SQLITE_BUSY");
}
#[test]
fn full_ancestor_rename_and_symlink_are_rejected_without_releasing_sqlite_locks() {
    for mode in ["DELETE", "WAL"] {
        let fixture = Fixture::new();
        let runtime = fixture.runtime();
        runtime
            .connection
            .pragma_update(None, "journal_mode", mode)
            .unwrap();
        runtime
            .connection
            .execute_batch(
                "BEGIN IMMEDIATE; UPDATE authority_metadata SET global_sequence=global_sequence;",
            )
            .unwrap();
        runtime.inputs.assert_current().unwrap();
        assert_busy(&fixture.database);
        let parent_before = fs::symlink_metadata(&fixture.parent).unwrap();
        let database_before = fs::symlink_metadata(&fixture.database).unwrap();
        let moved = fixture.root.join("moved-state-tree");
        fs::rename(&fixture.state_tree, &moved).unwrap();
        symlink(&moved, &fixture.state_tree).unwrap();
        let parent_after = fs::symlink_metadata(&fixture.parent).unwrap();
        let database_after = fs::symlink_metadata(&fixture.database).unwrap();
        assert_eq!(
            (parent_before.dev(), parent_before.ino()),
            (parent_after.dev(), parent_after.ino())
        );
        assert_eq!(
            (database_before.dev(), database_before.ino()),
            (database_after.dev(), database_after.ino())
        );
        // The independent trust tree is unchanged; it cannot accidentally make
        // this regression pass by rejecting the configuration or key instead.
        runtime.inputs.configuration.assert_current().unwrap();
        runtime.inputs.key.assert_current().unwrap();
        assert_eq!(
            runtime.inputs.assert_current().unwrap_err().code,
            "local_state_authority_directory_namespace_changed"
        );
        assert_busy(&fixture.database);
        runtime.connection.execute_batch("ROLLBACK;").unwrap();
        drop(runtime);
    }
}
#[test]
fn directory_children_may_change_but_mode_identity_and_missing_ancestors_cannot() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime();
    fs::create_dir(fixture.state_tree.join("legitimate-new-child")).unwrap();
    fs::write(
        fixture.parent.join("normal-sidecar-observation"),
        b"unrelated child",
    )
    .unwrap();
    runtime.inputs.assert_current().unwrap();
    fs::set_permissions(&fixture.state_tree, fs::Permissions::from_mode(0o750)).unwrap();
    assert_eq!(
        runtime.inputs.assert_current().unwrap_err().code,
        "local_state_authority_directory_namespace_changed"
    );
    fs::set_permissions(&fixture.state_tree, fs::Permissions::from_mode(0o700)).unwrap();
    runtime.inputs.assert_current().unwrap();
    let moved = fixture.root.join("moved-state-tree");
    fs::rename(&fixture.state_tree, &moved).unwrap();
    assert_eq!(
        runtime.inputs.assert_current().unwrap_err().code,
        "local_state_authority_directory_namespace_changed"
    );
    fs::create_dir(&fixture.state_tree).unwrap();
    fs::set_permissions(&fixture.state_tree, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        runtime.inputs.assert_current().unwrap_err().code,
        "local_state_authority_directory_namespace_changed"
    );
    fs::remove_dir(&fixture.state_tree).unwrap();
    fs::rename(&moved, &fixture.state_tree).unwrap();
    runtime.inputs.assert_current().unwrap();
}
#[test]
fn capture_refuses_existing_ancestor_symlink_and_binds_the_opened_directory() {
    let fixture = Fixture::new();
    let captured = Ancestors::capture(&fixture.parent).unwrap();
    let parent = File::open(&fixture.parent).unwrap();
    captured.assert_open_directory(&parent).unwrap();
    let other = File::open(&fixture.state_tree).unwrap();
    assert_eq!(
        captured.assert_open_directory(&other).unwrap_err().code,
        "local_state_authority_directory_namespace_changed"
    );
    let moved = fixture.root.join("moved-state-tree");
    fs::rename(&fixture.state_tree, &moved).unwrap();
    symlink(&moved, &fixture.state_tree).unwrap();
    assert!(Ancestors::capture(&fixture.parent).is_err());
    assert_eq!(
        captured.assert_open_directory(&parent).unwrap_err().code,
        "local_state_authority_directory_namespace_changed"
    );
    assert!(LocalStateAuthorityRuntimeV1::open(&fixture.config).is_err());
}
