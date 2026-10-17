//! Signed provider billing enters through the ordinary broker/service/CAS/SQLite path.
//! Fixtures use a local key and protocol peer; they are not provider or target-host acceptance.
use super::*;
use hepta_campaign_writer::{CampaignWriterPolicyV1, CampaignWriterStoreV1};
use hepta_module_platform::PreparedResultV1;
use std::os::unix::fs::MetadataExt;

fn durable_cost(f: &Fixture) -> (u64, u64, PreparedResultV1) {
    let owner = fs::metadata(&f.config.state_directory).unwrap().uid();
    let (campaign, log, _) = CampaignWriterStoreV1::read_local_control_snapshot(
        f.config.state_directory.join("campaign.sqlite"),
        CampaignWriterPolicyV1::strict(owner),
        &f.config.snapshot.campaign_id,
    )
    .unwrap();
    assert_eq!(log.entries.len(), 1);
    let result: PreparedResultV1 = serde_json::from_str(&log.entries[0].result_json).unwrap();
    (
        campaign.budget_remaining_microusd,
        log.entries[0].actual_cost_microusd,
        result,
    )
}

fn empty_durable_log(f: &Fixture) {
    let owner = fs::metadata(&f.config.state_directory).unwrap().uid();
    let (campaign, log, _) = CampaignWriterStoreV1::read_local_control_snapshot(
        f.config.state_directory.join("campaign.sqlite"),
        CampaignWriterPolicyV1::strict(owner),
        &f.config.snapshot.campaign_id,
    )
    .unwrap();
    assert_eq!(campaign.budget_remaining_microusd, 100);
    assert!(log.entries.is_empty());
}

