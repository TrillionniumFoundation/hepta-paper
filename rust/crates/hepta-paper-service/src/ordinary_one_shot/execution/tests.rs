use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use hepta_legacy_compatibility::parse_production_json_v1;
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::atomic::Ordering,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
pub(super) const TIME: &str = "2026-08-03T00:00:00.000Z";
pub(super) struct Fixture(pub(super) PathBuf);
impl Fixture {
    pub(super) fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "one-shot-business-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    pub(super) fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    pub(super) fn runtime(&self, name: &str) -> PathBuf {
        let path = self.path(name);
        fs::DirBuilder::new().mode(0o755).create(&path).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub(super) fn source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}
pub(super) fn oracle(fixture: &Fixture, mode: &str) -> serde_json::Value {
    oracle_at(
        fixture,
        mode,
        &fixture.path("node-runtime"),
        &fixture.path("node-control"),
    )
}
pub(super) fn oracle_at(
    fixture: &Fixture,
    mode: &str,
    runtime: &Path,
    control: &Path,
) -> serde_json::Value {
    assert!(runtime.starts_with(&fixture.0) && control.starts_with(&fixture.0));
    let node =
        PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").expect("qualified actual Node oracle"))
            .canonicalize()
            .unwrap();
    let request = BoundedProcessRequestV1 {
        executable: node,
        arguments: vec![
            "--input-type=module".into(),
            "--eval".into(),
            include_str!("oracle.mjs").into(),
        ],
        working_directory: source(),
        environment: EnvironmentPolicyV1::new("one-shot-business-oracle", ["PATH"], ["PATH"])
            .unwrap()
            .build(std::env::vars_os(), &BTreeMap::new())
            .unwrap(),
        stdin: Some(
            serde_json::to_vec(&serde_json::json!({"source":source(),"runtime":runtime,
            "control":control,"mode":mode}))
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
        ProcessTerminationReason::Exited,
        "{:?}",
        output.process
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
pub(super) fn json(value: &serde_json::Value) -> Json {
    parse_production_json_v1(&serde_json::to_vec(value).unwrap()).unwrap()
}
pub(super) fn equal(actual: &Json, expected: &serde_json::Value) {
    assert!(
        same_json(actual, &json(expected), &AtomicBool::new(false)),
        "actual {:?}\nexpected {expected}",
        actual
    );
}
pub(super) fn append<'a>(
    value: &'a serde_json::Value,
    evidence: &'a Json,
) -> OneShotAppendRequestV1<'a> {
    OneShotAppendRequestV1 {
        attempt_id: value["attemptId"].as_str().unwrap(),
        phase: value["phase"].as_str().unwrap(),
        evidence,
        event_id: None,
        recorded_at: value["recordedAt"].as_str().unwrap(),
        expected_previous_event_hash: value["expectedPreviousEventHash"].as_str().unwrap(),
        expected_sequence: value["expectedSequence"].as_u64().unwrap() as u8,
        expected_phase: value["expectedPhase"].as_str().unwrap(),
    }
}
pub(super) fn rows(journal: &OneShotJournalV1) -> serde_json::Value {
    let db = journal.open_connection(false).unwrap();
    let mut result = serde_json::Map::new();
    for table in [
        "campaign_one_shot_attempt_journal_metadata",
        "campaign_one_shot_attempts",
        "campaign_one_shot_attempt_events",
        "campaign_one_shot_attempt_terminal_receipts",
    ] {
        let values = crate::automation_runtime_reconciliation::rows_with_control(
            &db,
            &format!("SELECT rowid,* FROM {table} ORDER BY rowid"),
            [],
            Some(&journal.control),
        )
        .unwrap();
        result.insert(table.into(), serde_json::Value::Array(values));
    }
    serde_json::Value::Object(result)
}
#[test]
fn actual_node_fixed_journal_transactions_preserve_all_reports_raw_rows_and_rowids() {
    let fixture = Fixture::new();
    let expected = oracle(&fixture, "normal");
    let cancelled = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(120);
    let runtime = fixture.runtime("native-runtime");
    let mut journal = OneShotJournalV1::open(
        &runtime,
        &fixture.path("native-control"),
        TIME,
        &cancelled,
        deadline,
    )
    .unwrap();
    let reservation = json(&expected["reservation"]);
    let reserved = journal.reserve(&reservation).unwrap();
    assert!(reserved.newly_appended() && reserved.commit_acknowledged());
    equal(reserved.inspection(), &expected["reports"][0]);
    let replay = journal.reserve(&reservation).unwrap();
    assert!(!replay.newly_appended());
    equal(replay.inspection(), &expected["reports"][1]);
    for (index, request) in expected["requests"].as_array().unwrap().iter().enumerate() {
        let evidence = json(&request["evidence"]);
        let mutation = journal.append(append(request, &evidence)).unwrap();
        assert!(mutation.newly_appended() && mutation.commit_acknowledged());
        equal(mutation.inspection(), &expected["reports"][index + 2]);
        let replay = journal.append(append(request, &evidence)).unwrap();
        assert!(!replay.newly_appended());
        equal(replay.inspection(), &expected["reports"][index + 2]);
    }
    let value = &expected["finalize"];
    let outcome = json(&value["outcome"]);
    let request = || OneShotFinalizeRequestV1 {
        attempt_id: value["attemptId"].as_str().unwrap(),
        terminal_status: value["terminalStatus"].as_str().unwrap(),
        outcome: &outcome,
        event_id: None,
        completed_at: value["completedAt"].as_str().unwrap(),
        expected_previous_event_hash: value["expectedPreviousEventHash"].as_str().unwrap(),
        expected_sequence: value["expectedSequence"].as_u64().unwrap() as u8,
        expected_phase: value["expectedPhase"].as_str().unwrap(),
    };
    let finalized = journal.finalize(request()).unwrap();
    assert!(finalized.newly_appended());
    equal(finalized.inspection(), &expected["reports"][7]);
    let replay = journal.finalize(request()).unwrap();
    assert!(!replay.newly_appended());
    equal(replay.inspection(), &expected["reports"][8]);
    assert_eq!(rows(&journal), expected["rows"]);
    assert!(
        !fixture
            .path("native-control/campaign-one-shot-attempt.sqlite-journal")
            .exists()
    );
    // Original Node accepts the actual native journal without a rowid/schema
    // rewrite; this cross-engine status is covered again by normal frontend.
}
#[test]
fn actual_node_all_eight_terminal_commits_preserve_raw_rows_and_idempotent_replays() {
    for (phase, status) in [
        ("attempt_reserved", "blocked_pre_provider"),
        ("preconditions_verified", "blocked_pre_provider"),
        ("prepare_verified", "blocked_pre_provider"),
        ("provider_started", "recovered_incomplete"),
        ("provider_completed", "blocked_post_provider"),
        ("launch_started", "recovered_incomplete"),
        ("launch_started", "completed"),
        ("launch_started", "failed_terminal"),
    ] {
        let fixture = Fixture::new();
        let expected = oracle(&fixture, &format!("terminal/{phase}/{status}"));
        let cancelled = Arc::new(AtomicBool::new(false));
        let runtime = fixture.runtime("native-runtime");
        let control_root = fixture.path("native-control");
        let mut journal = OneShotJournalV1::open(
            &runtime,
            &control_root,
            TIME,
            &cancelled,
            Instant::now() + Duration::from_secs(120),
        )
        .unwrap();
        let reservation = json(&expected["reservation"]);
        let reserved = journal.reserve(&reservation).unwrap();
        assert!(reserved.newly_appended() && reserved.commit_acknowledged());
        equal(reserved.inspection(), &expected["reports"][0]);
        let replay = journal.reserve(&reservation).unwrap();
        assert!(!replay.newly_appended());
        equal(replay.inspection(), &expected["reports"][1]);
        let requests = expected["requests"].as_array().unwrap();
        for (index, request) in requests.iter().enumerate() {
            let evidence = json(&request["evidence"]);
            let mutation = journal.append(append(request, &evidence)).unwrap();
            assert!(mutation.newly_appended() && mutation.commit_acknowledged());
            equal(mutation.inspection(), &expected["reports"][index + 2]);
            let replay = journal.append(append(request, &evidence)).unwrap();
            assert!(!replay.newly_appended());
            equal(replay.inspection(), &expected["reports"][index + 2]);
        }
        let value = &expected["finalize"];
        let outcome = json(&value["outcome"]);
        let request = || OneShotFinalizeRequestV1 {
            attempt_id: value["attemptId"].as_str().unwrap(),
            terminal_status: value["terminalStatus"].as_str().unwrap(),
            outcome: &outcome,
            event_id: None,
            completed_at: value["completedAt"].as_str().unwrap(),
            expected_previous_event_hash: value["expectedPreviousEventHash"].as_str().unwrap(),
            expected_sequence: value["expectedSequence"].as_u64().unwrap() as u8,
            expected_phase: value["expectedPhase"].as_str().unwrap(),
        };
        let finalized = journal.finalize(request()).unwrap();
        assert!(finalized.newly_appended() && finalized.commit_acknowledged());
        equal(
            finalized.inspection(),
            &expected["reports"][requests.len() + 2],
        );
        let replay = journal.finalize(request()).unwrap();
        assert!(!replay.newly_appended());
        equal(
            replay.inspection(),
            &expected["reports"][requests.len() + 3],
        );
        assert_eq!(rows(&journal), expected["rows"]);
        let incumbent = oracle_at(&fixture, "inspect", &runtime, &control_root);
        equal(
            &journal.inspect("native-fixed-one-shot-journal").unwrap(),
            &incumbent["report"],
        );
        assert_eq!(incumbent["rows"], expected["rows"]);
    }
}

#[test]
fn actual_node_commit_loss_and_rollback_keep_unknown_markers_without_repeating_actions() {
    for mode in ["loss", "rollback"] {
        let fixture = Fixture::new();
        let expected = oracle(&fixture, mode);
        let cancelled = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + Duration::from_secs(120);
        let runtime = fixture.runtime("native-runtime");
        let control = fixture.path("native-control");
        let mut journal =
            OneShotJournalV1::open(&runtime, &control, TIME, &cancelled, deadline).unwrap();
        journal.reserve(&json(&expected["reservation"])).unwrap();
        for (index, request) in expected["requests"].as_array().unwrap().iter().enumerate() {
            if request["phase"] == "provider_started" {
                journal.failure.set(Some(if mode == "loss" {
                    repository::FailurePoint::AfterCommitLoss
                } else {
                    repository::FailurePoint::BeforeCommit
                }));
            }
            let evidence = json(&request["evidence"]);
            let result = journal.append(append(request, &evidence));
            if mode == "rollback" && request["phase"] == "provider_started" {
                assert!(result.is_err());
            } else {
                let mutation = result.unwrap();
                equal(mutation.inspection(), &expected["reports"][index + 2]);
                if request["phase"] == "provider_started" {
                    assert!(!mutation.commit_acknowledged());
                    assert_eq!(
                        expected["transitions"][index]["mutationDisposition"]["externalActionPermitAvailable"],
                        false
                    );
                }
            }
        }
        drop(journal);
        let reopened =
            OneShotJournalV1::open(&runtime, &control, TIME, &cancelled, deadline).unwrap();
        equal(
            &reopened.inspect("native-fixed-one-shot-journal").unwrap(),
            expected["reports"].as_array().unwrap().last().unwrap(),
        );
        assert_eq!(rows(&reopened), expected["rows"]);
        // This component returns no grant/lease/provider callback at all.
    }
}
#[test]
fn original_control_and_unknown_foreign_journal_refusal_precedes_new_transactions() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime("runtime");
    let control = fixture.path("control");
    let cancelled = Arc::new(AtomicBool::new(true));
    assert!(
        OneShotJournalV1::open(
            &runtime,
            &control,
            TIME,
            &cancelled,
            Instant::now() + Duration::from_secs(120)
        )
        .is_err()
    );
    assert!(!control.exists());
    cancelled.store(false, Ordering::Release);
    assert!(OneShotJournalV1::open(&runtime, &control, TIME, &cancelled, Instant::now()).is_err());
    assert!(!control.exists());
    let deadline = Instant::now() + Duration::from_secs(120);
    let journal = OneShotJournalV1::open(&runtime, &control, TIME, &cancelled, deadline).unwrap();
    let file = control.join(super::super::JOURNAL_NAME);
    let before = fs::read(&file).unwrap();
    fs::rename(&file, control.join("retained-original.sqlite")).unwrap();
    fs::write(&file, &before).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(journal.assert_current().is_err());
    drop(journal);
    // Fresh epochs are explicit, while the old replaced descriptor never revives.
    let fresh = OneShotJournalV1::open(&runtime, &control, TIME, &cancelled, deadline).unwrap();
    cancelled.store(true, Ordering::Release);
    assert!(fresh.inspect("unissued").unwrap_err().contains("cancelled"));
    drop(fresh);
    cancelled.store(false, Ordering::Release);
    let sidecar = control.join("campaign-one-shot-attempt.sqlite-journal");
    fs::write(&sidecar, b"unknown rollback bytes").unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(OneShotJournalV1::open(&runtime, &control, TIME, &cancelled, deadline).is_err());
    assert_eq!(fs::read(&sidecar).unwrap(), b"unknown rollback bytes");
    assert_eq!(fs::read(&file).unwrap(), before);
}

