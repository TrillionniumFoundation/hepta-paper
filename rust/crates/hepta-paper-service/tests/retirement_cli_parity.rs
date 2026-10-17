//! Compare actual Node and Rust retirement commands, including blocked execution.
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

fn invoke(args: &[&str], root: &std::path::Path, node: bool) -> Output {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut command = if node {
        let mut command = Command::new("node");
        command.arg(workspace.join("paper-core/bin/retire-legacy-archive.mjs"));
        command
    } else {
        Command::new(env!("CARGO_BIN_EXE_hepta-retire-legacy-archive"))
    };
    command
        .args(args)
        .current_dir(root)
        .env("PAPER_FACTORY_LEGACY_ROOT", root.join("legacy"))
        .env("HEPTA_PAPER_RUNTIME_ROOT", root.join("runtime"))
        .env("HEPTA_PAPER_ASSET_ROOT", root.join("assets"))
        .output()
        .expect("CLI output")
}

#[test]
fn retirement_cli_matches_node_status_and_blocked_execute_without_mutation() {
    let root = std::env::temp_dir().join(format!("hepta-retirement-cli-{}", std::process::id()));
    fs::create_dir_all(root.join("legacy")).unwrap();
    fs::create_dir_all(root.join("runtime")).unwrap();
    fs::create_dir_all(root.join("assets")).unwrap();
    let protected = root.join("legacy/paper_factory.sqlite");
    fs::write(&protected, b"retirement CLI must not delete or modify").unwrap();
    for args in [vec![], vec!["status"], vec!["--execute"]] {
        let node = invoke(&args, &root, true);
        let rust = invoke(&args, &root, false);
        assert_eq!(rust.status.code(), node.status.code(), "{args:?}");
        assert_eq!(rust.stderr, node.stderr, "{args:?}");
        let expected: Value = serde_json::from_slice(&node.stdout).unwrap();
        let actual: Value = serde_json::from_slice(&rust.stdout).unwrap();
        assert_eq!(actual, expected, "{args:?}");
        assert_eq!(actual["executeSupported"], false);
        assert_eq!(actual["externalActionPerformed"], false);
        assert_eq!(actual["destructiveRemovalPerformed"], false);
        assert_eq!(
            fs::read(&protected).unwrap(),
            b"retirement CLI must not delete or modify"
        );
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retirement_cli_matches_node_help_and_argument_errors() {
    let root = std::env::temp_dir();
    for args in [
        vec!["--help"],
        vec!["-h"],
        vec!["--"],
        vec!["unknown"],
        vec!["status", "--execute"],
        vec!["--help", "--execute"],
        vec!["--execute", "--execute"],
        vec!["--help=true"],
        vec![""],
    ] {
        let node = invoke(&args, &root, true);
        let rust = invoke(&args, &root, false);
        assert_eq!(rust.status.code(), node.status.code(), "{args:?}");
        assert_eq!(rust.stdout, node.stdout, "{args:?}");
        if node.stderr.is_empty() {
            assert!(rust.stderr.is_empty());
        } else {
            let expected: Value = serde_json::from_slice(&node.stderr).unwrap();
            let actual: Value = serde_json::from_slice(&rust.stderr).unwrap();
            assert_eq!(actual, expected, "{args:?}");
        }
    }
}
