//! Interruption through the real autonomous CLI and unchanged SQLite/CAS owners.
use super::autonomous_entrypoint::{invoke, request, success};
use super::*;
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use std::{
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

fn prepared_count(temp: &Temp) -> usize {
    fs::read_dir(temp.state().join("attempts"))
        .unwrap()
        .map(Result::unwrap)
        .filter(|e| e.path().extension().is_some_and(|x| x == "prepared"))
        .count()
}

#[test]
fn cancellation_before_dispatch_creates_no_attempt_and_status_stays_read_only() {
    let (temp, digest) = fixture();
    let cancelled = Arc::new(AtomicBool::new(true));
    let before = attempt_count(&temp);
    assert!(
        operate_local_workflow_with_clock_and_cancellation_v1(
            &temp.state(),
            &digest,
            WorkflowActionV1::Advance { through_steps: 1 },
            &mut || Ok(1100),
            Arc::clone(&cancelled),
        )
        .is_err()
    );
    assert_eq!(attempt_count(&temp), before);
    assert!(!temp.state().join("step-0000.json").exists());
    let progress = operate_local_workflow_with_clock_and_cancellation_v1(
        &temp.state(),
        &digest,
        WorkflowActionV1::Status,
        &mut || panic!("read-only status must not sample time"),
        cancelled,
    )
    .unwrap();
    assert_eq!(progress.committed_steps, 0);
    assert_eq!(progress.budget_remaining_microusd, 100);
}

#[test]
fn cancellation_after_preparation_preserves_commits_and_replays_without_relaunch() {
    let (temp, digest) = fixture();
    operate_local_workflow_v1(
        &temp.state(),
        &digest,
        WorkflowActionV1::Advance { through_steps: 1 },
        1100,
    )
    .unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut clock = || {
        if prepared_count(&temp) == 2 {
            cancelled.store(true, Ordering::Release);
        }
        Ok(1200)
    };
    assert!(
        operate_local_workflow_with_clock_and_cancellation_v1(
            &temp.state(),
            &digest,
            WorkflowActionV1::Advance { through_steps: 3 },
            &mut clock,
            Arc::clone(&cancelled),
        )
        .is_err()
    );
    let observed = status(&temp, &digest);
    assert_eq!(observed.committed_steps, 1);
    assert_eq!(observed.budget_remaining_microusd, 99);
    assert_eq!(prepared_count(&temp), 2);
    assert!(observed.pending_step);
    assert!(!temp.state().join("step-0002.json").exists());
    let attempts = attempt_count(&temp);
    // A fresh explicit invocation can consume the complete retained prepared
    // output; it cannot execute the same worker or debit that step twice.
    let resumed = operate_local_workflow_v1(
        &temp.state(),
        &digest,
        WorkflowActionV1::Advance { through_steps: 2 },
        1300,
    )
    .unwrap();
    assert_eq!(resumed.committed_steps, 2);
    assert_eq!(resumed.budget_remaining_microusd, 98);
    assert_eq!(attempt_count(&temp), attempts);
    let retry = operate_local_workflow_v1(
        &temp.state(),
        &digest,
        WorkflowActionV1::Advance { through_steps: 2 },
        1400,
    )
    .unwrap();
    assert_eq!(retry.campaign_revision, resumed.campaign_revision);
    assert_eq!(retry.budget_remaining_microusd, 98);
}

// A small actual Python process avoids spending the startup observation budget
// hashing a copy of this very large Rust test binary. Its language and source
// closure are explicit; it is never labelled a native Rust implementation.
fn interruptible_binding(cwd: &Path) -> WorkerBindingV1 {
    let source = r#"import os, pathlib, signal, subprocess, time
stop = False
def terminate(signum, frame):
    global stop
    stop = True
signal.signal(signal.SIGTERM, terminate)
child = subprocess.Popen(['/bin/sleep', '30'])
root = pathlib.Path.cwd()
counter = root / 'invocations'
count = int(counter.read_text()) if counter.exists() else 0
counter.write_text(str(count + 1))
(root / 'descendant-pid').write_text(str(child.pid))
(root / 'worker-pid').write_text(str(os.getpid()))
deadline = time.monotonic() + 30
try:
    while not stop and time.monotonic() < deadline:
        time.sleep(0.005)
finally:
    child.terminate()
    child.wait(timeout=1)
raise SystemExit(23)
"#;
    let script = cwd.join("interruptible.py");
    fs::write(&script, source).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o600)).unwrap();
    let executable = fs::canonicalize("/usr/bin/python3").unwrap();
    let digest = |path: &Path| {
        format!(
            "sha256:{}",
            hex::encode(Sha256::digest(fs::read(path).unwrap()))
        )
        .parse()
        .unwrap()
    };
    WorkerBindingV1::Process {
        executable_hash: digest(&executable),
        executable,
        arguments: vec!["-I".into(), "-B".into(), script.to_str().unwrap().into()],
        code_files: BTreeMap::from([(script.clone(), digest(&script))]),
        working_directory: cwd.to_path_buf(),
        implementation_language: "python".into(),
        timeout_ms: 10_000,
        network_declared: false,
    }
}

