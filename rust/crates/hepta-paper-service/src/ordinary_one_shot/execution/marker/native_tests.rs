//! Native-only safety owners using a source-pinned captured synthetic input.
//! These do not replace, skip, or claim success for the live Node comparisons.
use super::super::tests::{Fixture, TIME, append, json};
use super::*;
use sha2::{Digest, Sha256};
use std::{fs, sync::atomic::Ordering, time::Duration};

fn captured() -> serde_json::Value {
    let value: serde_json::Value =
        serde_json::from_slice(include_bytes!("captured-input.v1.json")).unwrap();
    assert_eq!(value["kind"], "NativeOneShotMarkerSyntheticBusinessInput");
    let sources: &[(&str, &[u8])] = &[
        (
            "paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs",
            include_bytes!(
                "../../../../../../../paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs"
            ),
        ),
        (
            "paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs",
            include_bytes!(
                "../../../../../../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs"
            ),
        ),
        (
            "paper-core/tests/support/autonomous-research-one-shot-campaign-attempt-fixture.mjs",
            include_bytes!(
                "../../../../../../../paper-core/tests/support/autonomous-research-one-shot-campaign-attempt-fixture.mjs"
            ),
        ),
        (
            "rust/crates/hepta-paper-service/src/ordinary_one_shot/execution/marker/oracle.mjs",
            include_bytes!("oracle.mjs"),
        ),
    ];
    assert_eq!(
        value["sourceHashes"].as_object().unwrap().len(),
        sources.len()
    );
    for (name, bytes) in sources {
        assert_eq!(
            value["sourceHashes"][name],
            hex::encode(Sha256::digest(bytes))
        );
    }
    value
}
fn prepare<'a>(
    fixture: &Fixture,
    input: &serde_json::Value,
    phase: &str,
    loss: bool,
    cancelled: &'a Arc<AtomicBool>,
) -> (OneShotJournalV1<'a>, OneShotJournalMutationV1) {
    let runtime = fixture.runtime("runtime");
    let mut journal = OneShotJournalV1::open(
        &runtime,
        &fixture.path("control"),
        TIME,
        cancelled,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap();
    let mut reserved = journal.reserve(&json(&input["reservation"])).unwrap();
    assert_eq!(
        journal
            .claim_external_action_marker(&mut reserved)
            .err()
            .unwrap(),
        PERMIT_INVALID
    );
    for request in input["requests"].as_array().unwrap() {
        if loss && request["phase"] == phase {
            journal.failure.set(Some(
                super::super::repository::FailurePoint::AfterCommitLoss,
            ));
        }
        let evidence = json(&request["evidence"]);
        let mut mutation = journal.append(append(request, &evidence)).unwrap();
        if request["phase"] == phase {
            return (journal, mutation);
        }
        if request["phase"] == "provider_started" {
            journal.claim_external_action_marker(&mut mutation).unwrap();
        } else {
            assert_eq!(
                journal
                    .claim_external_action_marker(&mut mutation)
                    .err()
                    .unwrap(),
                PERMIT_INVALID
            );
        }
    }
    unreachable!()
}
fn reopen<'a>(fixture: &Fixture, cancelled: &'a Arc<AtomicBool>) -> OneShotJournalV1<'a> {
    OneShotJournalV1::open(
        &fixture.path("runtime"),
        &fixture.path("control"),
        TIME,
        cancelled,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap()
}
fn terminal(
    journal: &mut OneShotJournalV1<'_>,
    mutation: &OneShotJournalMutationV1,
) -> OneShotJournalMutationV1 {
    let current = mutation.inspection();
    let head = match field(current, "events") {
        Json::Array(v) => v.last().unwrap(),
        _ => unreachable!(),
    };
    let sequence = match field(head, "sequence") {
        Json::Number(v) => *v as u8 + 1,
        _ => unreachable!(),
    };
    journal
        .finalize(OneShotFinalizeRequestV1 {
            attempt_id: &text(field(field(current, "reservation"), "attemptId")).unwrap(),
            terminal_status: "recovered_incomplete",
            outcome: &Json::Null,
            event_id: None,
            completed_at: TIME,
            expected_previous_event_hash: &text(field(current, "headEventHash")).unwrap(),
            expected_sequence: sequence,
            expected_phase: &text(field(current, "headPhase")).unwrap(),
        })
        .unwrap()
}

