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
fn git_source_observation_disables_repository_fsmonitor_hooks_before_cargo_execution() {
    use std::os::unix::fs::PermissionsExt;
    let workspace = NativeWorkspace::new();
    let hook = workspace.0.join(".git/fsmonitor-hook");
    let marker = workspace.0.join(".git/fsmonitor-ran");
    fs::write(
        &hook,
        "#!/bin/sh\nprintf observed > .git/fsmonitor-ran\nprintf 'fixture-token\\0'\n",
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        Command::new("git")
            .current_dir(&workspace.0)
            .args(["config", "core.fsmonitor", hook.to_str().unwrap()])
            .status()
            .unwrap()
            .success()
    );
    // Prove this is an actual executable Git hook, not a shape-only fixture.
    assert!(
        Command::new("git")
            .current_dir(&workspace.0)
            .args(["status", "--porcelain=v1"])
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(fs::read(&marker).unwrap(), b"observed");
    fs::remove_file(&marker).unwrap();
    let tree = Command::new("git")
        .current_dir(&workspace.0)
        .args(["rev-parse", "HEAD^{tree}"])
        .output()
        .unwrap();
    assert!(tree.status.success());
    let tree = String::from_utf8(tree.stdout).unwrap();
    let output = workspace
        .command()
        .args([
            "--expected-head",
            &"a".repeat(40),
            "--expected-tree",
            tree.trim(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("full_suite_verification_subject_mismatch"),
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        !marker.exists(),
        "fixed source observation executed repository fsmonitor"
    );
    assert!(!workspace.0.join("rust/target").exists());
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
fn ordinary_native_verification_accepts_empty_gitlink_reference_and_refuses_nested_bytes() {
    let workspace = NativeWorkspace::new();
    let query = |args: &[&str]| {
        let out = Command::new("git")
            .current_dir(&workspace.0)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    };
    let oid = query(&["rev-parse", "HEAD"]);
    let oid = oid.trim();
    fs::write(workspace.0.join(".gitmodules"),"[submodule \"reference\"]\n\tpath = reference\n\turl = https://example.invalid/immutable-reference.git\n").unwrap();
    query(&["add", ".gitmodules"]);
    query(&[
        "update-index",
        "--add",
        "--cacheinfo",
        &format!("160000,{oid},reference"),
    ]);
    query(&[
        "-c",
        "user.name=Native Test",
        "-c",
        "user.email=native@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Unmaterialized reference",
    ]);
    fs::create_dir(workspace.0.join("reference")).unwrap();
    let output = workspace.command().output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["source"]["gitlinkReferences"][0]["commit"], oid);
    assert_eq!(
        report["source"]["gitlinkReferences"][0]["state"],
        "empty_directory"
    );
    assert_eq!(report["sourceCurrentAfterExecution"], true);
    fs::write(
        workspace.0.join("reference/.hidden"),
        "unaccepted nested content",
    )
    .unwrap();
    let output = workspace.command().output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("gitlink_materialized"));
}

#[test]
fn ordinary_native_verification_refuses_same_empty_gitlink_directory_replacement_by_actual_child() {
    let workspace = NativeWorkspace::new();
    fs::write(
        workspace.0.join("rust/src/lib.rs"),
        r#"
pub fn value() -> u8 { 7 }
#[cfg(test)]
mod tests {
    #[test]
    fn replace_empty_reference() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        std::fs::rename(root.join("reference"), root.join(".git/original-reference")).unwrap();
        std::fs::create_dir(root.join("reference")).unwrap();
        assert_eq!(super::value(), 7);
    }
}
"#,
    )
    .unwrap();
    assert!(
        Command::new(env!("CARGO"))
            .current_dir(&workspace.0)
            .args(["fmt", "--manifest-path", "rust/Cargo.toml", "--all"])
            .status()
            .unwrap()
            .success()
    );
    let query = |args: &[&str]| {
        let out = Command::new("git")
            .current_dir(&workspace.0)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    };
    query(&["add", "rust/src/lib.rs"]);
    let oid = query(&["rev-parse", "HEAD"]);
    let oid = oid.trim();
    fs::write(workspace.0.join(".gitmodules"), "[submodule \"reference\"]\n\tpath = reference\n\turl = https://example.invalid/immutable-reference.git\n").unwrap();
    query(&["add", ".gitmodules"]);
    query(&[
        "update-index",
        "--add",
        "--cacheinfo",
        &format!("160000,{oid},reference"),
    ]);
    query(&[
        "-c",
        "user.name=Native Test",
        "-c",
        "user.email=native@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Actual child swaps empty reference",
    ]);
    fs::create_dir(workspace.0.join("reference")).unwrap();
    let output = workspace.command().output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["sourceCurrentAfterExecution"], false);
    assert_eq!(
        report["postObservationError"],
        "full_suite_verification_gitlink_changed"
    );
    assert!(
        report["commands"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["passed"] == true)
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
fn hidden_index_flags_and_ignored_mode_changes_refuse_before_suite_execution() {
    use std::os::unix::fs::PermissionsExt;
    for flag in ["--assume-unchanged", "--skip-worktree", "mode"] {
        let workspace = NativeWorkspace::new();
        if flag == "mode" {
            assert!(
                Command::new("git")
                    .current_dir(&workspace.0)
                    .args(["config", "core.filemode", "false"])
                    .status()
                    .unwrap()
                    .success()
            );
            fs::set_permissions(
                workspace.0.join("rust/src/lib.rs"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        } else {
            assert!(
                Command::new("git")
                    .current_dir(&workspace.0)
                    .args(["update-index", flag, "rust/src/lib.rs"])
                    .status()
                    .unwrap()
                    .success()
            );
            fs::write(
                workspace.0.join("rust/src/lib.rs"),
                "pub fn value() -> u8 { 8 }\n",
            )
            .unwrap();
        }
        let status = Command::new("git")
            .current_dir(&workspace.0)
            .args(["status", "--porcelain=v1"])
            .output()
            .unwrap();
        assert!(status.status.success() && status.stdout.is_empty());
        let output = workspace.command().output().unwrap();
        assert!(!output.status.success() && output.stdout.is_empty());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(if flag == "mode" {
                "full_suite_verification_source_mode_mismatch"
            } else {
                "full_suite_verification_source_hidden_index_flags"
            })
        );
        assert!(!workspace.0.join("rust/target").exists());
    }
}

#[test]
fn clean_git_stat_cache_cannot_substitute_different_bytes_for_the_selected_tree() {
    use std::fs::{File, FileTimes};
    use std::time::{Duration, SystemTime};
    let workspace = NativeWorkspace::new();
    let source = workspace.0.join("rust/src/lib.rs");
    for (key, value) in [("core.trustctime", "false"), ("core.checkStat", "minimal")] {
        assert!(
            Command::new("git")
                .current_dir(&workspace.0)
                .args(["config", key, value])
                .status()
                .unwrap()
                .success()
        );
    }
    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
    File::options()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();
    assert!(
        Command::new("git")
            .current_dir(&workspace.0)
            .args(["update-index", "--refresh"])
            .status()
            .unwrap()
            .success()
    );
    let selected = Command::new("git")
        .current_dir(&workspace.0)
        .args(["rev-parse", "HEAD", "HEAD^{tree}"])
        .output()
        .unwrap();
    let selected = String::from_utf8(selected.stdout).unwrap();
    let selected: Vec<_> = selected.lines().collect();
    let bytes = fs::read_to_string(&source).unwrap();
    fs::write(&source, bytes.replacen("    7\n", "    8\n", 1)).unwrap();
    File::options()
        .write(true)
        .open(&source)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();
    let status = Command::new("git")
        .current_dir(&workspace.0)
        .args(["status", "--porcelain=v1"])
        .output()
        .unwrap();
    assert!(
        status.status.success() && status.stdout.is_empty(),
        "{}",
        String::from_utf8_lossy(&status.stdout)
    );
    let output = workspace
        .command()
        .args([
            "--expected-head",
            selected[0],
            "--expected-tree",
            selected[1],
        ])
        .output()
        .unwrap();
    assert!(!output.status.success() && output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("full_suite_verification_source_blob_mismatch"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!workspace.0.join("rust/target").exists());
}

#[test]
fn redirected_git_worktree_cannot_hide_untracked_execution_inputs() {
    let workspace = NativeWorkspace::new();
    let other = NativeWorkspace::new();
    assert!(
        Command::new("git")
            .current_dir(&workspace.0)
            .args(["config", "core.worktree"])
            .arg(&other.0)
            .status()
            .unwrap()
            .success()
    );
    fs::write(workspace.0.join("untracked-input.rs"), "different input\n").unwrap();
    let status = Command::new("git")
        .current_dir(&workspace.0)
        .args(["status", "--porcelain=v1"])
        .output()
        .unwrap();
    assert!(status.status.success() && status.stdout.is_empty());
    let output = workspace.command().output().unwrap();
    assert!(!output.status.success() && output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("full_suite_verification_source_root_mismatch")
    );
    assert!(!workspace.0.join("rust/target").exists());
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
fn real_suite_refuses_readable_corrupt_git_objects_before_running_rust() {
    let workspace = NativeWorkspace::new();
    let blob = Command::new("git")
        .current_dir(&workspace.0)
        .args(["rev-parse", "HEAD:rust/src/lib.rs"])
        .output()
        .unwrap();
    assert!(blob.status.success());
    let blob = String::from_utf8(blob.stdout).unwrap().trim().to_owned();
    let object = workspace
        .0
        .join(".git/objects")
        .join(&blob[..2])
        .join(&blob[2..]);
    let changed = Command::new("python3").args(["-c", "import pathlib,sys,zlib; p=pathlib.Path(sys.argv[1]); raw=zlib.decompress(p.read_bytes()); changed=raw.replace(b'    7\\n',b'    8\\n'); assert changed!=raw and len(changed)==len(raw); p.chmod(0o600); p.write_bytes(zlib.compress(changed))"])
        .arg(object).status().unwrap();
    assert!(changed.success());
    let readable = Command::new("git")
        .current_dir(&workspace.0)
        .args(["cat-file", "blob", &blob])
        .output()
        .unwrap();
    assert!(readable.status.success());
    assert!(String::from_utf8_lossy(&readable.stdout).contains("    8\n"));
    let output = workspace.command().output().unwrap();
    assert!(!output.status.success() && output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("tree_object_integrity_failed"));
    assert!(!workspace.0.join("rust/target").exists());
}

#[test]
fn real_suite_refuses_integrity_bypass_in_common_and_worktree_git_configuration() {
    for worktree in [false, true] {
        let workspace = NativeWorkspace::new();
        if worktree {
            assert!(
                Command::new("git")
                    .current_dir(&workspace.0)
                    .args(["config", "extensions.worktreeConfig", "true"])
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let scope = if worktree { "--worktree" } else { "--local" };
        assert!(
            Command::new("git")
                .current_dir(&workspace.0)
                .args(["config", scope, "fsck.hashMismatch", "ignore"])
                .status()
                .unwrap()
                .success()
        );
        let output = workspace.command().output().unwrap();
        assert!(!output.status.success() && output.stdout.is_empty());
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("git_configuration_can_bypass_integrity_or_fetch")
        );
        assert!(!workspace.0.join("rust/target").exists());
    }
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
