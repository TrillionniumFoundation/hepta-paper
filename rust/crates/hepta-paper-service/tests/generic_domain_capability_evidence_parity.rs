//! Differential coverage for the bounded generic-domain evidence-file adapter.
//!
//! The fixture exercises only the canonical explicit runtime file.  It does not
//! invoke the incumbent convergence workflow, external replay, Mathlib,
//! reviewers, signers or publication writer.

use hepta_paper_service::generic_domain_capability_evidence::{
    converge_generic_domain_capability_evidence_v1, inspect_generic_domain_capability_evidence_v1,
};
use serde_json::Value;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use nix::{sys::stat::Mode, unistd::mkfifo};

static NEXT: AtomicU64 = AtomicU64::new(1);

const KEYS: [&str; 14] = [
    "dynamicFormalExecutionAuthority",
    "experimentHarnessExecutionReceipt",
    "experimentIrExecutionAuthorityReceipt",
    "experimentReplayReceipt",
    "externalResearchReplayReceipt",
    "externalResearchReplayRequest",
    "formalDomainCoverageReceipt",
    "formalDomainQualificationExternalEvidence",
    "independentFormalReviewReceipt",
    "priorArtClaimAlignmentReceipt",
    "priorArtEvidenceReceipt",
    "researchAgendaIr",
    "venueProfile",
    "venueRequirementIr",
];

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn fixture() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "hepta-generic-domain-evidence-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let evidence = root.join("generic-domain-capability-evidence.json");
    (root, evidence)
}

