//! Real process interruptions in the original SQLite transaction. These are
//! business-adapter fixtures, not ordinary provider/campaign admission tests.
use super::{repository::FailurePoint, tests::*, *};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use nix::sys::signal::{Signal, kill};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::atomic::Ordering,
    time::Duration,
};

pub(super) fn interrupt_process(
    journal: &OneShotJournalV1<'_>,
    before_commit: bool,
) -> Result<(), String> {
    journal
        .directory
        .write_new(
            "test-interruption.json",
            &serde_json::to_vec(
                &serde_json::json!({"beforeCommit":before_commit,"pid":std::process::id(),
            "originalControl":journal.control.cancelled.load(Ordering::SeqCst),
            "externalActionAuthorized":false}),
            )
            .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    journal
        .directory
        .sync_with_parents()
        .map_err(|e| e.to_string())?;
    kill(
        nix::unistd::getpid(),
        if before_commit {
            Signal::SIGTERM
        } else {
            Signal::SIGKILL
        },
    )
    .map_err(|e| e.to_string())?;
    // Another libtest thread can receive the process-directed signal. Wait
    // for that actual handler's original AtomicBool, under a fixed 5s ceiling
    // inside the original deadline; kill(2) returning alone is not delivery.
    if before_commit {
        let delivered_by = (Instant::now() + Duration::from_secs(5)).min(journal.control.deadline);
        while !journal.control.cancelled.load(Ordering::SeqCst) {
            if Instant::now() >= delivered_by {
                return Err("one_shot_test_signal_delivery_not_observed".into());
            }
            std::thread::yield_now();
        }
    }
    // The actual transaction unwinds before COMMIT. SIGKILL cannot return here.
    journal.control.checkpoint().map_err(|e| e.to_string())
}

#[test]
#[ignore = "only invoked by actual_process_transaction_interruptions_preserve_original_node_history"]
fn journal_interruption_child() {
    let root = PathBuf::from(std::env::var_os("HEPTA_ONESHOT_TRANSACTION_FIXTURE").unwrap());
    let before_commit = std::env::var("HEPTA_ONESHOT_TRANSACTION_BOUNDARY").unwrap() == "before";
    let input = fs::read(root.join("expected.json")).unwrap();
    assert!(input.len() <= 4 * 1024 * 1024);
    let expected: serde_json::Value = serde_json::from_slice(&input).unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let registration =
        signal_hook::flag::register(signal_hook::consts::SIGTERM, cancelled.clone()).unwrap();
    let mut journal = OneShotJournalV1::open(
        &root.join("native-runtime"),
        &root.join("native-control"),
        TIME,
        &cancelled,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap();
    journal.reserve(&json(&expected["reservation"])).unwrap();
    for request in expected["requests"].as_array().unwrap() {
        let evidence = json(&request["evidence"]);
        if request["phase"] == "provider_started" {
            journal.failure.set(Some(if before_commit {
                FailurePoint::BeforeCommitTerm
            } else {
                FailurePoint::AfterCommitKill
            }));
            let result = journal.append(append(request, &evidence));
            assert!(
                before_commit,
                "SIGKILL must terminate the child after the actual COMMIT"
            );
            assert!(result.is_err());
            assert!(cancelled.load(Ordering::SeqCst));
            assert!(journal.poisoned.get());
            signal_hook::low_level::unregister(registration);
            return;
        }
        journal.append(append(request, &evidence)).unwrap();
    }
    panic!("actual provider-start transaction was not reached");
}

#[test]
fn actual_process_transaction_interruptions_preserve_original_node_history() {
    for before_commit in [true, false] {
        let fixture = Fixture::new();
        let expected = oracle(&fixture, if before_commit { "rollback" } else { "loss" });
        fixture.runtime("native-runtime");
        fs::write(
            fixture.path("expected.json"),
            serde_json::to_vec(&expected).unwrap(),
        )
        .unwrap();
        // The existing process owner requires a non-writable real executable.
        // This owned byte-identical copy has one fixed slot, not a new runner.
        let original = std::env::current_exe().unwrap();
        let original_meta = fs::metadata(&original).unwrap();
        assert!(original_meta.is_file() && original_meta.len() <= 256 * 1024 * 1024);
        let executable = fixture.path("journal-child");
        assert_eq!(
            fs::copy(&original, &executable).unwrap(),
            original_meta.len()
        );
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o550)).unwrap();
        let environment = EnvironmentPolicyV1::new(
            "one-shot-transaction-child",
            [
                "PATH",
                "HEPTA_ONESHOT_TRANSACTION_FIXTURE",
                "HEPTA_ONESHOT_TRANSACTION_BOUNDARY",
            ],
            [
                "PATH",
                "HEPTA_ONESHOT_TRANSACTION_FIXTURE",
                "HEPTA_ONESHOT_TRANSACTION_BOUNDARY",
            ],
        )
        .unwrap()
        .build(
            std::env::vars_os(),
            &BTreeMap::from([
                (
                    "HEPTA_ONESHOT_TRANSACTION_FIXTURE".into(),
                    fixture.0.to_str().unwrap().to_owned(),
                ),
                (
                    "HEPTA_ONESHOT_TRANSACTION_BOUNDARY".into(),
                    if before_commit { "before" } else { "after" }.into(),
                ),
            ]),
        )
        .unwrap();
        let output = run_bounded_process_capturing_stdout_with_cancellation(
            &BoundedProcessRequestV1 {
                executable,
                arguments: vec![
                    "ordinary_one_shot::execution::interruption_tests::journal_interruption_child"
                        .into(),
                    "--exact".into(),
                    "--ignored".into(),
                    "--nocapture".into(),
                ],
                working_directory: source(),
                environment,
                stdin: None,
            },
            ProcessLimitsV1 {
                timeout_ms: 45_000,
                cleanup_timeout_ms: 15_000,
                maximum_stdout_bytes: 64 * 1024,
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
        assert!(output.process.process_group_cleanup_verified);
        if before_commit {
            assert_eq!(output.process.exit_code, Some(0), "{:?}", output.process);
            assert_eq!(output.process.signal, None);
        } else {
            assert_eq!(output.process.exit_code, None);
            assert_eq!(output.process.signal, Some(9));
        }
        let marker: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture.path("native-control/test-interruption.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(marker["beforeCommit"], before_commit);
        assert_eq!(marker["externalActionAuthorized"], false);
        let native_control = fixture.path("native-control");
        let database = native_control.join(super::super::JOURNAL_NAME);
        let identity = fs::metadata(&database).unwrap();
        let raw_before = fs::read(&database).unwrap();
        let observed = oracle_at(
            &fixture,
            "inspect",
            &fixture.path("native-runtime"),
            &native_control,
        );
        assert_eq!(observed["rows"], expected["rows"]);
        assert_eq!(
            observed["report"],
            *expected["reports"].as_array().unwrap().last().unwrap()
        );
        assert_eq!(fs::read(&database).unwrap(), raw_before);
        let after = fs::metadata(&database).unwrap();
        assert_eq!(
            (
                identity.dev(),
                identity.ino(),
                identity.len(),
                identity.mtime(),
                identity.mtime_nsec(),
                identity.ctime(),
                identity.ctime_nsec()
            ),
            (
                after.dev(),
                after.ino(),
                after.len(),
                after.mtime(),
                after.mtime_nsec(),
                after.ctime(),
                after.ctime_nsec()
            )
        );
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut reopened = OneShotJournalV1::open(
            &fixture.path("native-runtime"),
            &native_control,
            TIME,
            &cancelled,
            Instant::now() + Duration::from_secs(120),
        )
        .unwrap();
        equal(
            &reopened.inspect("native-fixed-one-shot-journal").unwrap(),
            &observed["report"],
        );
        assert_eq!(rows(&reopened), observed["rows"]);
        let request = expected["requests"].as_array().unwrap().last().unwrap();
        let evidence = json(&request["evidence"]);
        let retry = reopened.append(append(request, &evidence)).unwrap();
        assert_eq!(retry.newly_appended(), before_commit);
        assert!(retry.commit_acknowledged());
        // After a durable start marker, identical replay only reports the
        // existing record. It cannot recreate external permission on restart.
        if !before_commit {
            assert_eq!(rows(&reopened), observed["rows"]);
        }
    }
}
