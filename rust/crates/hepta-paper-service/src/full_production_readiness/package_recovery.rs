//! Bounded package-retention recovery readiness command adapter.
//!
//! The incumbent invokes a pinned, root-owned command through an inherited
//! `/proc/self/fd/*` descriptor (Node uses slot 3). This module keeps that
//! descriptor pin, protected path walk, restricted child environment, timeout,
//! process-group cleanup, and output cap in one boundary.

#![forbid(unsafe_code)]

use super::policy;
use nix::fcntl::{FcntlArg, FdFlag, OFlag, fcntl};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileExt, MetadataExt, OpenOptionsExt},
            process::CommandExt,
        },
    },
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const SHA256_PREFIX: &str = "sha256:";
pub const PACKAGE_READINESS_TIMEOUT_MS: u64 = 30_000;
pub const MAXIMUM_PACKAGE_READINESS_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAXIMUM_PACKAGE_READINESS_COMMAND_BYTES: u64 = 16 * 1024 * 1024;
const BASE_CHILD_ENV_KEYS: [&str; 15] = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
];

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
struct Identity {
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    nlink: u64,
    len: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}

fn identity(metadata: &fs::Metadata) -> Identity {
    Identity {
        dev: metadata.dev(),
        ino: metadata.ino(),
        mode: metadata.mode(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        nlink: metadata.nlink(),
        len: metadata.len(),
        mtime: metadata.mtime(),
        mtime_nsec: metadata.mtime_nsec(),
        ctime: metadata.ctime(),
        ctime_nsec: metadata.ctime_nsec(),
    }
}
fn same_protected_identity(left: Identity, right: Identity) -> bool {
    left.dev == right.dev
        && left.ino == right.ino
        && left.mode == right.mode
        && left.uid == right.uid
        && left.gid == right.gid
}
fn same_file_identity(left: Identity, right: Identity) -> bool {
    left == right
}
fn valid_sha256(value: &str) -> bool {
    value.strip_prefix(SHA256_PREFIX).is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[derive(Debug)]
struct PathEntry {
    path: PathBuf,
    identity: Identity,
}
#[derive(Debug)]
struct PinnedCommand {
    path: PathBuf,
    file: File,
    identity: Identity,
    path_snapshot: Vec<PathEntry>,
    content_hash: String,
}

fn invalid() -> String {
    "full_production_package_readiness_command_reference_invalid".to_owned()
}
fn drift() -> String {
    "full_production_package_readiness_command_reference_drift".to_owned()
}

fn canonical_absolute(path: &Path) -> bool {
    path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::RootDir | Component::Normal(_)))
        && fs::canonicalize(path)
            .ok()
            .is_some_and(|resolved| resolved == path)
}

/// Walk every directory from `/` to the command and retain the protected
/// identity. This mirrors the Node trusted-root policy with UID 0 in production.
fn protected_path(
    command: &Path,
    required_uid: u32,
    trusted_root: &Path,
) -> Result<Vec<PathEntry>, String> {
    if !canonical_absolute(command) || !canonical_absolute(trusted_root) || command == trusted_root
    {
        return Err(invalid());
    }
    let relative = command.strip_prefix(trusted_root).map_err(|_| invalid())?;
    let mut paths = vec![trusted_root.to_path_buf()];
    let mut cursor = trusted_root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err(invalid());
        };
        cursor.push(part);
        paths.push(cursor.clone());
    }
    let mut entries = Vec::new();
    for path in paths {
        let metadata = fs::symlink_metadata(&path).map_err(|_| invalid())?;
        let final_entry = path == command;
        let sticky_root_directory = metadata.uid() == 0 && metadata.mode() & 0o1000 != 0;
        let valid = !metadata.file_type().is_symlink()
            && metadata.uid() == required_uid
            && if final_entry {
                metadata.is_file()
                    && metadata.nlink() == 1
                    && (1..=MAXIMUM_PACKAGE_READINESS_COMMAND_BYTES).contains(&metadata.len())
                    && metadata.mode() & 0o111 != 0
                    && metadata.mode() & 0o222 == 0
            } else {
                metadata.is_dir() && (metadata.mode() & 0o022 == 0 || sticky_root_directory)
            };
        if !valid {
            return Err(invalid());
        }
        entries.push(PathEntry {
            path,
            identity: identity(&metadata),
        });
    }
    Ok(entries)
}

fn assert_path_current(snapshot: &[PathEntry]) -> Result<(), String> {
    for entry in snapshot {
        let current = fs::symlink_metadata(&entry.path).map_err(|_| drift())?;
        if !same_protected_identity(entry.identity, identity(&current)) {
            return Err(drift());
        }
    }
    Ok(())
}

