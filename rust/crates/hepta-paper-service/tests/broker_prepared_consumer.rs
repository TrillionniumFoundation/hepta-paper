//! Existing service and real filesystem/Unix IPC tests. The remote side is an
//! explicit protocol fixture, not live-model or installed-broker qualification.
#[path = "broker_prepared_consumer/cache_admission.rs"]
mod cache_admission;
#[path = "broker_prepared_consumer/capacity_admission.rs"]
mod capacity_admission;
#[path = "broker_prepared_consumer/cost_settlement.rs"]
mod cost_settlement;
#[path = "broker_prepared_consumer/fixture.rs"]
mod fixture;
#[path = "broker_prepared_consumer/plan_waves.rs"]
mod plan_waves;
#[path = "broker_prepared_consumer/revision.rs"]
mod revision;
use fixture::*;
use hepta_paper_service::{ObjectStoreV1, run_service_v1};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    process::Command,
};
const OUTPUT: &[u8] = br#"{"manuscript":"original model result"}"#;

#[test]
fn original_output_enters_existing_cas_sqlite_and_replays_without_ipc_or_debit() {
    let f = Fixture::new();
    let server = f.serve(f.listener(), OUTPUT, false, false);
    let first = run_service_v1(f.config.clone()).unwrap();
    server.join().unwrap();
    assert!(first.commit_receipts[0].newly_committed);
    let objects = ObjectStoreV1::open(&f.config.state_directory).unwrap();
    assert_eq!(objects.read(&hash(OUTPUT)).unwrap(), OUTPUT);
    fs::remove_file(&f.socket_path).unwrap();
    let replay = run_service_v1(f.config.clone()).unwrap();
    assert!(!replay.commit_receipts[0].newly_committed);
    assert_eq!(
        first.commit_receipts[0].result_hash,
        replay.commit_receipts[0].result_hash
    );
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        2
    );
}

#[test]
fn same_readonly_query_can_recover_after_response_failure() {
    let f = Fixture::new();
    let server = f.serve(f.listener(), OUTPUT, true, false);
    assert!(run_service_v1(f.config.clone()).is_err());
    server.join().unwrap();
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        1
    );
    fs::remove_file(&f.socket_path).unwrap();
    let server = f.serve(f.listener(), OUTPUT, false, false);
    let accepted = run_service_v1(f.config.clone()).unwrap();
    server.join().unwrap();
    assert!(accepted.commit_receipts[0].newly_committed);
}

#[test]
fn ordinary_cli_reopens_committed_result_after_broker_disappears() {
    let f = Fixture::new();
    let config_path = f.root.join("service.json");
    fs::write(&config_path, serde_json::to_vec(&f.config).unwrap()).unwrap();
    let server = f.serve(f.listener(), OUTPUT, false, false);
    let first = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config_path)
        .output()
        .unwrap();
    server.join().unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    fs::remove_file(&f.socket_path).unwrap();
    let replay = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config_path)
        .output()
        .unwrap();
    assert!(
        replay.status.success(),
        "{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    let replay: serde_json::Value = serde_json::from_slice(&replay.stdout).unwrap();
    assert_eq!(replay["commitReceipts"][0]["newlyCommitted"], false);
}

