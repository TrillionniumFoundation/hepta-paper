//! Actual development commands composed over the existing process-group owner.
//! Source and tool observations bind before/after bytes; they are cooperative
//! consistency checks, not an immutable snapshot or hostile-UID containment.
use super::{FullSuiteVerificationOptions, MAX_WALK_ENTRIES, digest, read_regular};
use crate::operational_status::OperationalStatusError;
use crate::release_attest::source_capture::git_binding::{self, GitTreeObservationV1};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, BoundedProcessResultV1, EnvironmentPolicyV1, ProcessLimitsV1,
    ProcessTerminationReason, RestrictedEnvironmentV1,
    run_bounded_process_capturing_stdout_with_cancellation, run_bounded_process_with_cancellation,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

const MAX_SOURCE_BYTES: u64 = 1024 * 1024 * 1024;

fn error(suffix: &str) -> String {
    format!("full_suite_verification_{suffix}")
}

fn executable(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(error("executable_must_be_absolute"));
    }
    let path = fs::canonicalize(path).map_err(|_| error("executable_missing"))?;
    let metadata = fs::symlink_metadata(&path).map_err(|_| error("executable_missing"))?;
    if !metadata.is_file() || metadata.mode() & 0o111 == 0 || metadata.mode() & 0o022 != 0 {
        return Err(error("executable_invalid"));
    }
    Ok(path)
}

fn find_executable(name: &str) -> Result<PathBuf, String> {
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let candidate = directory.join(name);
        if let Ok(path) = executable(&candidate)
            && path.file_name().is_some_and(|n| n == name)
        {
            return Ok(path);
        }
    }
    Err(error(&format!("{name}_executable_required")))
}

