//! Resource limits for ordinary, read-only provenance and imported evidence.
//! The existing provenance/sealed algorithms remain the byte identity owners.
//! Process cancellation and cleanup use the existing bounded runtime owner.
use super::{OperationalStatusError, Result, error, files};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    RestrictedEnvironmentV1, run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

pub(super) const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub(super) const MAX_ENTRIES: usize = 200_000;
const MAX_OPERATION_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const TIMEOUT_MS: u64 = 120_000;

pub(super) struct Observation<'a> {
    cancelled: &'a AtomicBool,
    started: Instant,
    timeout_ms: u64,
    source_bytes: u64,
    source_entries: usize,
    git_path: PathBuf,
    git_file: File,
    git_metadata: Metadata,
    environment: RestrictedEnvironmentV1,
}

fn read_error(_: std::io::Error) -> OperationalStatusError {
    error("code_provenance_entry_read_failed")
}

impl<'a> Observation<'a> {
    pub(super) fn new(cancelled: &'a AtomicBool) -> Result<Self> {
        Self::select(cancelled, PathBuf::from("/usr/bin/git"), TIMEOUT_MS, true)
    }

    fn select(
        cancelled: &'a AtomicBool,
        git_path: PathBuf,
        timeout_ms: u64,
        production: bool,
    ) -> Result<Self> {
        if cancelled.load(Ordering::Acquire) {
            return Err(error("code_provenance_cancelled"));
        }
        let mut git_file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
            .open(&git_path)
            .map_err(|_| error("code_provenance_git_executable_invalid"))?;
        let git_metadata = git_file
            .metadata()
            .map_err(|_| error("code_provenance_git_executable_invalid"))?;
        if !git_metadata.is_file()
            || git_metadata.mode() & 0o111 == 0
            || git_metadata.mode() & 0o022 != 0
            || !(4..=MAX_FILE_BYTES).contains(&git_metadata.len())
            || (production && git_metadata.uid() != 0)
        {
            return Err(error("code_provenance_git_executable_invalid"));
        }
        let mut magic = [0; 4];
        git_file
            .read_exact(&mut magic)
            .map_err(|_| error("code_provenance_git_executable_invalid"))?;
        if production && magic != *b"\x7fELF" {
            return Err(error("code_provenance_git_executable_invalid"));
        }
        let environment = EnvironmentPolicyV1::new(
            "ordinary-provenance-fixed-git-v1",
            [
                "PATH",
                "HOME",
                "XDG_CONFIG_HOME",
                "LANG",
                "LC_ALL",
                "GIT_OPTIONAL_LOCKS",
                "GIT_NO_REPLACE_OBJECTS",
                "GIT_CONFIG_NOSYSTEM",
                "GIT_CONFIG_GLOBAL",
                "GIT_NO_LAZY_FETCH",
                "GIT_TERMINAL_PROMPT",
                "GIT_LFS_SKIP_SMUDGE",
            ],
            ["PATH", "LANG", "LC_ALL"],
        )
        .map_err(|_| error("code_provenance_git_environment_invalid"))?
        .build(
            std::iter::empty::<(OsString, OsString)>(),
            &BTreeMap::from(
                [
                    ("PATH", "/usr/bin:/bin"),
                    ("HOME", "/nonexistent"),
                    ("XDG_CONFIG_HOME", "/nonexistent"),
                    ("LANG", "C.UTF-8"),
                    ("LC_ALL", "C.UTF-8"),
                    ("GIT_OPTIONAL_LOCKS", "0"),
                    ("GIT_NO_REPLACE_OBJECTS", "1"),
                    ("GIT_CONFIG_NOSYSTEM", "1"),
                    ("GIT_CONFIG_GLOBAL", "/dev/null"),
                    ("GIT_NO_LAZY_FETCH", "1"),
                    ("GIT_TERMINAL_PROMPT", "0"),
                    ("GIT_LFS_SKIP_SMUDGE", "1"),
                ]
                .map(|(key, value)| (key.to_owned(), value.to_owned())),
            ),
        )
        .map_err(|_| error("code_provenance_git_environment_invalid"))?;
        let observation = Self {
            cancelled,
            started: Instant::now(),
            timeout_ms,
            source_bytes: 0,
            source_entries: 0,
            git_path,
            git_file,
            git_metadata,
            environment,
        };
        observation.checkpoint()?;
        Ok(observation)
    }