#[test]
fn corrupt_transferred_output_cannot_enter_prepared_cache_or_commit() {
    let f = Fixture::new();
    let server = f.serve(f.listener(), OUTPUT, false, true);
    assert!(run_service_v1(f.config.clone()).is_err());
    server.join().unwrap();
    assert!(
        ObjectStoreV1::open(&f.config.state_directory)
            .unwrap()
            .read(&hash(OUTPUT))
            .is_err()
    );
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn incorrect_request_context_is_rejected_before_socket_io() {
    use hepta_codex_protocol::{AgentRole, CodexExecutionRequestV1, SandboxPolicy, TaskKind};
    let f = Fixture::new();
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    let changes: [fn(&mut CodexExecutionRequestV1); 13] = [
        |r| r.operation_id.push('x'),
        |r| r.attempt_id.push('x'),
        |r| r.campaign_id.push('x'),
        |r| r.node_id.push('x'),
        |r| r.lease_generation += 1,
        |r| r.campaign_revision += 1,
        |r| r.input_manifest_hash = hash(b"other input"),
        |r| r.output_schema_hash = hash(b"other schema"),
        |r| r.codex_runtime_identity_hash = hash(b"other runtime"),
        |r| r.prompt_envelope_hash = hash(b"other prompt"),
        |r| r.maximum_cost_microusd += 1,
        |r| r.remaining_token_hint = Some(101),
        |r| {
            r.role = AgentRole::Reviewer;
            r.task_kind = TaskKind::Review;
            r.sandbox_policy = SandboxPolicy::ReadOnly;
        },
    ];
    for change in changes {
        let mut request = f.request.clone();
        change(&mut request);
        f.publish(&request);
        assert!(run_service_v1(f.config.clone()).is_err());
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}

#[test]
fn readonly_retry_does_not_clear_unrelated_ambiguous_dispatch() {
    let f = Fixture::new();
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    let id = hash(b"unrelated effectful attempt");
    let path = f.config.state_directory.join("attempts").join(format!(
        "{}.started",
        id.as_str().trim_start_matches("sha256:")
    ));
    fs::write(&path, id.as_str()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(run_service_v1(f.config.clone()).is_err());
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(fs::read_to_string(path).unwrap(), id.as_str());
}

#[test]
fn mutable_or_aliased_request_files_are_not_accepted() {
    let f = Fixture::new();
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    fs::set_permissions(&f.request_path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(run_service_v1(f.config.clone()).is_err());
    let moved = f.root.join("moved.json");
    fs::rename(&f.request_path, &moved).unwrap();
    fs::set_permissions(&moved, fs::Permissions::from_mode(0o400)).unwrap();
    symlink(&moved, &f.request_path).unwrap();
    assert!(run_service_v1(f.config.clone()).is_err());
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn normal_workflow_uses_broker_backend_and_retains_committed_prefix() {
    use hepta_paper_service::workflow::{
        LocalWorkflowV1, WorkflowActionV1, WorkflowStepV1, initialize_local_workflow_v1,
        operate_local_workflow_v1,
    };
    let f = Fixture::new();
    let candidate = f.config.frontier.candidates[0].clone();
    let job = ObjectStoreV1::open(&f.config.state_directory)
        .unwrap()
        .read(&candidate.payload_hash)
        .unwrap();
    let state = f.root.join("workflow");
    let mut template = f.config.clone();
    template.state_directory = state.clone();
    template.frontier.candidates.clear();
    let definition = LocalWorkflowV1 {
        version: 1,
        template,
        steps: vec![WorkflowStepV1 {
            id: candidate.candidate_id,
            module_id: candidate.module_id,
            capability_id: candidate.capability_id,
            resources: candidate.resources,
            cost_microusd: candidate.cost_microusd,
            job_template: serde_json::from_slice(&job).unwrap(),
            bindings: vec![],
            gate: None,
        }],
    };
    let definition_hash = initialize_local_workflow_v1(definition).unwrap();
    let server = f.serve(f.listener(), OUTPUT, false, false);
    let first = operate_local_workflow_v1(
        &state,
        &definition_hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        1000,
    )
    .unwrap();
    server.join().unwrap();
    fs::remove_file(&f.socket_path).unwrap();
    assert_eq!(first.committed_steps, 1);
    assert_eq!(first.budget_remaining_microusd, 90);
    assert!(!first.production_activation);
    assert!(!first.scientific_acceptance);
    let replay = operate_local_workflow_v1(
        &state,
        &definition_hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        1000,
    )
    .unwrap();
    assert_eq!(replay.committed_steps, 1);
    assert_eq!(replay.budget_remaining_microusd, 90);
    assert_eq!(replay.artifacts_by_step, first.artifacts_by_step);
}

#[test]
fn ordinary_run_dispatches_once_then_queries_commits_and_replays_without_ipc() {
    let f = Fixture::new_execution();
    let server = f.serve_execution(f.listener(), OUTPUT, 0);
    let first = run_service_v1(f.config.clone()).unwrap();
    server.join().unwrap();
    assert!(first.commit_receipts[0].newly_committed);
    assert_eq!(
        ObjectStoreV1::open(&f.config.state_directory)
            .unwrap()
            .read(&hash(OUTPUT))
            .unwrap(),
        OUTPUT
    );
    fs::remove_file(&f.socket_path).unwrap();
    let replay = run_service_v1(f.config.clone()).unwrap();
    assert!(!replay.commit_receipts[0].newly_committed);
    assert_eq!(
        first.commit_receipts[0].result_hash,
        replay.commit_receipts[0].result_hash
    );
}

#[test]
fn lost_execution_response_recovers_by_query_without_resending_execution() {
    let f = Fixture::new_execution();
    let server = f.serve_execution(f.listener(), OUTPUT, 1);
    assert!(run_service_v1(f.config.clone()).is_err());
    server.join().unwrap();
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        1
    );
    fs::remove_file(&f.socket_path).unwrap();
    // This peer refuses any frame other than HEPTAQX1.
    let server = f.serve(f.listener(), OUTPUT, false, false);
    let recovered = run_service_v1(f.config.clone()).unwrap();
    server.join().unwrap();
    assert!(recovered.commit_receipts[0].newly_committed);
}

#[test]
fn execution_response_identity_mismatch_keeps_original_attempt_unresolved() {
    let f = Fixture::new_execution();
    let server = f.serve_execution(f.listener(), OUTPUT, 2);
    assert!(run_service_v1(f.config.clone()).is_err());
    server.join().unwrap();
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn reservation_is_not_a_completed_execution_or_a_second_dispatch_permission() {
    let f = Fixture::new_execution();
    let server = f.serve_execution(f.listener(), OUTPUT, 3);
    assert!(run_service_v1(f.config.clone()).is_err());
    server.join().unwrap();
    fs::remove_file(&f.socket_path).unwrap();
    let server = f.serve(f.listener(), OUTPUT, false, false);
    assert!(run_service_v1(f.config.clone()).unwrap().commit_receipts[0].newly_committed);
    server.join().unwrap();
}

#[test]
fn ordinary_cli_uses_explicit_execution_backend_and_durable_recovery() {
    let f = Fixture::new_execution();
    let path = f.root.join("execution-run.json");
    fs::write(&path, serde_json::to_vec(&f.config).unwrap()).unwrap();
    let server = f.serve_execution(f.listener(), OUTPUT, 0);
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&path)
        .output()
        .unwrap();
    server.join().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fs::remove_file(&f.socket_path).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["commitReceipts"][0]["newlyCommitted"], false);
}

#[test]
fn ordinary_execution_cli_rejects_a_stale_serialized_writer_clock_before_ipc() {
    let mut f = Fixture::new_execution();
    f.config.observed_at_unix_ms = 1_000;
    f.config.writer_lease.expires_at_unix_ms = 2_000;
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    let path = f.root.join("stale-run.json");
    fs::write(&path, serde_json::to_vec(&f.config).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&path)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn execution_recovery_cannot_bypass_an_unrelated_ambiguous_effect() {
    let f = Fixture::new_execution();
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    let id = hash(b"another unconfirmed provider operation");
    let path = f.config.state_directory.join("attempts").join(format!(
        "{}.started",
        id.as_str().trim_start_matches("sha256:")
    ));
    fs::write(&path, id.as_str()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(run_service_v1(f.config.clone()).is_err());
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(fs::read_to_string(path).unwrap(), id.as_str());
}

#[test]
fn normal_workflow_uses_explicit_execution_backend_and_retains_committed_prefix() {
    use hepta_paper_service::workflow::{
        LocalWorkflowV1, WorkflowActionV1, WorkflowStepV1, initialize_local_workflow_v1,
        operate_local_workflow_v1,
    };
    let f = Fixture::new_execution();
    let candidate = f.config.frontier.candidates[0].clone();
    let job = ObjectStoreV1::open(&f.config.state_directory)
        .unwrap()
        .read(&candidate.payload_hash)
        .unwrap();
    let state = f.root.join("workflow");
    let mut template = f.config.clone();
    template.state_directory = state.clone();
    template.frontier.candidates.clear();
    let definition = LocalWorkflowV1 {
        version: 1,
        template,
        steps: vec![WorkflowStepV1 {
            id: candidate.candidate_id,
            module_id: candidate.module_id,
            capability_id: candidate.capability_id,
            resources: candidate.resources,
            cost_microusd: candidate.cost_microusd,
            job_template: serde_json::from_slice(&job).unwrap(),
            bindings: vec![],
            gate: None,
        }],
    };
    let definition_hash = initialize_local_workflow_v1(definition).unwrap();
    let server = f.serve_execution(f.listener(), OUTPUT, 0);
    let first = operate_local_workflow_v1(
        &state,
        &definition_hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        f.config.observed_at_unix_ms,
    )
    .unwrap();
    server.join().unwrap();
    fs::remove_file(&f.socket_path).unwrap();
    assert_eq!(first.committed_steps, 1);
    assert_eq!(first.budget_remaining_microusd, 90);
    assert!(!first.production_activation);
    assert!(!first.scientific_acceptance);
    let replay = operate_local_workflow_v1(
        &state,
        &definition_hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        f.config.observed_at_unix_ms,
    )
    .unwrap();
    assert_eq!(replay.committed_steps, 1);
    assert_eq!(replay.budget_remaining_microusd, 90);
    assert_eq!(replay.artifacts_by_step, first.artifacts_by_step);
}

#[test]
fn ordinary_execution_library_also_rejects_stale_serialized_time() {
    let mut f = Fixture::new_execution();
    f.config.observed_at_unix_ms = 1_000;
    f.config.writer_lease.expires_at_unix_ms = 2_000;
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    assert!(run_service_v1(f.config.clone()).is_err());
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn preflight_rejection_preserves_fresh_execution_for_the_ordinary_cli() {
    let f = Fixture::new_execution();
    let path = f.root.join("execution-preflight.json");
    fs::write(&path, serde_json::to_vec(&f.config).unwrap()).unwrap();
    fs::remove_file(&f.request_path).unwrap();
    let rejected = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&path)
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        0,
        "a locally missing request cannot have dispatched a provider operation"
    );
    f.publish(&f.request);
    let server = f.serve_execution(f.listener(), OUTPUT, 0);
    let accepted = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&path)
        .output()
        .unwrap();
    server.join().unwrap();
    assert!(
        accepted.status.success(),
        "{}",
        String::from_utf8_lossy(&accepted.stderr)
    );
    fs::remove_file(&f.socket_path).unwrap();
    let replay = run_service_v1(f.config.clone()).unwrap();
    assert!(!replay.commit_receipts[0].newly_committed);
}

#[test]
fn invalid_execution_request_does_not_create_an_ambiguous_dispatch() {
    let f = Fixture::new_execution();
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    let mut invalid = f.request.clone();
    invalid.campaign_revision += 1;
    f.publish(&invalid);
    assert!(run_service_v1(f.config.clone()).is_err());
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        0,
        "local admission rejection is not an unknown external result"
    );
    drop(listener);
    fs::remove_file(&f.socket_path).unwrap();
    f.publish(&f.request);
    let server = f.serve_execution(f.listener(), OUTPUT, 0);
    assert!(run_service_v1(f.config.clone()).unwrap().commit_receipts[0].newly_committed);
    server.join().unwrap();
}

#[test]
fn failed_broker_connection_preserves_fresh_dispatch() {
    let f = Fixture::new_execution();
    // A missing endpoint cannot have received an execution request.
    assert!(run_service_v1(f.config.clone()).is_err());
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        0
    );
    // A stale socket pathname is also a known local connection failure.
    drop(f.listener());
    assert!(run_service_v1(f.config.clone()).is_err());
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        0
    );
    fs::remove_file(&f.socket_path).unwrap();
    let server = f.serve_execution(f.listener(), OUTPUT, 0);
    let accepted = run_service_v1(f.config.clone()).unwrap();
    server.join().unwrap();
    assert!(accepted.commit_receipts[0].newly_committed);
}

