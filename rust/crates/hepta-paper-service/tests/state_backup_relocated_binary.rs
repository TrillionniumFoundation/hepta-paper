//! The executable is genuinely copied out of its build checkout. An explicit
//! deployment root owns both its manifest and the default sibling runtime.
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    data: Value,
    binary: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-backup-cli-e2e-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = Command::new("node")
            .arg(repo.join("rust/oracle/state-backup-cli-v1.mjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(json!({"root":root,"mode":"fixture"}).to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["ok"], true, "{value}");
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&value["profile"]).unwrap();
        let data = value["value"].clone();
        let deployment_runtime = root.join("hepta-paper-runtime/native-runtime");
        fs::create_dir(deployment_runtime.parent().unwrap()).unwrap();
        fs::rename(data["runtime"].as_str().unwrap(), &deployment_runtime).unwrap();
        let install = root.join("installation/bin");
        fs::create_dir_all(&install).unwrap();
        let binary = install.join("hepta-state-backup");
        fs::copy(env!("CARGO_BIN_EXE_hepta-state-backup"), &binary).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root, data, binary }
    }
    fn run(&self, args: &[String], runtime: Option<&Path>) -> std::process::Output {
        let mut command = Command::new(&self.binary);
        command
            .args(args)
            .current_dir(self.binary.parent().unwrap())
            .env_remove("HEPTA_PAPER_RUNTIME_ROOT");
        if let Some(runtime) = runtime {
            command.env("HEPTA_PAPER_RUNTIME_ROOT", runtime);
        }
        command.output().unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn copied_binary_reads_deployment_manifest_and_default_runtime() {
    let f = Fixture::new();
    let expected =
        hepta_paper_service::state_database_inventory::inspect_state_database_inventory_v1(
            &f.root.join("hepta-paper-runtime/native-runtime"),
            &f.data["manifest"],
        )
        .unwrap();
    assert_eq!(
        expected["status"],
        "autonomous_research_state_database_inventory_ready"
    );
    for root in [
        f.data["workspace"].as_str().unwrap().to_owned(),
        "../../workspace".into(),
    ] {
        let output = f.run(&[format!("--root={root}")], None);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            expected
        );
    }
    let other = f.root.join("empty-runtime");
    fs::create_dir(&other).unwrap();
    let args = vec![
        "--root".into(),
        f.data["workspace"].as_str().unwrap().into(),
    ];
    let output = f.run(&args, Some(&other));
    assert_eq!(output.status.code(), Some(2));
    let blocked: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(blocked["manifestHash"], expected["manifestHash"]);
    assert_eq!(blocked["instances"], json!([]));
    let mut explicit = args;
    explicit.extend([
        "--runtime-root".into(),
        f.root
            .join("hepta-paper-runtime/native-runtime")
            .display()
            .to_string(),
    ]);
    let output = f.run(&explicit, Some(&other));
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        expected
    );
    assert!(!f.root.join("calls.jsonl").exists());
}
#[test]
fn deployment_root_is_strict_and_never_falls_back_after_refusal() {
    let f = Fixture::new();
    for (args, code) in [
        (vec!["--root"], "missing_cli_option_value:--root"),
        (vec!["--root="], "empty_cli_option_value:--root"),
        (vec!["--root=x", "--root=y"], "duplicate_cli_option:--root"),
        (vec!["--root", "--help"], "missing_cli_option_value:--root"),
        (
            vec!["--root=missing"],
            "autonomous_research_state_backup_manifest_file_invalid",
        ),
    ] {
        let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
        let output = f.run(&args, None);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(output.stdout.is_empty());
        assert_eq!(String::from_utf8_lossy(&output.stderr).trim(), code);
    }
    let alias = f.root.join("alias");
    std::os::unix::fs::symlink(f.data["workspace"].as_str().unwrap(), &alias).unwrap();
    let output = f.run(&[format!("--root={}", alias.display())], None);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(!f.root.join("calls.jsonl").exists());
}
