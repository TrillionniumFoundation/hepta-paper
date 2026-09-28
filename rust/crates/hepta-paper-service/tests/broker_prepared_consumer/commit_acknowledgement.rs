//! Commit-bound ACK flows through the ordinary service after SQLite commit.
//! Local keys and protocol peers are fixtures, not installed authority acceptance.
use super::*;
use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_campaign_writer::{CampaignWriterPolicyV1, CampaignWriterStoreV1};
use hepta_codex_broker::{
    CommitBindingDatabaseScopeV2, CommitBindingResolverV2,
    CommitBoundPreparedResultAcknowledgementV2, SqliteCommitBindingResolverV2,
    commit_bound_acknowledgement_signing_bytes_v2,
};
use hepta_paper_service::ServiceError;
use std::os::unix::fs::MetadataExt;

fn current_unix_ms() -> u64 {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

fn write_resigned_acknowledgement(
    f: &Fixture,
    acknowledgement: &mut CommitBoundPreparedResultAcknowledgementV2,
) {
    acknowledgement.signature_base64 = Base64UrlUnpadded::encode_string(
        &SigningKey::from_bytes(&[75; 32])
            .sign(&commit_bound_acknowledgement_signing_bytes_v2(acknowledgement).unwrap())
            .to_bytes(),
    );
    let path = f.commit_acknowledgement_path();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&path, serde_json::to_vec(acknowledgement).unwrap()).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o400)).unwrap();
}

fn durable_entry(f: &Fixture) -> (u64, hepta_module_platform::PreparedResultV1) {
    let owner = fs::metadata(&f.config.state_directory).unwrap().uid();
    let (campaign, log, _) = CampaignWriterStoreV1::read_local_control_snapshot(
        f.config.state_directory.join("campaign.sqlite"),
        CampaignWriterPolicyV1::strict(owner),
        &f.config.snapshot.campaign_id,
    )
    .unwrap();
    assert_eq!(log.entries.len(), 1);
    (
        campaign.budget_remaining_microusd,
        serde_json::from_str(&log.entries[0].result_json).unwrap(),
    )
}

fn canonical_commit_binding(
    f: &Fixture,
    acknowledgement: &hepta_codex_broker::CommitBoundPreparedResultAcknowledgementV2,
) -> hepta_codex_broker::PreparedResultCommitBindingV2 {
    let owner = fs::metadata(&f.config.state_directory).unwrap().uid();
    let resolver = SqliteCommitBindingResolverV2::new(
        f.config.state_directory.join("campaign.sqlite"),
        owner,
        5_000,
        4 * 1024 * 1024 * 1024,
        CommitBindingDatabaseScopeV2::LocalOnly,
    )
    .unwrap();
    resolver
        .resolve_commit_binding(&acknowledgement.subject())
        .unwrap()
}

fn commit_without_ack(f: &Fixture) {
    f.publish_cost_settlement(OUTPUT, 6);
    let peer = f.serve_execution(f.listener(), OUTPUT, 0);
    assert!(matches!(
        run_service_v1(f.config.clone()),
        Err(ServiceError::PostCommitAcknowledgement)
    ));
    peer.join().unwrap();
    let (budget, result) = durable_entry(f);
    assert_eq!(budget, 94);
    assert_eq!(result.actual_cost_microusd, 6);
    fs::remove_file(&f.socket_path).unwrap();
}

