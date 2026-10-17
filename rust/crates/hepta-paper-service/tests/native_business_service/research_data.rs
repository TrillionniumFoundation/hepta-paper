//! Real service/CAS dispatch and recovery for data reports, not a whole paper verdict.
use super::*;
use hepta_paper_service::native_business::research_data::{
    NativeResearchDataInputV1, NativeResearchDataWorkerRequestV1, NativeResearchDataWorkerTypeV1,
};
use serde_json::json;
use std::os::unix::fs::MetadataExt;

fn job(temp: &Temp) -> (NativeBusinessJobV1, PathBuf, Vec<u8>) {
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let bytes = b"value\n1\n3\n".to_vec();
    let hash = objects.put(&bytes).unwrap();
    let path = objects
        .root()
        .join(hash.as_str().trim_start_matches("sha256:"));
    (
        NativeBusinessJobV1::ResearchDataWorkerV1 {
            request: NativeResearchDataWorkerRequestV1 {
                version: 1,
                worker_type: NativeResearchDataWorkerTypeV1::CsvDescriptiveStatistics,
                parameters_json: "{}".into(),
                inputs: vec![NativeResearchDataInputV1 {
                    role: "numeric_source".into(),
                    path: "data/values.csv".into(),
                    expected_hash: hash.clone(),
                    hash,
                }],
            },
        },
        path,
        bytes,
    )
}
fn attempts(temp: &Temp) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(temp.0.join("attempts"))
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().into_string().unwrap(),
                fs::read(entry.path()).unwrap(),
            )
        })
        .collect()
}
fn prepared(temp: &Temp) -> hepta_module_platform::PreparedResultV1 {
    let bytes = attempts(temp)
        .into_iter()
        .find(|(name, _)| name.ends_with(".prepared"))
        .unwrap()
        .1;
    serde_json::from_slice(&bytes).unwrap()
}
fn snapshot(
    temp: &Temp,
) -> (
    hepta_campaign_writer::CampaignSnapshotV1,
    hepta_campaign_writer::DurableControlLogV1,
) {
    let (campaign, log, _) =
        hepta_campaign_writer::CampaignWriterStoreV1::read_local_control_snapshot(
            temp.0.join("campaign.sqlite"),
            hepta_campaign_writer::CampaignWriterPolicyV1::strict(
                fs::metadata(&temp.0).unwrap().uid(),
            ),
            "campaign-native-business",
        )
        .unwrap();
    (campaign, log)
}
#[test]
fn actual_cas_research_data_worker_commits_full_report_once_and_reopens() {
    let temp = Temp::new();
    let (job, path, bytes) = job(&temp);
    let config = configuration_for_job(&temp, job);
    let first = run_service_v1(config.clone()).unwrap();
    assert_eq!(first.commit_receipts.len(), 1);
    assert!(first.commit_receipts[0].newly_committed);
    let result = prepared(&temp);
    assert_eq!(result.artifact_hashes.len(), 1);
    assert_eq!(result.actual_cost_microusd, 1); // Source candidate tariff, not a measured provider charge.
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let report: serde_json::Value =
        serde_json::from_slice(&objects.read(&result.artifact_hashes[0]).unwrap()).unwrap();
    assert_eq!(
        report,
        json!({"status":"native_research_worker_passed","rowCount":2,"columns":{"value":{"count":2,"min":1,"max":3,"sum":4,"mean":2,"sampleVariance":2,"sampleStdDev":2.0_f64.sqrt()}},"blockers":[]})
    );
    let evidence: serde_json::Value =
        serde_json::from_slice(&objects.read(&result.evidence_hash).unwrap()).unwrap();
    assert_eq!(
        evidence["workerEvidence"]["kind"],
        "NativeResearchDataWorkerEvidenceV1"
    );
    assert_eq!(evidence["workerEvidence"]["scientificAcceptance"], false);
    assert_eq!(
        evidence["workerEvidence"]["externalEffectAuthorized"],
        false
    );
    let before = attempts(&temp);
    let (campaign, log) = snapshot(&temp);
    assert_eq!(campaign.budget_remaining_microusd, 99);
    assert_eq!(log.entries.len(), 1);
    assert_eq!(
        log.entries[0].result_hash,
        first.commit_receipts[0].result_hash
    );
    assert_eq!(log.entries[0].actual_cost_microusd, 1);
    let retry = run_service_v1(config).unwrap();
    assert!(!retry.commit_receipts[0].newly_committed);
    assert_eq!(
        retry.commit_receipts[0].result_hash,
        first.commit_receipts[0].result_hash
    );
    assert_eq!(attempts(&temp), before);
    assert_eq!(prepared(&temp), result);
    let (after, after_log) = snapshot(&temp);
    assert_eq!(after.budget_remaining_microusd, 99);
    assert_eq!(after_log.entries, log.entries);
    assert_eq!(fs::read(path).unwrap(), bytes);
}
#[test]
fn actual_cas_research_data_unknown_start_preserved_and_restore_cannot_reexecute() {
    let temp = Temp::new();
    let (job, path, bytes) = job(&temp);
    let config = configuration_for_job(&temp, job);
    fs::write(&path, b"corrupt retained source").unwrap();
    assert!(run_service_v1(config.clone()).is_err());
    let before = attempts(&temp);
    assert_eq!(before.len(), 1);
    assert!(before.keys().all(|name| name.ends_with(".started")));
    let (campaign, log) = snapshot(&temp);
    assert_eq!(campaign.budget_remaining_microusd, 100);
    assert!(log.entries.is_empty());
    assert_eq!(fs::read(&path).unwrap(), b"corrupt retained source");
    fs::write(&path, bytes).unwrap();
    assert!(run_service_v1(config).is_err());
    assert_eq!(attempts(&temp), before);
    assert!(snapshot(&temp).1.entries.is_empty());
}
#[test]
fn actual_cas_research_data_wrong_capability_refused_before_intent_then_valid_retry() {
    let temp = Temp::new();
    let (job, path, bytes) = job(&temp);
    let mut wrong = build_configuration(&temp);
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    wrong.frontier.candidates[0].payload_hash = objects
        .put(&serde_json::to_vec(&NativeJobV1::Business { job: job.clone() }).unwrap())
        .unwrap();
    assert!(run_service_v1(wrong).is_err());
    assert!(attempts(&temp).is_empty());
    let good = configuration_for_job(&temp, job);
    assert!(run_service_v1(good).unwrap().commit_receipts[0].newly_committed);
    assert_eq!(fs::read(path).unwrap(), bytes);
}