#[test]
fn native_only_one_use_cross_owner_replay_and_terminal_marker_checks_preserve_journal_bytes() {
    let input = captured();
    for phase in ["provider_started", "launch_started"] {
        let fixture = Fixture::new();
        let cancelled = Arc::new(AtomicBool::new(false));
        let (mut journal, mut mutation) = prepare(&fixture, &input, phase, false, &cancelled);
        let path = fixture.path("control/campaign-one-shot-attempt.sqlite");
        let before = fs::read(&path).unwrap();
        let other = reopen(&fixture, &cancelled);
        assert_eq!(
            other
                .claim_external_action_marker(&mut mutation)
                .err()
                .unwrap(),
            PERMIT_INVALID
        );
        let marker = journal.claim_external_action_marker(&mut mutation).unwrap();
        assert_eq!(
            journal
                .claim_external_action_marker(&mut mutation)
                .err()
                .unwrap(),
            PERMIT_INVALID
        );
        assert_eq!(marker.assert_current(&other).unwrap_err(), OWNER_INVALID);
        marker.assert_current(&journal).unwrap();
        marker.assert_current(&journal).unwrap();
        drop(other);
        let request = input["requests"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["phase"] == phase)
            .unwrap();
        let evidence = json(&request["evidence"]);
        let mut replay = journal.append(append(request, &evidence)).unwrap();
        assert!(!replay.newly_appended());
        assert_eq!(
            journal
                .claim_external_action_marker(&mut replay)
                .err()
                .unwrap(),
            PERMIT_INVALID
        );
        marker.assert_current(&journal).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
        let mut terminal = terminal(&mut journal, &mutation);
        assert_eq!(
            journal
                .claim_external_action_marker(&mut terminal)
                .err()
                .unwrap(),
            PERMIT_INVALID
        );
        assert_eq!(marker.assert_current(&journal).unwrap_err(), OWNER_STALE);
        assert_eq!(marker.assert_current(&journal).unwrap_err(), OWNER_INVALID);
    }
}

#[test]
fn native_only_lost_acknowledgment_drop_and_reopen_never_restore_marker_claim() {
    let input = captured();
    for phase in ["provider_started", "launch_started"] {
        for lost in [false, true] {
            let fixture = Fixture::new();
            let cancelled = Arc::new(AtomicBool::new(false));
            let (journal, mut mutation) = prepare(&fixture, &input, phase, lost, &cancelled);
            assert!(mutation.newly_appended());
            assert_eq!(mutation.commit_acknowledged(), !lost);
            let current = mutation.inspection().clone();
            if lost {
                assert_eq!(
                    journal
                        .claim_external_action_marker(&mut mutation)
                        .err()
                        .unwrap(),
                    PERMIT_INVALID
                );
            } else {
                drop(journal.claim_external_action_marker(&mut mutation).unwrap());
            }
            let path = fixture.path("control/campaign-one-shot-attempt.sqlite");
            let before = fs::read(&path).unwrap();
            drop(journal);
            let mut fresh = reopen(&fixture, &cancelled);
            assert_eq!(
                fresh
                    .claim_external_action_marker(&mut mutation)
                    .err()
                    .unwrap(),
                PERMIT_INVALID
            );
            let observed = fresh
                .inspect(input["reservation"]["attemptId"].as_str().unwrap())
                .unwrap();
            assert!(same_json(&observed, &current, &cancelled));
            let request = input["requests"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["phase"] == phase)
                .unwrap();
            let evidence = json(&request["evidence"]);
            let mut replay = fresh.append(append(request, &evidence)).unwrap();
            assert!(replay.commit_acknowledged());
            assert!(!replay.newly_appended());
            assert_eq!(
                fresh
                    .claim_external_action_marker(&mut replay)
                    .err()
                    .unwrap(),
                PERMIT_INVALID
            );
            assert_eq!(fs::read(&path).unwrap(), before);
        }
    }
}