#[test]
fn ordinary_commit_waits_for_signed_commit_ack_then_replays_without_provider() {
    let f = Fixture::new_acknowledged_execution();
    commit_without_ack(&f);
    let acknowledgement = f.publish_commit_acknowledgement(OUTPUT);
    assert_eq!(
        canonical_commit_binding(&f, &acknowledgement),
        acknowledgement.commit_binding()
    );
    let peer = f.serve_commit_acknowledgement(f.listener(), acknowledgement, false);
    let recovered = run_service_v1(f.config.clone()).unwrap();
    peer.join().unwrap();
    assert!(!recovered.commit_receipts[0].newly_committed);
    let (budget, result) = durable_entry(&f);
    assert_eq!((budget, result.actual_cost_microusd), (94, 6));
    fs::remove_file(&f.socket_path).unwrap();
    fs::remove_file(f.commit_acknowledgement_path()).unwrap();
    let offline = run_service_v1(f.config.clone()).unwrap();
    assert!(!offline.commit_receipts[0].newly_committed);
    assert_eq!(
        offline.commit_receipts[0].result_hash,
        recovered.commit_receipts[0].result_hash
    );
    // Legacy valid V2 confirmations did not have an intent companion.
    let hash = offline.commit_receipts[0]
        .result_hash
        .as_str()
        .trim_start_matches("sha256:");
    fs::remove_file(
        f.config
            .state_directory
            .join("commit-acknowledgements-v2")
            .join(format!("{hash}.intent.json")),
    )
    .unwrap();
    assert!(
        ack_cli(&f).status.success(),
        "legacy completed replay remains offline"
    );
}

#[test]
fn lost_commit_ack_response_retries_only_the_identical_ack() {
    let f = Fixture::new_acknowledged_execution();
    commit_without_ack(&f);
    let acknowledgement = f.publish_commit_acknowledgement(OUTPUT);
    let lost = f.serve_commit_acknowledgement(f.listener(), acknowledgement.clone(), true);
    assert!(matches!(
        run_service_v1(f.config.clone()),
        Err(ServiceError::PostCommitAcknowledgement)
    ));
    lost.join().unwrap();
    fs::remove_file(&f.socket_path).unwrap();
    let recovery = f.serve_commit_acknowledgement(f.listener(), acknowledgement, false);
    let completed = run_service_v1(f.config.clone()).unwrap();
    recovery.join().unwrap();
    assert!(!completed.commit_receipts[0].newly_committed);
    assert_eq!(durable_entry(&f).0, 94);
}

#[test]
fn expired_or_revoked_ack_keeps_the_commit_fenced_without_provider_reexecution() {
    let f = Fixture::new_acknowledged_execution();
    commit_without_ack(&f);
    let valid = f.publish_commit_acknowledgement(OUTPUT);

    let mut expired = valid.clone();
    expired.acknowledged_at_unix_ms = 1;
    write_resigned_acknowledgement(&f, &mut expired);
    assert!(matches!(
        run_service_v1(f.config.clone()),
        Err(ServiceError::PostCommitAcknowledgement)
    ));
    assert!(!f.socket_path.exists(), "expired ACK reached broker IPC");
    assert_eq!(durable_entry(&f).0, 94);

    let mut revoked_generation = valid.clone();
    revoked_generation.trust_store_generation += 1;
    write_resigned_acknowledgement(&f, &mut revoked_generation);
    assert!(matches!(
        run_service_v1(f.config.clone()),
        Err(ServiceError::PostCommitAcknowledgement)
    ));
    assert!(
        !f.socket_path.exists(),
        "revoked-generation ACK reached broker IPC"
    );
    assert_eq!(durable_entry(&f).0, 94);

    let mut valid = valid;
    write_resigned_acknowledgement(&f, &mut valid);
    let peer = f.serve_commit_acknowledgement(f.listener(), valid, false);
    let completed = run_service_v1(f.config.clone()).unwrap();
    peer.join().unwrap();
    assert!(!completed.commit_receipts[0].newly_committed);
    assert_eq!(durable_entry(&f).0, 94);
}

#[test]
fn changed_or_invalid_ack_cannot_replace_the_durable_commit() {
    let f = Fixture::new_acknowledged_execution();
    commit_without_ack(&f);
    let acknowledgement = f.publish_commit_acknowledgement(OUTPUT);
    let canonical = canonical_commit_binding(&f, &acknowledgement);
    assert_eq!(canonical, acknowledgement.commit_binding());
    let path = f.commit_acknowledgement_path();
    let retained = fs::read(&path).unwrap();
    let mut changed: serde_json::Value = serde_json::from_slice(&retained).unwrap();
    changed["committedStateHash"] = serde_json::json!(hash(b"wrong committed state"));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    assert!(matches!(
        run_service_v1(f.config.clone()),
        Err(ServiceError::PostCommitAcknowledgement)
    ));
    assert!(!f.socket_path.exists(), "invalid ACK reached broker IPC");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&path, retained).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    let peer = f.serve_commit_acknowledgement(f.listener(), acknowledgement, false);
    assert!(run_service_v1(f.config.clone()).is_ok());
    peer.join().unwrap();
    assert_eq!(durable_entry(&f).0, 94);
}