#[test]
fn actual_sqlite_reopen_rejects_leaf_and_parent_swap_return_before_pragmas() {
    for kind in [path::ReopenSwap::Leaf, path::ReopenSwap::ControlRoot] {
        let fixture = Fixture::new();
        let runtime = fixture.runtime("runtime");
        let control = fixture.path("control");
        let cancelled = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + Duration::from_secs(120);
        let journal =
            OneShotJournalV1::open(&runtime, &control, TIME, &cancelled, deadline).unwrap();
        let foreign = fixture.path("test-foreign");
        let foreign_db = if matches!(kind, path::ReopenSwap::ControlRoot) {
            fs::DirBuilder::new().mode(0o700).create(&foreign).unwrap();
            foreign.join(super::super::JOURNAL_NAME)
        } else {
            foreign.clone()
        };
        fs::copy(control.join(super::super::JOURNAL_NAME), &foreign_db).unwrap();
        let connection = rusqlite::Connection::open(&foreign_db).unwrap();
        connection
            .execute_batch("CREATE TABLE foreign_marker(value TEXT);")
            .unwrap();
        drop(connection);
        let before = fs::read(&foreign_db).unwrap();
        journal.reopen_swap.set(Some(kind));
        assert!(journal.open_connection(false).is_err());
        // The swapped connection must not run a pragma, rollback or transaction.
        assert_eq!(fs::read(&foreign_db).unwrap(), before);
        assert!(control.join(super::super::JOURNAL_NAME).is_file());
        assert!(!fixture.path("test-original").exists());
        assert!(journal.inspect("missing").is_err());
        drop(journal);
        let fresh = OneShotJournalV1::open(&runtime, &control, TIME, &cancelled, deadline).unwrap();
        assert!(fresh.inspect("missing").unwrap_err().contains("missing"));
        assert_eq!(fs::read(&foreign_db).unwrap(), before);
    }
}

