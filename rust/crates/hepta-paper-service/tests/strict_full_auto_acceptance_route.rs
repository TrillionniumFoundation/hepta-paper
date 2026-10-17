use serde_json::Value;
use std::{fs, path::PathBuf, process::Command};

fn temp_config() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "hepta-strict-acceptance-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::write(
        &path,
        br#"{"version":1,"kind":"StrictFullAutoAcceptanceConfiguration","opaqueSecret":"do-not-echo"}"#,
    )
    .unwrap();
    path
}

#[test]
fn help_is_structured_and_read_only() {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["strict-full-auto-acceptance", "--help"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["kind"], "StrictFullAutoAcceptanceUsage");
}

#[test]
fn require_accepted_remains_fail_closed_without_live_authority() {
    let path = temp_config();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "strict-full-auto-acceptance",
            "--configuration",
            path.to_str().unwrap(),
            "--require-accepted",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["strictFullAutoAccepted"], false);
    assert_eq!(report["externalActionPerformed"], false);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("do-not-echo"));
    let _ = fs::remove_file(path);
}
