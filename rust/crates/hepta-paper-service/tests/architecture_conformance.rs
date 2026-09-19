use hepta_paper_service::architecture_conformance::{
    ArchitectureConformanceModeV1, inspect_architecture_conformance_v1,
};
use serde_json::Value;
use std::{path::PathBuf, process::Command};

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

#[test]
fn native_checker_accepts_current_declared_architecture_boundary() {
    let report = inspect_architecture_conformance_v1(
        &repository_root(),
        ArchitectureConformanceModeV1::Strict,
    )
    .unwrap();
    assert_eq!(report["kind"], "NativeArchitectureConformanceReport");
    assert_eq!(report["ready"], true, "{}", report);
    assert_eq!(report["status"], "architecture_conformance_ready");
    assert_eq!(report["nativeChecker"]["executesNode"], false);
    for category in [
        "production",
        "compatibility",
        "experimental",
        "verification",
        "maintenance",
        "migrationSupport",
    ] {
        assert!(
            report["graphs"][category]["moduleCount"].as_u64().unwrap() > 0,
            "{category}"
        );
        assert!(
            !report["graphs"][category]["entrypoints"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    assert!(
        !report["researchGraph"]["modules"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        !report["dispatcherGraph"]["modules"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn native_checker_has_explicit_diagnostic_contract() {
    let report = inspect_architecture_conformance_v1(
        &repository_root(),
        ArchitectureConformanceModeV1::Strict,
    )
    .unwrap();
    let blockers = report["blockers"].as_array().unwrap();
    assert!(
        blockers.is_empty(),
        "unexpected current source blockers: {blockers:?}"
    );
    let graph = &report["graphs"]["production"];
    assert!(graph["unresolvedImports"].as_array().unwrap().is_empty());
    assert!(graph["escapedPaths"].as_array().unwrap().is_empty());
    let _: Value = report;
}

#[test]
fn native_checker_cli_covers_json_and_rejects_unknown_arguments() {
    let root = repository_root();
    let binary = env!("CARGO_BIN_EXE_hepta-paper-rust");
    let output = Command::new(binary)
        .args([
            "verify-architecture",
            root.to_str().unwrap(),
            "--json",
            "--strict",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ready"], true);
    assert_eq!(report["nativeChecker"]["executesNode"], false);

    let output = Command::new(binary)
        .args(["verify-architecture", root.to_str().unwrap(), "--unknown"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("verify-architecture accepts only"));
}
