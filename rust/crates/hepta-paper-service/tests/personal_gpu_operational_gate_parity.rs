//! Differential checks for the personal GPU receipt check/publication route.
//!
//! The execute branch remains intentionally unported: it requires a real
//! single-device NVIDIA host, a pinned Docker image, PDE/DL workers and
//! independent CPU/holdout evidence.  These tests cover only the incumbent
//! `--check` verifier, fail-closed fallback and explicit --write publication.

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
    let receipt = root.join("missing-𐀀-收据.json");
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

#[test]
fn check_with_write_flag_is_read_only_and_accepts_inline_values() {
    let root = fixture_root();
    let receipt = root.join("ready.json");
    write_fixture(&receipt, "ready");
    let before_bytes = fs::read(&receipt).expect("read receipt before check");
    let before_metadata = fs::metadata(&receipt).expect("receipt metadata before check");
    let receipt_arg = format!("--receipt={}", receipt.display());
    let root_arg = format!("--root={}", root.display());
    let runtime_arg = format!("--runtime-root={}", root.display());
    let (rust_status, rust_output) = run_rust(&[
        "personal-gpu-operational-gate",
        "--check",
        "--write",
        &root_arg,
        &runtime_arg,
        &receipt_arg,
    ]);
    let (node_status, node_output) = run_node(&[
        "paper-core/bin/personal-gpu-operational-gate.mjs",
        "--check",
        "--write",
        &root_arg,
        &runtime_arg,
        &receipt_arg,
    ]);
    assert_eq!(rust_status, 0);
    assert_eq!(node_status, 0);
    assert_eq!(
        serde_json::from_str::<Value>(&rust_output).expect("Rust inline receipt JSON"),
        serde_json::from_str::<Value>(&node_output).expect("Node inline receipt JSON"),
    );
    assert_eq!(
        fs::read(&receipt).expect("read receipt after check"),
        before_bytes
    );
    let after_metadata = fs::metadata(&receipt).expect("receipt metadata after check");
    assert_eq!(before_metadata.len(), after_metadata.len());
    assert_eq!(
        before_metadata.modified().expect("mtime before"),
        after_metadata.modified().expect("mtime after")
    );
}

#[test]
fn invalid_cli_arguments_match_node_exit_stdout_and_stderr() {
    let mut cases: Vec<Vec<String>> = vec![
        vec!["--".into()],
        vec!["unexpected".into()],
        vec!["-h".into()],
        vec!["--=value".into()],
        vec!["--unknown=value".into()],
        vec!["--help".into(), "--unknown".into()],
        vec!["--check".into(), "--receipt".into(), "--help".into()],
    ];
    for flag in ["check", "help", "write"] {
        cases.push(vec![format!("--{flag}"), format!("--{flag}")]);
        cases.push(vec![format!("--{flag}=false")]);
        cases.push(vec![format!("--{flag}=")]);
    }
    for flag in [
        "root",
        "runtime-root",
        "receipt",
        "output-root",
        "run-id",
        "deadline-ms",
    ] {
        cases.push(vec![format!("--{flag}")]);
        cases.push(vec![format!("--{flag}=")]);
        cases.push(vec![format!("--{flag}"), String::new()]);
        cases.push(vec![
            format!("--{flag}=first"),
            format!("--{flag}"),
            "second".into(),
        ]);
        cases.push(vec![format!("--{flag}=first"), format!("--{flag}")]);
        cases.push(vec![format!("--{flag}=first"), format!("--{flag}=")]);
    }
    for args in cases {
        let rust = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .arg("personal-gpu-operational-gate")
            .args(&args)
            .output()
            .expect("Rust parser");
        let node = Command::new("node")
            .current_dir(repository_root())
            .arg("paper-core/bin/personal-gpu-operational-gate.mjs")
            .args(&args)
            .output()
            .expect("Node parser");
        assert_eq!(node.status.code(), Some(2), "Node arguments: {args:?}");
        assert_eq!(rust.status.code(), node.status.code(), "exit: {args:?}");
        assert_eq!(rust.stdout, node.stdout, "stdout: {args:?}");
        assert_eq!(rust.stderr, node.stderr, "stderr: {args:?}");
    }
}

