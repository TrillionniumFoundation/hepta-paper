use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, File},
    io::Write,
    os::{
        fd::AsFd,
        unix::{
            fs::{MetadataExt, PermissionsExt},
            net::UnixStream,
        },
    },
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use hepta_codex_runtime::{
    BoundedProcessRequestV1, DurableGateError, DurableGatePolicyV1, EnvironmentPolicyV1,
    GateProcessObservationV1, ProcessLimitsV1, ProcessTerminationReason,
    observe_preexec_gate_process, spawn_blocked_preexec_gate, terminate_journaled_preexec_gate,
};

use nix::fcntl::{FcntlArg, FdFlag, fcntl};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

struct TempTree(PathBuf);

impl TempTree {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "hepta-durable-gate-{}-{nonce}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir(&path).expect("temp root");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("private root");
        Self(path)
    }

    fn script(&self, name: &str, source: &str) -> PathBuf {
        let path = self.0.join(name);
        let mut file = File::create(&path).expect("create script");
        file.write_all(source.as_bytes()).expect("write script");
        file.sync_all().expect("sync script");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("executable");
        path
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn environment(root: &Path) -> hepta_codex_runtime::RestrictedEnvironmentV1 {
    EnvironmentPolicyV1::new(
        "gate-test-v1",
        ["PATH", "HOME", "TMPDIR"],
        ["PATH", "HOME", "TMPDIR"],
    )
    .expect("policy")
    .build(
        [
            (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
            (OsString::from("HOME"), root.as_os_str().to_owned()),
            (OsString::from("TMPDIR"), root.as_os_str().to_owned()),
        ],
        &BTreeMap::new(),
    )
    .expect("environment")
}

fn gate_policy(tree: &TempTree) -> DurableGatePolicyV1 {
    let built_gate = PathBuf::from(env!("CARGO_BIN_EXE_hepta-codex-preexec-gate"));
    let gate = tree.0.join("hepta-codex-preexec-gate");
    fs::copy(&built_gate, &gate).expect("copy gate binary into private single-link root");
    fs::set_permissions(&gate, fs::Permissions::from_mode(0o700)).expect("private gate mode");
    File::open(&gate)
        .expect("open copied gate")
        .sync_all()
        .expect("sync copied gate");
    File::open(&tree.0)
        .expect("open gate parent")
        .sync_all()
        .expect("sync gate parent");
    let owner_uid = fs::metadata(&tree.0).expect("root metadata").uid();
    assert_eq!(fs::metadata(&gate).expect("gate metadata").nlink(), 1);
    DurableGatePolicyV1::strict(gate, tree.0.clone(), owner_uid)
}

fn request(
    tree: &TempTree,
    executable: PathBuf,
    stdin: Option<Vec<u8>>,
) -> BoundedProcessRequestV1 {
    BoundedProcessRequestV1 {
        executable,
        arguments: Vec::new(),
        working_directory: tree.0.clone(),
        environment: environment(&tree.0),
        stdin,
    }
}

fn limits() -> ProcessLimitsV1 {
    ProcessLimitsV1 {
        timeout_ms: 2_000,
        termination_grace_ms: 100,
        cleanup_timeout_ms: 2_000,
        poll_interval_ms: 5,
        maximum_stdin_bytes: 1024 * 1024,
        maximum_stdout_bytes: 1024 * 1024,
        maximum_stderr_bytes: 1024 * 1024,
        maximum_tail_bytes: 64 * 1024,
    }
}

fn socket_descriptor_count(pid: u32) -> usize {
    fs::read_dir(format!("/proc/{pid}/fd"))
        .expect("read process fd directory")
        .filter_map(Result::ok)
        .filter_map(|entry| fs::read_link(entry.path()).ok())
        .filter(|target| target.to_string_lossy().starts_with("socket:["))
        .count()
}

#[test]
fn target_cannot_execute_before_durable_release() {
    let tree = TempTree::new();
    let marker = tree.0.join("target-started");
    let target = tree.script(
        "target.sh",
        &format!(
            "#!/bin/sh\nset -eu\nprintf started > '{}'\ncat\n",
            marker.display()
        ),
    );
    let blocked = spawn_blocked_preexec_gate(
        &request(&tree, target, Some(b"payload\n".to_vec())),
        limits(),
        &gate_policy(&tree),
    )
    .expect("blocked gate");
    assert!(!marker.exists());
    assert_eq!(
        observe_preexec_gate_process(blocked.identity()).expect("observe blocked gate"),
        GateProcessObservationV1::Blocked,
    );
    assert_eq!(socket_descriptor_count(blocked.identity().pid), 0);
    blocked.identity().validate_hash().expect("identity hash");

    let durable_receipt = tree.0.join("journal-commit");
    let mut receipt = File::create(&durable_receipt).expect("receipt");
    receipt
        .write_all(blocked.identity().identity_hash.as_str().as_bytes())
        .expect("write receipt");
    receipt.sync_all().expect("sync receipt");
    File::open(&tree.0)
        .expect("open root")
        .sync_all()
        .expect("sync root");

    let (_identity, result) = blocked.release_and_supervise().expect("released target");
    assert_eq!(result.termination_reason, ProcessTerminationReason::Exited);
    assert_eq!(
        result.exit_code,
        Some(0),
        "gate stderr: {}",
        String::from_utf8_lossy(&result.stderr_tail),
    );
    assert_eq!(result.stdout_tail, b"payload\n");
    assert_eq!(fs::read_to_string(marker).expect("marker"), "started");
}

#[test]
fn failed_durable_commit_can_terminate_stopped_gate_without_target_execution() {
    let tree = TempTree::new();
    let marker = tree.0.join("must-not-exist");
    let target = tree.script(
        "target.sh",
        &format!("#!/bin/sh\nprintf started > '{}'\n", marker.display()),
    );
    let blocked =
        spawn_blocked_preexec_gate(&request(&tree, target, None), limits(), &gate_policy(&tree))
            .expect("blocked gate");
    blocked.terminate_blocked().expect("terminate blocked gate");
    assert!(!marker.exists());
}

#[test]
fn target_replacement_after_journal_link_is_rejected_before_execution() {
    let tree = TempTree::new();
    let marker = tree.0.join("must-not-exist");
    let target = tree.script(
        "target.sh",
        &format!("#!/bin/sh\nprintf original > '{}'\n", marker.display()),
    );
    let blocked = spawn_blocked_preexec_gate(
        &request(&tree, target.clone(), None),
        limits(),
        &gate_policy(&tree),
    )
    .expect("blocked gate");
    fs::remove_file(&target).expect("remove target");
    let replacement = tree.script(
        "target.sh",
        &format!("#!/bin/sh\nprintf replacement > '{}'\n", marker.display()),
    );
    assert_eq!(replacement, target);
    let (_identity, result) = blocked.release_and_supervise().expect("gate result");
    assert_ne!(result.exit_code, Some(0));
    assert!(!marker.exists());
}

#[test]
fn process_observation_rejects_tampered_persisted_identity() {
    let tree = TempTree::new();
    let target = tree.script("target.sh", "#!/bin/sh\nexit 0\n");
    let blocked =
        spawn_blocked_preexec_gate(&request(&tree, target, None), limits(), &gate_policy(&tree))
            .expect("blocked gate");
    let mut tampered = blocked.identity().clone();
    tampered.start_time_ticks = tampered.start_time_ticks.saturating_add(1);
    assert!(tampered.validate_hash().is_err());
    blocked.terminate_blocked().expect("cleanup");
}

#[test]
fn startup_recovery_can_terminate_exact_blocked_gate_without_false_zombie_timeout() {
    let tree = TempTree::new();
    let marker = tree.0.join("must-not-exist");
    let target = tree.script(
        "target.sh",
        &format!("#!/bin/sh\nprintf started > '{}'\n", marker.display()),
    );
    let blocked =
        spawn_blocked_preexec_gate(&request(&tree, target, None), limits(), &gate_policy(&tree))
            .expect("blocked gate");
    let identity = blocked.identity().clone();
    let envelope_path = PathBuf::from(&identity.launch_envelope.canonical_path);
    assert!(envelope_path.exists());
    assert_eq!(
        terminate_journaled_preexec_gate(&identity, limits()).expect("terminate journaled gate"),
        GateProcessObservationV1::Blocked,
    );
    drop(blocked);
    assert!(!marker.exists());
    assert!(!envelope_path.exists());
    assert_eq!(
        observe_preexec_gate_process(&identity).expect("observe terminated gate"),
        GateProcessObservationV1::Absent,
    );
}

#[test]
fn gate_closes_inherited_non_stdio_socket_before_kernel_stop() {
    let tree = TempTree::new();
    let target = tree.script("target.sh", "#!/bin/sh\nexit 0\n");
    let (inherited, _peer) = UnixStream::pair().expect("socket pair");
    let raw_flags = fcntl(inherited.as_fd(), FcntlArg::F_GETFD).expect("get socket flags");
    let mut flags = FdFlag::from_bits_truncate(raw_flags);
    flags.remove(FdFlag::FD_CLOEXEC);
    fcntl(inherited.as_fd(), FcntlArg::F_SETFD(flags)).expect("make socket inheritable");

    let blocked =
        spawn_blocked_preexec_gate(&request(&tree, target, None), limits(), &gate_policy(&tree))
            .expect("blocked gate");
    assert_eq!(socket_descriptor_count(blocked.identity().pid), 0);
    blocked.terminate_blocked().expect("cleanup blocked gate");
}

#[test]
fn same_owner_production_gate_authority_is_rejected() {
    let tree = TempTree::new();
    let target = tree.script("target.sh", "#!/bin/sh\nexit 0\n");
    let local = gate_policy(&tree);
    let production = DurableGatePolicyV1::separate_gate_authority(
        local.gate_executable,
        local.state_directory,
        local.owner_uid,
        local.owner_uid,
    );
    assert!(!production.production_eligible());
    assert!(matches!(
        spawn_blocked_preexec_gate(&request(&tree, target, None), limits(), &production),
        Err(DurableGateError::GateOwnerMustDiffer),
    ));
}

#[test]
fn orphaned_target_helpers_are_reconciled_by_exact_session_identity() {
    let tree = TempTree::new();
    let marker = tree.0.join("target-started");
    let target = tree.script(
        "target.sh",
        &format!(
            "#!/bin/sh\nset -eu\nprintf started > '{}'\nsleep 30\n",
            marker.display(),
        ),
    );
    let blocked =
        spawn_blocked_preexec_gate(&request(&tree, target, None), limits(), &gate_policy(&tree))
            .expect("blocked gate");
    let identity = blocked.identity().clone();
    let released = blocked.release().expect("release gate");
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !marker.exists() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(marker.exists(), "target must start after release");
    let status = Command::new("/usr/bin/kill")
        .args(["-KILL", &identity.pid.to_string()])
        .status()
        .expect("kill gate leader");
    assert!(status.success());
    released
        .reap_after_external_termination()
        .expect("reap killed gate leader");
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut observation = observe_preexec_gate_process(&identity).expect("observe orphaned group");
    while observation == GateProcessObservationV1::Absent && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
        observation = observe_preexec_gate_process(&identity).expect("observe orphaned group");
    }
    assert_eq!(observation, GateProcessObservationV1::OrphanedProcessGroup);
    assert_eq!(
        terminate_journaled_preexec_gate(&identity, limits()).expect("terminate orphaned group"),
        GateProcessObservationV1::OrphanedProcessGroup,
    );
    assert_eq!(
        observe_preexec_gate_process(&identity).expect("observe cleaned group"),
        GateProcessObservationV1::Absent,
    );
}
