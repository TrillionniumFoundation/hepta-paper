//! Thin tar and fixed-snapshot HTTPS adapters over the existing process owner.
//! No shell, inherited tool options, alternate supervisor or authority.
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
        self.capture(&request, limits, "archive")
    }

    /// Explicit fixed-origin GET only; response bytes are still untrusted until
    /// the existing archive, lock-closure and publication owners accept them.
    pub(super) fn snapshot_archive(
        &mut self,
        entry: &serde_json::Value,
        target: &Path,
    ) -> Result<Vec<u8>, String> {
        require_active(self.cancelled)?;
        if self.outcome_unknown {
            return Err("r_runtime_source_cas_snapshot_cleanup_unverified".into());
        }
        let url = snapshot_url(entry)?;
        let executable =
            tool_path("curl").map_err(|_| "r_runtime_source_cas_snapshot_transport_unavailable")?;
        let working_directory = fs::canonicalize(
            target
                .parent()
                .ok_or("r_runtime_source_cas_archive_invalid")?,
        )
        .map_err(|_| "r_runtime_source_cas_archive_invalid")?;
        let environment = EnvironmentPolicyV1::new(
            "r-source-cas-snapshot-v1",
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
        .map_err(|_| "r_runtime_source_cas_snapshot_transport_invalid")?;
        // --disable must be first: never consult curlrc. No credentials, proxy,
        // redirects, alternate origin or caller headers are inherited/accepted.
        let archive_bound = SNAPSHOT_ARCHIVE_BYTES.to_string();
        let timeout_seconds = (SNAPSHOT_TIMEOUT_MS / 1000).to_string();
        let request = BoundedProcessRequestV1 {
            executable,
            arguments: [
                "--disable",
                "--silent",
                "--show-error",
                "--globoff",
                "--proto",
                "=https",
                "--proxy",
                "",
                "--noproxy",
                "*",
                "--request",
                "GET",
                "--connect-timeout",
                "15",
                "--max-time",
                &timeout_seconds,
                "--max-filesize",
                &archive_bound,
                "--retry",
                "0",
                "--max-redirs",
                "0",
                "--header",
                "Accept: application/gzip, application/octet-stream",
                "--write-out",
                "\nHEPTA_R_SOURCE_HTTP_V1\n%{http_code}\n%{url_effective}\n",
                "--url",
                &url,
            ]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect(),
            working_directory,
            environment,
            stdin: None,
        };
        let limits = ProcessLimitsV1 {
            timeout_ms: SNAPSHOT_TIMEOUT_MS,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2_000,
            poll_interval_ms: 10,
            maximum_stdin_bytes: 1,
            maximum_stdout_bytes: SNAPSHOT_ARCHIVE_BYTES + 1024,
            maximum_stderr_bytes: 64 * 1024,
            maximum_tail_bytes: 4096,
        };
        let output = self.capture(&request, limits, "snapshot")?;
        snapshot_response(output, &url).map_err(|error| {
            // The package file is validated fixed-snapshot data, not a secret or
            // caller path. Retain which exact lock entry refused acquisition.
            format!("{error}:{}", entry["file"].as_str().unwrap_or("invalid"))
        })
    }

    fn capture(
        &mut self,
        request: &BoundedProcessRequestV1,
        limits: ProcessLimitsV1,
        kind: &str,
    ) -> Result<Vec<u8>, String> {
        self.outcome_unknown = true;
        let captured = match run_bounded_process_capturing_stdout_with_cancellation(
            request,
            limits,
            self.cancelled,
        ) {
            Ok(captured) => captured,
            Err(BoundedProcessError::CancelledBeforeSpawn) => {
                self.outcome_unknown = false;
                return Err("r_runtime_source_cas_cancelled".into());
            }
            Err(_) => return Err(format!("r_runtime_source_cas_{kind}_cleanup_unverified")),
        };
        if !captured.process.process_group_cleanup_verified {
            return Err(format!("r_runtime_source_cas_{kind}_cleanup_unverified"));
        }
        self.outcome_unknown = false;
        match captured.process.termination_reason {
            ProcessTerminationReason::Cancelled => {
                return Err("r_runtime_source_cas_cancelled".into());
            }
            ProcessTerminationReason::TimedOut => {
                return Err(format!("r_runtime_source_cas_{kind}_timeout"));
            }
            ProcessTerminationReason::Exited => {}
            _ => return Err(format!("r_runtime_source_cas_{kind}_invalid")),
        }
        if captured.process.exit_code != Some(0)
            || captured.process.stdout_bytes != captured.stdout.len() as u64
            || super::digest(&captured.stdout) != captured.process.stdout_hash.as_str()
        {
            return Err(format!("r_runtime_source_cas_{kind}_invalid"));
        }
        require_active(self.cancelled)?;
        Ok(captured.stdout)
    }
}

