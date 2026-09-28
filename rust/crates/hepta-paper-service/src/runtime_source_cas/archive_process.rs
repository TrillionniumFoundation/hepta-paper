//! Thin tar adapter over the existing bounded process-group owner.
//! No shell, inherited tar/gzip options, alternate supervisor or authority.
use hepta_codex_runtime::{
    BoundedProcessError, BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1,
    ProcessTerminationReason, run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) fn require_active(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        Err("r_runtime_source_cas_cancelled".to_owned())
    } else {
        Ok(())
    }
}

pub(super) struct ArchiveExecution<'a> {
    cancelled: &'a AtomicBool,
    outcome_unknown: bool,
}
impl<'a> ArchiveExecution<'a> {
    pub(super) fn new(cancelled: &'a AtomicBool) -> Self {
        Self {
            cancelled,
            outcome_unknown: false,
        }
    }
    pub(super) fn cleanup_verified(&self) -> bool {
        !self.outcome_unknown
    }
    pub(super) fn output(
        &mut self,
        args: &[&str],
        archive: &Path,
        trailing: Option<&str>,
        limit: u64,
    ) -> Result<Vec<u8>, String> {
        require_active(self.cancelled)?;
        if self.outcome_unknown {
            return Err("r_runtime_source_cas_archive_cleanup_unverified".into());
        }
        let executable = tar_path()?;
        let working_directory = fs::canonicalize(
            archive
                .parent()
                .ok_or("r_runtime_source_cas_archive_invalid")?,
        )
        .map_err(|_| "r_runtime_source_cas_archive_invalid")?;
        let environment = EnvironmentPolicyV1::new(
            "r-source-cas-tar-v1",
            ["PATH", "LC_ALL"],
            ["PATH", "LC_ALL"],
        )
        .and_then(|policy| {
            policy.build(
                std::iter::empty(),
                &BTreeMap::from([
                    ("PATH".into(), "/usr/bin:/bin".into()),
                    ("LC_ALL".into(), "C".into()),
                ]),
            )
        })
        .map_err(|_| "r_runtime_source_cas_archive_invalid")?;
        let mut arguments = args
            .iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>();
        arguments.push(archive.as_os_str().to_owned());
        if let Some(trailing) = trailing {
            // Archive-controlled member names are data, never tar options.
            arguments.push("--".into());
            arguments.push(trailing.into());
        }
        let request = BoundedProcessRequestV1 {
            executable,
            arguments,
            working_directory,
            environment,
            stdin: None,
        };
        let limits = ProcessLimitsV1 {
            timeout_ms: 60_000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2_000,
            poll_interval_ms: 10,
            maximum_stdin_bytes: 1,
            maximum_stdout_bytes: limit,
            maximum_stderr_bytes: 64 * 1024,
            maximum_tail_bytes: 4096,
        };
        self.outcome_unknown = true;
        let captured = match run_bounded_process_capturing_stdout_with_cancellation(
            &request,
            limits,
            self.cancelled,
        ) {
            Ok(captured) => captured,
            Err(BoundedProcessError::CancelledBeforeSpawn) => {
                self.outcome_unknown = false;
                return Err("r_runtime_source_cas_cancelled".into());
            }
            Err(_) => return Err("r_runtime_source_cas_archive_cleanup_unverified".into()),
        };
        if !captured.process.process_group_cleanup_verified {
            return Err("r_runtime_source_cas_archive_cleanup_unverified".into());
        }
        self.outcome_unknown = false;
        match captured.process.termination_reason {
            ProcessTerminationReason::Cancelled => {
                return Err("r_runtime_source_cas_cancelled".into());
            }
            ProcessTerminationReason::TimedOut => {
                return Err("r_runtime_source_cas_archive_timeout".into());
            }
            ProcessTerminationReason::Exited => {}
            _ => return Err("r_runtime_source_cas_archive_invalid".into()),
        }
        if captured.process.exit_code != Some(0)
            || captured.process.stdout_bytes != captured.stdout.len() as u64
            || super::digest(&captured.stdout) != captured.process.stdout_hash.as_str()
        {
            return Err("r_runtime_source_cas_archive_invalid".into());
        }
        require_active(self.cancelled)?;
        Ok(captured.stdout)
    }
}

fn tar_path() -> Result<PathBuf, String> {
    // Resolve the explicitly selected PATH once. The generic owner then enforces
    // canonical regular-file/executable permissions; this is not tool qualification.
    let path = std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into());
    for directory in std::env::split_paths(&path) {
        if !directory.is_absolute() {
            continue;
        }
        let candidate = directory.join("tar");
        if !candidate.is_file() {
            continue;
        }
        return fs::canonicalize(candidate)
            .map_err(|_| "r_runtime_source_cas_archive_invalid".into());
    }
    Err("r_runtime_source_cas_archive_invalid".into())
}