fn write_fixture(path: &Path) {
    let mut value = serde_json::Map::new();
    for key in KEYS {
        let item = if key == "venueProfile" {
            serde_json::json!({
                "numeric": 1.5,
                "nested": ["fixture", true, null],
                "unicode": "数学"
            })
        } else {
            Value::Object(serde_json::Map::new())
        };
        value.insert(key.to_owned(), item);
    }
    fs::write(path, serde_json::to_vec(&Value::Object(value)).unwrap()).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn node_inspection(runtime_root: &Path) -> Value {
    let output = Command::new("node")
        .current_dir(root())
        .args([
            "--input-type=module",
            "--eval",
            "import { inspectGenericDomainCapabilityEvidence } from './paper-adapters/automation/generic-domain-capability-evidence-repository.mjs'; process.stdout.write(JSON.stringify(inspectGenericDomainCapabilityEvidence({ runtimeRoot: process.argv[1], environment: {} })));",
            runtime_root.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Node inspection failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn missing_and_loaded_inspections_match_node_shape_and_hash() {
    let (runtime_root, evidence) = fixture();
    let missing = inspect_generic_domain_capability_evidence_v1(&runtime_root).unwrap();
    assert_eq!(missing, node_inspection(&runtime_root));
    write_fixture(&evidence);
    let loaded = inspect_generic_domain_capability_evidence_v1(&runtime_root).unwrap();
    let node = node_inspection(&runtime_root);
    assert_eq!(loaded, node);
    assert_eq!(loaded["ready"], true);
    assert!(
        loaded["evidenceHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    fs::remove_dir_all(runtime_root).unwrap();
}

#[test]
fn symlink_and_shape_drift_fail_closed_without_following_or_writing() {
    let (runtime_root, evidence) = fixture();
    let target = runtime_root.join("target.json");
    write_fixture(&target);
    symlink(&target, &evidence).unwrap();
    let report = inspect_generic_domain_capability_evidence_v1(&runtime_root).unwrap();
    assert_eq!(report["ready"], false);
    assert_eq!(
        report["blockers"],
        serde_json::json!(["generic_domain_capability_evidence_not_private_regular_file"])
    );
    fs::remove_file(&evidence).unwrap();
    fs::write(&evidence, br#"{"only":"one"}"#).unwrap();
    fs::set_permissions(&evidence, fs::Permissions::from_mode(0o600)).unwrap();
    let shape = inspect_generic_domain_capability_evidence_v1(&runtime_root).unwrap();
    assert_eq!(shape["ready"], false);
    assert_eq!(
        shape["blockers"],
        serde_json::json!(["generic_domain_capability_evidence_shape_invalid"])
    );
    fs::remove_dir_all(runtime_root).unwrap();
}

#[test]
fn fifo_hard_link_permissions_and_size_limits_fail_closed_without_blocking() {
    let (runtime_root, evidence) = fixture();
    mkfifo(&evidence, Mode::from_bits_truncate(0o600)).unwrap();
    let started = Instant::now();
    let fifo = inspect_generic_domain_capability_evidence_v1(&runtime_root).unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(
        fifo["blockers"],
        serde_json::json!(["generic_domain_capability_evidence_not_private_regular_file"])
    );

    fs::remove_file(&evidence).unwrap();
    let target = runtime_root.join("hard-link-target.json");
    write_fixture(&target);
    fs::hard_link(&target, &evidence).unwrap();
    let linked = inspect_generic_domain_capability_evidence_v1(&runtime_root).unwrap();
    assert_eq!(
        linked["blockers"],
        serde_json::json!(["generic_domain_capability_evidence_not_private_regular_file"])
    );

    fs::remove_file(&evidence).unwrap();
    fs::write(&evidence, b"{}").unwrap();
    fs::set_permissions(&evidence, fs::Permissions::from_mode(0o640)).unwrap();
    let broad = inspect_generic_domain_capability_evidence_v1(&runtime_root).unwrap();
    assert_eq!(
        broad["blockers"],
        serde_json::json!(["generic_domain_capability_evidence_not_private_regular_file"])
    );

    fs::set_permissions(&evidence, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&evidence, []).unwrap();
    let empty = inspect_generic_domain_capability_evidence_v1(&runtime_root).unwrap();
    assert_eq!(
        empty["blockers"],
        serde_json::json!(["generic_domain_capability_evidence_size_invalid"])
    );

    let file = fs::OpenOptions::new().write(true).open(&evidence).unwrap();
    file.set_len(16 * 1024 * 1024 + 1).unwrap();
    drop(file);
    let oversized = inspect_generic_domain_capability_evidence_v1(&runtime_root).unwrap();
    assert_eq!(
        oversized["blockers"],
        serde_json::json!(["generic_domain_capability_evidence_size_invalid"])
    );
    fs::remove_dir_all(runtime_root).unwrap();
}

#[test]
fn converge_is_always_fail_closed_and_never_changes_the_explicit_file() {
    let (runtime_root, evidence) = fixture();
    write_fixture(&evidence);
    let before = fs::read(&evidence).unwrap();
    let report = converge_generic_domain_capability_evidence_v1(&runtime_root).unwrap();
    assert_eq!(report["ready"], false);
    assert_eq!(report["convergenceImplemented"], false);
    assert_eq!(report["externalActionPerformed"], false);
    assert_eq!(report["serviceStateChanged"], false);
    assert_eq!(report["published"], false);
    assert!(
        report["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| { value == "rust_generic_domain_capability_convergence_not_ported" })
    );
    assert_eq!(before, fs::read(&evidence).unwrap());
    fs::remove_dir_all(runtime_root).unwrap();
}

#[test]
fn cli_status_and_converge_are_explicit_and_fail_closed() {
    let (runtime_root, evidence) = fixture();
    write_fixture(&evidence);
    let binary = env!("CARGO_BIN_EXE_hepta-paper-rust");
    let status = Command::new(binary)
        .args([
            "generic-domain-capability-evidence",
            "--action",
            "status",
            "--runtime-root",
            runtime_root.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(status.status.success());
    let status_json: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(
        status_json["kind"],
        "GenericDomainCapabilityEvidenceInspection"
    );
    let converge = Command::new(binary)
        .args([
            "generic-domain-capability-evidence",
            "--action",
            "converge",
            "--runtime-root",
            runtime_root.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(converge.status.code(), Some(2));
    let converge_json: Value = serde_json::from_slice(&converge.stdout).unwrap();
    assert_eq!(converge_json["ready"], false);
    assert_eq!(converge_json["externalActionPerformed"], false);
    fs::remove_dir_all(runtime_root).unwrap();
}