fn tool_hash(path: &Path) -> Result<String, String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| error("tool_unreadable"))?;
    let before = file.metadata().map_err(|_| error("tool_unreadable"))?;
    if !before.is_file()
        || before.mode() & 0o111 == 0
        || before.mode() & 0o022 != 0
        || before.len() > 512 * 1024 * 1024
    {
        return Err(error("tool_too_large"));
    }
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| error("tool_unreadable"))?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > 512 * 1024 * 1024 {
            return Err(error("tool_too_large"));
        }
        hasher.update(&buffer[..count]);
    }
    let after = fs::symlink_metadata(path).map_err(|_| error("tool_changed"))?;
    if (
        before.dev(),
        before.ino(),
        before.len(),
        before.mtime(),
        before.mtime_nsec(),
        before.ctime(),
        before.ctime_nsec(),
    ) != (
        after.dev(),
        after.ino(),
        after.len(),
        after.mtime(),
        after.mtime_nsec(),
        after.ctime(),
        after.ctime_nsec(),
    ) || total != before.len()
    {
        return Err(error("tool_changed"));
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

struct Owner<'a> {
    root: PathBuf,
    git: PathBuf,
    environment: RestrictedEnvironmentV1,
    cancelled: &'a AtomicBool,
    deadline: Instant,
    timeout_ms: u64,
}
impl Owner<'_> {
    fn request(&self, path: &Path, arguments: &[&str]) -> Result<BoundedProcessRequestV1, String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(error("cancelled"));
        }
        // Repository config may name an executable fsmonitor. Fixed Git queries
        // must not turn that config into another command or credential helper.
        let git_prefix: &[&str] = if path == self.git {
            &[
                "--no-replace-objects",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "credential.helper=",
            ]
        } else {
            &[]
        };
        Ok(BoundedProcessRequestV1 {
            executable: path.into(),
            arguments: git_prefix
                .iter()
                .chain(arguments.iter())
                .map(OsString::from)
                .collect(),
            working_directory: self.root.clone(),
            environment: self.environment.clone(),
            stdin: None,
        })
    }
    fn limits(&self) -> Result<ProcessLimitsV1, String> {
        let elapsed = u64::try_from(self.deadline.elapsed().as_millis()).unwrap_or(u64::MAX);
        let remaining = self.timeout_ms.saturating_sub(elapsed);
        if remaining == 0 {
            return Err(error("deadline_exceeded"));
        }
        Ok(ProcessLimitsV1 {
            timeout_ms: remaining,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2_000,
            maximum_stdout_bytes: 64 * 1024 * 1024,
            maximum_stderr_bytes: 16 * 1024 * 1024,
            maximum_tail_bytes: 64 * 1024,
            ..ProcessLimitsV1::default()
        })
    }
    fn capture(&self, path: &Path, arguments: &[&str]) -> Result<Vec<u8>, String> {
        self.capture_with_stdin(path, arguments, None)
    }
    fn capture_with_stdin(
        &self,
        path: &Path,
        arguments: &[&str],
        stdin: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, String> {
        let mut request = self.request(path, arguments)?;
        request.stdin = stdin;
        let result = run_bounded_process_capturing_stdout_with_cancellation(
            &request,
            self.limits()?,
            self.cancelled,
        )
        .map_err(|e| format!("{}:{e}", error("observation_failed")))?;
        if !passed(&result.process) {
            return Err(error("observation_failed"));
        }
        Ok(result.stdout)
    }
    fn run(&self, name: &str, path: &Path, arguments: &[&str]) -> Result<Value, String> {
        let hash = tool_hash(path)?;
        let result = run_bounded_process_with_cancellation(
            &self.request(path, arguments)?,
            self.limits()?,
            self.cancelled,
        )
        .map_err(|e| format!("{}:{e}", error("execution_failed")))?;
        if tool_hash(path)? != hash {
            return Err(error("tool_changed"));
        }
        Ok(json!({
            "name": name, "executable": path, "executableHash": hash, "arguments": arguments,
            "workingDirectory": self.root, "passed": passed(&result),
            "exitCode": result.exit_code, "signal": result.signal,
            "terminationReason": format!("{:?}", result.termination_reason),
            "processGroupCleanupVerified": result.process_group_cleanup_verified,
            "stdoutHash": result.stdout_hash.to_string(), "stderrHash": result.stderr_hash.to_string(),
            "stdoutBytes": result.stdout_bytes, "stderrBytes": result.stderr_bytes,
            "stdoutTruncated": result.stdout_truncated, "stderrTruncated": result.stderr_truncated,
            "stdoutTail": String::from_utf8_lossy(&result.stdout_tail),
            "stderrTail": String::from_utf8_lossy(&result.stderr_tail), "elapsedMs": result.elapsed_ms,
        }))
    }
}
fn passed(result: &BoundedProcessResultV1) -> bool {
    result.exit_code == Some(0)
        && result.signal.is_none()
        && result.termination_reason == ProcessTerminationReason::Exited
        && result.process_group_cleanup_verified
}

