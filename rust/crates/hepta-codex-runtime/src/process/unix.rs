use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use std::os::unix::process::{CommandExt, ExitStatusExt};

use super::{
    io::{
        StreamKind, receive_output, receive_stdin_result, spawn_output_reader, spawn_stdin_writer,
    },
    types::{
        BoundedProcessError, BoundedProcessRequestV1, BoundedProcessResultV1,
        MAXIMUM_ARGUMENT_BYTES, MAXIMUM_ARGUMENT_COUNT, ProcessLimitsV1, ProcessTerminationReason,
    },
};

pub fn run_bounded_process(
    request: &BoundedProcessRequestV1,
    limits: ProcessLimitsV1,
) -> Result<BoundedProcessResultV1, BoundedProcessError> {
    run_bounded_process_with_spawn_hook(request, limits, |_| Ok(()))
}

/// Spawns a new Unix process group, then runs a fail-closed synchronous hook
/// before normal supervision continues. A rejected hook kills and reaps the
/// entire group before returning.
pub fn run_bounded_process_with_spawn_hook<F>(
    request: &BoundedProcessRequestV1,
    limits: ProcessLimitsV1,
    on_spawn: F,
) -> Result<BoundedProcessResultV1, BoundedProcessError>
where
    F: FnOnce(u32) -> Result<(), BoundedProcessError>,
{
    let limits = limits.validate()?;
    validate_request(request, limits)?;
    let kill_utility = resolve_kill_utility()?;

    let mut command = Command::new(&request.executable);
    command
        .args(&request.arguments)
        .current_dir(&request.working_directory)
        .env_clear()
        .stdin(if request.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    for (key, value) in request.environment.iter() {
        command.env(key, value);
    }

    let started = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|error| BoundedProcessError::Spawn(error.kind()))?;
    let process_id = child.id();
    if process_id == 0 || process_id > i32::MAX as u32 {
        cleanup_after_error(&mut child, &kill_utility, process_id, limits);
        return Err(BoundedProcessError::InvalidProcessId(process_id));
    }
    if let Err(error) = on_spawn(process_id) {
        cleanup_after_error(&mut child, &kill_utility, process_id, limits);
        return Err(error);
    }

    let result = supervise_spawned_group(
        &mut child,
        process_id,
        request,
        limits,
        &kill_utility,
        started,
    );
    if result.is_err() {
        cleanup_after_error(&mut child, &kill_utility, process_id, limits);
    }
    result
}

