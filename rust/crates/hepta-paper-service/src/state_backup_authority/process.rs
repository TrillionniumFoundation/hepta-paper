use super::*;
use nix::fcntl::{FcntlArg, FdFlag, OFlag, fcntl};
use std::{
    io::{Read, Write},
    os::{
        fd::{AsFd, AsRawFd},
        unix::process::CommandExt,
    },
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
const LIMIT: usize = 256 * 1024 * 1024;
pub struct ProcessStateBackupAuthorityTransportV1 {
    configuration: Snapshot,
    public_document: Snapshot,
    command: Snapshot,
    online_configuration: Option<Snapshot>,
    timeout_ms: u64,
}
impl ProcessStateBackupAuthorityTransportV1 {
    pub fn load(path: &Path, pin: &str) -> Result<Self> {
        let (configuration, value) = load_configuration(path, pin)?;
        let code = "autonomous_research_state_backup_authority_process_identity_mismatch";
        let public_document = Snapshot::load(
            Path::new(text(&value, "publicKeyPath")?),
            text(&value, "publicKeySha256")?,
            64 * 1024,
            code,
        )?;
        let command = Snapshot::load(
            Path::new(text(&value, "commandPath")?),
            text(&value, "commandSha256")?,
            256 * 1024 * 1024,
            code,
        )?;
        if !command.executable() {
            return Err(error(code));
        }
        let online_configuration = if number(&value["version"]) == Some(2) {
            Some(Snapshot::load(
                Path::new(text(&value, "onlineMutationAuthorityConfigurationPath")?),
                text(&value, "onlineMutationAuthorityConfigurationSha256")?,
                4 * 1024 * 1024,
                "autonomous_research_state_backup_online_authority_identity_mismatch",
            )?)
        } else {
            None
        };
        let timeout_ms = number(&value["timeoutMs"])
            .and_then(|v| u64::try_from(v).ok())
            .ok_or_else(|| error(code))?;
        Ok(Self {
            configuration,
            public_document,
            command,
            online_configuration,
            timeout_ms,
        })
    }
    pub(super) fn current(&self) -> Result<()> {
        for file in [&self.configuration, &self.public_document, &self.command]
            .into_iter()
            .chain(self.online_configuration.as_ref())
        {
            file.assert_current()
                .map_err(|_| error("autonomous_research_state_backup_authority_command_changed"))?;
        }
        Ok(())
    }
}
fn nonblocking(pipe: &impl AsFd) -> bool {
    fcntl(pipe, FcntlArg::F_GETFL).ok().is_some_and(|flags| {
        fcntl(
            pipe,
            FcntlArg::F_SETFL(OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK),
        )
        .is_ok()
    })
}
fn write_input(mut pipe: impl Write, input: &[u8], stopped: &AtomicBool) -> bool {
    let mut offset = 0;
    while offset < input.len() {
        match pipe.write(&input[offset..]) {
            Ok(0) => return false,
            Ok(count) => offset += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if stopped.load(Ordering::Acquire) {
                    return false;
                }
                thread::sleep(Duration::from_millis(2));
            }
            Err(_) => return false,
        }
    }
    true
}
fn output(
    mut pipe: impl Read,
    retain: bool,
    overflow: &AtomicBool,
    stopped: &AtomicBool,
) -> (Vec<u8>, bool) {
    let mut bytes = Vec::new();
    let mut total = 0usize;
    let mut buffer = [0; 8192];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => return (bytes, true),
            Ok(count) => {
                total = total.saturating_add(count);
                if total > LIMIT {
                    overflow.store(true, Ordering::Release);
                    return (bytes, false);
                }
                if retain {
                    bytes.extend_from_slice(&buffer[..count]);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if stopped.load(Ordering::Acquire) {
                    return (bytes, false);
                }
                thread::sleep(Duration::from_millis(2));
            }
            Err(_) => return (bytes, false),
        }
    }
}
impl StateBackupAuthorityTransportV1 for ProcessStateBackupAuthorityTransportV1 {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        self.current()?;
        let failed = || error("autonomous_research_state_backup_authority_process_failed");
        let mut input = serde_json::to_vec(request).map_err(|_| failed())?;
        input.push(b'\n');
        if input.len() > LIMIT {
            return Err(failed());
        }
        // Execute the already pinned inode. Keeping this descriptor across exec
        // supports shebang executables without reopening a swapped pathname.
        let executable = self.command.file.try_clone().map_err(|_| failed())?;
        fcntl(&executable, FcntlArg::F_SETFD(FdFlag::empty())).map_err(|_| failed())?;
        let descriptor_path = PathBuf::from(format!("/proc/self/fd/{}", executable.as_raw_fd()));
        let mut child = Command::new(descriptor_path)
            .env_clear()
            .envs([("PATH", "/usr/bin:/bin"), ("LANG", "C"), ("LC_ALL", "C")])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|_| failed())?;
        let process_id = i32::try_from(child.id()).map_err(|_| failed())?;
        let stdout = child.stdout.take().ok_or_else(failed)?;
        let stderr = child.stderr.take().ok_or_else(failed)?;
        let stdin = child.stdin.take().ok_or_else(failed)?;
        if !nonblocking(&stdout) || !nonblocking(&stderr) || !nonblocking(&stdin) {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(process_id),
                nix::sys::signal::Signal::SIGKILL,
            );
            let _ = child.kill();
            let _ = child.wait();
            return Err(failed());
        }
        let stopped = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        let overflow = Arc::new(AtomicBool::new(false));
        let (status, expired, stdout, stderr, written) = thread::scope(|scope| {
            let out_overflow = overflow.clone();
            let err_overflow = overflow.clone();
            let out_stopped = stopped.clone();
            let err_stopped = stopped.clone();
            let in_stopped = stopped.clone();
            let out = scope.spawn(move || output(stdout, true, &out_overflow, &out_stopped));
            let err = scope.spawn(move || output(stderr, false, &err_overflow, &err_stopped));
            let written = scope.spawn(move || write_input(stdin, &input, &in_stopped));
            let mut expired = false;
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) => {
                        if started.elapsed() >= Duration::from_millis(self.timeout_ms)
                            || overflow.load(Ordering::Acquire)
                        {
                            expired = true;
                            break None;
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break None,
                }
            };
            // Even an exited leader may leave descendants holding the protocol
            // pipes. End the entire process group before joining IO threads.
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(process_id),
                nix::sys::signal::Signal::SIGKILL,
            );
            let _ = child.kill();
            let _ = child.wait();
            stopped.store(true, Ordering::Release);
            (status, expired, out.join(), err.join(), written.join())
        });
        drop(executable);
        let (stdout, stdout_ok) = stdout.map_err(|_| failed())?;
        let (_, stderr_ok) = stderr.map_err(|_| failed())?;
        if expired
            || !status.is_some_and(|s| s.success())
            || !stdout_ok
            || !stderr_ok
            || !written.is_ok_and(|r| r)
        {
            return Err(failed());
        }
        self.current()?;
        pinned_files::parse(
            &stdout,
            "autonomous_research_state_backup_authority_process_output_invalid",
        )
    }
}
