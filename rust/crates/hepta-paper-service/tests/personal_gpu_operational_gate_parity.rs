//! Differential checks for the read-only personal GPU gate route.
//!
//! The execute branch remains intentionally unported: it requires a real
//! single-device NVIDIA host, a pinned Docker image, PDE/DL workers and
//! independent CPU/holdout evidence.  These tests cover only the incumbent
//! `--check` receipt verifier and its fail-closed fallback.

use hepta_paper_service::personal_self_hosted_gpu::verify_personal_gpu_operational_receipt;
use serde_json::Value;
use std::{
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn fixture_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "hepta-personal-gpu-gate-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).expect("create fixture root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("private fixture root");
    root
}

fn run_rust(args: &[&str]) -> (i32, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(args)
        .output()
        .expect("run Rust GPU gate");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8(output.stdout).expect("Rust UTF-8"),
    )
}

fn run_node(args: &[&str]) -> (i32, String) {
    let output = Command::new("node")
        .current_dir(repository_root())
        .args(args)
        .output()
        .expect("run Node GPU gate");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8(output.stdout).expect("Node UTF-8"),
    )
}

fn write_fixture(receipt: &Path, mode: &str) {
    let root = repository_root();
    let mut child = Command::new("node")
        .current_dir(&root)
        .args([
            "--input-type=module",
            "-",
            receipt.to_str().expect("receipt UTF-8"),
            mode,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn Node receipt fixture");
    child
        .stdin
        .take()
        .expect("fixture stdin")
        .write_all(
            br#"
import fs from 'node:fs';
import {
  buildPersonalGpuOperationalReceipt,
} from './paper-domain/research/personal-gpu-operational-gate-contract.mjs';
import { hashRecord } from './workflow-kernel/record-hash.mjs';
const [receiptPath, mode] = process.argv.slice(2);
const H = (label) => hashRecord('PersonalGpuOperationalGateTest', { label });
const base = {
  pde: {
    status: 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable',
    receiptHash: H('pde'), cpuOracleStatus: 'process_isolated_pde_poisson_2d_cpu_oracle_verified',
    cpuOracleHash: H('pde-cpu'), scientificChecksPassed: true,
  },
  deepLearning: {
    status: 'personal_deep_learning_gpu_verified_non_promotable',
    originalReceiptHash: H('dl-original'), replayReceiptHash: H('dl-replay'),
    sameDeviceReplayHash: H('dl-same-device'), cpuOracleHash: H('dl-cpu'),
    cpuOracleStatus: 'process_isolated_deep_learning_cpu_oracle_verified',
    hiddenEvaluationHash: H('dl-hidden'), hiddenEvaluationStatus: 'deep_learning_hidden_evaluation_recorded',
    modelIrHash: H('model'), datasetManifestHash: H('dataset'),
    checkpointManifestHash: H('checkpoint'), deterministicReplay: true, errorBudgetHash: H('budget'),
  },
};
base.ir = {
  modelHash: base.deepLearning.modelIrHash, datasetHash: base.deepLearning.datasetManifestHash,
  checkpointHash: base.deepLearning.checkpointManifestHash, modelExecutableCodeEmbedded: false,
  checkpointExecutablePayloadAllowed: false, pickleAllowed: false,
};
const value = mode === 'ready'
  ? buildPersonalGpuOperationalReceipt({
      createdAtEpochMs: 1750000000000, workspaceCommit: '0123456789abcdef0123456789abcdef01234567',
      gpu: {
        gpuUuid: 'GPU-a33875b7-7eb7-679e-df08-19227d3decee', gpuModel: 'NVIDIA GeForce RTX 4060',
        computeCapability: '8.9', driverVersion: '580.173.02', memoryMiB: 8188,
      },
      runtime: { image: 'hepta/python-gpu:0.15.0', imageDigest: H('image'),
        dockerDigestBound: true, networkDisabled: true, singleDevicePinned: true },
      ...base,
    })
  : mode === 'invalid-timestamp'
    ? buildPersonalGpuOperationalReceipt({
        createdAtEpochMs: null, workspaceCommit: '0123456789abcdef0123456789abcdef01234567',
      })
    : buildPersonalGpuOperationalReceipt({
      createdAtEpochMs: 1750000000000, workspaceCommit: '0123456789abcdef0123456789abcdef01234567',
      blockers: ['fixture_blocked'],
    });
fs.writeFileSync(receiptPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o400 });
fs.chmodSync(receiptPath, 0o400);
"#,
        )
        .expect("write fixture script");
    let output = child.wait_with_output().expect("wait for fixture script");
    assert!(
        output.status.success(),
        "Node receipt fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_checks(receipt: &Path) -> ((i32, Value), (i32, Value)) {
    let receipt = receipt.to_str().expect("receipt UTF-8");
    let (rust_status, rust_output) = run_rust(&[
        "personal-gpu-operational-gate",
        "--check",
        "--receipt",
        receipt,
    ]);
    let (node_status, node_output) = run_node(&[
        "paper-core/bin/personal-gpu-operational-gate.mjs",
        "--check",
        "--receipt",
        receipt,
    ]);
    (
        (
            rust_status,
            serde_json::from_str(&rust_output).expect("Rust receipt JSON"),
        ),
        (
            node_status,
            serde_json::from_str(&node_output).expect("Node receipt JSON"),
        ),
    )
}

#[test]
fn help_matches_node() {
    let (rust_status, rust_output) = run_rust(&["personal-gpu-operational-gate", "--help"]);
    let (node_status, node_output) =
        run_node(&["paper-core/bin/personal-gpu-operational-gate.mjs", "--help"]);
    assert_eq!(rust_status, 0);
    assert_eq!(node_status, 0);
    assert_eq!(rust_output, node_output);
}

#[test]
fn blocked_receipt_check_matches_node_exactly() {
    let root = fixture_root();
    let receipt = root.join("blocked.json");
    write_fixture(&receipt, "blocked");
    let ((rust_status, rust), (node_status, node)) = run_checks(&receipt);
    assert_eq!(rust_status, 2);
    assert_eq!(node_status, 2);
    assert_eq!(rust, node);
}

#[test]
fn ready_receipt_check_matches_node_exactly() {
    let root = fixture_root();
    let receipt = root.join("ready.json");
    write_fixture(&receipt, "ready");
    let ((rust_status, rust), (node_status, node)) = run_checks(&receipt);
    assert_eq!(rust_status, 0);
    assert_eq!(node_status, 0);
    assert_eq!(rust, node);
    assert_eq!(rust["personalProductionReady"], true);
}

#[test]
fn invalid_timestamp_blocked_receipt_matches_node_exactly() {
    let root = fixture_root();
    let receipt = root.join("invalid-timestamp.json");
    write_fixture(&receipt, "invalid-timestamp");
    let ((rust_status, rust), (node_status, node)) = run_checks(&receipt);
    assert_eq!(rust_status, 2);
    assert_eq!(node_status, 2);
    assert_eq!(rust, node);
    assert!(
        rust["blockers"]
            .as_array()
            .expect("blockers")
            .iter()
            .any(|item| item == "personal_gpu_receipt_timestamp_invalid")
    );
}

#[test]
fn missing_receipt_is_fail_closed_and_hash_valid() {
    let root = fixture_root();
    let receipt = root.join("missing.json");
    let ((rust_status, rust), (node_status, node)) = run_checks(&receipt);
    assert_eq!(rust_status, 2);
    assert_eq!(node_status, 2);
    for value in [&rust, &node] {
        assert_eq!(value["kind"], "PersonalGpuOperationalReceipt");
        assert_eq!(value["personalProductionReady"], false);
        assert!(
            value["personalGpuOperationalReceiptHash"]
                .as_str()
                .is_some()
        );
        assert!(
            value["blockers"]
                .as_array()
                .expect("blockers")
                .iter()
                .any(|item| {
                    item.as_str()
                        .is_some_and(|item| item.starts_with("personal_gpu_gate_failed:"))
                })
        );
    }
    assert!(verify_personal_gpu_operational_receipt(&rust));
    assert_eq!(rust["blockers"], node["blockers"]);
}

#[test]
fn symlink_receipt_is_rejected_by_both_scoped_readers() {
    let root = fixture_root();
    let target = root.join("target.json");
    let link = root.join("link.json");
    write_fixture(&target, "blocked");
    symlink(&target, &link).expect("create receipt symlink");
    let ((rust_status, rust), (node_status, node)) = run_checks(&link);
    assert_eq!(rust_status, 2);
    assert_eq!(node_status, 2);
    assert_eq!(rust["blockers"], node["blockers"]);
    assert_eq!(rust["personalProductionReady"], false);
}