#[test]
fn malformed_request_preflight_is_retryable_without_dispatch() {
    let f = Fixture::new_execution();
    fs::set_permissions(&f.request_path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&f.request_path, b"{not json}").unwrap();
    fs::set_permissions(&f.request_path, fs::Permissions::from_mode(0o400)).unwrap();
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    assert!(run_service_v1(f.config.clone()).is_err());
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        0
    );
    f.publish(&f.request);
    let server = f.serve_execution(listener, OUTPUT, 0);
    assert!(run_service_v1(f.config.clone()).unwrap().commit_receipts[0].newly_committed);
    server.join().unwrap();
}

fn broker_workflow_definition(
    f: &Fixture,
    state: &std::path::Path,
) -> hepta_paper_service::workflow::LocalWorkflowV1 {
    use hepta_paper_service::workflow::{LocalWorkflowV1, WorkflowStepV1};
    let candidate = f.config.frontier.candidates[0].clone();
    let job = ObjectStoreV1::open(&f.config.state_directory)
        .unwrap()
        .read(&candidate.payload_hash)
        .unwrap();
    let mut template = f.config.clone();
    template.state_directory = state.to_path_buf();
    template.frontier.candidates.clear();
    LocalWorkflowV1 {
        version: 1,
        template,
        steps: vec![WorkflowStepV1 {
            id: candidate.candidate_id,
            module_id: candidate.module_id,
            capability_id: candidate.capability_id,
            resources: candidate.resources,
            cost_microusd: candidate.cost_microusd,
            job_template: serde_json::from_slice(&job).unwrap(),
            bindings: vec![],
            gate: None,
        }],
    }
}

