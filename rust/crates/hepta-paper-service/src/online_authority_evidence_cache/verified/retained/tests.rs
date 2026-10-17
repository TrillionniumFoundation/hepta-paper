use super::*;
use crate::{
    online_runtime_activation::active_refresh::refresh_online_authority_evidence_v1,
    online_writer_static::verify_online_writer_static_coverage_v1,
    sqlite_mutation_coordinator::clock::SystemMutationClockV1,
    state_database_inventory::observe_state_database_inventory_v1,
};
use rusqlite::{Connection, ErrorCode};
use std::{
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-online-initial-composition-retained-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn fixture(root: &Path) -> Value {
    let mut child = Command::new("node")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../oracle/online-initial-composition-v1.mjs"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(json!({"mode":"fixture","root":root}).to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&response["profile"]).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    response["value"].clone()
}
fn probe(path: &Path) {
    let output = Command::new("/proc/self/exe")
        .args(["--exact", "online_authority_evidence_cache::verified::retained::tests::separate_process_cache_lock_probe", "--nocapture"])
        .env("HEPTA_RETAINED_CACHE_LOCK_PATH", path).output().unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("retained cache separate-process busy")
    );
}
#[test]
fn separate_process_cache_lock_probe() {
    let Some(path) = std::env::var_os("HEPTA_RETAINED_CACHE_LOCK_PATH") else {
        return;
    };
    let database = Connection::open(path).unwrap();
    database.busy_timeout(Duration::ZERO).unwrap();
    assert_eq!(
        database
            .execute_batch("BEGIN IMMEDIATE")
            .unwrap_err()
            .sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy)
    );
    println!("retained cache separate-process busy");
}

#[test]
fn actual_signed_source_and_cache_retention_recheck_transaction_without_rpc_or_lost_lock() {
    let root = Root::new();
    let value = fixture(&root.0);
    let runtime = PathBuf::from(value["runtime"].as_str().unwrap());
    let workspace = PathBuf::from(value["workspace"].as_str().unwrap());
    let inventory = observe_state_database_inventory_v1(&runtime, &value["manifest"]).unwrap();
    let other_inventory =
        observe_state_database_inventory_v1(&runtime, &value["manifest"]).unwrap();
    assert_eq!(inventory.value(), other_inventory.value());
    let source =
        verify_online_writer_static_coverage_v1(&workspace, &value["writerManifest"]).unwrap();
    let other_source =
        verify_online_writer_static_coverage_v1(&workspace, &value["writerManifest"]).unwrap();
    assert_eq!(source.value(), other_source.value());
    let mut authority = PinnedMutationAuthorityV1::load_process(
        Path::new(value["onlineProcess"].as_str().unwrap()),
        value["onlineProcessHash"].as_str().unwrap(),
    )
    .unwrap();
    let mut clock = SystemMutationClockV1;
    let active = refresh_online_authority_evidence_v1(
        inventory.value(),
        &value["writerManifest"],
        &mut authority,
        &source,
        &mut clock,
        3,
    )
    .unwrap();
    let cache = record_verified_authority_evidence_cache_v1(
        &runtime, &authority, &active, &inventory, &source, &mut clock,
    )
    .unwrap();
    let other_cache = record_verified_authority_evidence_cache_v1(
        &runtime, &authority, &active, &inventory, &source, &mut clock,
    )
    .unwrap();
    assert_eq!(cache.value(), other_cache.value());
    let retained_source = source
        .retain_for_native_store_transaction_v1(&inventory, &authority, &active, &mut clock)
        .unwrap();
    let retained_cache = cache
        .retain_for_native_store_transaction_v1(
            &authority, &active, &inventory, &source, &mut clock,
        )
        .unwrap();
    retained_cache.assert_bound_to(&cache).unwrap();
    assert!(retained_cache.assert_bound_to(&other_cache).is_err());
    let guard = inventory.native_store_transaction_guard_v1().unwrap();
    let other_guard = other_inventory.native_store_transaction_guard_v1().unwrap();
    let before_rpc = fs::read(root.0.join("calls.jsonl")).unwrap();
    let path = runtime.join(guard.instance()["sourceRelativePath"].as_str().unwrap());
    let database = Connection::open(&path).unwrap();
    database
        .execute_batch(
            "BEGIN IMMEDIATE; UPDATE fixture_anchor SET value='uncommitted-retained-input-check'",
        )
        .unwrap();
    retained_cache
        .assert_current(&authority, &retained_source, &guard, &mut clock)
        .unwrap();
    probe(&path);
    assert!(
        retained_source
            .assert_current(&other_source, &inventory, &authority, &active, &guard)
            .is_err()
    );
    assert!(
        retained_source
            .assert_current(&source, &inventory, &authority, &active, &other_guard)
            .is_err()
    );
    probe(&path);
    // Every expensive held-file/signature check must fit the terminal sample.
    let before = clock.now_millis().unwrap();
    let expiry = timestamp(&cache.value()["expiresAt"]).unwrap();
    let mut samples = [before, expiry].into_iter();
    assert!(
        retained_cache
            .assert_current(&authority, &retained_source, &guard, &mut || Ok(samples
                .next()
                .unwrap()))
            .is_err()
    );
    probe(&path);
    assert_eq!(fs::read(root.0.join("calls.jsonl")).unwrap(), before_rpc);
    // Direct retained-file rejection also proves lock safety even if a path
    // swap races an earlier inventory check in the future owning scope.
    let cache_path = runtime.join(CACHE_RELATIVE_PATH);
    fs::remove_file(&cache_path).unwrap();
    fs::hard_link(&path, &cache_path).unwrap();
    assert!(
        retained_cache
            .file
            .assert_retained_bytes(&retained_cache.directory, "current.json")
            .is_err()
    );
    probe(&path);
    assert!(
        retained_cache
            .assert_current(&authority, &retained_source, &guard, &mut clock)
            .is_err()
    );
    probe(&path);
    database.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        database
            .query_row(
                "SELECT value FROM fixture_anchor WHERE id='fixture'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "ready"
    );
    database.close().unwrap();
    drop(retained_cache);
    drop(retained_source);
}

