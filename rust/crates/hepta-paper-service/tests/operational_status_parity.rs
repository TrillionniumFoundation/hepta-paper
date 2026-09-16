//! Differential proof-loader tests use synthetic, isolated authority keys. A
//! passing fixture never supplies production operational qualification.
use hepta_paper_service::operational_status::{
    capability_operational_proof_status_v1, current_operational_code_provenance_v1,
    inspect_operational_sealed_submodules_v1,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "hepta-operational-parity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }
    fn oracle(&self, prepare: bool, mutate: Option<&str>) -> Value {
        self.oracle_mode(prepare, mutate, false, false)
    }
    fn oracle_mode(
        &self,
        prepare: bool,
        mutate: Option<&str>,
        sealed: bool,
        inspect_sealed: bool,
    ) -> Value {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = Command::new("node")
            .arg(root.join("rust/oracle/operational-status-v1.mjs"))
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Node differential oracle");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                json!({"root":self.0,"prepare":prepare,"mutate":mutate,"sealed":sealed,"inspectSealed":inspect_sealed})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            response["profile"]["node"], "v22.23.1",
            "use the pinned differential runtime"
        );
        response
    }
    fn inspect(&self) -> Value {
        capability_operational_proof_status_v1(
            &self.0.join("workspace"),
            &self.0.join("runtime"),
            &self.0.join("assets"),
        )
        .expect("Rust status")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        fn writable(path: &std::path::Path) {
            if let Ok(metadata) = fs::symlink_metadata(path) {
                if metadata.is_symlink() {
                    return;
                }
                if metadata.is_dir() {
                    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
                    if let Ok(entries) = fs::read_dir(path) {
                        for entry in entries.flatten() {
                            writable(&entry.path());
                        }
                    }
                }
            }
        }
        writable(&self.0);
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn verified_operational_and_conformance_match_node() {
    let fixture = Fixture::new();
    let node = fixture.oracle(true, None);
    assert_eq!(
        current_operational_code_provenance_v1(&fixture.0.join("workspace")).unwrap(),
        node["codeProvenance"]
    );
    let rust = fixture.inspect();
    assert_eq!(rust, node["status"]);
    assert_eq!(rust["operationallyProven"], 16);
    assert_eq!(rust["conformanceVerified"], 16);
}
#[test]
fn malformed_untrusted_and_replayed_proofs_match_node_fail_closed() {
    for mutation in [
        "tamper_signature",
        "reordered_targets",
        "reordered_subject",
        "reused_subject",
        "local_assurance",
        "duplicate_key",
        "retired_key",
        "missing_trust",
        "malformed_receipt",
        "world_writable",
        "receipt_symlink",
        "receipt_hardlink",
        "trust_symlink",
        "dirty_source",
        "changed_production",
        "bad_conformance",
        "historic_conformance",
        "duplicate_receipt",
        "missing_operational",
        "readonly_root",
    ] {
        let fixture = Fixture::new();
        let node = fixture.oracle(true, Some(mutation));
        assert_eq!(fixture.inspect(), node["status"], "mutation {mutation}");
    }
}
#[test]
fn conformance_cannot_substitute_for_operational_proof() {
    let fixture = Fixture::new();
    let node = fixture.oracle(true, Some("missing_operational"));
    let rust = fixture.inspect();
    assert_eq!(rust, node["status"]);
    assert_eq!(rust["conformanceVerified"], 16);
    assert_eq!(rust["operationallyProven"], 0);
    assert_eq!(rust["status"], "capability_operational_proof_pending");
}

fn binary(fixture: &Fixture, sealed: bool) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-operational-proof-status"));
    command
        .arg("--workspace-root")
        .arg(fixture.0.join("workspace"))
        .arg("--runtime-root")
        .arg(fixture.0.join("runtime"))
        .arg("--asset-root")
        .arg(fixture.0.join("assets"));
    if sealed {
        command.env("HEPTA_RELEASE_ENV_LAUNCHER", "sealed-v1");
    } else {
        command.env_remove("HEPTA_RELEASE_ENV_LAUNCHER");
    }
    command.output().expect("operational proof status binary")
}
#[test]
fn binary_reports_full_json_and_source_failures() {
    let fixture = Fixture::new();
    let node = fixture.oracle(true, None);
    let output = binary(&fixture, false);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        node["status"]
    );
    fs::write(fixture.0.join("workspace/package.json"), "not json").unwrap();
    let output = binary(&fixture, false);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap().trim(),
        "code_provenance_package_json_invalid"
    );
}
#[test]
fn hydrated_readonly_closure_matches_node_and_runs_sealed_binary() {
    let fixture = Fixture::new();
    let node = fixture.oracle_mode(true, None, true, false);
    assert!(node.get("error").is_none(), "{node}");
    assert_eq!(
        current_operational_code_provenance_v1(&fixture.0.join("workspace")).unwrap(),
        node["codeProvenance"]
    );
    assert_eq!(fixture.inspect(), node["status"]);
    assert_eq!(node["status"]["operationallyProven"], 16);
    assert_eq!(node["status"]["conformanceVerified"], 16);
    let inspection = fixture.oracle_mode(false, None, true, true);
    assert_eq!(
        inspect_operational_sealed_submodules_v1(&fixture.0.join("workspace")).unwrap(),
        inspection["inspection"]
    );
    let output = binary(&fixture, true);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        node["status"]
    );
}
#[test]
fn sealed_closure_rejects_tampering_and_unsafe_files_like_node() {
    for mutation in [
        "sealed_bad_hash",
        "sealed_bad_commit",
        "sealed_bad_tree",
        "sealed_bad_content",
        "sealed_writable_file",
        "sealed_writable_root",
        "sealed_writable_submodule",
        "sealed_bad_keys",
        "sealed_noncanonical",
        "sealed_missing",
        "sealed_hardlink",
        "sealed_symlink",
    ] {
        let fixture = Fixture::new();
        let node = fixture.oracle_mode(true, Some(mutation), true, true);
        let rust = inspect_operational_sealed_submodules_v1(&fixture.0.join("workspace"));
        if let Some(expected) = node.get("error") {
            assert_eq!(
                rust.unwrap_err().to_string(),
                expected.as_str().unwrap(),
                "{mutation}"
            );
        } else {
            assert_eq!(rust.unwrap(), node["inspection"], "{mutation}");
        }
        if mutation == "sealed_missing" {
            let output = binary(&fixture, true);
            assert_eq!(output.status.code(), Some(1));
            assert_eq!(
                String::from_utf8(output.stderr).unwrap().trim(),
                "code_provenance_sealed_submodule_closure_required"
            );
        }
    }
}
