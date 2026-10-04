use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use sha2::Digest;
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, sync::atomic::AtomicBool};
fn input(task: Value, venue: Option<Value>, reviewed: bool) -> LocalSubmissionPreflightInputV1 {
    LocalSubmissionPreflightInputV1 {
        version: 1,
        kind: "NativeLocalSubmissionPreflightInput".into(),
        paper_task: task,
        venue,
        mode: if reviewed {
            "reviewed-submit"
        } else {
            "local-dry-run"
        }
        .into(),
        reviewed_submit: reviewed,
    }
}
#[test]
fn native_local_preflight_four_records_match_actual_original_node_whole_values() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let node = std::env::var_os("HEPTA_TEST_NODE")
        .map(PathBuf::from)
        .expect("qualified Node22.23.1 executable required");
    let mut cases = Vec::new();
    for reviewed in [false, true] {
        for task_hash in [
            None,
            Some("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        ] {
            for venue in [
                None,
                Some(json!({"name":"Fixture Venue","venue_id":"venue:fixture","kind":"journal"})),
                Some(
                    json!({"name":"\u{feff}  Alternate\tVenue\r\n\n\n ","venueId":"other-id","kind":"workshop"}),
                ),
            ] {
                let mut task = json!({"paperId":"submission_boundary_fixture","taskKey":"submission_boundary_fixture:paper","title":"Submission boundary fixture","paperType":"systems","sourceWorkspace":"migration/fixtures/missing-source","mainTex":"migration/fixtures/missing-source/main.tex","venueTarget":"Fixture Venue","registry":{}});
                if let Some(hash) = task_hash {
                    task["taskHash"] = json!(hash);
                }
                cases.push(input(task, venue, reviewed));
            }
        }
    }
    // Missing/empty target really derives its fallback from the venue; it is
    // not a stored expected status or hard-coded fixture hash.
    for target in [Value::Null, json!(""), json!("different target")] {
        for reviewed in [false, true] {
            cases.push(input(json!({"paperId":"variable:paper","taskKey":"variable:paper:submission","venueTarget":target}),Some(json!({"name":"Other Venue","venue_id":"venue:other"})),reviewed));
        }
    }
    let program = r#"import { buildVenueSubmissionPlan } from './paper-domain/contracts/venue-contracts.mjs';
import { buildSubmissionApprovalPacket, buildFreshVenueEvidenceBundle } from './paper-domain/contracts/submission.mjs';
import { buildSemanticPromotionLock } from './paper-domain/submission/semantic-promotion-lock.mjs';
const request=readBoundedReplayInput('referee');
const actual=request.cases.map(row=>{if(row.name!=='native_local_submission_preflight'||row.args.length!==1)throw new Error('local_preflight_oracle_operation');const input=row.args[0];const venuePlan=buildVenueSubmissionPlan({paperTask:input.paperTask,venue:input.venue,mode:input.mode,warnings:input.venue?[]:['venue_registry_match_missing']});const semanticPromotionLock=buildSemanticPromotionLock({paperTask:input.paperTask,venuePlan});const approvalPacket=buildSubmissionApprovalPacket({paperTask:input.paperTask,mode:input.mode,venuePlan,semanticPromotionLock});const freshVenueEvidenceBundle=buildFreshVenueEvidenceBundle({paperTask:input.paperTask,venuePlan,semanticPromotionLock,requireAcademicEvidence:input.reviewedSubmit});return {version:1,kind:'NativeLocalSubmissionPreflightCalculations',venuePlan,semanticPromotionLock,approvalPacket,freshVenueEvidenceBundle,externalActionPerformed:false,fullOriginalLifecycleComputed:false,persistencePerformed:false};});process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},actual}));"#;
    let script = format!(
        "{}\n{}",
        include_str!("../../release_replay/oracle-input-guard.mjs"),
        program
    );
    let environment = EnvironmentPolicyV1::new(
        "native-local-submission-preflight-oracle-v1",
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
    let output = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: node,
            arguments: vec!["--input-type=module".into(), "--eval".into(), script.into()],
            working_directory: root,
            environment,
            stdin: Some(serde_json::to_vec(&json!({"version":1,"baseCaseCount":0,"cases":cases.iter().map(|input|json!({"name":"native_local_submission_preflight","args":[input]})).collect::<Vec<_>>()})).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2_000,
            maximum_stdin_bytes: 64 * 1024,
            maximum_stdout_bytes: 1024 * 1024,
            maximum_stderr_bytes: 64 * 1024,
            maximum_tail_bytes: 4 * 1024,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        output.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(output.process.exit_code, Some(0), "{:?}", output);
    assert!(output.process.process_group_cleanup_verified);
    assert_eq!(output.process.stdout_bytes, output.stdout.len() as u64);
    assert_eq!(
        output.process.stdout_hash.as_str(),
        format!(
            "sha256:{}",
            hex::encode(sha2::Sha256::digest(&output.stdout))
        )
    );
    assert_eq!(output.process.stderr_bytes, 0);
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    assert_eq!(value["actual"].as_array().unwrap().len(), cases.len());
    let actual_case_count = cases.len();
    for (index, (case, expected)) in cases
        .into_iter()
        .zip(value["actual"].as_array().unwrap())
        .enumerate()
    {
        assert_eq!(
            build_local_submission_preflight_v1(case).unwrap(),
            *expected,
            "actual same input case {index}"
        );
    }
    println!(
        "native_local_submission_preflight_observation={}",
        json!({"version":1,"actualNodePid":output.process.process_id,"actualCaseCount":actual_case_count,"actualComparedRecordCount":actual_case_count*4,"actualStdoutBytes":output.process.stdout_bytes,"actualStdoutSha256":output.process.stdout_hash.as_str(),"actualNodeNativeWholeValuesMatched":true,"processGroupCleanupVerified":output.process.process_group_cleanup_verified,"fullOriginalLifecycleMatched":false,"normalSubmissionRouteAccepted":false})
    );
}
#[test]
fn native_local_preflight_refuses_authority_fields_invalid_identifiers_and_input_budgets() {
    let valid = json!({"version":1,"kind":"NativeLocalSubmissionPreflightInput","paperTask":{"taskKey":"p:paper","paperId":"p"},"venue":null,"mode":"local-dry-run","reviewedSubmit":false});
    for (field, value) in [
        (
            "liveAuthorizationReceipt",
            json!({"status":"live_submission_authorization_verified"}),
        ),
        (
            "independentReviewAuthorityReceipt",
            json!({"acceptanceAuthorityReady":true}),
        ),
        ("executorResponse", json!({"externalActionPerformed":true})),
        ("callerPassCount", json!(30)),
        ("artifactPackage", json!({"submitReady":true})),
    ] {
        let mut bad = valid.clone();
        bad[field] = value;
        assert!(
            serde_json::from_value::<LocalSubmissionPreflightInputV1>(bad).is_err(),
            "{field}"
        );
    }
    for task in [
        json!({}),
        json!({"taskKey":"","paperId":"p"}),
        json!({"taskKey":"p:paper","paperId":"x".repeat(257)}),
        json!({"taskKey":"p:paper","paperId":"p","large":"x".repeat(64*1024+1)}),
        json!({"taskKey":"p:paper","paperId":"p","large":vec![Value::Null;1025]}),
    ] {
        assert!(build_local_submission_preflight_v1(input(task, None, false)).is_err());
    }
    let mut deep = json!(null);
    for _ in 0..66 {
        deep = json!({"nested":deep});
    }
    assert!(
        build_local_submission_preflight_v1(input(
            json!({"taskKey":"p:paper","paperId":"p","deep":deep}),
            None,
            false
        ))
        .is_err()
    );
    let mut wrong = input(json!({"taskKey":"p:paper","paperId":"p"}), None, false);
    wrong.version = 2;
    assert!(build_local_submission_preflight_v1(wrong).is_err());
}

#[test]
fn native_local_whole_lifecycle_matches_actual_original_node_both_modes() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let node = std::env::var_os("HEPTA_TEST_NODE")
        .map(PathBuf::from)
        .expect("qualified Node22.23.1 executable required");
    let mut cases = Vec::new();
    for reviewed in [false, true] {
        for task_hash in [
            None,
            Some("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        ] {
            for venue in [
                None,
                Some(json!({"name":"Fixture Venue","venue_id":"venue:fixture","kind":"journal"})),
                Some(
                    json!({"name":"\u{feff}  Alternate\tVenue\r\n\n\n ","venueId":"other-id","kind":"workshop"}),
                ),
            ] {
                let mut task = json!({"paperId":"submission_boundary_fixture","taskKey":"submission_boundary_fixture:paper","title":"Submission boundary fixture","paperType":"systems","sourceWorkspace":"migration/fixtures/missing-source","mainTex":"migration/fixtures/missing-source/main.tex","venueTarget":"Fixture Venue","registry":{}});
                if let Some(hash) = task_hash {
                    task["taskHash"] = json!(hash);
                }
                cases.push(input(task, venue, reviewed));
            }
        }
    }
    // Missing/empty target really derives its fallback from the venue; it is
    // not a stored expected status or hard-coded fixture hash.
    for target in [Value::Null, json!(""), json!("different target")] {
        for reviewed in [false, true] {
            cases.push(input(json!({"paperId":"variable:paper","taskKey":"variable:paper:submission","venueTarget":target}),Some(json!({"name":"Other Venue","venue_id":"venue:other"})),reviewed));
        }
    }
    let mut cases = cases
        .into_iter()
        .enumerate()
        .map(|(i, preflight)| LocalSubmissionLifecycleInputV1 {
            version: 1,
            kind: "NativeLocalSubmissionLifecycleInput".into(),
            preflight,
            row_blockers: if i % 3 == 0 {
                vec![
                    "source_missing".into(),
                    " artifact_package_missing ".into(),
                    "source_missing".into(),
                ]
            } else {
                vec![]
            },
            reference_time_millis: 1_759_276_800_000 + i as i64 * 86_400_000,
        })
        .collect::<Vec<_>>();
    let mut same = cases[0].clone();
    same.reference_time_millis = 1_759_276_800_000;
    cases.push(same.clone());
    same.reference_time_millis += 86_400_000;
    cases.push(same);
    let program = r#"import {buildSubmissionLifecycle} from './paper-adapters/submission/submission-lifecycle-orchestrator.mjs';
const request=readBoundedReplayInput('referee');const actual=request.cases.map(row=>{if(row.name!=='native_local_submission_lifecycle'||row.args.length!==1)throw new Error('local_lifecycle_oracle_operation');const input=row.args[0];return buildSubmissionLifecycle({row:{task:input.preflight.paperTask,venue:input.preflight.venue,state:{blockers:input.rowBlockers}},mode:input.preflight.mode,reviewedSubmit:input.preflight.reviewedSubmit,venueEvidenceNow:new Date(input.referenceTimeMillis)});});process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},actual}));"#;
    let script = format!(
        "{}\n{}",
        include_str!("../../release_replay/oracle-input-guard.mjs"),
        program
    );
    let environment = EnvironmentPolicyV1::new(
        "native-local-submission-preflight-oracle-v1",
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
    let output = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: node,
            arguments: vec!["--input-type=module".into(), "--eval".into(), script.into()],
            working_directory: root,
            environment,
            stdin: Some(serde_json::to_vec(&json!({"version":1,"baseCaseCount":0,"cases":cases.iter().map(|input|json!({"name":"native_local_submission_lifecycle","args":[input]})).collect::<Vec<_>>()})).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2_000,
            maximum_stdin_bytes: 64 * 1024,
            maximum_stdout_bytes: 1024 * 1024,
            maximum_stderr_bytes: 64 * 1024,
            maximum_tail_bytes: 4 * 1024,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        output.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(output.process.exit_code, Some(0), "{:?}", output);
    assert!(output.process.process_group_cleanup_verified);
    assert_eq!(output.process.stdout_bytes, output.stdout.len() as u64);
    assert_eq!(
        output.process.stdout_hash.as_str(),
        format!(
            "sha256:{}",
            hex::encode(sha2::Sha256::digest(&output.stdout))
        )
    );
    assert_eq!(output.process.stderr_bytes, 0);
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    assert_eq!(value["actual"].as_array().unwrap().len(), cases.len());
    let actual_case_count = cases.len();
    for (index, (case, expected)) in cases
        .into_iter()
        .zip(value["actual"].as_array().unwrap())
        .enumerate()
    {
        assert_eq!(
            build_local_submission_lifecycle_v1(case).unwrap(),
            *expected,
            "actual same input case {index}"
        );
    }
    println!(
        "native_local_submission_lifecycle_observation={}",
        json!({"version":1,"actualNodePid":output.process.process_id,"actualCaseCount":actual_case_count,"actualComparedRecordCount":actual_case_count,"actualStdoutBytes":output.process.stdout_bytes,"actualStdoutSha256":output.process.stdout_hash.as_str(),"actualNodeNativeWholeValuesMatched":true,"processGroupCleanupVerified":output.process.process_group_cleanup_verified,"fullOriginalLifecycleMatched":true,"normalSubmissionRouteAccepted":false})
    );
}

#[test]
fn native_local_lifecycle_refuses_authority_unbounded_time_and_is_semantically_stable() {
    let good = LocalSubmissionLifecycleInputV1 {
        version: 1,
        kind: "NativeLocalSubmissionLifecycleInput".into(),
        preflight: input(
            json!({"paperId":"p","taskKey":"p:submission","sourceWorkspace":"workspace/p","venueTarget":"Fixture Venue"}),
            None,
            false,
        ),
        row_blockers: vec![],
        reference_time_millis: 1_759_276_800_000,
    };
    let first = build_local_submission_lifecycle_v1(good.clone()).unwrap();
    let retry = build_local_submission_lifecycle_v1(good.clone()).unwrap();
    assert_eq!(first, retry);
    let mut later = good.clone();
    later.reference_time_millis += 86_400_000;
    let later = build_local_submission_lifecycle_v1(later).unwrap();
    assert_ne!(
        first["manifest"]["manifestHash"],
        later["manifest"]["manifestHash"]
    );
    assert_eq!(
        first["manifest"]["semanticIdentityHash"],
        later["manifest"]["semanticIdentityHash"]
    );
    assert_ne!(
        first["handoff"]["semanticIdentityHash"],
        later["handoff"]["semanticIdentityHash"]
    );
    for field in [
        "artifactPackage",
        "liveAuthorizationReceipt",
        "independentReviewAuthorityReceipt",
        "executorResponse",
        "deliveryStore",
    ] {
        let mut wire = serde_json::to_value(&good).unwrap();
        wire[field] = json!({"status":"ready","grantsAuthority":true});
        assert!(serde_json::from_value::<LocalSubmissionLifecycleInputV1>(wire).is_err());
    }
    for invalid in [
        i64::MIN,
        -8_640_000_000_000_001,
        8_640_000_000_000_001,
        i64::MAX,
    ] {
        let mut candidate = good.clone();
        candidate.reference_time_millis = invalid;
        assert!(build_local_submission_lifecycle_v1(candidate).is_err());
    }
    let mut wrong = good.clone();
    wrong.version = 2;
    assert!(build_local_submission_lifecycle_v1(wrong).is_err());
    let mut big = good;
    big.row_blockers = vec!["a".repeat(64 * 1024); 17];
    assert!(build_local_submission_lifecycle_v1(big).is_err());
    assert_eq!(
        first["deliveryRuntime"]["dispatchAuthorization"]["status"],
        "submission_dispatch_authorization_blocked"
    );
    assert_eq!(
        first["deliveryRuntime"]["redrivePlan"]["blockers"],
        json!([
            "dispatch_authorization_not_ready",
            "executor_response_not_retryable",
            "ambiguous_result_review_required"
        ])
    );
    assert_eq!(
        first["deliveryPersistence"]["status"],
        "submission_delivery_persistence_blocked"
    );
    assert_eq!(first["safety"]["externalActionPerformed"], false);
}

#[path = "cas_tests.rs"]
mod cas_tests;