fn tar_path() -> Result<PathBuf, String> {
    tool_path("tar")
}

fn tool_path(name: &str) -> Result<PathBuf, String> {
    // Resolve the explicitly selected PATH once. The generic owner then enforces
    // canonical regular-file/executable permissions; this is not tool qualification.
    let path = std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into());
    for directory in std::env::split_paths(&path) {
        if !directory.is_absolute() {
            continue;
        }
        let candidate = directory.join(name);
        if !candidate.is_file() {
            continue;
        }
        return fs::canonicalize(candidate)
            .map_err(|_| "r_runtime_source_cas_archive_invalid".into());
    }
    Err("r_runtime_source_cas_archive_invalid".into())
}

// Leave room for the bounded response trailer inside the unchanged 64 MiB
// process-owner stdout ceiling. This explicit profile is slightly narrower
// than Node's 64 MiB archive transport; it never enlarges the shared owner.
const SNAPSHOT_ARCHIVE_BYTES: u64 = 63 * 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS: u64 = 120_000;
const HTTP_TRAILER: &[u8] = b"\nHEPTA_R_SOURCE_HTTP_V1\n";

fn snapshot_url(entry: &serde_json::Value) -> Result<String, String> {
    let package = entry["package"]
        .as_str()
        .ok_or("r_runtime_source_cas_lock_entry_invalid")?;
    let version = entry["version"]
        .as_str()
        .ok_or("r_runtime_source_cas_lock_entry_invalid")?;
    let file = format!("{package}_{version}.tar.gz");
    if !super::valid_package(package)
        || !super::valid_version(version)
        || entry["file"].as_str() != Some(file.as_str())
    {
        return Err("r_runtime_source_cas_lock_entry_invalid".into());
    }
    Ok(format!("{}/src/contrib/{file}", super::SNAPSHOT))
}

fn snapshot_response(mut bytes: Vec<u8>, expected_url: &str) -> Result<Vec<u8>, String> {
    let trailer_len = HTTP_TRAILER.len() + 3 + 1 + expected_url.len() + 1;
    let body_len = bytes
        .len()
        .checked_sub(trailer_len)
        .ok_or("r_runtime_source_cas_snapshot_response_invalid")?;
    let tail = &bytes[body_len..];
    if !tail.starts_with(HTTP_TRAILER)
        || tail[HTTP_TRAILER.len() + 3] != b'\n'
        || &tail[HTTP_TRAILER.len() + 4..tail.len() - 1] != expected_url.as_bytes()
        || tail.last() != Some(&b'\n')
    {
        return Err("r_runtime_source_cas_snapshot_response_invalid".into());
    }
    let status = &tail[HTTP_TRAILER.len()..HTTP_TRAILER.len() + 3];
    if !status.iter().all(u8::is_ascii_digit) {
        return Err("r_runtime_source_cas_snapshot_response_invalid".into());
    }
    let status = u16::from(status[0] - b'0') * 100
        + u16::from(status[1] - b'0') * 10
        + u16::from(status[2] - b'0');
    if !(200..300).contains(&status) {
        return Err(format!("r_runtime_source_cas_snapshot_http_{status}"));
    }
    if body_len as u64 > SNAPSHOT_ARCHIVE_BYTES {
        return Err("r_runtime_source_cas_snapshot_size_exceeded".into());
    }
    bytes.truncate(body_len);
    Ok(bytes)
}

#[cfg(test)]
mod tests;
