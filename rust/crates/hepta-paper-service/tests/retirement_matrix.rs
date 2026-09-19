use serde_json::Value;
use std::{fs, path::PathBuf, process::Command};

#[test]
fn retirement_matrix_cli_emits_bounded_blocked_report_without_writes() {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let runtime = std::env::temp_dir().join(format!(
        "hepta-retirement-matrix-cli-{}-{}",
        std::process::id(),
        std::thread::current().name().unwrap_or("test")
    ));
    fs::create_dir_all(&runtime).unwrap();
    let before = fs::read_dir(&runtime).unwrap().count();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "retirement-matrix",
            "--workspace-root",
            workspace.to_str().unwrap(),
            "--runtime-root",
            runtime.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    // A clean release matrix is intentionally impossible without the archived
    // legacy source set and external owner proofs; the CLI must still emit the
    // machine-readable report before failing closed.
    assert_eq!(output.status.code(), Some(1));
    assert!(
        output
            .stderr
            .windows(b"retirement matrix".len())
            .any(|window| { window == b"retirement matrix" })
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["kind"], "LegacyCapabilityMigrationMatrixReadOnly");
    assert_eq!(report["readOnly"], true);
    assert_eq!(report["authorityGranted"], false);
    assert_eq!(report["nodeRetirement"], false);
    assert_eq!(report["summary"]["entryCount"], 249);
    assert_eq!(report["summary"]["implementationVerified"], 0);
    assert!(
        report["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|blocker| blocker
                == "independent_owner_acceptance_and_retirement_authority_required")
    );
    assert_eq!(fs::read_dir(&runtime).unwrap().count(), before);
    let _ = fs::remove_dir_all(&runtime);
}
