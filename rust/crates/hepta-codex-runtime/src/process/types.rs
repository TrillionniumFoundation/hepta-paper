use std::{ffi::OsString, io, path::PathBuf};

use hepta_codex_protocol::Sha256Digest;
use thiserror::Error;

use crate::RestrictedEnvironmentV1;

pub(super) const MAXIMUM_ARGUMENT_COUNT: usize = 4096;
pub(super) const MAXIMUM_ARGUMENT_BYTES: usize = 1024 * 1024;
pub(super) const MINIMUM_POLL_INTERVAL_MS: u64 = 2;
pub(super) const MAXIMUM_POLL_INTERVAL_MS: u64 = 250;
pub(super) const MAXIMUM_TIMEOUT_MS: u64 = 6 * 60 * 60 * 1000;
pub(super) const MAXIMUM_TERMINATION_GRACE_MS: u64 = 5 * 60 * 1000;
pub(super) const MAXIMUM_CLEANUP_TIMEOUT_MS: u64 = 10 * 60 * 1000;
pub(super) const MAXIMUM_STDIN_BYTES: usize = 64 * 1024 * 1024;
pub(super) const MAXIMUM_STDOUT_BYTES: u64 = 64 * 1024 * 1024;
pub(super) const MAXIMUM_STDERR_BYTES: u64 = 16 * 1024 * 1024;
pub(super) const MAXIMUM_TAIL_BYTES: usize = 1024 * 1024;

/// Resource and cleanup limits for one process-group execution.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessLimitsV1 {
    pub timeout_ms: u64,
    pub termination_grace_ms: u64,
    pub cleanup_timeout_ms: u64,
    pub poll_interval_ms: u64,
    pub maximum_stdin_bytes: usize,
    pub maximum_stdout_bytes: u64,
    pub maximum_stderr_bytes: u64,
    pub maximum_tail_bytes: usize,
}

impl Default for ProcessLimitsV1 {
    fn default() -> Self {
        Self {
            timeout_ms: 30 * 60 * 1000,
            termination_grace_ms: 5_000,
            cleanup_timeout_ms: 10_000,
            poll_interval_ms: 20,
            maximum_stdin_bytes: 8 * 1024 * 1024,
            maximum_stdout_bytes: 8 * 1024 * 1024,
            maximum_stderr_bytes: 2 * 1024 * 1024,
            maximum_tail_bytes: 256 * 1024,
        }
    }
}

impl ProcessLimitsV1 {
    pub(super) fn validate(self) -> Result<Self, BoundedProcessError> {
        let maximum_tail_bytes = u64::try_from(self.maximum_tail_bytes)
            .map_err(|_| BoundedProcessError::InvalidLimits)?;
        if self.timeout_ms == 0
            || self.timeout_ms > MAXIMUM_TIMEOUT_MS
            || self.termination_grace_ms == 0
            || self.termination_grace_ms > MAXIMUM_TERMINATION_GRACE_MS
            || self.cleanup_timeout_ms < self.termination_grace_ms
            || self.cleanup_timeout_ms > MAXIMUM_CLEANUP_TIMEOUT_MS
            || !(MINIMUM_POLL_INTERVAL_MS..=MAXIMUM_POLL_INTERVAL_MS)
                .contains(&self.poll_interval_ms)
            || self.maximum_stdin_bytes == 0
            || self.maximum_stdin_bytes > MAXIMUM_STDIN_BYTES
            || self.maximum_stdout_bytes == 0
            || self.maximum_stdout_bytes > MAXIMUM_STDOUT_BYTES
            || self.maximum_stderr_bytes == 0
            || self.maximum_stderr_bytes > MAXIMUM_STDERR_BYTES
            || self.maximum_tail_bytes == 0
            || self.maximum_tail_bytes > MAXIMUM_TAIL_BYTES
            || maximum_tail_bytes > self.maximum_stdout_bytes
            || maximum_tail_bytes > self.maximum_stderr_bytes
        {
            return Err(BoundedProcessError::InvalidLimits);
        }
        Ok(self)
    }
}