fn open_pinned_command(
    path: &Path,
    expected_hash: &str,
    required_uid: u32,
    trusted_root: &Path,
) -> Result<PinnedCommand, String> {
    if !valid_sha256(expected_hash) || !Path::new("/proc/self/fd").is_dir() {
        return Err(invalid());
    }
    let path_snapshot = protected_path(path, required_uid, trusted_root)?;
    let mut options = OpenOptions::new();
    options.read(true).custom_flags(
        OFlag::O_NOFOLLOW.bits() | OFlag::O_NONBLOCK.bits() | OFlag::O_CLOEXEC.bits(),
    );
    let file = options.open(path).map_err(|_| invalid())?;
    let before = file.metadata().map_err(|_| invalid())?;
    let before_identity = identity(&before);
    if !before.is_file()
        || before.nlink() != 1
        || before.uid() != required_uid
        || before.len() == 0
        || before.len() > MAXIMUM_PACKAGE_READINESS_COMMAND_BYTES
        || before.mode() & 0o111 == 0
        || before.mode() & 0o222 != 0
    {
        return Err(invalid());
    }
    let bytes = read_descriptor(&file).map_err(|_| invalid())?;
    let after = file.metadata().map_err(|_| invalid())?;
    assert_path_current(&path_snapshot)?;
    if !same_file_identity(before_identity, identity(&after))
        || bytes.len() as u64 != before.len()
        || digest(&bytes) != expected_hash
    {
        return Err(drift());
    }
    Ok(PinnedCommand {
        path: path.to_owned(),
        file,
        identity: identity(&after),
        path_snapshot,
        content_hash: expected_hash.to_owned(),
    })
}

fn assert_command_current(command: &PinnedCommand) -> Result<(), String> {
    assert_path_current(&command.path_snapshot)?;
    let path_metadata = fs::symlink_metadata(&command.path).map_err(|_| drift())?;
    let descriptor_metadata = command.file.metadata().map_err(|_| drift())?;
    if !same_file_identity(command.identity, identity(&path_metadata))
        || !same_file_identity(command.identity, identity(&descriptor_metadata))
    {
        return Err(drift());
    }
    let bytes = read_descriptor(&command.file).map_err(|_| drift())?;
    if digest(&bytes) != command.content_hash || bytes.len() as u64 != command.identity.len {
        return Err(drift());
    }
    Ok(())
}

fn read_descriptor(file: &File) -> Result<Vec<u8>, std::io::Error> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = match file.read_at(&mut buffer, bytes.len() as u64) {
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() as u64 > MAXIMUM_PACKAGE_READINESS_COMMAND_BYTES {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "command resource limit",
            ));
        }
    }
}

fn restricted_environment(source: &Value) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    let Some(object) = source.as_object() else {
        return result;
    };
    for key in BASE_CHILD_ENV_KEYS {
        if let Some(value) = object.get(key) {
            let value = match value {
                Value::String(value) => value.clone(),
                Value::Null => "null".to_owned(),
                Value::Bool(value) => value.to_string(),
                Value::Number(value) => value.to_string(),
                Value::Array(_) | Value::Object(_) => continue,
            };
            if !value.contains('\0') {
                result.insert(key.to_owned(), value);
            }
        }
    }
    result
}

fn nonblocking(file: &impl std::os::fd::AsFd) -> bool {
    fcntl(file, FcntlArg::F_GETFL).ok().is_some_and(|flags| {
        fcntl(
            file,
            FcntlArg::F_SETFL(OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK),
        )
        .is_ok()
    })
}
fn bounded_output(
    mut pipe: impl Read,
    stopped: &AtomicBool,
    overflow: &AtomicBool,
) -> (Vec<u8>, bool) {
    let mut bytes = Vec::new();
    let mut total = 0usize;
    let mut buffer = [0u8; 8192];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => return (bytes, true),
            Ok(count) => {
                total = total.saturating_add(count);
                if total > MAXIMUM_PACKAGE_READINESS_OUTPUT_BYTES {
                    overflow.store(true, Ordering::Release);
                    return (bytes, false);
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if stopped.load(Ordering::Acquire) {
                    return (bytes, false);
                }
                thread::sleep(Duration::from_millis(2));
            }
            Err(_) => return (bytes, false),
        }
    }
}

fn kill_group(pid: u32) {
    let _ = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(pid as i32),
        nix::sys::signal::Signal::SIGKILL,
    );
}

