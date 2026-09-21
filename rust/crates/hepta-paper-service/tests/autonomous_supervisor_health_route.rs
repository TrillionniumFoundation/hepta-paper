use serde_json::Value;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "hepta-supervisor-route-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    root
}

#[test]
fn health_route_reports_read_only_missing_instance_and_execution_stays_blocked() {
    let root = root();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-supervisor",
            "--action",
            "health",
            "--runtime-root",
        ])
        .arg(&root)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ready"], false);
    assert!(
        report["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "autonomous_research_supervisor_instance_missing")
    );

    let execution = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["autonomous-supervisor", "--action", "run", "--runtime-root"])
        .arg(&root)
        .output()
        .unwrap();
    assert_eq!(execution.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&execution.stderr)
            .contains("rust_autonomous_supervisor_execution_not_ported")
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn health_route_help_is_json_and_does_not_touch_runtime() {
    let root = root();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["autonomous-supervisor", "--help", "--runtime-root"])
        .arg(&root)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["mutation"], "none");
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unified_route_external_qualification_option_matches_node_parser_errors() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-core/bin/autonomous-research-supervisor.mjs");
    let binary = env!("CARGO_BIN_EXE_hepta-paper-rust");
    for (args, code) in [
        (
            vec!["autonomous-supervisor", "--external-qualification-config"],
            "missing_cli_option_value:--external-qualification-config",
        ),
        (
            vec![
                "autonomous-supervisor",
                "--external-qualification-config",
                "/tmp/a",
                "--external-qualification-config",
                "/tmp/b",
            ],
            "duplicate_cli_option:--external-qualification-config",
        ),
        (
            vec!["autonomous-supervisor", "--external-qualification-config="],
            "empty_cli_option_value:--external-qualification-config",
        ),
    ] {
        let node = Command::new("node")
            .arg(&script)
            .args(&args[1..])
            .output()
            .unwrap();
        let rust = Command::new(binary).args(args).output().unwrap();
        assert_eq!(node.status.code(), Some(1), "{code}: node");
        assert_eq!(rust.status.code(), Some(1), "{code}: rust");
        assert!(
            String::from_utf8_lossy(&node.stderr).contains(code),
            "{code}: node"
        );
        assert!(
            String::from_utf8_lossy(&rust.stderr).contains(code),
            "{code}: rust"
        );
    }
}

#[test]
fn unified_route_shared_options_match_node_value_validation_precedence() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-core/bin/autonomous-research-supervisor.mjs");
    for option in ["--external-qualification-config", "--runtime-root"] {
        for (tail, prefix) in [
            (vec![option.to_owned()], "missing_cli_option_value"),
            (
                vec![option.to_owned(), "--help".into()],
                "missing_cli_option_value",
            ),
            (vec![option.to_owned(), "".into()], "empty_cli_option_value"),
            (vec![format!("{option}=")], "empty_cli_option_value"),
            (vec![format!("{option}=/tmp/b")], "duplicate_cli_option"),
        ] {
            let mut args = vec!["--help".to_owned(), format!("{option}=/tmp/a")];
            args.extend(tail);
            let code = format!("{prefix}:{option}");
            let node = Command::new("node")
                .arg(&script)
                .args(&args)
                .output()
                .unwrap();
            let rust = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
                .arg("autonomous-supervisor")
                .args(&args)
                .output()
                .unwrap();
            for (implementation, output) in [("node", node), ("rust", rust)] {
                assert_eq!(output.status.code(), Some(1), "{implementation}: {args:?}");
                assert!(output.stdout.is_empty(), "{implementation}: {args:?}");
                assert!(
                    String::from_utf8_lossy(&output.stderr).contains(&code),
                    "{implementation}: {args:?}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
    }
}

#[test]
fn unified_route_shared_inline_paths_allow_help_without_reading_paths_like_node() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-core/bin/autonomous-research-supervisor.mjs");
    let root = root();
    let missing = root.join("does-not-exist");
    let missing = missing.to_str().unwrap();
    for option in ["--external-qualification-config", "--runtime-root"] {
        for path_args in [
            vec![option.to_owned(), missing.to_owned()],
            vec![format!("{option}={missing}")],
        ] {
            let node = Command::new("node")
                .arg(&script)
                .arg("--help")
                .args(&path_args)
                .output()
                .unwrap();
            let rust = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
                .args(["autonomous-supervisor", "--help"])
                .args(&path_args)
                .output()
                .unwrap();
            for (implementation, output) in [("node", node), ("rust", rust)] {
                assert_eq!(
                    output.status.code(),
                    Some(0),
                    "{implementation}: {path_args:?}"
                );
                let report: Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(report["version"], 1);
                assert!(report["usage"].is_string());
            }
            assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        }
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unified_route_native_action_selector_uses_node_strict_parser_rules() {
    // `action` is a native extension, so compare its grammar with the actual
    // Node strict parser rather than claiming incumbent resident action parity.
    let parser = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-core/src/strict-cli-arguments.mjs");
    let source = "const {pathToFileURL} = await import('node:url'); const {parseStrictCliArguments} = await import(pathToFileURL(process.argv[1])); parseStrictCliArguments(process.argv.slice(2), {booleanFlags: ['help'], valueFlags: ['action'], positional: false});";
    for (args, code) in [
        (vec!["--action"], "missing_cli_option_value:--action"),
        (
            vec!["--action", "--help"],
            "missing_cli_option_value:--action",
        ),
        (vec!["--action", ""], "empty_cli_option_value:--action"),
        (vec!["--action="], "empty_cli_option_value:--action"),
        (
            vec!["--action=health", "--action=run"],
            "duplicate_cli_option:--action",
        ),
        (
            vec!["--action=health", "--action="],
            "empty_cli_option_value:--action",
        ),
    ] {
        let node = Command::new("node")
            .args(["--input-type=module", "-e", source])
            .arg(&parser)
            .args(&args)
            .output()
            .unwrap();
        let rust = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .arg("autonomous-supervisor")
            .args(&args)
            .output()
            .unwrap();
        for (implementation, output) in [("node", node), ("rust", rust)] {
            assert_eq!(output.status.code(), Some(1), "{implementation}: {args:?}");
            assert!(
                String::from_utf8_lossy(&output.stderr).contains(code),
                "{implementation}: {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
    let root = root();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["autonomous-supervisor", "--action=health"])
        .arg(format!("--runtime-root={}", root.display()))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ready"], false);
    fs::remove_dir_all(root).unwrap();
}
