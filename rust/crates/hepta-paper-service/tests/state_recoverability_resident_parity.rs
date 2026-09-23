use hepta_paper_service::state_recoverability::resident::ResidentLeaseV1;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const NOW: i64 = 1_789_516_800_000;
fn oracle(input: Value) -> Value {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(repository.join("rust/oracle/state-recoverability-resident-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&value["profile"]).unwrap();
    value
}
struct Fixture {
    root: PathBuf,
    lease: Value,
    row: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-recoverability-resident-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let data = oracle(json!({"root":root,"mode":"create","now":"2026-09-16T00:00:00.000Z"}));
        assert_eq!(data["ok"], true, "{data}");
        Self {
            root,
            lease: data["value"]["lease"].clone(),
            row: data["value"]["row"].clone(),
        }
    }
    fn fence(&self) -> ResidentLeaseV1 {
        ResidentLeaseV1::new(
            &self.root,
            self.lease["ownerId"].as_str().unwrap(),
            self.lease["leaseToken"].as_str().unwrap(),
            self.lease["leaseGeneration"].as_i64().unwrap(),
        )
        .unwrap()
    }
    fn path(&self) -> PathBuf {
        self.root
            .join("autonomous-research/supervisor/resident-instance.sqlite")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn real_resident_lease_matches_node_and_expiry_is_exclusive() {
    let f = Fixture::new();
    let fence = f.fence();
    assert_eq!(fence.assert_current(NOW).unwrap().value(), &f.row);
    for delta in [59999, 60000, 60001] {
        let node = oracle(
            json!({"root":f.root,"mode":"inspect","lease":f.lease,"now":hepta_paper_service::sqlite_mutation_coordinator::clock::iso(NOW+delta).unwrap()}),
        );
        assert_eq!(
            fence.assert_current(NOW + delta).is_ok(),
            node["ok"] == true,
            "delta {delta}: {node}"
        );
    }
}
#[test]
fn actual_persisted_corruption_and_wrong_identity_cannot_fence() {
    for sql in [
        "UPDATE autonomous_research_supervisor_instance SET lease_generation=2",
        "UPDATE autonomous_research_supervisor_instance SET lease_token='instance:competitor'",
        "UPDATE autonomous_research_supervisor_instance SET heartbeat_interval_ms=30000",
        "UPDATE autonomous_research_supervisor_instance SET startup_reconciliation_receipt_hash='bad'",
        "UPDATE autonomous_research_supervisor_instance SET machine_intake_reconciled_at='2026-09-16T00:00:00.000Z'",
        "UPDATE autonomous_research_supervisor_instance SET fully_autonomous_prerequisite_identity_hash='unexpected'",
        "UPDATE autonomous_research_supervisor_instance SET lease_expires_at='2026-09-16T00:01:02.000Z'",
    ] {
        let f = Fixture::new();
        let node = oracle(
            json!({"root":f.root,"mode":"inspect","lease":f.lease,"now":"2026-09-16T00:00:00.000Z","sql":sql}),
        );
        assert_eq!(node["ok"], false, "{sql}: {node}");
        assert!(f.fence().assert_current(NOW).is_err(), "{sql}");
    }
}
#[test]
fn retained_resident_observation_rejects_real_replacement_permission_and_sidecar_races() {
    for mode in ["replace", "symlink", "hardlink", "permissions", "sidecar"] {
        let f = Fixture::new();
        let result = f.fence().assert_current_with_hook(NOW, || {
            let path = f.path();
            match mode {
                "replace" => {
                    fs::rename(&path, path.with_extension("old")).unwrap();
                    fs::copy(path.with_extension("old"), &path).unwrap();
                }
                "symlink" => {
                    fs::rename(&path, path.with_extension("old")).unwrap();
                    symlink(path.with_extension("old"), &path).unwrap();
                }
                "hardlink" => fs::hard_link(&path, path.with_extension("linked")).unwrap(),
                "permissions" => {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o660)).unwrap()
                }
                _ => fs::write(format!("{}-wal", path.display()), b"untrusted").unwrap(),
            }
        });
        assert!(result.is_err(), "{mode}");
    }
}
