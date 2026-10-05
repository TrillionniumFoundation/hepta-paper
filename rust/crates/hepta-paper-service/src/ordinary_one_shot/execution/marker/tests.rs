use super::super::tests::{Fixture, TIME, append, equal, json, rows, source};
use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{
    collections::BTreeMap, fs, os::unix::fs::MetadataExt, path::PathBuf, sync::atomic::Ordering,
    time::Duration,
};

fn oracle(fixture: &Fixture, phase: &str, loss: bool) -> serde_json::Value {
    let request = BoundedProcessRequestV1 {
        executable: PathBuf::from(
            std::env::var_os("HEPTA_TEST_NODE").expect("qualified actual Node oracle"),
        )
        .canonicalize()
        .unwrap(),
        arguments: vec![
            "--input-type=module".into(),
            "--eval".into(),
            include_str!("oracle.mjs").into(),
        ],
        working_directory: source(),
        environment: EnvironmentPolicyV1::new("one-shot-marker-oracle", ["PATH"], ["PATH"])
            .unwrap()
            .build(std::env::vars_os(), &BTreeMap::new())
            .unwrap(),
        stdin: Some(
            serde_json::to_vec(&serde_json::json!({"source":source(),
            "runtime":fixture.path("node-runtime"), "control":fixture.path("node-control"),
            "phase":phase,"loss":loss}))
            .unwrap(),
        ),
    };
    let output = run_bounded_process_capturing_stdout_with_cancellation(
        &request,
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            maximum_stdin_bytes: 64 * 1024,
            maximum_stdout_bytes: 4 * 1024 * 1024,
            maximum_stderr_bytes: 64 * 1024,
            maximum_tail_bytes: 64 * 1024,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        output.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(
        output.process.exit_code,
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.process.stderr_tail)
    );
    assert!(output.process.process_group_cleanup_verified);
    serde_json::from_slice(&output.stdout).unwrap()
}
fn outcome<T>(result: &Result<T, String>) -> serde_json::Value {
    match result {
        Ok(_) => serde_json::json!({"ok": true}),
        Err(error) => serde_json::json!({"error": error}),
    }
}
fn finalize(
    journal: &mut OneShotJournalV1<'_>,
    expected: &serde_json::Value,
) -> OneShotJournalMutationV1 {
    let value = &expected["finalize"];
    let evidence = json(&value["outcome"]);
    journal
        .finalize(OneShotFinalizeRequestV1 {
            attempt_id: value["attemptId"].as_str().unwrap(),
            terminal_status: value["terminalStatus"].as_str().unwrap(),
            outcome: &evidence,
            event_id: None,
            completed_at: TIME,
            expected_previous_event_hash: value["expectedPreviousEventHash"].as_str().unwrap(),
            expected_sequence: value["expectedSequence"].as_u64().unwrap() as u8,
            expected_phase: value["expectedPhase"].as_str().unwrap(),
        })
        .unwrap()
}
fn identity(path: &Path) -> (u64, u64, u64, i64, i64, i64, i64) {
    let m = fs::symlink_metadata(path).unwrap();
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}
fn prepare<'a>(
    fixture: &Fixture,
    expected: &serde_json::Value,
    cancelled: &'a Arc<AtomicBool>,
    loss: bool,
) -> (OneShotJournalV1<'a>, OneShotJournalMutationV1) {
    let runtime = fixture.runtime("native-runtime");
    let mut journal = OneShotJournalV1::open(
        &runtime,
        &fixture.path("native-control"),
        TIME,
        cancelled,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap();
    let mut reserved = journal.reserve(&json(&expected["reservation"])).unwrap();
    assert_eq!(
        outcome(&journal.claim_external_action_marker(&mut reserved)),
        expected["outcomes"]["reservationClaim"]
    );
    let requests = expected["requests"].as_array().unwrap();
    let mut selected = None;
    for (index, request) in requests.iter().enumerate() {
        if loss && index == requests.len() - 1 {
            journal.failure.set(Some(
                super::super::repository::FailurePoint::AfterCommitLoss,
            ));
        }
        let evidence = json(&request["evidence"]);
        let mut mutation = journal.append(append(request, &evidence)).unwrap();
        if index == requests.len() - 1 {
            selected = Some(mutation);
        } else {
            assert_eq!(
                outcome(&journal.claim_external_action_marker(&mut mutation)),
                expected["outcomes"][format!("{}Claim", request["phase"].as_str().unwrap())]
            );
        }
    }
    (journal, selected.unwrap())
}

#[test]
fn actual_node_marker_claims_match_both_phases_and_preserve_all_business_rows() {
    for phase in ["provider_started", "launch_started"] {
        let fixture = Fixture::new();
        let expected = oracle(&fixture, phase, false);
        let cancelled = Arc::new(AtomicBool::new(false));
        let (mut journal, mut mutation) = prepare(&fixture, &expected, &cancelled, false);
        equal(mutation.inspection(), &expected["inspection"]);
        let db_path = fixture.path("native-control/campaign-one-shot-attempt.sqlite");
        let before_bytes = fs::read(&db_path).unwrap();
        let before_identity = identity(&db_path);
        let foreign = OneShotJournalV1::open(
            &fixture.path("native-runtime"),
            &fixture.path("native-control"),
            TIME,
            &cancelled,
            journal.control.deadline,
        )
        .unwrap();
        assert_eq!(
            outcome(&foreign.claim_external_action_marker(&mut mutation)),
            expected["outcomes"]["foreignClaim"]
        );
        let claimed = journal.claim_external_action_marker(&mut mutation);
        assert_eq!(outcome(&claimed), expected["outcomes"]["firstClaim"]);
        let marker = claimed.unwrap();
        assert_eq!(
            outcome(&journal.claim_external_action_marker(&mut mutation)),
            expected["outcomes"]["secondClaim"]
        );
        assert_eq!(
            outcome(&marker.assert_current(&foreign)),
            expected["outcomes"]["foreignCurrent"]
        );
        drop(foreign);
        assert_eq!(
            outcome(&marker.assert_current(&journal)),
            expected["outcomes"]["current"]
        );
        assert_eq!(
            outcome(&marker.assert_current(&journal)),
            expected["outcomes"]["currentAgain"]
        );
        let request = expected["requests"].as_array().unwrap().last().unwrap();
        let evidence = json(&request["evidence"]);
        let mut replay = journal.append(append(request, &evidence)).unwrap();
        assert_eq!(
            outcome(&journal.claim_external_action_marker(&mut replay)),
            expected["outcomes"]["replayClaim"]
        );
        assert_eq!(
            outcome(&marker.assert_current(&journal)),
            expected["outcomes"]["originalAfterReplay"]
        );
        assert_eq!(rows(&journal), expected["before"]);
        assert_eq!(fs::read(&db_path).unwrap(), before_bytes);
        assert_eq!(identity(&db_path), before_identity);
        let mut terminal = finalize(&mut journal, &expected);
        equal(terminal.inspection(), &expected["terminal"]);
        assert_eq!(
            outcome(&journal.claim_external_action_marker(&mut terminal)),
            expected["outcomes"]["terminalClaim"]
        );
        assert_eq!(
            outcome(&marker.assert_current(&journal)),
            expected["outcomes"]["afterTerminal"]
        );
        assert_eq!(marker.assert_current(&journal).unwrap_err(), OWNER_INVALID);
        assert_eq!(rows(&journal), expected["after"]);
    }
}

#[test]
fn actual_node_commit_acknowledgment_loss_and_exact_replay_never_create_marker_ownership() {
    for phase in ["provider_started", "launch_started"] {
        let fixture = Fixture::new();
        let expected = oracle(&fixture, phase, true);
        let cancelled = Arc::new(AtomicBool::new(false));
        let (mut journal, mut mutation) = prepare(&fixture, &expected, &cancelled, true);
        assert!(mutation.newly_appended());
        assert!(!mutation.commit_acknowledged());
        assert_eq!(
            outcome(&journal.claim_external_action_marker(&mut mutation)),
            expected["outcomes"]["firstClaim"]
        );
        assert_eq!(
            outcome(&journal.claim_external_action_marker(&mut mutation)),
            expected["outcomes"]["secondClaim"]
        );
        equal(mutation.inspection(), &expected["inspection"]);
        let request = expected["requests"].as_array().unwrap().last().unwrap();
        let evidence = json(&request["evidence"]);
        let mut replay = journal.append(append(request, &evidence)).unwrap();
        assert!(replay.commit_acknowledged());
        assert!(!replay.newly_appended());
        assert_eq!(
            outcome(&journal.claim_external_action_marker(&mut replay)),
            expected["outcomes"]["replayClaim"]
        );
        assert_eq!(rows(&journal), expected["before"]);
        drop(journal);
        let reopened = OneShotJournalV1::open(
            &fixture.path("native-runtime"),
            &fixture.path("native-control"),
            TIME,
            &cancelled,
            Instant::now() + Duration::from_secs(120),
        )
        .unwrap();
        assert_eq!(
            reopened
                .claim_external_action_marker(&mut mutation)
                .err()
                .unwrap(),
            PERMIT_INVALID
        );
        equal(
            &reopened
                .inspect(expected["reservation"]["attemptId"].as_str().unwrap())
                .unwrap(),
            &expected["inspection"],
        );
    }
}

#[test]
fn marker_claim_is_consumed_before_failed_currentness_and_cannot_refresh_control() {
    let fixture = Fixture::new();
    let expected = oracle(&fixture, "provider_started", false);
    let cancelled = Arc::new(AtomicBool::new(false));
    let (journal, mut mutation) = prepare(&fixture, &expected, &cancelled, false);
    let db_path = fixture.path("native-control/campaign-one-shot-attempt.sqlite");
    let bytes = fs::read(&db_path).unwrap();
    cancelled.store(true, Ordering::Relaxed);
    assert!(journal.claim_external_action_marker(&mut mutation).is_err());
    cancelled.store(false, Ordering::Relaxed);
    assert_eq!(
        journal
            .claim_external_action_marker(&mut mutation)
            .err()
            .unwrap(),
        PERMIT_INVALID
    );
    assert_eq!(fs::read(&db_path).unwrap(), bytes);
    drop(journal);
    let fresh_cancelled = Arc::new(AtomicBool::new(false));
    let reopened = OneShotJournalV1::open(
        &fixture.path("native-runtime"),
        &fixture.path("native-control"),
        TIME,
        &fresh_cancelled,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap();
    assert_eq!(
        reopened
            .claim_external_action_marker(&mut mutation)
            .err()
            .unwrap(),
        PERMIT_INVALID
    );
    equal(
        &reopened
            .inspect(expected["reservation"]["attemptId"].as_str().unwrap())
            .unwrap(),
        &expected["inspection"],
    );
}

#[test]
fn marker_live_checks_revoke_on_cancellation_expiry_and_foreign_inode_without_removing_evidence() {
    for failure in ["cancel", "expire", "replace", "peer"] {
        let fixture = Fixture::new();
        let expected = oracle(&fixture, "provider_started", false);
        let cancelled = Arc::new(AtomicBool::new(false));
        let (mut journal, mut mutation) = prepare(&fixture, &expected, &cancelled, false);
        let marker = journal.claim_external_action_marker(&mut mutation).unwrap();
        let db_path = fixture.path("native-control/campaign-one-shot-attempt.sqlite");
        let original = fixture.path("original-journal.sqlite");
        let bytes = fs::read(&db_path).unwrap();
        match failure {
            "cancel" => cancelled.store(true, Ordering::Relaxed),
            "expire" => journal.control.deadline = Instant::now() - Duration::from_millis(1),
            "replace" => {
                fs::rename(&db_path, &original).unwrap();
                fs::copy(&original, &db_path).unwrap();
            }
            "peer" => {
                let mut peer = OneShotJournalV1::open(
                    &fixture.path("native-runtime"),
                    &fixture.path("native-control"),
                    TIME,
                    &cancelled,
                    journal.control.deadline,
                )
                .unwrap();
                finalize(&mut peer, &expected);
            }
            _ => unreachable!(),
        }
        assert!(marker.assert_current(&journal).is_err(), "{failure}");
        if failure == "cancel" {
            cancelled.store(false, Ordering::Relaxed);
        }
        assert_eq!(marker.assert_current(&journal).unwrap_err(), OWNER_INVALID);
        drop(marker);
        drop(journal);
        if failure != "peer" {
            assert_eq!(fs::read(&db_path).unwrap(), bytes);
        }
        if failure == "replace" {
            assert_eq!(fs::read(&original).unwrap(), bytes);
        }
        let fresh = OneShotJournalV1::open(
            &fixture.path("native-runtime"),
            &fixture.path("native-control"),
            TIME,
            &cancelled,
            Instant::now() + Duration::from_secs(120),
        )
        .unwrap();
        assert_eq!(
            fresh
                .claim_external_action_marker(&mut mutation)
                .err()
                .unwrap(),
            PERMIT_INVALID
        );
        equal(
            &fresh
                .inspect(expected["reservation"]["attemptId"].as_str().unwrap())
                .unwrap(),
            &expected[if failure == "peer" {
                "terminal"
            } else {
                "inspection"
            }],
        );
    }
}
