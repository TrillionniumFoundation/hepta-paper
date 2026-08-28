use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, File},
    io::Write,
    os::unix::{
        ffi::OsStringExt,
        fs::{PermissionsExt, symlink},
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{RestrictedEnvironmentV1, model_child_environment_policy_v1};

use super::{
    BoundedProcessError, BoundedProcessRequestV1, ProcessLimitsV1,
    ProcessTerminationReason, run_bounded_process,
};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

struct TempTree(PathBuf);

impl TempTree {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "hepta-codex-process-{}-{nonce}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir(&path).expect("create temp tree");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("private temp tree");
        Self(path)
    }

    fn script(&self, name: &str, source: &str) -> PathBuf {
        let path = self.0.join(name);
        let mut file = File::create(&path).expect("create script");
        file.write_all(source.as_bytes()).expect("write script");
        file.sync_all().expect("sync script");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("make script executable");
        path
    }

    fn environment(&self) -> RestrictedEnvironmentV1 {
        let source = [
            (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
            (OsString::from("HOME"), self.0.clone().into_os_string()),
            (OsString::from("TMPDIR"), self.0.clone().into_os_string()),
            (
                OsString::from("OPENAI_API_KEY"),
                OsString::from("must-not-leak"),
            ),
        ];
        model_child_environment_policy_v1()
            .build(source, &BTreeMap::new())
            .expect("model child environment")
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn request(tree: &TempTree, script: PathBuf) -> BoundedProcessRequestV1 {
    BoundedProcessRequestV1 {
        executable: script,
        arguments: Vec::new(),
        working_directory: tree.0.clone(),
        environment: tree.environment(),
        stdin: None,
    }
}

fn pressure_limits() -> ProcessLimitsV1 {
    ProcessLimitsV1 {
        timeout_ms: 2_000,
        termination_grace_ms: 100,
        cleanup_timeout_ms: 2_000,
        poll_interval_ms: 5,
        maximum_stdin_bytes: 1024,
        maximum_stdout_bytes: 256,
        maximum_stderr_bytes: 256,
        maximum_tail_bytes: 128,
    }
}

#[test]
fn child_environment_does_not_inherit_provider_secret() {
    let tree = TempTree::new();
    let script = tree.script("environment.sh", "#!/bin/sh\nset -eu\nenv | sort\n");
    let result = run_bounded_process(&request(&tree, script), ProcessLimitsV1::default())
        .expect("bounded environment probe");
    let output = String::from_utf8(result.stdout_tail).expect("UTF-8 env output");
    assert!(!output.contains("OPENAI_API_KEY"));
    assert!(!output.contains("must-not-leak"));
    assert!(result.process_group_cleanup_verified);
}

#[test]
fn stdout_limit_terminates_the_process_group() {
    let tree = TempTree::new();
    let script = tree.script(
        "overflow.sh",
        "#!/bin/sh\nset -eu\nwhile :; do printf '0123456789abcdef'; done\n",
    );
    let limits = pressure_limits();
    let result = run_bounded_process(&request(&tree, script), limits)
        .expect("overflow must be terminated and reaped");
    assert_eq!(
        result.termination_reason,
        ProcessTerminationReason::StdoutLimitExceeded,
    );
    assert!(result.stdout_bytes > limits.maximum_stdout_bytes);
    assert!(result.process_group_cleanup_verified);
}

#[test]
fn stderr_limit_terminates_the_process_group() {
    let tree = TempTree::new();
    let script = tree.script(
        "stderr-overflow.sh",
        "#!/bin/sh\nset -eu\nwhile :; do printf 'stderr-pressure' >&2; done\n",
    );
    let limits = pressure_limits();
    let result = run_bounded_process(&request(&tree, script), limits)
        .expect("stderr overflow must be terminated and reaped");
    assert_eq!(
        result.termination_reason,
        ProcessTerminationReason::StderrLimitExceeded,
    );
    assert!(result.stderr_bytes > limits.maximum_stderr_bytes);
    assert!(result.process_group_cleanup_verified);
}

#[test]
fn term_resistant_process_group_is_escalated_to_kill() {
    let tree = TempTree::new();
    let script = tree.script(
        "term-resistant.sh",
        "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n",
    );
    let limits = ProcessLimitsV1 {
        timeout_ms: 50,
        termination_grace_ms: 50,
        cleanup_timeout_ms: 2_000,
        poll_interval_ms: 5,
        maximum_stdin_bytes: 1024,
        maximum_stdout_bytes: 1024,
        maximum_stderr_bytes: 1024,
        maximum_tail_bytes: 1024,
    };
    let result = run_bounded_process(&request(&tree, script), limits)
        .expect("TERM-resistant group must be killed and reaped");
    assert_eq!(result.termination_reason, ProcessTerminationReason::TimedOut);
    assert!(result.termination_escalated);
    assert!(result.process_group_cleanup_verified);
}

#[cfg(target_os = "linux")]
#[test]
fn timeout_terminates_descendants_in_the_same_process_group() {
    let tree = TempTree::new();
    let script = tree.script(
        "descendant.sh",
        "#!/bin/sh\nset -eu\nsleep 30 &\nchild=$!\nprintf '%s\\n' \"$child\"\nwait \"$child\"\n",
    );
    let limits = ProcessLimitsV1 {
        timeout_ms: 100,
        termination_grace_ms: 100,
        cleanup_timeout_ms: 3_000,
        poll_interval_ms: 5,
        maximum_stdin_bytes: 1024,
        maximum_stdout_bytes: 1024,
        maximum_stderr_bytes: 1024,
        maximum_tail_bytes: 1024,
    };
    let result = run_bounded_process(&request(&tree, script), limits)
        .expect("timeout must clean the process group");
    assert_eq!(result.termination_reason, ProcessTerminationReason::TimedOut);
    assert!(result.process_group_cleanup_verified);
    let descendant = String::from_utf8(result.stdout_tail)
        .expect("pid output")
        .trim()
        .parse::<u32>()
        .expect("descendant pid");
    assert!(!Path::new(&format!("/proc/{descendant}")).exists());
}

#[test]
fn hard_limit_caps_and_stdin_limit_fail_before_spawn() {
    let tree = TempTree::new();
    let script = tree.script("no-spawn.sh", "#!/bin/sh\nexit 99\n");
    let mut limits = ProcessLimitsV1::default();
    limits.timeout_ms = 6 * 60 * 60 * 1000 + 1;
    assert_eq!(
        run_bounded_process(&request(&tree, script.clone()), limits),
        Err(BoundedProcessError::InvalidLimits),
    );

    let mut oversized_stdin = request(&tree, script);
    oversized_stdin.stdin = Some(vec![0; 2]);
    let limits = ProcessLimitsV1 {
        maximum_stdin_bytes: 1,
        ..pressure_limits()
    };
    assert_eq!(
        run_bounded_process(&oversized_stdin, limits),
        Err(BoundedProcessError::StdinBytesExceeded),
    );
}

#[test]
fn nul_argument_is_rejected_before_spawn() {
    let tree = TempTree::new();
    let script = tree.script("no-spawn-nul.sh", "#!/bin/sh\nexit 99\n");
    let mut value = request(&tree, script);
    value
        .arguments
        .push(OsString::from_vec(b"bad\0argument".to_vec()));
    assert_eq!(
        run_bounded_process(&value, ProcessLimitsV1::default()),
        Err(BoundedProcessError::ArgumentContainsNul),
    );
}

#[test]
fn symlinked_executable_and_working_directory_are_rejected() {
    let tree = TempTree::new();
    let script = tree.script("canonical.sh", "#!/bin/sh\nexit 0\n");
    let executable_link = tree.0.join("executable-link");
    symlink(&script, &executable_link).expect("executable symlink");
    assert_eq!(
        run_bounded_process(
            &request(&tree, executable_link),
            ProcessLimitsV1::default(),
        ),
        Err(BoundedProcessError::NonCanonicalPath("executable")),
    );

    let real_working_directory = tree.0.join("real-working-directory");
    fs::create_dir(&real_working_directory).expect("real working directory");
    let working_directory_link = tree.0.join("working-directory-link");
    symlink(&real_working_directory, &working_directory_link)
        .expect("working directory symlink");
    let mut value = request(&tree, script);
    value.working_directory = working_directory_link;
    assert_eq!(
        run_bounded_process(&value, ProcessLimitsV1::default()),
        Err(BoundedProcessError::NonCanonicalPath("working_directory")),
    );
}

#[test]
fn setid_executable_is_rejected_before_spawn() {
    let tree = TempTree::new();
    let script = tree.script("setid.sh", "#!/bin/sh\nexit 99\n");
    fs::set_permissions(&script, fs::Permissions::from_mode(0o4700))
        .expect("set setuid bit");
    assert_eq!(
        run_bounded_process(&request(&tree, script), ProcessLimitsV1::default()),
        Err(BoundedProcessError::ExecutablePermissionsInvalid(0o4700)),
    );
}