#[test]
fn workflow_reopens_committed_prefix_and_recovers_lost_ack_without_provider() {
    use hepta_paper_service::workflow::{
        WorkflowActionV1, WorkflowError, initialize_local_workflow_v1, operate_local_workflow_v1,
    };
    let mut f = Fixture::new_acknowledged_execution();
    let state = f.root.join("acknowledged-workflow");
    let definition = broker_workflow_definition(&f, &state);
    let definition_hash = initialize_local_workflow_v1(definition).unwrap();
    // The selected workflow owns the actual sequencer database used by ACK authority.
    f.config.state_directory = state.clone();
    f.publish_cost_settlement(OUTPUT, 6);
    let execution = f.serve_execution(f.listener(), OUTPUT, 0);
    let first = operate_local_workflow_v1(
        &state,
        &definition_hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        current_unix_ms(),
    );
    assert!(
        matches!(
            first,
            Err(WorkflowError::Service(
                ServiceError::PostCommitAcknowledgement
            ))
        ),
        "unexpected initial workflow result: {first:?}"
    );
    execution.join().unwrap();
    fs::remove_file(&f.socket_path).unwrap();
    assert_eq!(durable_entry(&f).0, 94);

    let acknowledgement = f.publish_commit_acknowledgement(OUTPUT);
    let lost = f.serve_commit_acknowledgement(f.listener(), acknowledgement.clone(), true);
    let lost_result = operate_local_workflow_v1(
        &state,
        &definition_hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        current_unix_ms(),
    );
    assert!(
        matches!(
            lost_result,
            Err(WorkflowError::Service(
                ServiceError::PostCommitAcknowledgement
            ))
        ),
        "unexpected lost-ACK workflow result: {lost_result:?}"
    );
    lost.join().unwrap();
    fs::remove_file(&f.socket_path).unwrap();

    let recovery = f.serve_commit_acknowledgement(f.listener(), acknowledgement, false);
    let completed = operate_local_workflow_v1(
        &state,
        &definition_hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        current_unix_ms(),
    )
    .unwrap();
    recovery.join().unwrap();
    assert_eq!(completed.committed_steps, 1);
    assert_eq!(completed.budget_remaining_microusd, 94);
    fs::remove_file(&f.socket_path).unwrap();
    fs::remove_file(f.commit_acknowledgement_path()).unwrap();
    let offline = operate_local_workflow_v1(
        &state,
        &definition_hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        current_unix_ms(),
    )
    .unwrap();
    assert_eq!(offline.artifacts_by_step, completed.artifacts_by_step);
    assert_eq!(durable_entry(&f).0, 94);
}