#[test]
fn actual_node_normal_transaction_retries_only_proven_unrelated_ancestor_sibling_change() {
    let fixture = Fixture::new();
    let expected = oracle(&fixture, "normal");
    let cancelled = Arc::new(AtomicBool::new(false));
    let runtime = fixture.runtime("native-runtime");
    let control = fixture.path("native-control");
    let mut journal = OneShotJournalV1::open(
        &runtime,
        &control,
        TIME,
        &cancelled,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap();
    journal.reserve(&json(&expected["reservation"])).unwrap();
    let original_epoch = journal.epoch.ino();
    for (index, request) in expected["requests"].as_array().unwrap().iter().enumerate() {
        let evidence = json(&request["evidence"]);
        journal
            .reopen_swap
            .set(Some(path::ReopenSwap::AncestorSibling));
        let mutation = journal.append(append(request, &evidence)).unwrap();
        assert!(mutation.newly_appended() && mutation.commit_acknowledged());
        equal(mutation.inspection(), &expected["reports"][index + 2]);
        assert_eq!(journal.epoch.ino(), original_epoch);
        assert!(!journal.poisoned.get());
        assert!(!fixture.path("test-unrelated-sibling").exists());
    }
    let observed = oracle_at(&fixture, "inspect", &runtime, &control);
    equal(
        &journal.inspect("native-fixed-one-shot-journal").unwrap(),
        &observed["report"],
    );
    assert_eq!(rows(&journal), observed["rows"]);
}
