use super::*;
use nix::fcntl::{FcntlArg, FdFlag, OFlag, fcntl};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    os::{
        fd::{AsFd, AsRawFd},
        unix::process::CommandExt,
    },
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
mod executable;
mod identity;
use executable::PinnedExecutable;
use identity::*;

/// Contains only public signing keys. Controller code never opens signer private keys.
#[derive(Debug)]
pub struct ProcessConfiguration {
    pub identity: Value,
    pub public_keys: Vec<String>,
    processes: Vec<VerifierProcess>,
    config_path: PathBuf,
    config_hash: String,
    environment: Value,
    pinned: bool,
}
impl ProcessConfiguration {
    pub(super) fn is_pinned(&self) -> bool {
        self.pinned
    }
}
#[derive(Debug)]
pub struct VerifierProcess {
    command: Value,
    environment: BTreeMap<String, String>,
    executable: PinnedExecutable,
}

/// Load and pin both actual command/credential/backend identities. `expected_pin`
/// is the Node-compatible configuration identity hash, not a JSON content hash.
pub fn read_runtime_image_reproducibility_process_configuration_v1(
    path: &Path,
    expected_pin: Option<&str>,
    environment: &Value,
) -> Result<ProcessConfiguration> {
    let bytes = read(path, 256 * 1024)?;
    let value = parse(&bytes)?;
    ensure(
        exact(
            &value,
            &[
                "buildArgs",
                "kind",
                "maximumReceiptAgeMs",
                "platform",
                "sourceDateEpoch",
                "maximumVerificationCostUsd",
                "status",
                "verificationCostAuthority",
                "verifiers",
                "version",
            ],
        ) && value["version"] == 1
            && value["kind"] == "RuntimeImageReproducibilityProcessConfiguration"
            && value["status"] == "active"
            && value["maximumReceiptAgeMs"]
                .as_u64()
                .is_some_and(|n| (60_000..=86_400_000).contains(&n))
            && value["maximumVerificationCostUsd"]
                .as_f64()
                .is_some_and(|n| (0.0..=1_000_000.0).contains(&n))
            && array(&value["verifiers"]).len() == 2
            && !private_material(&value),
        "runtime_reproducibility_configuration_invalid",
    )?;
    ensure(
        value["platform"] == "linux/amd64"
            && value["sourceDateEpoch"] == SOURCE_DATE_EPOCH
            && value["buildArgs"] == json!({}),
        "runtime_reproducibility_canonical_build_configuration_drift",
    )?;
    let cost = value["maximumVerificationCostUsd"].as_f64().unwrap_or(-1.0);
    ensure(
        (value["verificationCostAuthority"] == "operator_declared_worst_case_usd" && cost > 0.0)
            || (value["verificationCostAuthority"] == "externally_operated_zero_cost"
                && cost == 0.0),
        "runtime_reproducibility_configuration_invalid",
    )?;
    ensure(
        environment.as_object().is_some_and(|o| {
            o.len() <= 256
                && o.iter().all(|(k, v)| {
                    k.len() <= 128
                        && v.as_str()
                            .is_some_and(|s| s.len() <= 65536 && !s.contains('\0'))
                })
        }),
        "runtime_reproducibility_environment_invalid",
    )?;
    let mut processes = Vec::new();
    let mut verifiers = Vec::new();
    let mut keys = Vec::new();
    for item in array(&value["verifiers"]) {
        ensure(
            exact(item, &["attestor", "command"]),
            "runtime_reproducibility_configuration_invalid",
        )?;
        let process = command(&item["command"], path, environment)?;
        let (signer, pem, spki) = signer(&item["attestor"], path)?;
        let c = &process.command;
        let service_hash = hash(
            "RuntimeImageReproducibilityVerifierServiceIdentity",
            &json!({"serviceId":c["serviceId"],"principalId":c["principalId"],"commandIdentityHash":c["commandIdentityHash"],"backendIdentityHash":c["backend"]["backendIdentityHash"],"signerPublicKeySpkiHash":spki}),
        )?;
        verifiers.push(json!({"serviceId":c["serviceId"],"principalId":c["principalId"],"commandIdentityHash":c["commandIdentityHash"],"serviceIdentityHash":service_hash,"credentialRootIdentityHash":c["credentialRootIdentityHash"],"credentialMaterialIdentityHash":c["credentialMaterialIdentityHash"],"credentialRootUsage":c["credentialRootUsage"],"executableContentHash":c["executableContentHash"],"backend":c["backend"],"signer":signer,"signerPublicKeySpkiHash":spki}));
        keys.push(pem);
        processes.push(process);
    }
    independent(&processes, &verifiers)?;
    let max_timeout = processes
        .iter()
        .filter_map(|p| p.command["timeoutMs"].as_u64())
        .max()
        .unwrap_or(0);
    ensure(
        max_timeout + 60_000 < value["maximumReceiptAgeMs"].as_u64().unwrap_or(0),
        "runtime_reproducibility_verifier_timeout_exceeds_receipt_window",
    )?;
    let trust = hash(
        "RuntimeImageReproducibilityTrustIdentity",
        &json!(verifiers),
    )?;
    let mut identity = json!({"platform":value["platform"],"sourceDateEpoch":value["sourceDateEpoch"],"buildArgs":value["buildArgs"],"maximumReceiptAgeMs":value["maximumReceiptAgeMs"],"maximumVerificationCostUsd":value["maximumVerificationCostUsd"],"verificationCostAuthority":value["verificationCostAuthority"],"maximumVerifierTimeoutMs":max_timeout,"minimumRefreshLeadMs":max_timeout+60_000,"trustIdentityHash":trust,"verifiers":verifiers});
    identity = seal(
        "RuntimeImageReproducibilityProcessConfigurationIdentity",
        identity,
        "configurationIdentityHash",
    )?;
    if let Some(pin) = expected_pin {
        ensure(
            sha(&pin.into()) && identity["configurationIdentityHash"] == pin,
            "runtime_reproducibility_configuration_pin_mismatch",
        )?;
    }
    Ok(ProcessConfiguration {
        identity,
        public_keys: keys,
        processes,
        config_path: path.to_owned(),
        config_hash: digest(&bytes),
        environment: environment.clone(),
        pinned: expected_pin.is_some(),
    })
}
const PIPE_LIMIT: usize = 32 * 1024 * 1024;
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
fn bounded_output(
    mut pipe: impl Read,
    retain: bool,
    stopped: &AtomicBool,
    overflow: &AtomicBool,
) -> (Vec<u8>, bool) {
    let mut bytes = Vec::new();
    let mut total = 0usize;
    let mut buf = [0; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) => return (bytes, true),
            Ok(n) => {
                total = total.saturating_add(n);
                if total > PIPE_LIMIT {
                    overflow.store(true, Ordering::Release);
                    return (bytes, false);
                }
                if retain {
                    bytes.extend_from_slice(&buf[..n]);
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
fn invoke(p: &VerifierProcess, request: &Value, directory: &Path) -> Result<Value> {
    let mut payload = serde_json::to_vec(request)
        .map_err(|_| Error("runtime_reproducibility_json_invalid".into()))?;
    payload.push(b'\n');
    ensure(
        payload.len() <= 32 * 1024 * 1024,
        "runtime_reproducibility_request_resource_limit",
    )?;
    let c = &p.command;
    let executable = p.executable.execution_handle()?;
    let mut command = Command::new(format!("/proc/self/fd/{}", executable.as_raw_fd()));
    command
        .args(array(&c["args"]).iter().map(s))
        .current_dir(directory)
        .env_clear()
        .envs(&p.environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| Error("runtime_reproducibility_verifier_process_failed".into()))?;
    let pid = child.id();
    let output = child
        .stdout
        .take()
        .ok_or_else(|| Error("runtime_reproducibility_verifier_process_failed".into()))?;
    let err = child
        .stderr
        .take()
        .ok_or_else(|| Error("runtime_reproducibility_verifier_process_failed".into()))?;
    let input = child
        .stdin
        .take()
        .ok_or_else(|| Error("runtime_reproducibility_verifier_process_failed".into()))?;
    if !nonblocking(&output) || !nonblocking(&err) || !nonblocking(&input) {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
        let _ = child.kill();
        let _ = child.wait();
        return Err(Error(
            "runtime_reproducibility_verifier_process_failed".into(),
        ));
    }
    let stopped = AtomicBool::new(false);
    let overflow = AtomicBool::new(false);
    let started = Instant::now();
    let timeout = Duration::from_millis(c["timeoutMs"].as_u64().unwrap_or(1000));
    let (status, timed_out, stdout, stderr, write_result) = thread::scope(|scope| {
        let out = scope.spawn(|| bounded_output(output, true, &stopped, &overflow));
        let err = scope.spawn(|| bounded_output(err, false, &stopped, &overflow));
        let write = scope.spawn(|| write_input(input, &payload, &stopped));
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) => {
                    if started.elapsed() >= timeout || overflow.load(Ordering::Acquire) {
                        timed_out = true;
                        break None;
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break None,
            }
        };
        // Kill this group, then stop nonblocking IO even if an escaped descendant
        // retains a pipe. A process group alone is not a containment boundary.
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
        let _ = child.kill();
        let _ = child.wait();
        stopped.store(true, Ordering::Release);
        (status, timed_out, out.join(), err.join(), write.join())
    });
    drop(executable);
    p.executable.assert_current()?;
    let (stdout, out_complete) =
        stdout.map_err(|_| Error("runtime_reproducibility_verifier_process_failed".into()))?;
    let (_, err_complete) =
        stderr.map_err(|_| Error("runtime_reproducibility_verifier_process_failed".into()))?;
    ensure(
        !timed_out
            && status.is_some_and(|s| s.success())
            && out_complete
            && err_complete
            && write_result.is_ok_and(|r| r),
        "runtime_reproducibility_verifier_process_failed",
    )?;
    let response = parse(&stdout)?;
    ensure(
        response.is_object(),
        "runtime_reproducibility_verifier_response_invalid",
    )?;
    Ok(response)
}
/// Reopen and re-hash all configuration inputs immediately before invoking the
/// two processes concurrently. No shell, inherited credentials, or Node forwarding.
pub fn invoke_runtime_image_reproducibility_verifiers_v1(
    configuration: &ProcessConfiguration,
    request: &Value,
) -> Result<Value> {
    let directory = configuration
        .config_path
        .parent()
        .ok_or("runtime_reproducibility_path_not_canonical")?;
    invoke_with_directory(configuration, request, directory)
}
pub(super) fn invoke_with_directory(
    configuration: &ProcessConfiguration,
    request: &Value,
    directory: &Path,
) -> Result<Value> {
    ensure(
        configuration.pinned,
        "runtime_reproducibility_configuration_pin_required",
    )?;
    ensure(
        rehash(
            "RuntimeImageReproducibilityVerificationRequest",
            request,
            "requestHash",
        ) && id(&request["nonce"])
            && (1..=3).contains(&array(&request["inputs"]).len())
            && array(&request["inputs"]).iter().all(contract::input_valid),
        "runtime_reproducibility_request_invalid",
    )?;
    ensure(
        digest(&read(&configuration.config_path, 256 * 1024)?) == configuration.config_hash,
        "runtime_reproducibility_configuration_drift",
    )?;
    let current = read_runtime_image_reproducibility_process_configuration_v1(
        &configuration.config_path,
        Some(s(&configuration.identity["configurationIdentityHash"])),
        &configuration.environment,
    )?;
    ensure(
        current.identity == configuration.identity
            && request["configurationIdentityHash"]
                == configuration.identity["configurationIdentityHash"]
            && request["trustIdentityHash"] == configuration.identity["trustIdentityHash"],
        "runtime_reproducibility_configuration_drift",
    )?;
    let results = thread::scope(|scope| {
        let handles: Vec<_> = current
            .processes
            .iter()
            .map(|p| scope.spawn(move || invoke(p, request, directory)))
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .map_err(|_| Error("runtime_reproducibility_verifier_process_failed".into()))?
            })
            .collect::<Result<Vec<_>>>()
    })?;
    Ok(json!(results))
}
