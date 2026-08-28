use std::{
    fs,
    io::{self, Read, Write},
    os::unix::process::{CommandExt, ExitStatusExt},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    str::FromStr,
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    thread,
    time::{Duration, Instant},
};

use hepta_codex_protocol::Sha256Digest;
use sha2::{Digest, Sha256};

use super::types::{
    BoundedProcessError, BoundedProcessRequestV1, BoundedProcessResultV1,
    MAXIMUM_ARGUMENT_BYTES, MAXIMUM_ARGUMENT_COUNT, ProcessLimitsV1,
    ProcessTerminationReason,
};

/// Spawns and supervises a new Unix process group with default-deny environment and hard limits.
pub fn run_bounded_process(
    request: &BoundedProcessRequestV1,
    limits: ProcessLimitsV1,
) -> Result<BoundedProcessResultV1, BoundedProcessError> {
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
        let _ = child.kill();
        let _ = child.wait();
        return Err(BoundedProcessError::InvalidProcessId(process_id));
    }

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
            send_group_signal(&kill_utility, process_id, "TERM")?;
            termination_requested_at = Some(Instant::now());
        }
        if let Some(requested_at) = termination_requested_at
            && !kill_sent
            && requested_at.elapsed() >= grace
            && process_group_alive(&kill_utility, process_id)?
        {
            send_group_signal(&kill_utility, process_id, "KILL")?;
            kill_sent = true;
        }

        if leader_status.is_none() {
            leader_status = child
                .try_wait()
                .map_err(|error| BoundedProcessError::Wait(error.kind()))?;
        }
        if leader_status.is_some() {
            if !process_group_alive(&kill_utility, process_id)? {
                break;
            }
            if reason.is_none() {
                reason = Some(ProcessTerminationReason::DescendantSurvivedLeader);
                send_group_signal(&kill_utility, process_id, "TERM")?;
                termination_requested_at = Some(Instant::now());
            }
        }

        if let Some(requested_at) = termination_requested_at
            && requested_at.elapsed() >= cleanup_timeout
        {
            if process_group_alive(&kill_utility, process_id)? {
                if !kill_sent {
                    send_group_signal(&kill_utility, process_id, "KILL")?;
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(BoundedProcessError::ProcessGroupCleanupTimeout(
                    process_id,
                ));
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
    let process_group_cleanup_verified = !process_group_alive(&kill_utility, process_id)?;
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
    let executable_metadata = fs::symlink_metadata(&request.executable)
        .map_err(|error| BoundedProcessError::Filesystem("executable", error.kind()))?;
    if executable_metadata.file_type().is_symlink() || !executable_metadata.is_file() {
        return Err(BoundedProcessError::ExecutableNotRegularFile);
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

fn spawn_stdin_writer<W>(
    stdin: Option<W>,
    input: Option<Vec<u8>>,
) -> Receiver<Result<(), io::ErrorKind>>
where
    W: Write + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = match (stdin, input) {
            (Some(mut stdin), Some(input)) => stdin
                .write_all(&input)
                .and_then(|()| stdin.flush())
                .map_err(|error| error.kind()),
            _ => Ok(()),
        };
        let _ = sender.send(result);
    });
    receiver
}

fn spawn_output_reader<R: Read + Send + 'static>(
    mut reader: R,
    stream: StreamKind,
    maximum_bytes: u64,
    maximum_tail_bytes: usize,
    limit_sender: Sender<StreamKind>,
) -> Receiver<Result<OutputObservation, io::ErrorKind>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        let mut tail = Vec::new();
        let mut limit_reported = false;
        let mut buffer = [0_u8; 64 * 1024];
        let result = loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => break digest_output(hasher, total, tail),
                Ok(read) => read,
                Err(error) => break Err(error.kind()),
            };
            hasher.update(&buffer[..read]);
            let Some(next_total) = total.checked_add(u64::try_from(read).unwrap_or(u64::MAX))
            else {
                break Err(io::ErrorKind::OutOfMemory);
            };
            total = next_total;
            append_tail(&mut tail, &buffer[..read], maximum_tail_bytes);
            if total > maximum_bytes && !limit_reported {
                limit_reported = true;
                let _ = limit_sender.send(stream);
            }
        };
        let _ = sender.send(result);
    });
    receiver
}

fn append_tail(tail: &mut Vec<u8>, chunk: &[u8], maximum_tail_bytes: usize) {
    if chunk.len() >= maximum_tail_bytes {
        tail.clear();
        tail.extend_from_slice(&chunk[chunk.len() - maximum_tail_bytes..]);
        return;
    }
    let required = tail.len().saturating_add(chunk.len());
    if required > maximum_tail_bytes {
        tail.drain(..required - maximum_tail_bytes);
    }
    tail.extend_from_slice(chunk);
}

fn digest_output(
    hasher: Sha256,
    bytes: u64,
    tail: Vec<u8>,
) -> Result<OutputObservation, io::ErrorKind> {
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    let hash = Sha256Digest::from_str(&value).map_err(|_| io::ErrorKind::InvalidData)?;
    Ok(OutputObservation {
        hash,
        bytes,
        truncated: bytes > u64::try_from(tail.len()).unwrap_or(u64::MAX),
        tail,
    })
}

fn receive_stdin_result(
    receiver: Receiver<Result<(), io::ErrorKind>>,
    timeout: Duration,
) -> Result<(), BoundedProcessError> {
    match receiver.recv_timeout(nonzero_timeout(timeout)) {
        Ok(Ok(())) | Ok(Err(io::ErrorKind::BrokenPipe)) => Ok(()),
        Ok(Err(kind)) => Err(BoundedProcessError::StdinWrite(kind)),
        Err(RecvTimeoutError::Timeout) => Err(BoundedProcessError::StdinWriterDidNotFinish),
        Err(RecvTimeoutError::Disconnected) => {
            Err(BoundedProcessError::StdinWriterDisconnected)
        }
    }
}

fn receive_output(
    receiver: Receiver<Result<OutputObservation, io::ErrorKind>>,
    timeout: Duration,
    stream: &'static str,
) -> Result<OutputObservation, BoundedProcessError> {
    match receiver.recv_timeout(nonzero_timeout(timeout)) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(kind)) => Err(BoundedProcessError::OutputRead(stream, kind)),
        Err(RecvTimeoutError::Timeout) => {
            Err(BoundedProcessError::OutputReaderDidNotFinish(stream))
        }
        Err(RecvTimeoutError::Disconnected) => {
            Err(BoundedProcessError::OutputReaderDisconnected(stream))
        }
    }
}

fn nonzero_timeout(timeout: Duration) -> Duration {
    if timeout.is_zero() {
        Duration::from_millis(1)
    } else {
        timeout
    }
}

#[derive(Clone, Copy, Debug)]
enum StreamKind {
    Stdout,
    Stderr,
}

struct OutputObservation {
    hash: Sha256Digest,
    bytes: u64,
    tail: Vec<u8>,
    truncated: bool,
}

fn resolve_kill_utility() -> Result<PathBuf, BoundedProcessError> {
    [Path::new("/bin/kill"), Path::new("/usr/bin/kill")]
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(Path::to_path_buf)
        .ok_or(BoundedProcessError::ProcessGroupControlUnavailable)
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

fn process_group_alive(
    kill_utility: &Path,
    process_id: u32,
) -> Result<bool, BoundedProcessError> {
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