#[test]
fn signed_actual_cost_is_debited_by_the_normal_sequencer_and_replays_offline() {
    let f = Fixture::new_settled_execution();
    f.publish_cost_settlement(OUTPUT, 6);
    let peer = f.serve_execution(f.listener(), OUTPUT, 0);
    let first = run_service_v1(f.config.clone()).unwrap();
    peer.join().unwrap();
    assert!(first.commit_receipts[0].newly_committed);
    let (budget, cost, result) = durable_cost(&f);
    assert_eq!(budget, 94);
    assert_eq!(cost, 6);
    assert_eq!(result.actual_cost_microusd, 6);
    let objects = ObjectStoreV1::open(&f.config.state_directory).unwrap();
    let evidence: serde_json::Value =
        serde_json::from_slice(&objects.read(&result.evidence_hash).unwrap()).unwrap();
    assert_eq!(
        evidence["workerEvidence"]["cost"]["classification"],
        "measured_signed_provider_settlement"
    );
    assert_eq!(evidence["workerEvidence"]["cost"]["costMicrousd"], 6);
    assert!(
        evidence["workerEvidence"]["cost"]["settlementHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );

    fs::remove_file(&f.socket_path).unwrap();
    fs::remove_file(f.cost_settlement_path()).unwrap();
    let replay = run_service_v1(f.config.clone()).unwrap();
    assert!(!replay.commit_receipts[0].newly_committed);
    assert_eq!(
        first.commit_receipts[0].result_hash,
        replay.commit_receipts[0].result_hash
    );
    let (replay_budget, replay_cost, replay_result) = durable_cost(&f);
    assert_eq!((replay_budget, replay_cost), (94, 6));
    assert_eq!(replay_result, result);
}

#[test]
fn missing_settlement_preserves_query_only_recovery_and_commits_when_authority_arrives() {
    let f = Fixture::new_settled_execution();
    let peer = f.serve_execution(f.listener(), OUTPUT, 0);
    assert!(run_service_v1(f.config.clone()).is_err());
    peer.join().unwrap();
    empty_durable_log(&f);
    let records: Vec<_> = fs::read_dir(f.config.state_directory.join("attempts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(records.len(), 1);
    assert!(records[0].ends_with(".started"));

    fs::remove_file(&f.socket_path).unwrap();
    f.publish_cost_settlement(OUTPUT, 6);
    // This peer accepts only the original HEPTAQX1 query. An execution retry fails the fixture.
    let recovery = f.serve(f.listener(), OUTPUT, false, false);
    let committed = run_service_v1(f.config.clone()).unwrap();
    recovery.join().unwrap();
    assert!(committed.commit_receipts[0].newly_committed);
    let (budget, cost, result) = durable_cost(&f);
    assert_eq!((budget, cost, result.actual_cost_microusd), (94, 6, 6));
}

#[test]
fn valid_signature_over_a_cost_above_the_signed_request_cap_never_commits() {
    let f = Fixture::new_settled_execution();
    f.publish_cost_settlement(OUTPUT, 11);
    let peer = f.serve_execution(f.listener(), OUTPUT, 0);
    assert!(run_service_v1(f.config.clone()).is_err());
    peer.join().unwrap();
    empty_durable_log(&f);
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn changed_signed_settlement_cannot_replace_an_uncommitted_prepared_cache() {
    use hepta_control_plane::ControlPlaneError;

    let f = Fixture::new_settled_execution();
    f.publish_cost_settlement(OUTPUT, 6);
    let settlement: hepta_codex_broker::ProviderCostSettlementV1 =
        serde_json::from_slice(&fs::read(f.cost_settlement_path()).unwrap()).unwrap();
    let peer = f.serve_execution(f.listener(), OUTPUT, 0);
    let mut clock = || {
        if fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .any(|entry| {
                entry
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|ext| ext == "prepared")
            })
        {
            Err(ControlPlaneError::ExecutionInvalid)
        } else {
            Ok(settlement.issued_at_unix_ms)
        }
    };
    assert!(hepta_paper_service::run_service_with_clock_v1(f.config.clone(), &mut clock).is_err());
    peer.join().unwrap();
    empty_durable_log(&f);
    let retained: Vec<_> = fs::read_dir(f.config.state_directory.join("attempts"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                path.file_name().unwrap().to_owned(),
                fs::read(path).unwrap(),
            )
        })
        .collect();
    assert_eq!(retained.len(), 2);

    fs::remove_file(&f.socket_path).unwrap();
    f.publish_cost_settlement(OUTPUT, 5);
    let replacement = f.serve(f.listener(), OUTPUT, false, false);
    assert!(run_service_v1(f.config.clone()).is_err());
    replacement.join().unwrap();
    let observed: Vec<_> = fs::read_dir(f.config.state_directory.join("attempts"))
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                path.file_name().unwrap().to_owned(),
                fs::read(path).unwrap(),
            )
        })
        .collect();
    assert_eq!(observed, retained);
}

#[test]
fn settlement_uses_the_service_admission_clock_and_recovers_after_time_advances() {
    use hepta_codex_broker::ProviderCostSettlementV1;

    let f = Fixture::new_settled_execution();
    f.publish_cost_settlement(OUTPUT, 6);
    let settlement: ProviderCostSettlementV1 =
        serde_json::from_slice(&fs::read(f.cost_settlement_path()).unwrap()).unwrap();
    assert!(settlement.issued_at_unix_ms > f.config.observed_at_unix_ms);
    let stale_now = settlement.issued_at_unix_ms - 1;
    let peer = f.serve_execution(f.listener(), OUTPUT, 0);
    let mut stale_clock = || Ok(stale_now);
    assert!(
        hepta_paper_service::run_service_with_clock_v1(f.config.clone(), &mut stale_clock).is_err()
    );
    peer.join().unwrap();
    empty_durable_log(&f);
    assert_eq!(
        fs::read_dir(f.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        1
    );

    fs::remove_file(&f.socket_path).unwrap();
    let recovery = f.serve(f.listener(), OUTPUT, false, false);
    let mut current_clock = || Ok(settlement.issued_at_unix_ms);
    let committed =
        hepta_paper_service::run_service_with_clock_v1(f.config.clone(), &mut current_clock)
            .unwrap();
    recovery.join().unwrap();
    assert!(committed.commit_receipts[0].newly_committed);
    let (budget, cost, result) = durable_cost(&f);
    assert_eq!((budget, cost, result.actual_cost_microusd), (94, 6, 6));
}