    pub(super) fn checkpoint(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(error("code_provenance_cancelled"));
        }
        if self.started.elapsed().as_millis() >= u128::from(self.timeout_ms) {
            return Err(error("code_provenance_deadline_exceeded"));
        }
        let named = fs::symlink_metadata(&self.git_path)
            .map_err(|_| error("code_provenance_git_executable_changed"))?;
        let held = self
            .git_file
            .metadata()
            .map_err(|_| error("code_provenance_git_executable_changed"))?;
        if !files::same(&self.git_metadata, &named) || !files::same(&self.git_metadata, &held) {
            return Err(error("code_provenance_git_executable_changed"));
        }
        Ok(())
    }

    pub(super) fn entry(&mut self) -> Result<()> {
        self.checkpoint()?;
        self.source_entries = self
            .source_entries
            .checked_add(1)
            .filter(|count| *count <= MAX_ENTRIES)
            .ok_or_else(|| error("code_provenance_entry_budget_exceeded"))?;
        Ok(())
    }

    pub(super) fn file_size(&self, size: u64) -> Result<()> {
        self.checkpoint()?;
        if size > MAX_FILE_BYTES {
            return Err(error("code_provenance_file_budget_exceeded"));
        }
        Ok(())
    }

    pub(super) fn consume(&mut self, count: usize) -> Result<()> {
        self.checkpoint()?;
        self.source_bytes = self
            .source_bytes
            .checked_add(count as u64)
            .filter(|count| *count <= MAX_OPERATION_BYTES)
            .ok_or_else(|| error("code_provenance_read_budget_exceeded"))?;
        Ok(())
    }

    pub(super) fn read_capacity(&self, requested: usize) -> Result<usize> {
        self.checkpoint()?;
        let remaining = MAX_OPERATION_BYTES.saturating_sub(self.source_bytes);
        let capacity = remaining.min(requested as u64) as usize;
        if capacity == 0 {
            return Err(error("code_provenance_read_budget_exceeded"));
        }
        Ok(capacity)
    }

    pub(super) fn open_regular(&self, path: &Path) -> Result<File> {
        self.checkpoint()?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
            .open(path)
            .map_err(read_error)?;
        let metadata = file.metadata().map_err(read_error)?;
        if !metadata.is_file() {
            return Err(error("code_provenance_entry_not_regular"));
        }
        self.file_size(metadata.len())?;
        Ok(file)
    }

    pub(super) fn read_file(&mut self, path: &Path, limit: u64) -> Result<Vec<u8>> {
        let named = fs::symlink_metadata(path).map_err(read_error)?;
        let mut file = self.open_regular(path)?;
        let before = file.metadata().map_err(read_error)?;
        if !files::same(&named, &before) || before.len() > limit {
            return Err(error("code_provenance_file_budget_exceeded"));
        }
        let mut bytes = Vec::new();
        let mut buffer = [0; 64 * 1024];
        loop {
            self.checkpoint()?;
            let remaining = before.len().saturating_sub(bytes.len() as u64);
            if remaining == 0 {
                break;
            }
            let capacity = self.read_capacity(remaining.min(buffer.len() as u64) as usize)?;
            let count = file.read(&mut buffer[..capacity]).map_err(read_error)?;
            if count == 0 {
                break;
            }
            self.consume(count)?;
            bytes.extend_from_slice(&buffer[..count]);
        }
        if bytes.len() as u64 != before.len()
            || !files::same(&before, &file.metadata().map_err(read_error)?)
            || !files::same(&before, &fs::symlink_metadata(path).map_err(read_error)?)
        {
            return Err(error("code_provenance_snapshot_changed_during_scan"));
        }
        Ok(bytes)
    }

    pub(super) fn git(
        &mut self,
        root: &Path,
        operation: &str,
        args: &[&str],
        empty: bool,
    ) -> Result<Vec<u8>> {
        self.checkpoint()?;
        let elapsed = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let mut arguments: Vec<OsString> = [
            "--no-replace-objects",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
        ]
        .iter()
        .map(OsString::from)
        .collect();
        arguments.push(OsString::from("-c"));
        arguments.push(OsString::from(format!("safe.directory={}", root.display())));
        arguments.extend(args.iter().map(OsString::from));
        let result = run_bounded_process_capturing_stdout_with_cancellation(
            &BoundedProcessRequestV1 {
                executable: self.git_path.clone(),
                arguments,
                working_directory: root.into(),
                environment: self.environment.clone(),
                stdin: None,
            },
            ProcessLimitsV1 {
                timeout_ms: self.timeout_ms.saturating_sub(elapsed),
                termination_grace_ms: 100,
                cleanup_timeout_ms: 2000,
                maximum_stdin_bytes: 1,
                maximum_stdout_bytes: 64 * 1024 * 1024,
                maximum_stderr_bytes: 1024 * 1024,
                maximum_tail_bytes: 4096,
                ..ProcessLimitsV1::default()
            },
            self.cancelled,
        )
        .map_err(|_| error(&format!("code_provenance_git_spawn_failed:{operation}")))?;
        self.checkpoint()?;
        let process = result.process;
        if process.termination_reason != ProcessTerminationReason::Exited
            || !process.process_group_cleanup_verified
        {
            return Err(error(match process.termination_reason {
                ProcessTerminationReason::Cancelled => "code_provenance_cancelled",
                ProcessTerminationReason::TimedOut => "code_provenance_deadline_exceeded",
                ProcessTerminationReason::StdoutLimitExceeded
                | ProcessTerminationReason::StderrLimitExceeded => {
                    "code_provenance_git_output_budget_exceeded"
                }
                _ => "code_provenance_git_cleanup_unverified",
            }));
        }
        if process.exit_code != Some(0) || process.signal.is_some() {
            return Err(error(&format!(
                "code_provenance_git_command_failed:{operation}:exit_{}:stderr_{}",
                process
                    .exit_code
                    .map_or("no_status".to_owned(), |code| code.to_string()),
                process
                    .stderr_hash
                    .as_str()
                    .strip_prefix("sha256:")
                    .unwrap_or(process.stderr_hash.as_str())
            )));
        }
        if !empty && result.stdout.is_empty() {
            return Err(error(&format!(
                "code_provenance_git_output_required:{operation}"
            )));
        }
        self.consume(result.stdout.len())?;
        Ok(result.stdout)
    }
}

