use serde_json::Value;
use std::{env, path::PathBuf, process::Command};
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct NativeWorkspace(PathBuf);
impl NativeWorkspace {
    fn new() -> Self {
        let root = env::temp_dir().join(format!(
            "hepta-full-suite-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("rust/src")).unwrap();
        fs::write(root.join(".gitignore"), "rust/target\n").unwrap();
        fs::write(root.join("rust/Cargo.toml"), "[package]\nname = \"native-verification-fixture\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[workspace]\nmembers = [\".\"]\n").unwrap();
        fs::write(root.join("rust/src/lib.rs"), "/// Native fixture.\npub fn value() -> u8 {\n    7\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn native_behavior() {\n        assert_eq!(super::value(), 7);\n        assert!(std::env::var_os(\"OPENAI_API_KEY\").is_none());\n    }\n}\n").unwrap();
        let cargo = PathBuf::from(env!("CARGO"));
        assert!(
            Command::new(&cargo)
                .current_dir(&root)
                .args([
                    "generate-lockfile",
                    "--manifest-path",
                    "rust/Cargo.toml",
                    "--offline"
                ])
                .status()
                .unwrap()
                .success()
        );
        for args in [
            vec!["init", "--quiet"],
            vec!["add", "."],
            vec![
                "-c",
                "user.name=Native Test",
                "-c",
                "user.email=native@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "Native verification fixture",
            ],
        ] {
            assert!(
                Command::new("git")
                    .current_dir(&root)
                    .args(args)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        Self(root)
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
        command
            .args(["verify-full", "--workspace-root"])
            .arg(&self.0)
            .arg("--cargo")
            .arg(env!("CARGO"))
            .arg("--json")
            .env_remove("CARGO_TARGET_DIR")
            .env("OPENAI_API_KEY", "must-never-reach-verification-children");
        command
    }
    fn prepare_slow_real_test(&self) {
        fs::write(
            self.0.join("rust/src/lib.rs"),
            r#"
/// Actual cancellation fixture.
pub fn value() -> u8 { 7 }
#[cfg(test)]
mod tests {
    #[test]
    fn bounded_child() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/entered");
        std::fs::write(path, std::process::id().to_string()).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(30));
        assert_eq!(super::value(), 7);
    }
}
"#,
        )
        .unwrap();
        for arguments in [
            vec!["fmt", "--manifest-path", "rust/Cargo.toml", "--all"],
            vec![
                "test",
                "--manifest-path",
                "rust/Cargo.toml",
                "--locked",
                "--offline",
                "--no-run",
            ],
        ] {
            assert!(
                Command::new(env!("CARGO"))
                    .current_dir(&self.0)
                    .env_remove("CARGO_TARGET_DIR")
                    .args(arguments)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        assert!(
            Command::new("git")
                .current_dir(&self.0)
                .args(["add", "."])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .current_dir(&self.0)
                .args([
                    "-c",
                    "user.name=Native Test",
                    "-c",
                    "user.email=native@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--quiet",
                    "-m",
                    "Real bounded child fixture",
                ])
                .status()
                .unwrap()
                .success()
        );
    }
}
impl Drop for NativeWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn ordinary_native_verification_runs_real_rust_commands_and_binds_the_source() {
    let workspace = NativeWorkspace::new();
    let output = workspace.command().output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["status"], "native_development_suite_passed");
    assert_eq!(report["commands"].as_array().unwrap().len(), 5);
    assert!(
        report["commands"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["passed"] == true && v["processGroupCleanupVerified"] == true)
    );
    assert_eq!(report["parityAccepted"], false);
    assert_eq!(report["nodeExecutionPerformed"], false);
    assert_eq!(report["releaseAuthority"], false);
    assert_eq!(report["submissionAuthority"], false);
    let first_source = report["source"].clone();
    let retry = workspace.command().output().unwrap();
    assert!(
        retry.status.success(),
        "{}",
        String::from_utf8_lossy(&retry.stderr)
    );
    let retry: Value = serde_json::from_slice(&retry.stdout).unwrap();
    assert_eq!(retry["source"], first_source);
    // A source change is rejected rather than attributed to the previous SHA.
    fs::write(
        workspace.0.join("rust/src/lib.rs"),
        "pub fn value() -> u8 { 8 }\n",
    )
    .unwrap();
    let dirty = workspace.command().output().unwrap();
    assert!(!dirty.status.success());
    assert!(dirty.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&dirty.stderr).contains("full_suite_verification_source_not_clean")
    );
}

#[test]
fn native_verification_rejects_wrong_subject_and_missing_differential_tools() {
    let workspace = NativeWorkspace::new();
    let output = workspace
        .command()
        .args([
            "--expected-head",
            &"a".repeat(40),
            "--expected-tree",
            &"b".repeat(40),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("full_suite_verification_subject_mismatch")
    );
    let output = workspace
        .command()
        .arg("--require-parity")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("full_suite_verification_node_differential_toolchain_required")
    );
}

#[test]
fn real_suite_sigterm_and_deadline_keep_failure_receipts_and_reap_the_test_group() {
    use nix::{
        sys::signal::{Signal, kill},
        unistd::Pid,
    };
    use std::{
        process::Stdio,
        time::{Duration, Instant},
    };
    for signal in [true, false] {
        let workspace = NativeWorkspace::new();
        workspace.prepare_slow_real_test();
        let mut command = workspace.command();
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        if !signal {
            command.args(["--timeout-ms", "15000"]);
        }
        let child = command.spawn().unwrap();
        let marker = workspace.0.join("rust/target/entered");
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut entered = false;
        while Instant::now() < deadline {
            if marker.is_file() {
                entered = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        // Send to the exact spawned CLI; its sticky signal handler asks the
        // existing process owner to cancel and reap the actual cargo/test tree.
        if signal || !entered {
            kill(Pid::from_raw(child.id() as i32), Signal::SIGTERM).unwrap();
        }
        let output = child.wait_with_output().unwrap();
        assert!(entered, "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(
            output.status.code(),
            Some(2),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["ok"], false);
        assert_eq!(report["sourceCurrentAfterExecution"], false);
        let executed = report["commands"].as_array().unwrap();
        let tests = executed
            .iter()
            .find(|v| v["name"] == "workspace-tests")
            .unwrap();
        assert_eq!(tests["passed"], false);
        assert_eq!(tests["processGroupCleanupVerified"], true);
        assert_eq!(
            tests["terminationReason"],
            if signal { "Cancelled" } else { "TimedOut" }
        );
        let child_pid = fs::read_to_string(marker).unwrap().parse::<u32>().unwrap();
        assert!(!PathBuf::from(format!("/proc/{child_pid}")).exists());
    }
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

#[test]
fn help_describes_actual_execution_and_separate_preflight() {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["verify-full", "--help"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["kind"], "FullSuiteVerificationUsage");
    assert_eq!(report["semanticNotReadyExitCode"], 2);
    assert!(report["usage"].as_str().unwrap().contains("--preflight"));
}

#[test]
fn require_parity_reports_inventory_without_running_node_or_npm() {
    let root = workspace_root();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "verify-full",
            "--workspace-root",
            root.to_str().unwrap(),
            "--require-parity",
            "--preflight",
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["status"], "verify_full_blocked");
    assert_eq!(report["parityAccepted"], false);
    assert_eq!(report["nodeExecutionPerformed"], false);
    assert_eq!(report["npmExecutionPerformed"], false);
    assert!(
        report["nodeTestManifest"]["testFileCount"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(report["rustWorkspace"]["crateCount"].as_u64().unwrap() > 0);
}