fn interrupted_workflow_recovers_original_broker_result(execute: bool) {
    use hepta_paper_service::workflow::{
        WorkflowActionV1, initialize_local_workflow_v1,
        operate_local_workflow_with_clock_and_cancellation_v1,
        operate_local_workflow_with_clock_v1,
    };
    use std::{
        io::Read,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::{Duration, Instant},
    };
    let f = if execute {
        Fixture::new_execution()
    } else {
        Fixture::new()
    };
    let state = f.root.join("interrupted-workflow");
    let definition = broker_workflow_definition(&f, &state);
    let definition_hash = initialize_local_workflow_v1(definition).unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let peer_cancelled = Arc::clone(&cancelled);
    let listener = f.listener();
    let mut expected = Vec::new();
    if execute {
        hepta_codex_broker::write_request_frame(&mut expected, &f.request, Default::default())
            .unwrap();
    } else {
        hepta_codex_broker::write_result_query_frame(&mut expected, &f.request, Default::default())
            .unwrap();
    }
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_millis(1500)))
            .unwrap();
        let mut received = vec![0; expected.len()];
        stream.read_exact(&mut received).unwrap();
        assert_eq!(received, expected);
        let began = Instant::now();
        peer_cancelled.store(true, Ordering::Release);
        let mut byte = [0_u8; 1];
        let ended = stream.read(&mut byte);
        (began.elapsed(), ended)
    });
    let mut clock = || Ok(f.config.observed_at_unix_ms);
    assert!(
        operate_local_workflow_with_clock_and_cancellation_v1(
            &state,
            &definition_hash,
            WorkflowActionV1::Advance { through_steps: 1 },
            &mut clock,
            cancelled,
        )
        .is_err()
    );
    let (elapsed, ended) = server.join().unwrap();
    assert!(
        matches!(ended, Ok(0)),
        "cancel must close IPC, not wait for its timeout: {ended:?}"
    );
    assert!(
        elapsed < Duration::from_millis(750),
        "cancellation took {elapsed:?}"
    );
    let attempts: Vec<_> = fs::read_dir(state.join("attempts"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].extension().unwrap(), "started");
    let status = operate_local_workflow_with_clock_v1(
        &state,
        &definition_hash,
        WorkflowActionV1::Status,
        &mut clock,
    )
    .unwrap();
    assert_eq!(status.committed_steps, 0);
    assert_eq!(status.budget_remaining_microusd, 100);
    fs::remove_file(&f.socket_path).unwrap();
    // The ordinary workflow is reopened. The protocol fixture accepts query
    // only: any accidental second execution request fails the test.
    let recovery = f.serve(f.listener(), OUTPUT, false, false);
    let recovered = operate_local_workflow_with_clock_v1(
        &state,
        &definition_hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        &mut clock,
    )
    .unwrap();
    recovery.join().unwrap();
    assert_eq!(recovered.committed_steps, 1);
    assert_eq!(recovered.budget_remaining_microusd, 90);
    fs::remove_file(&f.socket_path).unwrap();
    let replay = operate_local_workflow_with_clock_v1(
        &state,
        &definition_hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        &mut clock,
    )
    .unwrap();
    assert_eq!(replay.budget_remaining_microusd, 90);
    assert_eq!(replay.artifacts_by_step, recovered.artifacts_by_step);
}