impl super::provenance::ProvenanceObservationV1 for Observation<'_> {
    fn git(&mut self, root: &Path, operation: &str, args: &[&str], empty: bool) -> Result<Vec<u8>> {
        Self::git(self, root, operation, args, empty)
    }
    fn checkpoint(&mut self) -> Result<()> {
        Self::checkpoint(self)
    }
    fn repository_entry_count(&mut self, count: usize) -> Result<()> {
        self.checkpoint()?;
        if count > MAX_ENTRIES {
            return Err(error("code_provenance_entry_budget_exceeded"));
        }
        Ok(())
    }
    fn source_entry(&mut self, _: &Path, _: &str) -> Result<()> {
        self.entry()
    }
    fn file_size(&mut self, size: u64) -> Result<()> {
        Self::file_size(self, size)
    }
    fn consume(&mut self, bytes: usize) -> Result<()> {
        Self::consume(self, bytes)
    }
    fn read_capacity(&mut self, requested: usize) -> Result<usize> {
        Self::read_capacity(self, requested)
    }
    fn open_regular(&mut self, root: &Path, relative: &str) -> Result<File> {
        Self::open_regular(self, &root.join(relative))
    }
    fn payload(&mut self, _: &str, _: Option<u32>, _: Option<&[u8]>) -> Result<()> {
        Self::checkpoint(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::unix::fs::PermissionsExt, sync::atomic::AtomicU64, time::Duration};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "hepta-bounded-provenance-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            Self(root)
        }
        fn script(&self, body: &str) -> PathBuf {
            let path = self.0.join("git");
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn ordinary_provenance_refuses_cancelled_requests_before_source_or_git_observation() {
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            Observation::new(&cancelled).err().unwrap().0,
            "code_provenance_cancelled"
        );
    }

    #[test]
    fn ordinary_provenance_refuses_actual_fifo_and_oversized_regular_source_files() {
        let fixture = Fixture::new();
        let cancelled = AtomicBool::new(false);
        let mut observation = Observation::new(&cancelled).unwrap();
        let fifo = fixture.0.join("fifo");
        nix::unistd::mkfifo(
            &fifo,
            nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
        )
        .unwrap();
        assert_eq!(
            observation.read_file(&fifo, MAX_FILE_BYTES).unwrap_err().0,
            "code_provenance_entry_not_regular"
        );
        let oversized = fixture.0.join("oversized");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        assert_eq!(
            observation
                .read_file(&oversized, MAX_FILE_BYTES)
                .unwrap_err()
                .0,
            "code_provenance_file_budget_exceeded"
        );
    }

    #[test]
    fn ordinary_provenance_stops_actual_file_reads_at_the_remaining_operation_budget() {
        let fixture = Fixture::new();
        let cancelled = AtomicBool::new(false);
        let mut observation = Observation::new(&cancelled).unwrap();
        let path = fixture.0.join("bytes");
        fs::write(&path, b"abcd").unwrap();
        observation.source_bytes = MAX_OPERATION_BYTES - 2;
        assert_eq!(
            observation.read_file(&path, MAX_FILE_BYTES).unwrap_err().0,
            "code_provenance_read_budget_exceeded"
        );
        assert_eq!(observation.source_bytes, MAX_OPERATION_BYTES);
    }

    #[test]
    fn ordinary_git_observation_retains_tool_identity_and_refuses_identical_byte_rewrites() {
        let fixture = Fixture::new();
        let cancelled = AtomicBool::new(false);
        let path = fixture.0.join("git");
        let bytes = fs::read("/usr/bin/git").unwrap();
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let observation = Observation::select(&cancelled, path.clone(), TIMEOUT_MS, false).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        fs::write(&path, &bytes).unwrap();
        assert_eq!(
            observation.checkpoint().unwrap_err().0,
            "code_provenance_git_executable_changed"
        );
    }

    #[test]
    fn ordinary_git_observation_refuses_actual_stdout_and_stderr_overflow() {
        for (count, redirect) in [(64 * 1024 * 1024 + 1, ""), (1024 * 1024 + 1, " >&2")] {
            let fixture = Fixture::new();
            let cancelled = AtomicBool::new(false);
            let script = fixture.script(&format!(
                "exec /usr/bin/head -c {count} /dev/zero{redirect}"
            ));
            let mut observation =
                Observation::select(&cancelled, script, TIMEOUT_MS, false).unwrap();
            assert_eq!(
                observation
                    .git(&fixture.0, "head", &["rev-parse", "HEAD"], false)
                    .unwrap_err()
                    .0,
                "code_provenance_git_output_budget_exceeded"
            );
        }
    }

    fn pid_state(path: &Path) -> Option<(u64, String)> {
        let pid: u64 = fs::read_to_string(path).ok()?.trim().parse().ok()?;
        let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let (_, tail) = text.rsplit_once(')')?;
        let fields: Vec<_> = tail.split_whitespace().collect();
        Some((fields.get(19)?.parse().ok()?, fields.first()?.to_string()))
    }

    #[test]
    fn ordinary_git_observation_cancels_an_actual_started_child_and_cleans_its_process_group() {
        let fixture = Fixture::new();
        let cancelled = AtomicBool::new(false);
        let pid = fixture.0.join("pid");
        let script = fixture.script(&format!(
            "printf '%s\\n' \"$$\" > '{}'; exec /usr/bin/sleep 30",
            pid.display()
        ));
        let mut observation = Observation::select(&cancelled, script, TIMEOUT_MS, false).unwrap();
        std::thread::scope(|scope| {
            let barrier = scope.spawn(|| {
                let started = Instant::now();
                loop {
                    if let Some(identity) = pid_state(&pid) {
                        cancelled.store(true, Ordering::Release);
                        return identity;
                    }
                    assert!(
                        started.elapsed() < Duration::from_secs(10),
                        "actual child startup barrier"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
            });
            assert_eq!(
                observation
                    .git(&fixture.0, "head", &["rev-parse", "HEAD"], false)
                    .unwrap_err()
                    .0,
                "code_provenance_cancelled"
            );
            let prior = barrier.join().unwrap();
            assert!(
                pid_state(&pid).is_none_or(|now| now.0 != prior.0 || now.1 == "Z"),
                "original owned child remains live"
            );
        });
    }

    #[test]
    fn ordinary_git_observation_enforces_its_deadline_on_an_actual_started_child() {
        let fixture = Fixture::new();
        let cancelled = AtomicBool::new(false);
        let pid = fixture.0.join("pid");
        let script = fixture.script(&format!(
            "printf '%s\\n' \"$$\" > '{}'; exec /usr/bin/sleep 30",
            pid.display()
        ));
        let mut observation = Observation::select(&cancelled, script, 2000, false).unwrap();
        assert_eq!(
            observation
                .git(&fixture.0, "head", &["rev-parse", "HEAD"], false)
                .unwrap_err()
                .0,
            "code_provenance_deadline_exceeded"
        );
        assert!(pid.exists(), "deadline test reached actual child");
        assert!(
            pid_state(&pid).is_none_or(|now| now.1 == "Z"),
            "original owned child remains live"
        );
    }
}