#[test]
fn retained_cache_file_rejects_missing_replaced_changed_or_symlinked_name() {
    for kind in ["missing", "replacement", "bytes", "symlink"] {
        let root = Root::new();
        let directory = files::Directory::open(&root.0, true).unwrap();
        let path = root.0.join(CACHE_RELATIVE_PATH);
        fs::write(&path, b"{\"local-file-test\":true}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        let file = directory
            .read("current.json", MAXIMUM_BYTES, 0o400, 1)
            .unwrap()
            .unwrap();
        file.assert_retained_bytes(&directory, "current.json")
            .unwrap();
        match kind {
            "missing" => fs::remove_file(&path).unwrap(),
            "replacement" => {
                fs::remove_file(&path).unwrap();
                fs::write(&path, &file.bytes).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
            }
            "bytes" => {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
                fs::write(&path, b"{\"local-file-test\":null}").unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
            }
            "symlink" => {
                fs::remove_file(&path).unwrap();
                symlink("/dev/null", &path).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            file.assert_retained_bytes(&directory, "current.json")
                .is_err(),
            "{kind}"
        );
    }
}

#[test]
fn retained_cache_parent_permissions_and_namespace_are_exact() {
    for kind in ["mode", "replacement", "symlink"] {
        let root = Root::new();
        let directory = files::Directory::open(&root.0, true).unwrap();
        let parents = directory.retain_parent_identities().unwrap();
        let parent = root.0.join("automation-cache");
        match kind {
            "mode" => fs::set_permissions(&parent, fs::Permissions::from_mode(0o750)).unwrap(),
            "replacement" => {
                fs::rename(&parent, root.0.join("retained-parent")).unwrap();
                fs::create_dir(&parent).unwrap();
            }
            "symlink" => {
                fs::rename(&parent, root.0.join("retained-parent")).unwrap();
                symlink(root.0.join("retained-parent"), &parent).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(parents.assert_current(&directory).is_err(), "{kind}");
    }
}
