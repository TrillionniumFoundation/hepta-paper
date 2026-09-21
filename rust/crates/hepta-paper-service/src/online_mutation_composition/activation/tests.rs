use super::*;
use std::{
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-online-initial-composition-{}-{}",
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
fn request(root: &Path) -> InitialOnlineMutationCompositionRequestV1 {
    for name in ["workspace", "runtime", "backup"] {
        fs::create_dir(root.join(name)).unwrap();
    }
    InitialOnlineMutationCompositionRequestV1 {
        workspace_root: root.join("workspace"),
        runtime_root: root.join("runtime"),
        backup_root: root.join("backup"),
        online_process_configuration_path: root.join("online.json"),
        online_process_configuration_file_hash: "sha256:".to_owned() + &"0".repeat(64),
        backup_process_configuration_path: root.join("backup.json"),
        backup_process_configuration_file_hash: "sha256:".to_owned() + &"0".repeat(64),
        resident_owner_id: "resident:test".into(),
        resident_lease_token: "token:test".into(),
        resident_lease_generation: 1,
    }
}
#[test]
fn unsafe_roots_fail_before_any_authority_or_runtime_write() {
    let root = Root::new();
    let mut request = request(&root.0);
    request.backup_root = request.runtime_root.clone();
    assert_eq!(
        prepare_initial_online_mutation_composition_v1(&request)
            .err()
            .unwrap()
            .code,
        fail("roots_overlap").code
    );
    request.backup_root = root.0.join("link");
    symlink(root.0.join("backup"), &request.backup_root).unwrap();
    assert_eq!(
        prepare_initial_online_mutation_composition_v1(&request)
            .err()
            .unwrap()
            .code,
        fail("canonical_roots_required").code
    );
    assert!(
        fs::read_dir(&request.runtime_root)
            .unwrap()
            .next()
            .is_none()
    );
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
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let response: Value = serde_json::from_slice(&out.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&response["profile"]).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    response["value"].clone()
}
#[test]
fn actual_signed_initial_composition_retains_producers_and_refuses_native_authorization() {
    let root = Root::new();
    let value = fixture(&root.0);
    let path = |name: &str| PathBuf::from(value[name].as_str().unwrap());
    let request = InitialOnlineMutationCompositionRequestV1 {
        workspace_root: path("workspace"),
        runtime_root: path("runtime"),
        backup_root: path("backupRoot"),
        online_process_configuration_path: path("onlineProcess"),
        online_process_configuration_file_hash: value["onlineProcessHash"].as_str().unwrap().into(),
        backup_process_configuration_path: path("backupConfiguration"),
        backup_process_configuration_file_hash: value["backupConfigurationHash"]
            .as_str()
            .unwrap()
            .into(),
        resident_owner_id: value["lease"]["ownerId"].as_str().unwrap().into(),
        resident_lease_token: value["lease"]["leaseToken"].as_str().unwrap().into(),
        resident_lease_generation: value["lease"]["generation"].as_i64().unwrap(),
    };
    let prepared = prepare_initial_online_mutation_composition_v1(&request)
        .unwrap_or_else(|e| panic!("{} {}", e.code, e.details));
    assert_eq!(prepared.value()["runtimeReady"], false);
    assert_eq!(prepared.value()["productionActivation"], false);
    assert_eq!(prepared.value()["nodeRetirementVerified"], false);
    assert!(
        prepared.value()["remainingBlockers"]
            .as_array()
            .unwrap()
            .contains(&json!(NATIVE_BINDING_REQUIRED))
    );
    assert_eq!(prepared.startup.database_reconciliations().len(), 10);
    assert_eq!(prepared.finalized.database_inspections().len(), 10);
    let projected = coordinator_database_instances(prepared.startup.post_inventory()).unwrap();
    assert!(
        projected
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry.as_object().unwrap().len() == 3
                && entry["databaseInstanceId"].is_string()
                && entry["databaseRole"].is_string())
    );
    let attempts_before = fs::read(root.0.join("calls.jsonl")).unwrap();
    prepared.assert_current().unwrap();
    assert_eq!(
        fs::read(root.0.join("calls.jsonl")).unwrap(),
        attempts_before,
        "retained checks cannot invoke the broker"
    );
    let expiry =
        crate::sqlite_mutation_coordinator::timestamp(&prepared.schema.value()["expiresAt"])
            .unwrap();
    assert!(
        prepared.assert_valid_at(expiry).is_err(),
        "earliest schema evidence cannot survive later checks"
    );
    assert!(
        PackageDeletionWriterGuard::acquire(&request.runtime_root, RECONCILIATION_WRITER_SCOPE_V1)
            .is_err()
    );
    // A byte-identical replacement must fail retained inode pins.
    let config = &request.online_process_configuration_path;
    let bytes = fs::read(config).unwrap();
    let swap = config.with_extension("replacement");
    fs::write(&swap, bytes).unwrap();
    fs::set_permissions(&swap, fs::Permissions::from_mode(0o600)).unwrap();
    fs::rename(swap, config).unwrap();
    assert!(prepared.assert_current().is_err());
    drop(prepared);
    PackageDeletionWriterGuard::acquire(&request.runtime_root, RECONCILIATION_WRITER_SCOPE_V1)
        .unwrap();
}