fn ack_command(f: &Fixture) -> Command {
    let path = f.root.join("ack-recovery-run.json");
    fs::write(&path, serde_json::to_vec(&f.config).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
    command.arg("run").arg(path);
    command
}
fn ack_cli(f: &Fixture) -> std::process::Output {
    ack_command(f).output().unwrap()
}

#[test]
fn lost_ack_pins_exact_signed_intent_before_cli_restart_and_rejects_resigning() {
    let f = Fixture::new_acknowledged_execution();
    commit_without_ack(&f);
    let mut original = f.publish_commit_acknowledgement(OUTPUT);
    let lost = f.serve_commit_acknowledgement(f.listener(), original.clone(), true);
    assert!(!ack_cli(&f).status.success());
    lost.join().unwrap();
    fs::remove_file(&f.socket_path).unwrap();
    let hash = durable_entry(&f).1.result_hash().unwrap();
    let intent = f
        .config
        .state_directory
        .join("commit-acknowledgements-v2")
        .join(format!(
            "{}.intent.json",
            hash.as_str().trim_start_matches("sha256:")
        ));
    assert!(
        intent.is_file(),
        "exact signed ACK must be durable before transport"
    );
    let retained = fs::read(&intent).unwrap();
    let authority_bytes = fs::read(f.commit_acknowledgement_path()).unwrap();
    fs::remove_file(f.commit_acknowledgement_path()).unwrap();
    assert!(
        !ack_cli(&f).status.success(),
        "local intent cannot replace authority input"
    );
    assert!(!f.socket_path.exists());
    assert_eq!(fs::read(&intent).unwrap(), retained);
    fs::write(f.commit_acknowledgement_path(), authority_bytes).unwrap();
    fs::set_permissions(
        f.commit_acknowledgement_path(),
        fs::Permissions::from_mode(0o400),
    )
    .unwrap();
    let record: serde_json::Value = serde_json::from_slice(&retained).unwrap();
    assert_eq!(
        record["acknowledgement"],
        serde_json::to_value(&original).unwrap()
    );
    let mut replaced = original.clone();
    replaced.acknowledged_at_unix_ms -= 1;
    write_resigned_acknowledgement(&f, &mut replaced);
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    assert!(
        !ack_cli(&f).status.success(),
        "replacement is not the selected ACK"
    );
    assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    assert_eq!(fs::read(&intent).unwrap(), retained);
    assert_eq!(durable_entry(&f).0, 94);
    drop(listener);
    fs::remove_file(&f.socket_path).unwrap();
    write_resigned_acknowledgement(&f, &mut original);
    let peer = f.serve_commit_acknowledgement(f.listener(), original, false);
    assert!(ack_cli(&f).status.success());
    peer.join().unwrap();
    fs::remove_file(&f.socket_path).unwrap();
    fs::remove_file(f.commit_acknowledgement_path()).unwrap();
    assert!(ack_cli(&f).status.success(), "completed replay is IPC-free");
    assert_eq!(durable_entry(&f).0, 94);
    assert_eq!(fs::read(&intent).unwrap(), retained);
}

#[test]
fn actual_cli_death_after_ack_send_recovers_original_ack_without_provider_or_debit() {
    use std::{
        io::Read,
        os::unix::process::ExitStatusExt,
        process::Stdio,
        time::{Duration, Instant},
    };
    let f = Fixture::new_acknowledged_execution();
    commit_without_ack(&f);
    let acknowledgement = f.publish_commit_acknowledgement(OUTPUT);
    let listener = f.listener();
    listener.set_nonblocking(true).unwrap();
    let mut child = ack_command(&f)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    let mut stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
            {
                if let Some(status) = child.try_wait().unwrap() {
                    panic!("CLI ended before ACK: {status}");
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("ACK was not sent: {error}");
            }
        }
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut expected = Vec::new();
    hepta_codex_broker::write_commit_bound_acknowledgement_frame(
        &mut expected,
        &acknowledgement,
        Default::default(),
    )
    .unwrap();
    let mut received = vec![0; expected.len()];
    let observed = stream.read_exact(&mut received);
    // This is the owned test CLI only; the installed service is never signalled.
    child.kill().unwrap();
    assert_eq!(child.wait().unwrap().signal(), Some(9));
    observed.unwrap();
    assert_eq!(received, expected);
    drop(stream);
    drop(listener);
    fs::remove_file(&f.socket_path).unwrap();
    assert_eq!(durable_entry(&f).0, 94);
    let peer = f.serve_commit_acknowledgement(f.listener(), acknowledgement, false);
    assert!(ack_cli(&f).status.success());
    peer.join().unwrap();
    fs::remove_file(&f.socket_path).unwrap();
    fs::remove_file(f.commit_acknowledgement_path()).unwrap();
    assert!(ack_cli(&f).status.success());
    assert_eq!(durable_entry(&f).0, 94);
}