fn check_signal(signal: Signal) {
    let temp = Temp::new();
    let cwd = temp.0.join("interruption-child");
    fs::create_dir(&cwd).unwrap();
    fs::set_permissions(&cwd, fs::Permissions::from_mode(0o700)).unwrap();
    let binding = interruptible_binding(&cwd);
    let mut definition = LocalWorkflowV1 {
        version: 1,
        template: template(&temp.state(), binding).unwrap(),
        steps: steps(),
    };
    definition.steps.truncate(2);
    for step in &mut definition.steps {
        step.job_template = serde_json::json!({"kind":"process", "input":{}});
        step.bindings.clear();
    }
    let path = request(&temp, definition);
    let mut child = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-research",
            "--campaign-id",
            "campaign-service",
            "--workflow-file",
        ])
        .arg(&path)
        .args(["--action", "launch"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !cwd.join("worker-pid").exists() && Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    if !cwd.join("worker-pid").exists() {
        let _ = child.kill();
        let output = child.wait_with_output().unwrap();
        panic!(
            "worker did not start: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let worker_pid: i32 = fs::read_to_string(cwd.join("worker-pid"))
        .unwrap()
        .parse()
        .unwrap();
    let descendant_pid: i32 = fs::read_to_string(cwd.join("descendant-pid"))
        .unwrap()
        .parse()
        .unwrap();
    kill(Pid::from_raw(i32::try_from(child.id()).unwrap()), signal).unwrap();
    let deadline = Instant::now() + Duration::from_secs(6);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("autonomous CLI did not reconcile interruption before worker timeout");
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ready"], false);
    assert_eq!(report["interruptionRequested"], true);
    assert_eq!(report["reconciliationRequired"], true);
    assert_eq!(report["productionActivation"], false);
    for pid in [worker_pid, descendant_pid] {
        assert_eq!(
            kill(Pid::from_raw(pid), None),
            Err(nix::errno::Errno::ESRCH)
        );
    }
    let observation = success(invoke(&path, "status", &[]));
    assert_eq!(observation["workflow"]["committedSteps"], 0);
    assert_eq!(observation["workflow"]["budgetRemainingMicrousd"], 100);
    assert_eq!(observation["workflow"]["pendingStep"], true);
    assert!(!temp.state().join("step-0001.json").exists());
    let attempts = attempt_count(&temp);
    assert!(!invoke(&path, "converge", &[]).status.success());
    assert_eq!(attempt_count(&temp), attempts);
    assert_eq!(fs::read_to_string(cwd.join("invocations")).unwrap(), "1");
    // The signal itself does not change the campaign lifecycle. A subsequent
    // explicit revision-bound Cancel closes future admission, but must retain
    // unresolved execution and cannot refund or rewrite it as settled success.
    assert_eq!(observation["workflow"]["campaignState"], "running");
    let revision = observation["workflow"]["campaignRevision"]
        .as_u64()
        .unwrap()
        .to_string();
    let cancelled = success(invoke(&path, "cancel", &["--expected-revision", &revision]));
    assert_eq!(cancelled["workflow"]["campaignState"], "cancelled");
    assert_eq!(cancelled["workflow"]["pendingStep"], true);
    assert_eq!(cancelled["workflow"]["budgetRemainingMicrousd"], 100);
    assert_eq!(attempt_count(&temp), attempts);
    let next_revision = cancelled["workflow"]["campaignRevision"]
        .as_u64()
        .unwrap()
        .to_string();
    assert!(
        !invoke(&path, "resume", &["--expected-revision", &next_revision])
            .status
            .success()
    );
    assert!(!invoke(&path, "converge", &[]).status.success());
    assert_eq!(fs::read_to_string(cwd.join("invocations")).unwrap(), "1");
}

#[test]
fn sigint_stops_real_worker_group_and_blocks_ambiguous_relaunch() {
    check_signal(Signal::SIGINT);
}

#[test]
fn sigterm_stops_real_worker_group_and_blocks_ambiguous_relaunch() {
    check_signal(Signal::SIGTERM);
}
