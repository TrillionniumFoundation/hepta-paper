use hepta_paper_service::critical_module_coverage::{
    CriticalModuleCoverageOptions, inspect_critical_module_coverage_v1,
    parse_critical_module_coverage_arguments,
};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[test]
fn parser_rejects_unpaired_evidence_and_relative_roots() {
    assert!(
        parse_critical_module_coverage_arguments(&[
            "--evidence".into(),
            "/tmp/evidence.json".into(),
        ])
        .is_err()
    );
    assert!(
        parse_critical_module_coverage_arguments(&["--root".into(), "relative".into(),]).is_err()
    );
}

#[test]
fn missing_node_evidence_is_explicitly_blocked() {
    let report = inspect_critical_module_coverage_v1(
        &CriticalModuleCoverageOptions::default(),
        Path::new("/tmp/workspace"),
    )
    .unwrap();
    assert_eq!(report["ok"], false);
    assert!(
        report["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "critical_module_coverage_node_evidence_required")
    );
}

#[test]
fn runtime_root_default_matches_node_coverage_entrypoint() {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let workspace = workspace.canonicalize().expect("workspace");
    let node = Command::new("node")
        .args([
            "--input-type=module",
            "-e",
            "import { defaultPaperRuntimeRoot } from './paper-adapters/runtime/workspace-layout.mjs'; process.stdout.write(defaultPaperRuntimeRoot());",
        ])
        .current_dir(&workspace)
        .output()
        .expect("Node runtime-root oracle");
    assert!(
        node.status.success(),
        "{}",
        String::from_utf8_lossy(&node.stderr)
    );
    let expected = String::from_utf8(node.stdout).expect("Node path UTF-8");
    let report =
        inspect_critical_module_coverage_v1(&CriticalModuleCoverageOptions::default(), &workspace)
            .expect("Rust report");
    assert_eq!(report["runtimeRoot"], expected);
}
