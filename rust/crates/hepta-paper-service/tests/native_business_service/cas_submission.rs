//! These real worker and frontend runs prove the source primitive's durable
//! effects. They do not claim that the canonical batch parser queues this job.
use super::*;
use hepta_paper_service::native_business::{
    execute_native_business_v1,
    local_submission_preflight::{
        CasLocalSubmissionArtifactRoleV1, CasLocalSubmissionArtifactV1,
        CasLocalSubmissionPreparationRequestV1, LocalSubmissionPreflightInputV1,
    },
};
use serde_json::{Value, json};
use std::os::unix::fs::MetadataExt;

fn cas_job(temp: &Temp, body: &str) -> (NativeBusinessJobV1, Vec<(PathBuf, Vec<u8>)>) {
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let bundle = execute_native_business_v1(NativeBusinessJobV1::BuildPackage {
        entries: vec![BuildEntryV1 {
            path: "main.md".into(),
            content: body.into(),
            media_type: "text/markdown".into(),
        }],
    })
    .unwrap()
    .artifacts[1]
        .clone();
    let manuscript = objects.put(body.as_bytes()).unwrap();
    let source = objects.put(&bundle).unwrap();
    let observed = [(&manuscript, body.as_bytes().to_vec()), (&source, bundle)]
        .into_iter()
        .map(|(digest, bytes)| {
            (
                temp.0
                    .join("objects")
                    .join(digest.as_str().trim_start_matches("sha256:")),
                bytes,
            )
        })
        .collect();
    let request = CasLocalSubmissionPreparationRequestV1 {
        version: 1,
        kind: "NativeCasLocalSubmissionPreparationRequest".into(),
        preflight: LocalSubmissionPreflightInputV1 {
            version: 1,
            kind: "NativeLocalSubmissionPreflightInput".into(),
            paper_task: json!({"paperId":"worker-cas-paper","taskKey":"worker-cas-paper:submission","title":"Actual worker CAS paper","sourceWorkspace":format!("cas:{source}"),"mainTex":"main.md","venueTarget":"Fixture Venue"}),
            venue: Some(
                json!({"name":"Fixture Venue","venue_id":"fixture-venue","kind":"journal"}),
            ),
            mode: "local-dry-run".into(),
            reviewed_submit: false,
        },
        artifacts: vec![
            CasLocalSubmissionArtifactV1 {
                role: CasLocalSubmissionArtifactRoleV1::Manuscript,
                filename: "main.md".into(),
                digest: manuscript,
            },
            CasLocalSubmissionArtifactV1 {
                role: CasLocalSubmissionArtifactRoleV1::SourcePackage,
                filename: "source.hepta".into(),
                digest: source,
            },
        ],
        cover_letter: "Please consider this locally prepared manuscript.".into(),
        reference_time_millis: 1_759_276_800_000,
    };
    (
        NativeBusinessJobV1::PrepareLocalSubmissionFromCasV1 { request },
        observed,
    )
}
fn attempt_records(temp: &Temp) -> BTreeMap<String, Vec<u8>> {
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
    let path = fs::read_dir(temp.0.join("attempts"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "prepared"))
        .unwrap();
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn durable_log(
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
fn assert_local_prepared(temp: &Temp, result: &hepta_module_platform::PreparedResultV1) -> Value {
    assert_eq!(result.actual_cost_microusd, 1); // The existing source candidate tariff, not a provider measurement.
    assert_eq!(result.artifact_hashes.len(), 1);
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let value: Value =
        serde_json::from_slice(&objects.read(&result.artifact_hashes[0]).unwrap()).unwrap();
    assert_eq!(value["kind"], "NativeCasLocalSubmissionPreparation");
    assert_eq!(
        value["lifecycle"]["manifest"]["status"],
        "ready_for_adapter"
    );
    assert_eq!(value["lifecycle"]["receipt"]["status"], "dry_run_recorded");
    assert_eq!(value["externalActionPerformed"], false);
    assert_eq!(value["externalActionAuthorized"], false);
    let evidence: Value =
        serde_json::from_slice(&objects.read(&result.evidence_hash).unwrap()).unwrap();
    assert_eq!(
        evidence["workerEvidence"]["normalSubmissionRouteAccepted"],
        false
    );
    value
}
#[test]
fn cas_local_preparation_worker_commits_actual_artifacts_and_source_cost_once_then_reopens() {
    let temp = Temp::new();
    let (job, inputs) = cas_job(
        &temp,
        "# Real prepared worker artifact\n\nNo external action.\n",
    );
    let config = configuration_for_job(&temp, job);
    let first = run_service_v1(config.clone()).unwrap();
    assert_eq!(first.commit_receipts.len(), 1);
    assert!(first.commit_receipts[0].newly_committed);
    assert!(!first.production_activation);
    assert_eq!(first.resource_report.reservation_count, 0);
    let original = prepared(&temp);
    let value = assert_local_prepared(&temp, &original);
    let before = attempt_records(&temp);
    let (campaign, log) = durable_log(&temp);
    assert_eq!(campaign.budget_remaining_microusd, 99);
    assert_eq!(log.entries.len(), 1);
    assert_eq!(log.entries[0].actual_cost_microusd, 1);
    assert_eq!(
        log.entries[0].result_hash,
        first.commit_receipts[0].result_hash
    );
    assert_eq!(
        serde_json::from_str::<hepta_module_platform::PreparedResultV1>(
            &log.entries[0].result_json
        )
        .unwrap(),
        original
    );
    let again = run_service_v1(config).unwrap();
    assert!(!again.commit_receipts[0].newly_committed);
    assert_eq!(
        again.commit_receipts[0].result_hash,
        first.commit_receipts[0].result_hash
    );
    assert_eq!(attempt_records(&temp), before);
    assert_eq!(assert_local_prepared(&temp, &prepared(&temp)), value);
    let (after, after_log) = durable_log(&temp);
    assert_eq!(after.budget_remaining_microusd, 99);
    assert_eq!(after_log.entries, log.entries);
    for (path, bytes) in inputs {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}
#[test]
fn cas_local_preparation_unknown_start_retains_corruption_and_cannot_reexecute_after_restore() {
    let temp = Temp::new();
    let (job, inputs) = cas_job(&temp, "# Source before interrupted preparation\n");
    let config = configuration_for_job(&temp, job.clone());
    fs::write(&inputs[1].0, b"retained corrupt CAS source").unwrap();
    assert!(run_service_v1(config.clone()).is_err());
    let before = attempt_records(&temp);
    assert_eq!(before.len(), 1);
    assert!(before.keys().all(|n| n.ends_with(".started")));
    assert_eq!(
        fs::read(&inputs[1].0).unwrap(),
        b"retained corrupt CAS source"
    );
    let (campaign, log) = durable_log(&temp);
    assert_eq!(campaign.budget_remaining_microusd, 100);
    assert!(log.entries.is_empty());
    fs::write(&inputs[1].0, &inputs[1].1).unwrap();
    assert!(run_service_v1(config).is_err());
    assert!(run_service_v1(configuration_for_job(&temp, job)).is_err());
    assert_eq!(attempt_records(&temp), before);
    assert!(durable_log(&temp).1.entries.is_empty());
}
#[test]
fn cas_local_preparation_wrong_capability_is_refused_before_intent_and_valid_retry_commits() {
    let temp = Temp::new();
    let mut wrong = build_configuration(&temp); // This manifest authorizes CAP-BUILD only.
    let (job, inputs) = cas_job(&temp, "# Bound actual manuscript\n");
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    wrong.frontier.candidates[0].payload_hash = objects
        .put(&serde_json::to_vec(&NativeJobV1::Business { job: job.clone() }).unwrap())
        .unwrap();
    drop(objects);
    assert!(run_service_v1(wrong).is_err());
    assert!(attempt_records(&temp).is_empty());
    let good = configuration_for_job(&temp, job);
    let actual = run_service_v1(good).unwrap();
    assert!(actual.commit_receipts[0].newly_committed);
    assert_local_prepared(&temp, &prepared(&temp));
    for (path, bytes) in inputs {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[derive(Debug, PartialEq, Eq)]
struct CasSourceExecutableObservation {
    raw_hash: Vec<u8>,
    metadata: (u64, u64, u64, u32, u32, u32, u64, i64, i64, i64, i64),
}
fn cas_executable_observation(path: &std::path::Path) -> CasSourceExecutableObservation {
    use sha2::{Digest, Sha256};
    let m = fs::symlink_metadata(path).unwrap();
    assert!(m.is_file());
    let b = fs::read(path).unwrap();
    assert!(b.starts_with(b"\x7fELF"));
    CasSourceExecutableObservation {
        raw_hash: Sha256::digest(b).to_vec(),
        metadata: (
            m.dev(),
            m.ino(),
            m.len(),
            m.uid(),
            m.gid(),
            m.mode(),
            m.nlink(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        ),
    }
}
fn cas_actual_flat_run(
    temp: &Temp,
    executable: &std::path::Path,
    request: &std::path::Path,
) -> (u32, hepta_control_plane::ControlPlaneRunReceiptV1) {
    use hepta_codex_runtime::{
        BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
        run_bounded_process_capturing_stdout_with_cancellation,
    };
    use std::{ffi::OsString, sync::atomic::AtomicBool};
    let environment = EnvironmentPolicyV1::new(
        "source-cas-submission-worker-test-v1",
        ["PATH", "LANG", "LC_ALL"],
        ["PATH"],
    )
    .unwrap()
    .build(
        std::iter::empty::<(OsString, OsString)>(),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
        ]),
    )
    .unwrap();
    let result = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: executable.into(),
            arguments: vec!["run".into(), request.into()],
            working_directory: temp.0.clone(),
            environment,
            stdin: None,
        },
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2_000,
            maximum_stdin_bytes: 1,
            maximum_stdout_bytes: 1024 * 1024,
            maximum_stderr_bytes: 64 * 1024,
            maximum_tail_bytes: 4096,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        result.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(
        result.process.exit_code,
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.process.stderr_tail)
    );
    assert!(result.process.process_group_cleanup_verified);
    assert!(!result.process.stdout_truncated);
    assert!(!result.process.stderr_truncated);
    (
        result.process.process_id,
        serde_json::from_slice(&result.stdout).unwrap(),
    )
}
#[test]
fn cas_local_preparation_actual_flat_frontend_fresh_process_replays_durable_commit_without_route_acceptance()
 {
    let temp = Temp::new();
    let (job, inputs) = cas_job(
        &temp,
        "# Two real frontend processes\n\nLocally prepared.\n",
    );
    let config = configuration_for_job(&temp, job);
    let request = temp.0.join("run-request.json");
    let bytes = serde_json::to_vec(&config).unwrap();
    fs::write(&request, &bytes).unwrap();
    let original = std::path::Path::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
    let before = cas_executable_observation(original);
    let executable = temp.0.join("hepta-paper-rust");
    fs::copy(original, &executable).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o550)).unwrap();
    let shipping = cas_executable_observation(&executable);
    assert_eq!(shipping.raw_hash, before.raw_hash);
    assert_ne!(shipping.metadata.1, before.metadata.1);
    assert_eq!(cas_executable_observation(original), before);
    let (first_pid, first) = cas_actual_flat_run(&temp, &executable, &request);
    assert!(first.commit_receipts[0].newly_committed);
    let output = assert_local_prepared(&temp, &prepared(&temp));
    let original_attempts = attempt_records(&temp);
    let original_log = durable_log(&temp);
    let (second_pid, second) = cas_actual_flat_run(&temp, &executable, &request);
    assert_ne!(first_pid, second_pid);
    assert!(!second.commit_receipts[0].newly_committed);
    assert_eq!(
        first.commit_receipts[0].result_hash,
        second.commit_receipts[0].result_hash
    );
    assert_eq!(attempt_records(&temp), original_attempts);
    assert_eq!(durable_log(&temp).1.entries, original_log.1.entries);
    assert_eq!(durable_log(&temp).0.budget_remaining_microusd, 99);
    assert_eq!(assert_local_prepared(&temp, &prepared(&temp)), output);
    assert_eq!(cas_executable_observation(original), before);
    assert_eq!(cas_executable_observation(&executable), shipping);
    assert_eq!(fs::read(request).unwrap(), bytes);
    for (path, bytes) in inputs {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    println!(
        "native_cas_submission_worker_observation={}",
        json!({"version":1,"firstActualPid":first_pid,"secondActualPid":second_pid,"actualDurableCommitCount":1,"actualRemainingBudgetMicrousd":99,"costSource":"existing_native_candidate_source_tariff","actualReopenReplay":true,"normalSubmissionRouteAccepted":false,"externalActionAuthorized":false})
    );
}