#[test]
fn cancelled_broker_dispatch_unblocks_and_workflow_recovery_queries_only() {
    interrupted_workflow_recovers_original_broker_result(true);
}

#[test]
fn cancelled_prepared_query_unblocks_and_workflow_recovery_queries_only() {
    interrupted_workflow_recovers_original_broker_result(false);
}

fn check_broker_cli_signal(signal: nix::sys::signal::Signal) {
    use std::{
        io::Read,
        process::Stdio,
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };
    let f = Fixture::new_execution();
    let state = f.root.join("cli-interrupted-workflow");
    let definition = broker_workflow_definition(&f, &state);
    let path = f.root.join("workflow-input.json");
    fs::write(&path, serde_json::to_vec(&definition).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let mut expected = Vec::new();
    hepta_codex_broker::write_request_frame(&mut expected, &f.request, Default::default()).unwrap();
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    let (ready, request_observed) = mpsc::sync_channel(1);
    let server = thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(15);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("CLI did not reach broker: {e}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut received = vec![0; expected.len()];
        stream.read_exact(&mut received).unwrap();
        assert_eq!(received, expected);
        ready.send(()).unwrap();
        stream.read(&mut [0_u8; 1])
    });
    let command = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
        command
            .args([
                "autonomous-research",
                "--campaign-id",
                &f.request.campaign_id,
                "--workflow-file",
            ])
            .arg(&path);
        command
    };
    let mut child = command()
        .args(["--action", "launch"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if request_observed
        .recv_timeout(Duration::from_secs(15))
        .is_err()
    {
        let _ = child.kill();
        let output = child.wait_with_output().unwrap();
        panic!(
            "normal CLI did not dispatch: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let began = Instant::now();
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(child.id()).unwrap()),
        signal,
    )
    .unwrap();
    while child.try_wait().unwrap().is_none() && began.elapsed() < Duration::from_millis(1500) {
        thread::sleep(Duration::from_millis(5));
    }
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("signal did not interrupt the broker wait");
    }
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["interruptionRequested"], true);
    assert_eq!(report["reconciliationRequired"], true);
    assert_eq!(report["productionActivation"], false);
    assert_eq!(server.join().unwrap().unwrap(), 0);
    let status = command().args(["--action", "status"]).output().unwrap();
    assert!(status.status.success());
    let status: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status["workflow"]["committedSteps"], 0);
    assert_eq!(status["workflow"]["pendingStep"], true);
    fs::remove_file(&f.socket_path).unwrap();
    let recovery = f.serve(f.listener(), OUTPUT, false, false);
    let output = command().args(["--action", "converge"]).output().unwrap();
    recovery.join().unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let recovered: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(recovered["workflow"]["committedSteps"], 1);
    assert_eq!(recovered["workflow"]["budgetRemainingMicrousd"], 90);
    fs::remove_file(&f.socket_path).unwrap();
    let replay = command().args(["--action", "converge"]).output().unwrap();
    assert!(replay.status.success());
    let replay: serde_json::Value = serde_json::from_slice(&replay.stdout).unwrap();
    assert_eq!(replay["workflow"]["budgetRemainingMicrousd"], 90);
    assert_eq!(
        replay["workflow"]["artifactsByStep"],
        recovered["workflow"]["artifactsByStep"]
    );
}

#[test]
fn autonomous_cli_sigterm_interrupts_broker_and_restarts_query_only() {
    check_broker_cli_signal(nix::sys::signal::Signal::SIGTERM);
}

#[test]
fn autonomous_cli_sigint_interrupts_broker_and_restarts_query_only() {
    check_broker_cli_signal(nix::sys::signal::Signal::SIGINT);
}