fn run_child(
    command: &PinnedCommand,
    root: &Path,
    runtime_root: &Path,
    workspace_root: &Path,
    environment: &Value,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    assert_command_current(command)?;
    let executable = command
        .file
        .try_clone()
        .map_err(|_| "full_production_package_readiness_child_infrastructure_failed".to_owned())?;
    fcntl(&executable, FcntlArg::F_SETFD(FdFlag::empty()))
        .map_err(|_| "full_production_package_readiness_child_infrastructure_failed".to_owned())?;
    // Rust inherits this explicitly uncloexec'd descriptor without remapping it.
    // Node maps the same pinned descriptor to fd 3; its numeric slot is not an
    // authority property. Using the actual slot avoids closing an unrelated fd.
    let mut child = Command::new(format!("/proc/self/fd/{}", executable.as_raw_fd()));
    child
        .args([
            "--action",
            "retention-recovery-readiness",
            "--root",
            &root.to_string_lossy(),
            "--runtime-root",
            &runtime_root.to_string_lossy(),
        ])
        .current_dir(workspace_root)
        .env_clear()
        .envs(restricted_environment(environment))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = child
        .spawn()
        .map_err(|_| "full_production_package_readiness_child_infrastructure_failed".to_owned())?;
    let pid = child.id();
    let stdout = child.stdout.take().ok_or_else(|| {
        "full_production_package_readiness_child_infrastructure_failed".to_owned()
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        "full_production_package_readiness_child_infrastructure_failed".to_owned()
    })?;
    if !nonblocking(&stdout) || !nonblocking(&stderr) {
        kill_group(pid);
        let _ = child.wait();
        return Err("full_production_package_readiness_child_infrastructure_failed".to_owned());
    }
    let stopped = AtomicBool::new(false);
    let overflow = AtomicBool::new(false);
    let started = Instant::now();
    let (status, timed_out, stdout, stderr) = thread::scope(|scope| {
        let out = scope.spawn(|| bounded_output(stdout, &stopped, &overflow));
        let err = scope.spawn(|| bounded_output(stderr, &stopped, &overflow));
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if started.elapsed() < timeout && !overflow.load(Ordering::Acquire) => {
                    thread::sleep(Duration::from_millis(5))
                }
                Ok(None) => {
                    timed_out = true;
                    break None;
                }
                Err(_) => break None,
            }
        };
        kill_group(pid);
        let _ = child.kill();
        let _ = child.wait();
        stopped.store(true, Ordering::Release);
        (status, timed_out, out.join(), err.join())
    });
    drop(executable);
    let (stdout, stdout_complete) = stdout
        .map_err(|_| "full_production_package_readiness_child_infrastructure_failed".to_owned())?;
    let (_, stderr_complete) = stderr
        .map_err(|_| "full_production_package_readiness_child_infrastructure_failed".to_owned())?;
    if timed_out
        || overflow.load(Ordering::Acquire)
        || !stdout_complete
        || !stderr_complete
        || !status.is_some_and(|value| value.success())
    {
        return Err("full_production_package_readiness_child_infrastructure_failed".to_owned());
    }
    Ok(stdout)
}

/// Execute a root-owned command via an inherited descriptor and validate its
/// exact v2 JSON protocol. Any infrastructure, identity, timeout, or protocol
/// failure is returned as a fail-closed error string.
pub fn query_package_retention_recovery_readiness_v1(
    command_path: &Path,
    command_hash: &str,
    root: &Path,
    runtime_root: &Path,
    workspace_root: &Path,
    environment: &Value,
) -> Result<Value, String> {
    if !root.is_absolute()
        || !runtime_root.is_absolute()
        || !workspace_root.is_absolute()
        || root.to_str().is_none()
        || runtime_root.to_str().is_none()
        || workspace_root.to_str().is_none()
    {
        return Err("full_production_package_readiness_inputs_invalid".to_owned());
    }
    let command = open_pinned_command(command_path, command_hash, 0, Path::new("/"))?;
    query_pinned_command(
        &command,
        root,
        runtime_root,
        workspace_root,
        environment,
        Duration::from_millis(PACKAGE_READINESS_TIMEOUT_MS),
        current_observation,
    )
}

fn current_observation() -> Result<String, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "full_production_readiness_clock_invalid".to_owned())?
        .as_millis();
    let now =
        i64::try_from(now).map_err(|_| "full_production_readiness_clock_invalid".to_owned())?;
    let observed_at = crate::external_authority_intake::unix_millis_to_iso_v1(now)
        .map_err(|_| "full_production_readiness_clock_invalid".to_owned())?;
    Ok(observed_at)
}

fn query_pinned_command(
    command: &PinnedCommand,
    root: &Path,
    runtime_root: &Path,
    workspace_root: &Path,
    environment: &Value,
    timeout: Duration,
    observe_now: impl FnOnce() -> Result<String, String>,
) -> Result<Value, String> {
    let stdout = run_child(
        command,
        root,
        runtime_root,
        workspace_root,
        environment,
        timeout,
    );
    // Identity drift takes precedence even if the child failed infrastructure.
    assert_command_current(command)?;
    let stdout = stdout?;
    let response: Value = serde_json::from_slice(&stdout)
        .map_err(|_| "full_production_package_readiness_child_output_invalid".to_owned())?;
    if !response.is_object() {
        return Err("full_production_package_readiness_child_output_invalid".to_owned());
    }
    let observed_at = observe_now()?;
    let inspection = policy::inspect_package_retention_recovery_readiness_response_v1(
        &response,
        &json!(observed_at),
    )
    .map_err(|error| error.to_string())?;
    Ok(json!({"observedAt": observed_at, "inspection": inspection}))
}

#[cfg(test)]
#[path = "package_recovery_tests.rs"]
mod tests;