fn supervise_spawned_group(
    child: &mut Child,
    process_id: u32,
    request: &BoundedProcessRequestV1,
    limits: ProcessLimitsV1,
    kill_utility: &Path,
    started: Instant,
) -> Result<BoundedProcessResultV1, BoundedProcessError> {
    let stdout = child
        .stdout
        .take()
        .ok_or(BoundedProcessError::MissingPipe("stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or(BoundedProcessError::MissingPipe("stderr"))?;
    let (limit_tx, limit_rx) = mpsc::channel();
    let stdout_rx = spawn_output_reader(
        stdout,
        StreamKind::Stdout,
        limits.maximum_stdout_bytes,
        limits.maximum_tail_bytes,
        limit_tx.clone(),
    );
    let stderr_rx = spawn_output_reader(
        stderr,
        StreamKind::Stderr,
        limits.maximum_stderr_bytes,
        limits.maximum_tail_bytes,
        limit_tx,
    );
    let stdin_rx = spawn_stdin_writer(child.stdin.take(), request.stdin.clone());

    let timeout = Duration::from_millis(limits.timeout_ms);
    let grace = Duration::from_millis(limits.termination_grace_ms);
    let cleanup_timeout = Duration::from_millis(limits.cleanup_timeout_ms);
    let poll = Duration::from_millis(limits.poll_interval_ms);
    let mut reason = None;
    let mut termination_requested_at = None;
    let mut kill_sent = false;
    let mut leader_status = None;

    loop {
        if reason.is_none() {
            if let Ok(stream) = limit_rx.try_recv() {
                reason = Some(match stream {
                    StreamKind::Stdout => ProcessTerminationReason::StdoutLimitExceeded,
                    StreamKind::Stderr => ProcessTerminationReason::StderrLimitExceeded,
                });
            } else if started.elapsed() >= timeout {
                reason = Some(ProcessTerminationReason::TimedOut);
            }
        }

        if reason.is_some() && termination_requested_at.is_none() {
            send_group_signal(kill_utility, process_id, "TERM")?;
            termination_requested_at = Some(Instant::now());
        }
        if let Some(requested_at) = termination_requested_at
            && !kill_sent
            && requested_at.elapsed() >= grace
            && process_group_alive(kill_utility, process_id)?
        {
            send_group_signal(kill_utility, process_id, "KILL")?;
            kill_sent = true;
        }

        if leader_status.is_none() {
            leader_status = child
                .try_wait()
                .map_err(|error| BoundedProcessError::Wait(error.kind()))?;
        }
        if leader_status.is_some() {
            if !process_group_alive(kill_utility, process_id)? {
                break;
            }
            if reason.is_none() {
                reason = Some(ProcessTerminationReason::DescendantSurvivedLeader);
                send_group_signal(kill_utility, process_id, "TERM")?;
                termination_requested_at = Some(Instant::now());
            }
        }

        if let Some(requested_at) = termination_requested_at
            && requested_at.elapsed() >= cleanup_timeout
        {
            if process_group_alive(kill_utility, process_id)? {
                if !kill_sent {
                    send_group_signal(kill_utility, process_id, "KILL")?;
                }
                return Err(BoundedProcessError::ProcessGroupCleanupTimeout(process_id));
            }
            break;
        }
        thread::sleep(poll);
    }

    let status = match leader_status {
        Some(status) => status,
        None => child
            .wait()
            .map_err(|error| BoundedProcessError::Wait(error.kind()))?,
    };
    let remaining = cleanup_timeout.saturating_sub(
        termination_requested_at.map_or(Duration::ZERO, |instant| instant.elapsed()),
    );
    receive_stdin_result(stdin_rx, remaining)?;
    let stdout = receive_output(stdout_rx, remaining, "stdout")?;
    let stderr = receive_output(stderr_rx, remaining, "stderr")?;
    if reason.is_none() && stdout.bytes > limits.maximum_stdout_bytes {
        reason = Some(ProcessTerminationReason::StdoutLimitExceeded);
    }
    if reason.is_none() && stderr.bytes > limits.maximum_stderr_bytes {
        reason = Some(ProcessTerminationReason::StderrLimitExceeded);
    }
    let process_group_cleanup_verified = !process_group_alive(kill_utility, process_id)?;
    if !process_group_cleanup_verified {
        return Err(BoundedProcessError::ProcessGroupCleanupUnverified(
            process_id,
        ));
    }

    Ok(BoundedProcessResultV1 {
        process_id,
        exit_code: status.code(),
        signal: status.signal(),
        stdout_hash: stdout.hash,
        stderr_hash: stderr.hash,
        stdout_bytes: stdout.bytes,
        stderr_bytes: stderr.bytes,
        stdout_tail: stdout.tail,
        stderr_tail: stderr.tail,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        termination_reason: reason.unwrap_or(ProcessTerminationReason::Exited),
        termination_escalated: kill_sent,
        process_group_cleanup_verified,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

fn validate_request(
    request: &BoundedProcessRequestV1,
    limits: ProcessLimitsV1,
) -> Result<(), BoundedProcessError> {
    if !request.executable.is_absolute() || !request.working_directory.is_absolute() {
        return Err(BoundedProcessError::AbsolutePathRequired);
    }
    validate_canonical_path(&request.executable, "executable")?;
    validate_canonical_path(&request.working_directory, "working_directory")?;

    let executable_metadata = fs::symlink_metadata(&request.executable)
        .map_err(|error| BoundedProcessError::Filesystem("executable", error.kind()))?;
    if executable_metadata.file_type().is_symlink() || !executable_metadata.is_file() {
        return Err(BoundedProcessError::ExecutableNotRegularFile);
    }
    let executable_mode = executable_metadata.mode() & 0o7777;
    if executable_mode & 0o7000 != 0 || executable_mode & 0o022 != 0 || executable_mode & 0o100 == 0
    {
        return Err(BoundedProcessError::ExecutablePermissionsInvalid(
            executable_mode,
        ));
    }

    let working_directory = fs::symlink_metadata(&request.working_directory)
        .map_err(|error| BoundedProcessError::Filesystem("working_directory", error.kind()))?;
    if working_directory.file_type().is_symlink() || !working_directory.is_dir() {
        return Err(BoundedProcessError::WorkingDirectoryInvalid);
    }
    if request.arguments.len() > MAXIMUM_ARGUMENT_COUNT {
        return Err(BoundedProcessError::TooManyArguments);
    }
    let argument_bytes = request
        .arguments
        .iter()
        .try_fold(0usize, |total, argument| {
            if argument.as_encoded_bytes().contains(&0) {
                return Err(BoundedProcessError::ArgumentContainsNul);
            }
            total
                .checked_add(argument.as_encoded_bytes().len())
                .ok_or(BoundedProcessError::ArgumentBytesExceeded)
        })?;
    if argument_bytes > MAXIMUM_ARGUMENT_BYTES {
        return Err(BoundedProcessError::ArgumentBytesExceeded);
    }
    if request
        .stdin
        .as_ref()
        .is_some_and(|value| value.len() > limits.maximum_stdin_bytes)
    {
        return Err(BoundedProcessError::StdinBytesExceeded);
    }
    Ok(())
}

fn validate_canonical_path(path: &Path, subject: &'static str) -> Result<(), BoundedProcessError> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| BoundedProcessError::Filesystem(subject, error.kind()))?;
    if canonical != path {
        return Err(BoundedProcessError::NonCanonicalPath(subject));
    }
    Ok(())
}

fn resolve_kill_utility() -> Result<PathBuf, BoundedProcessError> {
    for candidate in [Path::new("/usr/bin/kill"), Path::new("/bin/kill")] {
        let Ok(canonical) = fs::canonicalize(candidate) else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&canonical) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let mode = metadata.mode() & 0o7777;
        if mode & 0o7022 != 0 || mode & 0o100 == 0 {
            return Err(BoundedProcessError::ProcessGroupControlPermissionsInvalid(
                mode,
            ));
        }
        if metadata.uid() != 0 {
            return Err(BoundedProcessError::ProcessGroupControlOwnerInvalid(
                metadata.uid(),
            ));
        }
        if metadata.nlink() != 1 {
            return Err(BoundedProcessError::ProcessGroupControlLinkCountInvalid(
                metadata.nlink(),
            ));
        }
        return Ok(canonical);
    }
    Err(BoundedProcessError::ProcessGroupControlUnavailable)
}

fn send_group_signal(
    kill_utility: &Path,
    process_id: u32,
    signal: &str,
) -> Result<(), BoundedProcessError> {
    let status = group_signal_status(kill_utility, process_id, signal)?;
    if status.success() {
        Ok(())
    } else if process_group_alive(kill_utility, process_id)? {
        Err(BoundedProcessError::ProcessGroupSignalFailed {
            process_id,
            signal: signal.to_owned(),
        })
    } else {
        Ok(())
    }
}

fn process_group_alive(kill_utility: &Path, process_id: u32) -> Result<bool, BoundedProcessError> {
    Ok(group_signal_status(kill_utility, process_id, "0")?.success())
}

fn group_signal_status(
    kill_utility: &Path,
    process_id: u32,
    signal: &str,
) -> Result<ExitStatus, BoundedProcessError> {
    Command::new(kill_utility)
        .arg(format!("-{signal}"))
        .arg("--")
        .arg(format!("-{process_id}"))
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| BoundedProcessError::SignalUtility(error.kind()))
}

fn cleanup_after_error(
    child: &mut Child,
    kill_utility: &Path,
    process_id: u32,
    limits: ProcessLimitsV1,
) {
    if process_id != 0 && process_id <= i32::MAX as u32 {
        let _ = send_group_signal(kill_utility, process_id, "KILL");
    }
    let _ = child.kill();
    let _ = child.wait();

    let deadline = Instant::now() + Duration::from_millis(limits.cleanup_timeout_ms);
    while process_id != 0 && process_id <= i32::MAX as u32 && Instant::now() < deadline {
        match process_group_alive(kill_utility, process_id) {
            Ok(false) | Err(_) => break,
            Ok(true) => {
                let _ = send_group_signal(kill_utility, process_id, "KILL");
                thread::sleep(Duration::from_millis(limits.poll_interval_ms));
            }
        }
    }
}