#[test]
fn check_write_failure_publishes_private_fallback_like_node() {
    use hepta_paper_service::personal_self_hosted_gpu::verify_personal_gpu_operational_receipt_raw_v1;
    let root = fixture_root();
    let rust_path = root.join("rust/nested/receipt.json");
    let node_path = root.join("node/nested/receipt.json");
    for existing in [false, true] {
        if existing {
            for path in [&rust_path, &node_path] {
                fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
                fs::write(path, b"{}").unwrap();
            }
        }
        let rust = run_rust(&[
            "personal-gpu-operational-gate",
            "--check",
            "--write",
            "--root",
            root.to_str().unwrap(),
            "--receipt",
            rust_path.to_str().unwrap(),
        ]);
        let node = run_node(&[
            "paper-core/bin/personal-gpu-operational-gate.mjs",
            "--check",
            "--write",
            "--root",
            root.to_str().unwrap(),
            "--receipt",
            node_path.to_str().unwrap(),
        ]);
        assert_eq!((rust.0, node.0), (2, 2));
        let rust_value: Value = serde_json::from_str(&rust.1).unwrap();
        let node_value: Value = serde_json::from_str(&node.1).unwrap();
        assert_eq!(rust_value["blockers"], node_value["blockers"]);
        for (path, output) in [(&rust_path, &rust.1), (&node_path, &node.1)] {
            assert_eq!(fs::read(path).unwrap(), output.as_bytes());
            assert!(verify_personal_gpu_operational_receipt_raw_v1(
                output.as_bytes()
            ));
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o400
            );
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        }
        // The just-published blocked receipt is valid: a repeated check/write
        // returns it verbatim, leaving its bytes and modification time intact.
        let before = fs::metadata(&rust_path).unwrap().modified().unwrap();
        let checked = run_rust(&[
            "personal-gpu-operational-gate",
            "--check",
            "--write",
            "--receipt",
            rust_path.to_str().unwrap(),
        ]);
        assert_eq!(checked, rust);
        assert_eq!(
            fs::metadata(&rust_path).unwrap().modified().unwrap(),
            before
        );
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn fallback_publication_refuses_nonprivate_parent_like_node() {
    let root = fixture_root();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    let path = root.join("receipt.json");
    for (code, output) in [
        run_rust(&[
            "personal-gpu-operational-gate",
            "--check",
            "--write",
            "--receipt",
            path.to_str().unwrap(),
        ]),
        run_node(&[
            "paper-core/bin/personal-gpu-operational-gate.mjs",
            "--check",
            "--write",
            "--receipt",
            path.to_str().unwrap(),
        ]),
    ] {
        assert_eq!(code, 2);
        assert!(!path.exists());
        assert!(verify_personal_gpu_operational_receipt(
            &serde_json::from_str(&output).unwrap()
        ));
    }
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    fs::remove_dir_all(root).unwrap();
}

fn mutate_fixture(receipt: &Path, mode: &str) {
    let mut child = Command::new("node")
        .current_dir(repository_root())
        .args(["--input-type=module", "-", receipt.to_str().unwrap(), mode])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node mutation fixture");
    child.stdin.take().unwrap().write_all(br#"
import fs from 'node:fs';
import { buildPersonalGpuOperationalReceipt as build } from './paper-domain/research/personal-gpu-operational-gate-contract.mjs';
import { hashRecord } from './workflow-kernel/record-hash.mjs';
const [path, mode] = process.argv.slice(2);
let value = JSON.parse(fs.readFileSync(path, 'utf8'));
const reverse = (v) => Object.fromEntries(Object.entries(v).reverse());
if (mode === 'numeric-gpu') {
  value.gpu.computeCapability = 8.9;
  value.gpu.driverVersion = 580.12;
  value.gpu.memoryMiB = 9007199254740991;
  value = build(value);
} else if (mode === 'coerced-gpu-and-hash') {
  value.gpu.computeCapability = ['8.9'];
  value.gpu.gpuUuid = [value.gpu.gpuUuid];
  value.gpu.driverVersion = ['580.12'];
  value.runtime.imageDigest = [value.runtime.imageDigest.toUpperCase()];
  value.pde.receiptHash = value.pde.receiptHash.toUpperCase();
  value = build(value);
} else if (mode === 'unicode-blockers') {
  value = build({ ...value, blockers: ['\uE000', '\u{10000}', 'z', '\u{10000}'] });
} else if (mode === 'nested-order') {
  value = build({ ...value, gpu: reverse(value.gpu), pde: reverse(value.pde) });
} else if (mode === 'top-order') {
  value = reverse(value);
} else if (mode === 'policy-order') {
  value.localPolicy = reverse(value.localPolicy);
} else if (mode === 'release-order') {
  value.releaseBoundary = reverse(value.releaseBoundary);
} else if (mode === 'tampered-hash') {
  value.gpu.memoryMiB += 1;
} else if (mode === 'null-ir-bindings') {
  value = structuredClone(build({createdAtEpochMs: 1750000000000}));
  value.ir = { modelHash: null, datasetHash: null, checkpointHash: null,
    modelExecutableCodeEmbedded: false, checkpointExecutablePayloadAllowed: false, pickleAllowed: false };
  const {personalGpuOperationalReceiptHash, ...payload} = value;
  value.personalGpuOperationalReceiptHash = hashRecord('PersonalGpuOperationalReceipt', payload);
}
let text = JSON.stringify(value);
if (mode === 'float-spelling') text = text.replace('"memoryMiB":8188', '"memoryMiB":8188.0').replace('"version":1', '"version":1.0');
if (mode === 'duplicate-key') text = text.replace('"version":1', '"version":0,"version":1');
fs.chmodSync(path, 0o600);
fs.writeFileSync(path, text + '\n');
fs.chmodSync(path, 0o400);
"#).expect("mutation script");
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn node_receipt_coercions_unicode_and_nested_order_preserve_output_bytes() {
    for mode in [
        "numeric-gpu",
        "coerced-gpu-and-hash",
        "unicode-blockers",
        "nested-order",
        "float-spelling",
        "duplicate-key",
    ] {
        let root = fixture_root();
        let receipt = root.join("receipt.json");
        write_fixture(&receipt, "ready");
        mutate_fixture(&receipt, mode);
        let path = receipt.to_str().unwrap();
        let rust = run_rust(&[
            "personal-gpu-operational-gate",
            "--check",
            "--receipt",
            path,
        ]);
        let node = run_node(&[
            "paper-core/bin/personal-gpu-operational-gate.mjs",
            "--check",
            "--receipt",
            path,
        ]);
        assert_eq!(
            node.0,
            if mode == "unicode-blockers" { 2 } else { 0 },
            "{mode}: {}",
            node.1
        );
        assert_eq!(rust, node, "{mode}");
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn reordered_contract_objects_and_forged_receipts_fail_like_node() {
    for mode in [
        "top-order",
        "policy-order",
        "release-order",
        "tampered-hash",
        "null-ir-bindings",
    ] {
        let root = fixture_root();
        let receipt = root.join("receipt.json");
        write_fixture(&receipt, "ready");
        mutate_fixture(&receipt, mode);
        let ((rust_status, rust), (node_status, node)) = run_checks(&receipt);
        assert_eq!((rust_status, node_status), (2, 2), "{mode}");
        assert_eq!(rust["blockers"], node["blockers"], "{mode}");
        assert!(
            rust["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == "personal_gpu_gate_failed:personal_gpu_existing_receipt_invalid"),
            "{mode}"
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn scoped_reader_allows_ancestor_symlink_but_rejects_hardlinked_receipt() {
    let root = fixture_root();
    let real = root.join("real");
    let scope = real.join("scope");
    fs::create_dir_all(&scope).unwrap();
    let receipt = scope.join("receipt.json");
    write_fixture(&receipt, "ready");
    symlink(&real, root.join("ancestor")).unwrap();
    let ((rust_status, rust), (node_status, node)) =
        run_checks(&root.join("ancestor/scope/receipt.json"));
    assert_eq!((rust_status, node_status), (0, 0));
    assert_eq!(rust, node);
    fs::hard_link(&receipt, root.join("linked.json")).unwrap();
    let ((rust_status, rust), (node_status, node)) = run_checks(&receipt);
    assert_eq!((rust_status, node_status), (2, 2));
    assert_eq!(rust["blockers"], node["blockers"]);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn fallback_commit_requires_complete_code_provenance_like_node() {
    let root = fixture_root();
    let workspace = root.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .current_dir(&workspace)
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    git(&["init", "--quiet"]);
    fs::write(workspace.join("package.json"), "{}").unwrap();
    git(&["add", "package.json"]);
    git(&["commit", "--quiet", "-m", "fixture"]);
    let receipt = root.join("receipt.json");
    for valid in [false, true] {
        if valid {
            fs::write(workspace.join("package.json"), r#"{"version":"1.0.0"}"#).unwrap();
        }
        let rust = run_rust(&[
            "personal-gpu-operational-gate",
            "--check",
            "--root",
            workspace.to_str().unwrap(),
            "--receipt",
            receipt.to_str().unwrap(),
        ]);
        let node = run_node(&[
            "paper-core/bin/personal-gpu-operational-gate.mjs",
            "--check",
            "--root",
            workspace.to_str().unwrap(),
            "--receipt",
            receipt.to_str().unwrap(),
        ]);
        assert_eq!((rust.0, node.0), (2, 2));
        let rust: Value = serde_json::from_str(&rust.1).unwrap();
        let node: Value = serde_json::from_str(&node.1).unwrap();
        assert_eq!(rust["workspaceCommit"], node["workspaceCommit"]);
        assert_eq!(rust["blockers"], node["blockers"]);
        assert_eq!(
            rust["workspaceCommit"],
            if valid {
                Value::String(git(&["rev-parse", "HEAD"]))
            } else {
                Value::Null
            }
        );
    }
    fs::remove_dir_all(root).unwrap();
}