/// Fully materialized local process request. No shell interpolation is performed.
#[derive(Clone, Debug)]
pub struct BoundedProcessRequestV1 {
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub working_directory: PathBuf,
    pub environment: RestrictedEnvironmentV1,
    pub stdin: Option<Vec<u8>>,
}

/// Why the supervisor ended or terminated the process group.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessTerminationReason {
    Exited,
    TimedOut,
    StdoutLimitExceeded,
    StderrLimitExceeded,
    DescendantSurvivedLeader,
}

/// Bounded exact-byte observations from one supervised process group.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundedProcessResultV1 {
    pub process_id: u32,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout_hash: Sha256Digest,
    pub stderr_hash: Sha256Digest,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub stdout_tail: Vec<u8>,
    pub stderr_tail: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub termination_reason: ProcessTerminationReason,
    pub termination_escalated: bool,
    pub process_group_cleanup_verified: bool,
    pub elapsed_ms: u64,
}

/// Process validation, spawn, I/O, timeout or process-group cleanup failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum BoundedProcessError {
    #[error("bounded process limits are invalid")]
    InvalidLimits,
    #[error("executable and working directory must be absolute")]
    AbsolutePathRequired,
    #[error("executable must be a real regular file")]
    ExecutableNotRegularFile,
    #[error("executable permissions are invalid: {0:o}")]
    ExecutablePermissionsInvalid(u32),
    #[error("{0} path is noncanonical or contains a symlink component")]
    NonCanonicalPath(&'static str),
    #[error("working directory must be a real directory")]
    WorkingDirectoryInvalid,
    #[error("process-group control utility permissions are invalid: {0:o}")]
    ProcessGroupControlPermissionsInvalid(u32),
    #[error("process-group control utility owner is invalid: {0}")]
    ProcessGroupControlOwnerInvalid(u32),
    #[error("process-group control utility link count is invalid: {0}")]
    ProcessGroupControlLinkCountInvalid(u64),
    #[error("process request contains too many arguments")]
    TooManyArguments,
    #[error("process request argument bytes exceed the limit")]
    ArgumentBytesExceeded,
    #[error("process request argument contains NUL")]
    ArgumentContainsNul,
    #[error("process request stdin bytes exceed the limit")]
    StdinBytesExceeded,
    #[error("process spawn failed: {0:?}")]
    Spawn(io::ErrorKind),
    #[error("spawned process id is invalid: {0}")]
    InvalidProcessId(u32),
    #[error("spawned process is missing its {0} pipe")]
    MissingPipe(&'static str),
    #[error("process wait failed: {0:?}")]
    Wait(io::ErrorKind),
    #[error("stdin write failed: {0:?}")]
    StdinWrite(io::ErrorKind),
    #[error("stdin writer did not finish")]
    StdinWriterDidNotFinish,
    #[error("stdin writer disconnected")]
    StdinWriterDisconnected,
    #[error("{0} read failed: {1:?}")]
    OutputRead(&'static str, io::ErrorKind),
    #[error("{0} reader did not finish")]
    OutputReaderDidNotFinish(&'static str),
    #[error("{0} reader disconnected")]
    OutputReaderDisconnected(&'static str),
    #[error("process-group control utility is unavailable")]
    ProcessGroupControlUnavailable,
    #[error("process-group signal utility failed: {0:?}")]
    SignalUtility(io::ErrorKind),
    #[error("failed to signal process group {process_id} with {signal}")]
    ProcessGroupSignalFailed { process_id: u32, signal: String },
    #[error("process group {0} did not terminate before cleanup deadline")]
    ProcessGroupCleanupTimeout(u32),
    #[error("process group {0} cleanup could not be verified")]
    ProcessGroupCleanupUnverified(u32),
    #[error("filesystem operation failed for {0}: {1:?}")]
    Filesystem(&'static str, io::ErrorKind),
}
