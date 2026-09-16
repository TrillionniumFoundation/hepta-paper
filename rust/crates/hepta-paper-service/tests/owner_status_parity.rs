use hepta_paper_service::owner_status::{
    build_owner_acceptance_families_v1, inspect_owner_acceptance_status_v1,
    owner_acceptance_status_from_values_v1,
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
            "hepta-owner-status-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }
    fn oracle(&self, mode: &str) -> Value {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = Command::new("node")
            .arg(root.join("rust/oracle/owner-status-v1.mjs"))
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(json!({"root":self.0,"mode":mode}).to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["profile"]["node"], "v22.23.1");
        response
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn signed_owner_acceptance_and_every_family_hash_match_node() {
    for mode in [
        "complete",
        "null_family",
        "null_entry",
        "unicode_metadata",
        "private_key_zero",
        "same_numeric_subject",
        "same_object_subject",
        "signature_unpadded",
        "signature_whitespace",
        "signature_urlsafe",
        "invalid_pem_unicode_whitespace",
        "version_one",
        "none",
        "local",
        "unclassified",
        "partial",
        "wrong_source",
        "wrong_manifest",
        "wrong_family",
        "wrong_decision",
        "duplicate_family",
        "revoked",
        "wrong_role",
        "tamper",
        "bad_signature",
        "duplicate_key",
        "private_key",
    ] {
        let fixture = Fixture::new();
        let node = fixture.oracle(mode);
        assert_eq!(
            build_owner_acceptance_families_v1(&node["matrix"]).unwrap(),
            node["manifest"],
            "{mode}"
        );
        let native = owner_acceptance_status_from_values_v1(
            &node["matrix"],
            &node["manifest"],
            &node["document"],
            &node["trust"],
        )
        .unwrap();
        assert_eq!(native, node["status"], "{mode}");
        if mode == "complete" {
            assert!(native["ownerAccepted"].as_u64().unwrap() > 200);
        }
    }
}
#[test]
fn changed_source_or_disposition_cannot_reuse_a_signed_manifest() {
    let fixture = Fixture::new();
    let node = fixture.oracle("complete");
    for field in ["sha256", "migrationAction"] {
        let mut matrix = node["matrix"].clone();
        let row = matrix["entries"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|r| r["verificationClass"] == "explicit_retirement")
            .unwrap();
        if field == "sha256" {
            row["source"][field] = json!("0".repeat(64));
        } else {
            row[field] = json!("changed_business_disposition");
        }
        let error = owner_acceptance_status_from_values_v1(
            &matrix,
            &node["manifest"],
            &node["document"],
            &node["trust"],
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "legacy_owner_acceptance_active_manifest_drift"
        );
    }
}
#[test]
fn actual_owner_cli_is_read_only_and_emits_current_node_equivalent_status() {
    let fixture = Fixture::new();
    let node = fixture.oracle("complete");
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let receipt = fixture
        .0
        .join("owner-acceptance/CAPABILITY_OWNER_ACCEPTANCE.json");
    let before = fs::read(&receipt).unwrap();
    assert_eq!(
        inspect_owner_acceptance_status_v1(&workspace, &fixture.0).unwrap(),
        node["status"]
    );
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-owner-acceptance-status"))
        .arg("--workspace-root")
        .arg(&workspace)
        .arg("--runtime-root")
        .arg(&fixture.0)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        node["status"]
    );
    assert_eq!(before, fs::read(&receipt).unwrap());
    for args in [
        vec!["--workspace-root", "relative"],
        vec!["--unknown"],
        vec!["--runtime-root", "/tmp", "--runtime-root", "/tmp"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_hepta-owner-acceptance-status"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn imported_owner_authority_rejects_writable_alias_and_duplicate_inputs() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    for name in ["OWNER_TRUST_STORE.json", "CAPABILITY_OWNER_ACCEPTANCE.json"] {
        for variant in [
            "group_write",
            "other_write",
            "symlink",
            "hardlink",
            "duplicate",
        ] {
            let fixture = Fixture::new();
            let node = fixture.oracle("complete");
            assert!(node["status"]["ownerAccepted"].as_u64().unwrap() > 0);
            let path = fixture.0.join("owner-acceptance").join(name);
            match variant {
                "group_write" => {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o660)).unwrap()
                }
                "other_write" => {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o606)).unwrap()
                }
                "symlink" => {
                    let backup = path.with_extension("backup");
                    fs::rename(&path, &backup).unwrap();
                    symlink(backup, &path).unwrap();
                }
                "hardlink" => fs::hard_link(&path, path.with_extension("link")).unwrap(),
                "duplicate" => {
                    let mut bytes = b"{\"version\":1,".to_vec();
                    bytes.extend_from_slice(&fs::read(&path).unwrap()[1..]);
                    fs::write(&path, bytes).unwrap();
                }
                _ => unreachable!(),
            }
            let report = inspect_owner_acceptance_status_v1(&workspace, &fixture.0).unwrap();
            assert_eq!(report["ownerAccepted"], 0, "{name}/{variant}");
            assert_eq!(
                report["independentExternalAcceptanceComplete"], false,
                "{name}/{variant}"
            );
        }
    }
}
