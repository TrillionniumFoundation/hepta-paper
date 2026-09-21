use hepta_paper_service::supervisor_health::inspect_supervisor_health_v1;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn root() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "hepta-health-parity-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&path).unwrap();
    path
}
fn setup(root: &PathBuf, mode: &str) {
    let adapter = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
        "../../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs",
    );
    let code = format!(
        r#"
import path from 'node:path';
import {{ DatabaseSync }} from 'node:sqlite';
import {{ createAutonomousResearchSupervisorInstanceRepository }} from {adapter:?};
const root=process.argv[1], mode=process.argv[2], r=createAutonomousResearchSupervisorInstanceRepository({{runtimeRoot:root}});
const now=new Date(), lease=r.acquireInstanceLease({{ownerId:'health-test',leaseMs:900000,heartbeatMs:30000,now}});
if (mode !== 'empty') {{
 lease && r.markStartupReconciled({{lease,receiptHash:'sha256:'+'1'.repeat(64),now}});
 lease && r.markMachineIntakeReconciled({{lease,receiptHash:'sha256:'+'2'.repeat(64),configurationHash:'sha256:'+'3'.repeat(64),now}});
}}
if (mode === 'stopped' && lease) r.releaseInstanceLease({{lease,now}});
r.close();
const db=new DatabaseSync(path.join(root,'autonomous-research/supervisor/resident-instance.sqlite'));
db.prepare('UPDATE autonomous_research_supervisor_instance SET lease_token=? WHERE scope_id=?').run('instance:fixture-token','resident-autonomous-research-supervisor');
if (mode === 'empty') db.prepare('DELETE FROM autonomous_research_supervisor_instance').run();
db.close();
"#,
        adapter = adapter.to_string_lossy()
    );
    let output = Command::new("node")
        .arg("--input-type=module")
        .arg("-e")
        .arg(code)
        .arg(root)
        .arg(mode)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn node(root: &PathBuf, flag: Option<&str>) -> (i32, serde_json::Value) {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-core/bin/autonomous-research-supervisor-health.mjs");
    let mut command = Command::new("node");
    command.arg(script).arg("--runtime-root").arg(root);
    if let Some(flag) = flag {
        command.arg(flag);
    }
    let output = command.output().unwrap();
    let status = output.status.code().unwrap();
    let value = serde_json::from_slice(&output.stdout).unwrap();
    (status, value)
}
fn scrub(mut value: serde_json::Value) -> serde_json::Value {
    value["inspectedAt"] = serde_json::Value::Null;
    value
}
#[test]
fn base_startup_machine_modes_match_node_with_fixed_lease_token() {
    let root = root();
    setup(&root, "ready");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    for flag in [
        None,
        Some("--require-startup-reconciliation"),
        Some("--require-machine-intake-reconciliation"),
    ] {
        let (exit, expected) = node(&root, flag);
        let actual = inspect_supervisor_health_v1(&root, now).unwrap();
        assert_eq!(exit, 0);
        assert_eq!(scrub(expected), scrub(actual.clone()));
        assert_eq!(actual["instance"]["leaseToken"], "instance:fixture-token");
    }
    let wal = root.join("autonomous-research/supervisor/resident-instance.sqlite-wal");
    fs::write(&wal, []).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&wal, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let (exit, expected) = node(&root, None);
    let actual = inspect_supervisor_health_v1(&root, now).unwrap();
    assert_eq!(exit, 0);
    assert_eq!(scrub(expected), scrub(actual.clone()));
    fs::write(&wal, b"malformed-wal").unwrap();
    let (exit, expected) = node(&root, None);
    let actual = inspect_supervisor_health_v1(&root, now).unwrap();
    assert_eq!(exit, 0);
    assert_eq!(scrub(expected), scrub(actual));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn malformed_permissions_and_timing_have_matching_exit_and_blocker() {
    let root = root();
    setup(&root, "ready");
    let database = root.join("autonomous-research/supervisor/resident-instance.sqlite");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&database, fs::Permissions::from_mode(0o666)).unwrap();
    }
    let (exit, expected) = node(&root, None);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let actual = inspect_supervisor_health_v1(&root, now).unwrap();
    assert_eq!(exit, 2);
    assert_eq!(actual["blockers"], expected["blockers"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute(
            "UPDATE autonomous_research_supervisor_instance SET heartbeat_interval_ms=900000",
            [],
        )
        .unwrap();
    drop(connection);
    let (exit, expected) = node(&root, None);
    let actual = inspect_supervisor_health_v1(&root, now).unwrap();
    assert_eq!(exit, 2);
    assert_eq!(scrub(expected), scrub(actual));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn empty_and_stopped_states_match_node() {
    for mode in ["empty", "stopped"] {
        let root = root();
        setup(&root, mode);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let (exit, expected) = node(&root, None);
        let actual = inspect_supervisor_health_v1(&root, now).unwrap();
        assert_eq!(exit, 2);
        assert_eq!(scrub(expected), scrub(actual), "{mode}");
        fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn remaining_unsupported_advanced_modes_are_explicitly_rejected() {
    let binary = env!("CARGO_BIN_EXE_hepta-autonomous-supervisor-health");
    for flag in [
        "--require-strict-machine-intake-reconciliation",
        "--require-fully-autonomous",
    ] {
        let output = Command::new(binary).arg(flag).output().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("unsupported_supervisor_health_mode")
        );
    }
}

#[test]
fn strict_cli_parse_errors_match_node_error_class() {
    let root = root();
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-core/bin/autonomous-research-supervisor-health.mjs");
    let binary = env!("CARGO_BIN_EXE_hepta-autonomous-supervisor-health");
    for (args, code) in [
        (vec!["--unknown"], "unknown_cli_option:--unknown"),
        (
            vec!["--runtime-root", "/tmp/a", "--runtime-root", "/tmp/b"],
            "duplicate_cli_option:--runtime-root",
        ),
        (
            vec!["--runtime-root"],
            "missing_cli_option_value:--runtime-root",
        ),
        (
            vec!["--external-qualification-config"],
            "missing_cli_option_value:--external-qualification-config",
        ),
        (
            vec![
                "--external-qualification-config",
                "/tmp/a",
                "--external-qualification-config",
                "/tmp/b",
            ],
            "duplicate_cli_option:--external-qualification-config",
        ),
        (vec!["positional"], "unexpected_cli_positional:positional"),
    ] {
        let node = Command::new("node")
            .arg(&script)
            .args(&args)
            .output()
            .unwrap();
        let rust = Command::new(binary).args(&args).output().unwrap();
        assert_eq!(node.status.code(), Some(1), "{code}");
        assert_eq!(rust.status.code(), Some(1), "{code}");
        assert!(
            String::from_utf8_lossy(&node.stderr).contains(code),
            "{code}: node"
        );
        assert!(
            String::from_utf8_lossy(&rust.stderr).contains(code),
            "{code}: rust"
        );
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn strict_cli_boundary_matrix_matches_node_error_precedence() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-core/bin/autonomous-research-supervisor-health.mjs");
    let binary = env!("CARGO_BIN_EXE_hepta-autonomous-supervisor-health");
    let mut cases = vec![vec!["--".to_owned()], vec!["--=value".to_owned()]];
    for flag in [
        "help",
        "require-startup-reconciliation",
        "require-machine-intake-reconciliation",
        "require-current-machine-intake",
        "require-strict-machine-intake-reconciliation",
        "require-fully-autonomous",
    ] {
        cases.push(vec![format!("--{flag}=false")]);
        cases.push(vec![format!("--{flag}"), format!("--{flag}")]);
    }
    cases.push(vec![
        "--require-current-machine-intake".into(),
        "--require-fully-autonomous".into(),
        "--require-fully-autonomous".into(),
    ]);
    for flag in ["runtime-root", "external-qualification-config"] {
        cases.push(vec![format!("--{flag}=")]);
        cases.push(vec![format!("--{flag}"), String::new()]);
        cases.push(vec![format!("--{flag}"), "--help".into()]);
        for suffix in [
            vec![format!("--{flag}")],
            vec![format!("--{flag}"), "--help".into()],
            vec![format!("--{flag}=")],
            vec![format!("--{flag}"), String::new()],
            vec![format!("--{flag}=second")],
        ] {
            let mut args = vec![format!("--{flag}=first")];
            args.extend(suffix);
            cases.push(args);
        }
    }
    for args in cases {
        let node = Command::new("node")
            .arg(&script)
            .args(&args)
            .output()
            .unwrap();
        let rust = Command::new(binary).args(&args).output().unwrap();
        assert_eq!(node.status.code(), Some(1), "{args:?}: node");
        assert_eq!(rust.status.code(), node.status.code(), "{args:?}: rust");
        let node_stderr = String::from_utf8_lossy(&node.stderr);
        let expected = node_stderr
            .lines()
            .find_map(|line| line.strip_prefix("Error: "))
            .unwrap_or_else(|| panic!("{args:?}: no Node error class: {node_stderr}"));
        assert_eq!(
            String::from_utf8_lossy(&rust.stderr).trim(),
            expected,
            "{args:?}"
        );
        assert!(rust.stdout.is_empty(), "{args:?}");
    }
}

#[test]
fn strict_cli_help_accepts_inline_option_like_values_without_runtime_access() {
    let root = root();
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-core/bin/autonomous-research-supervisor-health.mjs");
    let binary = env!("CARGO_BIN_EXE_hepta-autonomous-supervisor-health");
    for args in [
        vec!["--runtime-root=--option-like-path", "--help"],
        vec![
            "--external-qualification-config=--option-like-path",
            "--help",
        ],
        vec![
            "--require-current-machine-intake",
            "--require-fully-autonomous",
            "--require-strict-machine-intake-reconciliation",
            "--help",
        ],
    ] {
        let node = Command::new("node")
            .current_dir(&root)
            .arg(&script)
            .args(&args)
            .output()
            .unwrap();
        let rust = Command::new(binary)
            .current_dir(&root)
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(node.status.code(), Some(0), "{args:?}: node");
        assert_eq!(rust.status.code(), node.status.code(), "{args:?}: rust");
        let expected: serde_json::Value = serde_json::from_slice(&node.stdout).unwrap();
        let actual: serde_json::Value = serde_json::from_slice(&rust.stdout).unwrap();
        assert_eq!(actual, expected, "{args:?}");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }
    fs::remove_dir_all(root).unwrap();
}