// Reuse the same fixed Git-tree contract as release source capture. The
// development owner keeps its own tool identity, environment, timeout and
// cancellation; this adapter grants no release or runtime capability.
struct DevelopmentTreeObservation<'a, 'b> {
    owner: &'a Owner<'b>,
    git: &'a Path,
    head: &'a str,
    tree: &'a str,
    bytes: u64,
}
impl GitTreeObservationV1 for DevelopmentTreeObservation<'_, '_> {
    fn workspace_root(&self) -> &Path {
        &self.owner.root
    }
    fn expected_commit(&self) -> &str {
        self.head
    }
    fn expected_tree(&self) -> &str {
        self.tree
    }
    fn query(
        &self,
        root: &Path,
        args: &[&str],
        stdin: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, OperationalStatusError> {
        if root != self.owner.root {
            return Err(OperationalStatusError(error("source_entry_not_supported")));
        }
        self.owner
            .capture_with_stdin(self.git, args, stdin)
            .map_err(OperationalStatusError)
    }
    fn consume(&mut self, bytes: usize) -> Result<(), OperationalStatusError> {
        self.bytes = self.bytes.saturating_add(bytes as u64);
        if self.bytes > MAX_SOURCE_BYTES {
            Err(OperationalStatusError(error("source_inventory_too_large")))
        } else {
            Ok(())
        }
    }
}
fn source_binding_error(failure: OperationalStatusError) -> String {
    let code = failure.0;
    if code.starts_with("full_suite_verification_") {
        return code;
    }
    let suffix = code
        .strip_prefix("release_attestation_source_")
        .unwrap_or(&code);
    error(match suffix {
        "worktree_redirection" => "source_root_mismatch",
        "index_ignore_flags_forbidden" => "source_hidden_index_flags",
        "tree_index_mismatch" => "source_index_tree_mismatch",
        "tracked_mode_mismatch" => "source_mode_mismatch",
        "tracked_bytes_mismatch" => "source_blob_mismatch",
        _ => suffix,
    })
}

struct Source {
    head: String,
    tree: String,
    hash: String,
    count: usize,
    gitlink_references: Vec<git_binding::GitlinkReference>,
}
impl Source {
    fn assert_current(&self) -> Result<(), String> {
        for reference in &self.gitlink_references {
            reference.assert_current().map_err(source_binding_error)?;
        }
        Ok(())
    }
    fn matches(&self, other: &Self) -> bool {
        self.head == other.head
            && self.tree == other.tree
            && self.hash == other.hash
            && self.count == other.count
    }
    fn capture(owner: &Owner<'_>, git: &Path) -> Result<Self, String> {
        let oid = |name| -> Result<String, String> {
            let bytes = owner.capture(git, &["rev-parse", "--verify", name])?;
            let value = std::str::from_utf8(&bytes)
                .map_err(|_| error("subject_invalid"))?
                .trim();
            if value.len() != 40
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            {
                return Err(error("subject_invalid"));
            }
            Ok(value.into())
        };
        let head = oid("HEAD^{commit}")?;
        let tree = oid("HEAD^{tree}")?;
        let mut observation = DevelopmentTreeObservation {
            owner,
            git,
            head: &head,
            tree: &tree,
            bytes: 0,
        };
        let selected = git_binding::capture_tree(&observation).map_err(source_binding_error)?;
        git_binding::assert_object_integrity(&observation).map_err(source_binding_error)?;
        if !owner
            .capture(
                git,
                &[
                    "status",
                    "--porcelain=v1",
                    "--untracked-files=normal",
                    "--ignore-submodules=none",
                ],
            )?
            .is_empty()
        {
            return Err(error("source_not_clean"));
        }
        let mut hasher = Sha256::new();
        let mut actual = BTreeMap::new();
        let mut gitlink_references = Vec::new();
        for (name, entry) in &selected {
            if owner.cancelled.load(Ordering::Acquire) {
                return Err(error("cancelled"));
            }
            if selected.len() > MAX_WALK_ENTRIES
                || !matches!(entry.mode, 0o100644 | 0o100755 | 0o160000)
            {
                return Err(error("source_entry_not_supported"));
            }
            if entry.mode == 0o160000 {
                gitlink_references.push(
                    git_binding::GitlinkReference::capture(&owner.root, name, entry)
                        .map_err(source_binding_error)?,
                );
                hasher.update(format!("{:06o} {} 0\t{}", entry.mode, entry.oid, name));
                hasher.update([0]);
                hasher.update(git_binding::GITLINK_REFERENCE_PROFILE);
                hasher.update([0]);
                actual.insert(name.clone(), (entry.mode, None));
                continue;
            }
            let path = owner.root.join(name);
            let metadata = fs::symlink_metadata(&path).map_err(|_| error("source_unreadable"))?;
            if !metadata.is_file() || (metadata.mode() & 0o111 != 0) != (entry.mode == 0o100755) {
                return Err(error("source_mode_mismatch"));
            }
            let bytes = read_regular(&path)?;
            observation
                .consume(bytes.len())
                .map_err(source_binding_error)?;
            let payload_hash = digest(&bytes);
            hasher.update(format!("{:06o} {} 0\t{}", entry.mode, entry.oid, name));
            hasher.update([0]);
            hasher.update(&payload_hash);
            hasher.update([0]);
            actual.insert(name.clone(), (entry.mode, Some(payload_hash)));
        }
        git_binding::assert_blob_binding(&mut observation, &selected, &actual)
            .map_err(source_binding_error)?;
        git_binding::assert_object_integrity(&observation).map_err(source_binding_error)?;
        let count = selected.len();
        let source = Self {
            head,
            tree,
            hash: format!("sha256:{:x}", hasher.finalize()),
            count,
            gitlink_references,
        };
        source.assert_current()?;
        Ok(source)
    }
    fn value(&self) -> Value {
        json!({"head": self.head, "tree": self.tree, "trackedSourceHash": self.hash, "trackedEntryCount": self.count,
            "observationScope": "clean-source-and-byte-inventory-before-and-after",
            "gitlinkReferenceProfile":git_binding::GITLINK_REFERENCE_PROFILE,
            "gitlinkReferences":self.gitlink_references.iter().map(git_binding::GitlinkReference::value).collect::<Vec<_>>()})
    }
}

/// Run actual native development verification. Success is limited to these
/// commands and this source; it never supplies independently accepted parity.
pub fn execute_full_suite_verification_v1(
    options: &FullSuiteVerificationOptions,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    let root = fs::canonicalize(
        options
            .workspace_root
            .as_ref()
            .ok_or_else(|| error("workspace_root_required"))?,
    )
    .map_err(|_| error("workspace_root_missing"))?;
    let cargo = match options.cargo.as_ref() {
        Some(p) => executable(p)?,
        None => find_executable("cargo")?,
    };
    let git = find_executable("git")?;
    let node = if options.require_parity {
        Some(executable(options.node.as_ref().ok_or_else(|| {
            error("node_differential_toolchain_required")
        })?)?)
    } else {
        None
    };
    let npm = if options.require_parity {
        let path = options
            .npm_cli
            .as_ref()
            .ok_or_else(|| error("npm_cli_required"))?;
        let bytes = read_regular(path)?;
        Some((path.clone(), digest(&bytes)))
    } else {
        None
    };
    let rustc = executable(
        &cargo
            .parent()
            .ok_or_else(|| error("cargo_toolchain_unqualified"))?
            .join("rustc"),
    )?;
    let mut paths = vec![
        cargo
            .parent()
            .ok_or_else(|| error("cargo_toolchain_unqualified"))?
            .to_owned(),
    ];
    if let Some(node) = &node {
        paths.push(
            node.parent()
                .ok_or_else(|| error("node_toolchain_unqualified"))?
                .to_owned(),
        );
    }
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let path = std::env::join_paths(paths)
        .map_err(|_| error("environment_invalid"))?
        .into_string()
        .map_err(|_| error("environment_invalid"))?;
    let policy = EnvironmentPolicyV1::new(
        "native-development-verification-v1",
        [
            "PATH",
            "HOME",
            "LANG",
            "LC_ALL",
            "TZ",
            "TMPDIR",
            "CARGO_HOME",
            "RUSTUP_HOME",
            "RUSTUP_TOOLCHAIN",
            "CARGO_TARGET_DIR",
            "RUSTFLAGS",
            "RUSTDOCFLAGS",
            "GIT_CONFIG_NOSYSTEM",
            "GIT_CONFIG_GLOBAL",
            "GIT_OPTIONAL_LOCKS",
            "GIT_NO_REPLACE_OBJECTS",
            "GIT_NO_LAZY_FETCH",
        ],
        ["PATH", "LC_ALL"],
    )
    .map_err(|_| error("environment_invalid"))?;
    let environment = policy
        .build(
            std::env::vars_os(),
            &BTreeMap::from([
                ("PATH".into(), path),
                ("LC_ALL".into(), "C".into()),
                ("RUSTUP_TOOLCHAIN".into(), "1.98.0".into()),
                ("RUSTFLAGS".into(), "-Dunsafe-code".into()),
                ("RUSTDOCFLAGS".into(), "-Dwarnings".into()),
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
                ("GIT_OPTIONAL_LOCKS".into(), "0".into()),
                ("GIT_NO_REPLACE_OBJECTS".into(), "1".into()),
                ("GIT_NO_LAZY_FETCH".into(), "1".into()),
            ]),
        )
        .map_err(|_| error("environment_invalid"))?;
    let owner = Owner {
        root: root.clone(),
        git: git.clone(),
        environment,
        cancelled,
        deadline: Instant::now(),
        timeout_ms: options.timeout_ms,
    };
    let before = Source::capture(&owner, &git)?;
    if options
        .expected_head
        .as_ref()
        .is_some_and(|v| v != &before.head)
        || options
            .expected_tree
            .as_ref()
            .is_some_and(|v| v != &before.tree)
    {
        return Err(error("subject_mismatch"));
    }
    let cargo_version = owner.capture(&cargo, &["--version"])?;
    if !cargo_version.starts_with(b"cargo 1.98.") {
        return Err(error("cargo_toolchain_unqualified"));
    }
    let rustc_version = owner.capture(&rustc, &["--version"])?;
    if !rustc_version.starts_with(b"rustc 1.98.0 ") {
        return Err(error("rustc_toolchain_unqualified"));
    }
    let rustc_hash = tool_hash(&rustc)?;
    let cargo_hash = tool_hash(&cargo)?;
    let node_version = if let (Some(node), Some((npm, hash))) = (&node, &npm) {
        let version = owner.capture(node, &["--version"])?;
        if version != b"v22.23.1\n" {
            return Err(error("node_toolchain_unqualified"));
        }
        if digest(&read_regular(npm)?) != *hash {
            return Err(error("npm_cli_changed"));
        }
        let npm_version = owner.capture(
            node,
            &[
                npm.to_str().ok_or_else(|| error("source_path_invalid"))?,
                "--version",
            ],
        )?;
        if npm_version != b"10.9.8\n" {
            return Err(error("npm_toolchain_unqualified"));
        }
        Some(
            json!({"nodeVersion":"22.23.1","npmVersion":"10.9.8","nodeHash":tool_hash(node)?,"npmCliHash":hash}),
        )
    } else {
        None
    };
    let mut results = Vec::new();
    let manifest = root.join("rust/Cargo.toml");
    let manifest = manifest
        .to_str()
        .ok_or_else(|| error("source_path_invalid"))?;
    for (name, arguments) in [
        (
            "rustfmt",
            vec!["fmt", "--manifest-path", manifest, "--all", "--", "--check"],
        ),
        (
            "clippy-all-targets",
            vec![
                "clippy",
                "--manifest-path",
                manifest,
                "--locked",
                "--offline",
                "--workspace",
                "--all-features",
                "--all-targets",
                "--",
                "-Dwarnings",
            ],
        ),
        (
            "clippy-production",
            vec![
                "clippy",
                "--manifest-path",
                manifest,
                "--locked",
                "--offline",
                "--workspace",
                "--all-features",
                "--lib",
                "--bins",
                "--",
                "-Dwarnings",
                "-Dclippy::unwrap_used",
                "-Dclippy::expect_used",
                "-Dclippy::panic",
                "-Dclippy::todo",
                "-Dclippy::unimplemented",
            ],
        ),
        (
            "workspace-tests",
            vec![
                "test",
                "--manifest-path",
                manifest,
                "--locked",
                "--offline",
                "--workspace",
                "--all-features",
            ],
        ),
        (
            "rustdoc",
            vec![
                "doc",
                "--manifest-path",
                manifest,
                "--locked",
                "--offline",
                "--workspace",
                "--all-features",
                "--no-deps",
            ],
        ),
    ] {
        let result = owner.run(name, &cargo, &arguments)?;
        let ok = result["passed"] == true;
        results.push(result);
        if !ok {
            break;
        }
    }
    let native_passed = results.len() == 5 && results.iter().all(|v| v["passed"] == true);
    if native_passed && let (Some(node), Some((npm, hash))) = (&node, &npm) {
        let version = owner.capture(node, &["--version"])?;
        if version != b"v22.23.1\n" {
            return Err(error("node_toolchain_unqualified"));
        }
        if digest(&read_regular(npm)?) != *hash {
            return Err(error("npm_cli_changed"));
        }
        results.push(owner.run(
            "node-development-differential",
            node,
            &[
                npm.to_str().ok_or_else(|| error("source_path_invalid"))?,
                "test",
                "--ignore-scripts=false",
            ],
        )?);
        if digest(&read_regular(npm)?) != *hash {
            return Err(error("npm_cli_changed"));
        }
    }
    let after = before
        .assert_current()
        .and_then(|()| Source::capture(&owner, &git));
    let (source_current, post_observation_error) = match &after {
        Ok(after) if before.matches(after) => (true, None),
        Ok(_) => (false, Some(error("source_changed"))),
        Err(error) => (false, Some(error.clone())),
    };
    let tools_current = tool_hash(&cargo).is_ok_and(|hash| hash == cargo_hash)
        && tool_hash(&rustc).is_ok_and(|hash| hash == rustc_hash)
        && match (&node, &node_version) {
            (Some(node), Some(version)) => {
                tool_hash(node).is_ok_and(|hash| version["nodeHash"] == hash)
            }
            (None, None) => true,
            _ => false,
        };
    let success = native_passed
        && source_current
        && tools_current
        && (!options.require_parity || results.len() == 6)
        && results.iter().all(|v| v["passed"] == true);
    let mut blockers = Vec::new();
    if !native_passed || results.iter().any(|v| v["passed"] != true) {
        blockers.push(error("command_failed"));
    }
    if !source_current {
        blockers.push(
            post_observation_error
                .clone()
                .unwrap_or_else(|| error("source_changed")),
        );
    }
    if !tools_current {
        blockers.push(error("tool_changed"));
    }
    Ok(json!({
        "version": 2, "kind": "FullSuiteVerificationExecutionReport",
        "status": if success { "native_development_suite_passed" } else { "native_development_suite_failed" },
        "ok": success, "ready": success, "source": before.value(), "commands": results,
        "sourceCurrentAfterExecution":source_current,"sourceAfterExecution":after.as_ref().ok().map(Source::value),
        "postObservationError":post_observation_error,"toolchainCurrentAfterExecution":tools_current,
        "environmentPolicyHash": owner.environment.policy_hash.to_string(),
        "environmentHash": owner.environment.environment_hash.to_string(),
        "toolchain": {"cargoVersion":String::from_utf8_lossy(&cargo_version).trim(),"cargoHash":cargo_hash,
            "rustcVersion":String::from_utf8_lossy(&rustc_version).trim(),"rustcHash":rustc_hash,"nodeDifferential":node_version},
        "requireParity": options.require_parity, "parityAccepted": false,
        "nodeExecutionPerformed": results.iter().any(|v| v["name"] == "node-development-differential"),
        "npmExecutionPerformed": results.iter().any(|v| v["name"] == "node-development-differential"),
        "externalActionPerformed": false, "serviceStateChanged": false,
        "releaseAuthority": false, "submissionAuthority": false, "nodeRetirement": false,
        "blockers": blockers,
        "rustBoundary": "bounded-native-development-execution-with-explicit-optional-Node-differential",
    }))
}
