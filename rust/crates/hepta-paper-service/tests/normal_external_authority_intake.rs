//! Actual copied ordinary entrypoints and passive original Node reports.
use hepta_paper_service::external_authority_intake::{
    EXTERNAL_AUTHORITY_INTAKE_ENVIRONMENT_KEYS, external_authority_intake_cli_v1,
    inspect_external_authority_intake_with_cancellation_v1,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    frontend: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-external-normal-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let workspace = root.join("deployment");
        for name in [
            "deployment/bin",
            "deployment/paper-core/bin",
            "deployment/paper-core/config",
            "caller",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        fs::write(
            workspace.join("package.json"),
            br#"{"name":"hepta-paper-workspace"}"#,
        )
        .unwrap();
        let frontend = workspace.join("bin/hepta-paper-rust");
        fs::copy(env!("CARGO_BIN_EXE_hepta-paper-rust"), &frontend).unwrap();
        fs::set_permissions(&frontend, fs::Permissions::from_mode(0o555)).unwrap();
        Self {
            root,
            workspace,
            frontend,
        }
    }
    fn command(&self) -> Command {
        let mut command = Command::new(&self.frontend);
        command
            .current_dir(self.root.join("caller"))
            .env_clear()
            .env("PATH", "/nonexistent")
            .env(
                "HEPTA_PAPER_WORKSPACE_ROOT",
                self.root.join("wrong-environment-root"),
            );
        command
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn oracle(requests: &[Value]) -> Vec<Value> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/external-authority-intake-v1.mjs"))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(requests).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"]).unwrap();
    result["results"].as_array().unwrap().clone()
}
fn decoded(output: Output) -> Value {
    json!({"exitCode":output.status.code(), "stdout":if output.stdout.is_empty(){Value::Null}else{serde_json::from_slice::<Value>(&output.stdout).unwrap()}, "stderr":if output.stderr.is_empty(){Value::Null}else{serde_json::from_slice::<Value>(&output.stderr).unwrap()}})
}
fn snapshot(path: &Path) -> Value {
    let m = fs::symlink_metadata(path).unwrap();
    json!({"dev":m.dev(),"ino":m.ino(),"mode":m.mode(),"uid":m.uid(),"gid":m.gid(),"nlink":m.nlink(),"bytes":m.len(),"mtime":m.mtime(),"mtimeNs":m.mtime_nsec(),"ctime":m.ctime(),"ctimeNs":m.ctime_nsec(),"sha256":hex::encode(Sha256::digest(fs::read(path).unwrap()))})
}
#[test]
fn copied_ordinary_intake_preserves_complete_node_grammar_and_help_before_io() {
    let fixture = Fixture::new();
    let suffixes = vec![
        vec!["--", "--help"],
        vec!["--", "--help", "--require-ready"],
        vec!["--help"],
        vec!["--", "--unknown"],
        vec!["--", "--author-config"],
        vec!["--", "--author-config="],
        vec!["--", "--author-config=", "--help"],
        vec!["--", "--help=true"],
        vec!["--", "--require-ready=false"],
        vec!["--", "--help", "--help"],
        vec!["--", "--author-config=x", "--author-config=y"],
        vec!["--", "--"],
        vec!["--", "positional"],
        vec!["--", "--help", "--unknown"],
        vec!["--", "--root=/tmp"],
        vec!["--", "--action=status"],
    ];
    let argv = suffixes
        .iter()
        .map(|suffix| {
            [
                vec!["operator", "external-authority-intake"],
                suffix.clone(),
            ]
            .concat()
        })
        .collect::<Vec<_>>();
    let requests = argv
        .iter()
        .map(|argv| json!({"operation":"ordinary","argv":argv}))
        .collect::<Vec<_>>();
    let expected = oracle(&requests);
    for (argv, expected) in argv.iter().zip(expected) {
        assert_eq!(
            decoded(fixture.command().args(argv).output().unwrap()),
            expected,
            "{argv:?}"
        );
    }
    assert_eq!(
        fs::read_dir(fixture.root.join("caller")).unwrap().count(),
        0
    );
}
#[test]
fn ordinary_intake_default_environment_relative_paths_and_private_headers_match_original_reports() {
    let fixture = Fixture::new();
    let configuration = fixture.workspace.join("release.json");
    let headers = [
        "{}",
        "{invalid",
        "null",
        "[]",
        "{\"kind\":\"ResearchExecutionReleaseAttestorConfiguration\",\"version\":1}",
        "{\"kind\":\"ResearchExecutionReleaseAttestorConfiguration\",\"version\":1.0}",
        "{\"kind\":\"ResearchExecutionReleaseAttestorConfiguration\",\"version\":2,\"backend\":{\"kind\":\"external-command\"}}",
        "{\"kind\":\"ResearchExecutionReleaseAttestorConfiguration\",\"version\":3,\"backend\":{\"kind\":\"local-file\"}}",
        "{\"kind\":\"ResearchExecutionReleaseAttestorConfiguration\",\"version\":1.5}",
        "{\"kind\":\"ResearchExecutionReleaseAttestorConfiguration\",\"version\":\"1\"}",
        "{\"kind\":\"ResearchExecutionReleaseAttestorConfiguration\",\"version\":9007199254740992}",
        "{\"kind\":\"ResearchExecutionReleaseAttestorConfiguration\"}",
    ];
    let mut count = 0;
    for (body, mode) in headers.iter().map(|s| (*s, 0o600)).chain([
        (headers[4], 0o644),
        (headers[4], 0o640),
        (headers[4], 0o400),
    ]) {
        if configuration.exists() {
            fs::set_permissions(&configuration, fs::Permissions::from_mode(0o600)).unwrap();
        }
        fs::write(&configuration, body).unwrap();
        fs::set_permissions(&configuration, fs::Permissions::from_mode(mode)).unwrap();
        let before = snapshot(&configuration);
        let output = fixture
            .command()
            .args([
                "operator",
                "external-authority-intake",
                "--",
                "--require-ready",
                "--release-attestor-config=./release.json",
            ])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stderr.is_empty());
        let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
        let expected=oracle(&[json!({"operation":"compose","workspace":fixture.workspace,"releasePath":"./release.json","observedAt":actual["observedAt"]})]).remove(0);
        assert_eq!(actual, expected, "header {body} mode {mode:o}");
        assert_eq!(snapshot(&configuration), before);
        count += 1;
    }
    let empty = fixture
        .command()
        .args(["operator", "external-authority-intake"])
        .output()
        .unwrap();
    assert!(empty.status.success());
    let actual: Value = serde_json::from_slice(&empty.stdout).unwrap();
    assert_eq!(actual,oracle(&[json!({"operation":"compose","workspace":fixture.workspace,"observedAt":actual["observedAt"]})]).remove(0));
    count += 1;
    fs::set_permissions(&configuration, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&configuration, headers[4]).unwrap();
    fs::set_permissions(&configuration, fs::Permissions::from_mode(0o600)).unwrap();
    let before = snapshot(&configuration);
    for (selected, explicit) in [
        ("./release.json", None),
        (" ./release.json ", None),
        ("./missing.json", Some("./release.json")),
        ("./release.json", Some("   ")),
    ] {
        let mut command = fixture.command();
        command.args([
            "operator",
            "external-authority-intake",
            "--",
            "--require-ready",
        ]);
        command.env(EXTERNAL_AUTHORITY_INTAKE_ENVIRONMENT_KEYS[2], selected);
        if let Some(explicit) = explicit {
            command.arg(format!("--release-attestor-config={explicit}"));
        }
        let output = command.output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stderr.is_empty());
        let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
        let expected=oracle(&[json!({"operation":"compose","workspace":fixture.workspace,"releasePath":explicit,"environment":{(EXTERNAL_AUTHORITY_INTAKE_ENVIRONMENT_KEYS[2]):selected},"observedAt":actual["observedAt"]})]).remove(0);
        assert_eq!(actual, expected);
        assert_eq!(snapshot(&configuration), before);
        count += 1;
    }
    symlink(&configuration, fixture.workspace.join("release-link.json")).unwrap();
    let output = fixture
        .command()
        .args([
            "operator",
            "external-authority-intake",
            "--",
            "--release-attestor-config=release-link.json",
        ])
        .output()
        .unwrap();
    let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(actual,oracle(&[json!({"operation":"compose","workspace":fixture.workspace,"releasePath":"release-link.json","observedAt":actual["observedAt"]})]).remove(0));
    assert_eq!(snapshot(&configuration), before);
    count += 1;
    assert_eq!(count, 21);
    assert_eq!(
        fs::read_dir(fixture.root.join("caller")).unwrap().count(),
        0
    );
}
#[test]
fn passive_intake_original_cancellation_deadline_and_unknown_frontend_refuse_without_writes() {
    let fixture = Fixture::new();
    let file = fixture.workspace.join("release.json");
    fs::write(&file, b"{}").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    let before = snapshot(&file);
    let cancelled = AtomicBool::new(true);
    let deadline = Instant::now() + Duration::from_secs(20);
    assert!(
        inspect_external_authority_intake_with_cancellation_v1(
            Some(&file),
            None,
            Some(&file),
            None,
            "2026-10-02T10:00:00.000Z",
            &cancelled,
            deadline
        )
        .unwrap_err()
        .to_string()
        .contains("cancelled")
    );
    cancelled.store(false, Ordering::Release);
    assert!(
        inspect_external_authority_intake_with_cancellation_v1(
            Some(&file),
            None,
            Some(&file),
            None,
            "2026-10-02T10:00:00.000Z",
            &cancelled,
            Instant::now() - Duration::from_secs(1)
        )
        .unwrap_err()
        .to_string()
        .contains("expired")
    );
    let report = external_authority_intake_cli_v1(
        &["--release-attestor-config=release.json".into()],
        &BTreeMap::new(),
        &fixture.workspace,
        &cancelled,
        deadline,
    )
    .unwrap();
    assert_eq!(report.value["ready"], false);
    assert_eq!(report.value["externalActionPerformed"], false);
    assert_eq!(snapshot(&file), before);
    let unknown = fixture.root.join("caller/hepta-paper-rust");
    fs::copy(&fixture.frontend, &unknown).unwrap();
    fs::set_permissions(&unknown, fs::Permissions::from_mode(0o555)).unwrap();
    let output = Command::new(unknown)
        .args(["operator", "external-authority-intake", "--", "--help"])
        .current_dir(&fixture.workspace)
        .env_clear()
        .env("PATH", "/nonexistent")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("native_workspace_root_required"));
    assert_eq!(snapshot(&file), before);
}
