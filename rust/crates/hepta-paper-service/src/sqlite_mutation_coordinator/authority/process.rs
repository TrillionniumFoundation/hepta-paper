use super::*;
mod native_command;
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
const LIMIT: usize = 64 * 1024 * 1024;
pub struct ProcessMutationAuthorityTransportV1 {
    process_configuration: Snapshot,
    authority_configuration: Snapshot,
    command: Snapshot,
    pub(super) authority_configuration_path: PathBuf,
    pub(super) authority_configuration_pin: String,
    pub(super) timeout_ms: u64,
    pub(super) configuration_hash: String,
}
impl ProcessMutationAuthorityTransportV1 {
    pub fn load(path: &Path, expected_file_hash: &str) -> Result<Self> {
        let code = "autonomous_research_online_mutation_authority_process_configuration_invalid";
        let process_configuration =
            Snapshot::load(path, expected_file_hash, 4 * 1024 * 1024, code)?;
        let value = process_configuration.json(code)?;
        if !keys(
            &value,
            &[
                "version",
                "kind",
                "authorityConfigurationPath",
                "authorityConfigurationSha256",
                "commandPath",
                "commandSha256",
                "fixedArguments",
                "timeoutMs",
            ],
        ) || value["version"] != 1
            || value["kind"] != "AutonomousResearchOnlineMutationAuthorityProcessConfiguration"
            || !["authorityConfigurationPath", "commandPath"]
                .iter()
                .all(|key| {
                    value[key]
                        .as_str()
                        .is_some_and(|v| Path::new(v).is_absolute())
                })
            || !["authorityConfigurationSha256", "commandSha256"]
                .iter()
                .all(|key| sha(&value[key]))
            || !value["fixedArguments"]
                .as_array()
                .is_some_and(Vec::is_empty)
            || !value["timeoutMs"]
                .as_u64()
                .is_some_and(|v| (1000..=120000).contains(&v))
        {
            return Err(error(code));
        }
        let authority_configuration_path =
            PathBuf::from(text(&value, "authorityConfigurationPath")?);
        let authority_configuration_pin = text(&value, "authorityConfigurationSha256")?.to_owned();
        let identity_code =
            "autonomous_research_online_mutation_authority_process_identity_mismatch";
        let authority_configuration = Snapshot::load(
            &authority_configuration_path,
            &authority_configuration_pin,
            4 * 1024 * 1024,
            identity_code,
        )?;
        let command = Snapshot::load(
            Path::new(text(&value, "commandPath")?),
            text(&value, "commandSha256")?,
            128 * 1024 * 1024,
            identity_code,
        )?;
        if !command.executable() {
            return Err(error(identity_code));
        }
        let timeout_ms = value["timeoutMs"].as_u64().ok_or_else(|| error(code))?;
        Ok(Self {
            process_configuration,
            authority_configuration,
            command,
            authority_configuration_path,
            authority_configuration_pin,
            timeout_ms,
            configuration_hash: hash(
                "AutonomousResearchOnlineMutationAuthorityProcessConfiguration",
                &value,
            )?,
        })
    }
    pub(crate) fn current(&self) -> Result<()> {
        self.process_configuration.assert_current()?;
        self.authority_configuration.assert_current()?;
        self.command.assert_current()
    }

    /// Necessary native-command checks against the actual retained executable.
    /// Expected identity must come from a separately verified, closed adapter
    /// binding. ELF format alone also admits interpreters such as Node; this
    /// method grants no adapter provenance, deployment or runtime authority.
    /// Loading/capturing all inputs must precede an owning SQLite connection;
    /// this assertion only reads existing descriptors and named metadata.
    #[allow(dead_code)] // The native-only owning route is wired separately.
    pub(crate) fn assert_native_process_command_v1(
        &self,
        expected_command_path: &Path,
        expected_command_hash: &hepta_codex_protocol::Sha256Digest,
    ) -> Result<()> {
        self.current()?;
        self.command.assert_native_elf_command_v1(
            expected_command_path,
            expected_command_hash,
            "autonomous_research_online_mutation_authority_native_command_invalid",
        )?;
        self.current()
    }
}

impl PinnedMutationAuthorityV1<ProcessMutationAuthorityTransportV1> {
    /// Check all genuine verifier/process pins and the exact retained native
    /// command without an RPC. This is a necessary file-format/identity check,
    /// not proof that the command implements a reviewed native authority role.
    #[allow(dead_code)]
    pub(crate) fn assert_native_process_command_v1(
        &self,
        expected_command_path: &Path,
        expected_command_hash: &hepta_codex_protocol::Sha256Digest,
    ) -> Result<()> {
        self.assert_process_current_v1()?;
        self.transport
            .assert_native_process_command_v1(expected_command_path, expected_command_hash)?;
        self.assert_process_current_v1()
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
impl MutationAuthorityTransportV1 for ProcessMutationAuthorityTransportV1 {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        self.current()?;
        let failed = || error("autonomous_research_online_mutation_authority_process_failed");
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
        files::parse(
            &stdout,
            "autonomous_research_online_mutation_authority_process_output_invalid",
        )
    }
}