#[test]
fn native_only_claim_consumes_before_cancellation_and_failed_live_checks_revoke() {
    let input = captured();
    for failure in ["before_claim", "cancel", "expired", "replace", "peer"] {
        let fixture = Fixture::new();
        let cancelled = Arc::new(AtomicBool::new(false));
        let (mut journal, mut mutation) =
            prepare(&fixture, &input, "provider_started", false, &cancelled);
        let path = fixture.path("control/campaign-one-shot-attempt.sqlite");
        let before = fs::read(&path).unwrap();
        if failure == "before_claim" {
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
        } else {
            let marker = journal.claim_external_action_marker(&mut mutation).unwrap();
            match failure {
                "cancel" => cancelled.store(true, Ordering::Relaxed),
                "expired" => journal.control.deadline = Instant::now() - Duration::from_millis(1),
                "replace" => {
                    fs::rename(&path, fixture.path("original.sqlite")).unwrap();
                    fs::copy(fixture.path("original.sqlite"), &path).unwrap();
                }
                "peer" => {
                    terminal(&mut reopen(&fixture, &cancelled), &mutation);
                }
                _ => unreachable!(),
            }
            assert!(marker.assert_current(&journal).is_err());
            if failure == "cancel" {
                cancelled.store(false, Ordering::Relaxed);
            }
            assert_eq!(marker.assert_current(&journal).unwrap_err(), OWNER_INVALID);
        }
        drop(journal);
        let fresh = reopen(&fixture, &cancelled);
        assert_eq!(
            fresh
                .claim_external_action_marker(&mut mutation)
                .err()
                .unwrap(),
            PERMIT_INVALID
        );
        let current = fresh
            .inspect(input["reservation"]["attemptId"].as_str().unwrap())
            .unwrap();
        assert!(is_text(
            field(&current, "headPhase"),
            if failure == "peer" {
                "terminal"
            } else {
                "provider_started"
            }
        ));
        if failure != "peer" {
            assert_eq!(fs::read(&path).unwrap(), before);
        }
        if failure == "replace" {
            assert_eq!(fs::read(fixture.path("original.sqlite")).unwrap(), before);
        }
    }
}

#[test]
fn native_canary_subject_requires_original_provider_marker_and_exact_attempt() {
    let input = captured();
    let attempt = input["reservation"]["attemptId"].as_str().unwrap();
    for phase in ["provider_started", "launch_started"] {
        let fixture = Fixture::new();
        let cancelled = Arc::new(AtomicBool::new(false));
        let (journal, mut mutation) = prepare(&fixture, &input, phase, false, &cancelled);
        let marker = journal.claim_external_action_marker(&mut mutation).unwrap();
        assert!(
            marker
                .provider_canary_subject_v1(&journal, "other-attempt")
                .is_err()
        );
        let subject = marker.provider_canary_subject_v1(&journal, attempt);
        if phase == "launch_started" {
            assert!(subject.is_err());
            continue;
        }
        let subject = subject.unwrap();
        assert_eq!(subject.attempt_id, attempt);
        assert_eq!(
            subject.marker_event_hash.as_str(),
            text(field(mutation.inspection(), "headEventHash")).unwrap()
        );
        assert_eq!(
            subject.reservation_hash.as_str(),
            input["reservation"]["autonomousResearchOneShotCampaignAttemptReservationHash"]
                .as_str()
                .unwrap()
        );
        let other = reopen(&fixture, &cancelled);
        assert!(marker.provider_canary_subject_v1(&other, attempt).is_err());
        cancelled.store(true, Ordering::Relaxed);
        assert!(
            marker
                .provider_canary_subject_v1(&journal, attempt)
                .is_err()
        );
        cancelled.store(false, Ordering::Relaxed);
        assert!(
            marker
                .provider_canary_subject_v1(&journal, attempt)
                .is_err()
        );
    }
}
