use serde_json::Value;
use std::{fs, path::PathBuf, process::Command};

fn temp_root() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "hepta-empirical-plugin-release-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn help_is_structured_and_declares_no_external_action() {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["autonomous-empirical-plugin-release", "--help"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["kind"], "AutonomousEmpiricalPluginReleaseUsage");
    assert_eq!(report["externalAction"], false);
}

#[test]
fn publish_preflight_never_loads_key_or_writes_install_root() {
    let root = temp_root();
    let signer = root.join("signing-config.json");
    fs::write(
        &signer,
        br#"{"version":1,"kind":"AutonomousEmpiricalPluginSigningAuthorityConfiguration"}"#,
    )
    .unwrap();
    let install = root.join("install");
    fs::create_dir(&install).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-empirical-plugin-release",
            "--action",
            "publish",
            "--package-version",
            "1.0.0",
            "--signing-config",
            signer.to_str().unwrap(),
            "--install-root",
            install.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ready"], false);
    assert_eq!(report["signatureProduced"], false);
    assert_eq!(report["installed"], false);
    assert_eq!(report["privateKeyMaterialLoadedByHepta"], false);
    assert_eq!(report["externalActionPerformed"], false);
    assert!(fs::read_dir(&install).unwrap().next().is_none());
    let _ = fs::remove_dir_all(root);
}
