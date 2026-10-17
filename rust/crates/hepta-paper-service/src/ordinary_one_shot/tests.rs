use super::*;

#[test]
fn original_contract_sources_and_help_are_bound_without_runtime_io() {
    let output =
        inspect_ordinary_one_shot_status_v1(&["--help".into()], Arc::new(AtomicBool::new(false)))
            .expect("source-bound help");
    assert_eq!(output.exit_code, 0);
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("help JSON");
    assert_eq!(
        value,
        contract::contract().expect("current contract")["usage"]
    );
    assert_eq!(value["safety"]["replayExternalActions"], false);
}

#[test]
fn cancelled_and_expired_original_controls_refuse_before_runtime_observation() {
    let result = run(
        &["--attempt-id".into(), "unissued".into()],
        Arc::new(AtomicBool::new(true)),
        Instant::now() + Duration::from_secs(120),
    );
    assert!(result.unwrap_err().contains("cancelled"));
    let result = run(
        &["--attempt-id".into(), "unissued".into()],
        Arc::new(AtomicBool::new(false)),
        Instant::now(),
    );
    assert!(result.unwrap_err().contains("deadline"));
}

#[test]
fn retained_one_shot_missing_edges_and_original_file_epoch_cannot_revive() {
    use std::{
        fs,
        os::unix::fs::{DirBuilderExt, PermissionsExt},
        sync::atomic::Ordering,
    };
    let scratch = std::env::temp_dir().join(format!(
        "one-shot-status-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&scratch)
        .expect("owned scratch");
    struct OwnedScratch(PathBuf);
    impl Drop for OwnedScratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = OwnedScratch(scratch.clone());
    let root = fs::canonicalize(&scratch).expect("physical root");
    fs::DirBuilder::new()
        .mode(0o700)
        .create(root.join("runtime"))
        .expect("runtime");
    let flag = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut retained =
        SourceObservation::new_with_deadline(&root, &flag, deadline).expect("observer");
    assert!(
        !retained
            .one_shot_private_directory_v1(Path::new("control"))
            .expect("absence")
    );
    fs::DirBuilder::new()
        .mode(0o700)
        .create(root.join("control"))
        .expect("create fixture edge");
    fs::remove_dir(root.join("control")).expect("remove fixture edge");
    assert!(retained.assert_current().is_err());
    drop(retained);
    fs::DirBuilder::new()
        .mode(0o700)
        .create(root.join("control"))
        .expect("fresh directory");
    let file = root.join("control/campaign-one-shot-attempt.sqlite");
    fs::write(&file, b"historical fixture bytes").expect("fixture write");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).expect("private journal");
    let mut retained =
        SourceObservation::new_with_deadline(&root, &flag, deadline).expect("fresh observer");
    assert!(
        retained
            .one_shot_private_directory_v1(Path::new("control"))
            .expect("private root")
    );
    assert_eq!(
        retained
            .one_shot_journal_bytes_v1(Path::new("control/campaign-one-shot-attempt.sqlite"))
            .expect("held bytes")
            .expect("present"),
        b"historical fixture bytes"
    );
    fs::rename(&file, root.join("control/prior.sqlite")).expect("hold original");
    fs::write(&file, b"historical fixture bytes").expect("foreign same bytes");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).expect("private replacement");
    assert!(retained.assert_current().is_err());
    drop(retained);
    let mut fresh =
        SourceObservation::new_with_deadline(&root, &flag, deadline).expect("fresh observer");
    assert!(
        fresh
            .one_shot_journal_present_v1(Path::new("control/campaign-one-shot-attempt.sqlite"))
            .expect("fresh input")
    );
    flag.store(true, Ordering::Release);
    assert!(fresh.assert_current().is_err());
    assert!(
        fresh
            .one_shot_journal_bytes_v1(Path::new("control/campaign-one-shot-attempt.sqlite"))
            .is_err()
    );
    drop(fresh);
    flag.store(false, Ordering::Release);
    let mut retry = SourceObservation::new_with_deadline(
        &root,
        &flag,
        Instant::now() + Duration::from_secs(120),
    )
    .expect("new exact epoch");
    assert!(
        retry
            .one_shot_journal_bytes_v1(Path::new("control/campaign-one-shot-attempt.sqlite"))
            .expect("new bytes")
            .is_some()
    );
    retry.assert_current().expect("current new epoch");
}

// The private serializer seam is the same production normal parser and reader;
// the callback always runs the existing bounded encoder, never a hand-built
// permit or injected observation. All Node fixture work retains the fixed 30s
// normal fixture owner; the historical execution fixtures retain their 60s.
struct StatusWireFixture {
    root: PathBuf,
    expected: serde_json::Value,
}
impl StatusWireFixture {
    fn new() -> Self {
        Self::with_mode("normal", None)
    }
    fn with_mode(mode: &str, stop_at: Option<&str>) -> Self {
        use std::{
            fs,
            os::unix::fs::DirBuilderExt,
            time::{SystemTime, UNIX_EPOCH},
        };
        let root = std::env::temp_dir().join(format!(
            "os-wire-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let input = serde_json::json!({"source":preflight::tests::workspace(),"runtime":root.join("runtime"),"control":root.join("control"),"mode":mode,"stopAt":stop_at});
        let (exit, bytes, stderr) = preflight::tests::node(
            vec![
                "--input-type=module".into(),
                "--eval".into(),
                include_str!("execution/oracle.mjs").into(),
            ],
            Some(serde_json::to_vec(&input).unwrap()),
        );
        assert_eq!(exit, 0, "{}", String::from_utf8_lossy(&stderr));
        Self {
            root,
            expected: serde_json::from_slice(&bytes).unwrap(),
        }
    }
    fn arguments(&self) -> Vec<String> {
        vec![
            "--action".into(),
            "status".into(),
            "--runtime-root".into(),
            self.root.join("runtime").to_str().unwrap().into(),
            "--control-root".into(),
            self.root.join("control").to_str().unwrap().into(),
            "--attempt-id".into(),
            "native-fixed-one-shot-journal".into(),
        ]
    }
}
impl Drop for StatusWireFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[test]
fn actual_normal_status_serializer_retains_original_journal_through_same_bytes_replace_and_rename_restore()
 {
    use std::{cell::Cell, fs, os::unix::fs::PermissionsExt};
    for restore in [false, true] {
        let fixture = StatusWireFixture::new();
        let args = fixture.arguments();
        let baseline =
            inspect_ordinary_one_shot_status_v1(&args, Arc::new(AtomicBool::new(false))).unwrap();
        let observed: serde_json::Value = serde_json::from_slice(&baseline.stdout).unwrap();
        assert_eq!(
            &observed,
            fixture.expected["reports"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()
        );
        let journal = fixture.root.join("control").join(JOURNAL_NAME);
        let prior = fixture.root.join("control/prior.sqlite");
        let entered = Cell::new(false);
        let bounded_wire_completed = Cell::new(false);
        let result = inspect_ordinary_one_shot_with_serializer(
            &args,
            Arc::new(AtomicBool::new(false)),
            |value, control| {
                entered.set(true);
                fs::rename(&journal, &prior).unwrap();
                if restore {
                    fs::rename(&prior, &journal).unwrap();
                } else {
                    fs::copy(&prior, &journal).unwrap();
                    fs::set_permissions(&journal, fs::Permissions::from_mode(0o600)).unwrap();
                }
                let output = wire(value, control)?;
                bounded_wire_completed.set(true);
                Ok(output)
            },
        );
        assert!(
            entered.get() && bounded_wire_completed.get(),
            "genuine serializer must run, and currentness refusal follows the real bounded encoder"
        );
        assert!(
            result.is_err(),
            "historical status may not publish bytes after its original journal epoch changed"
        );
        let fresh =
            inspect_ordinary_one_shot_status_v1(&args, Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(
            fresh.stdout, baseline.stdout,
            "fresh independently observed same bytes remain readable; no replay or writer occurs"
        );
    }
}
#[test]
fn actual_normal_status_serializer_keeps_original_cancellation_and_deadline_and_emits_no_stale_report()
 {
    use std::{cell::Cell, sync::atomic::Ordering};
    for expire in [false, true] {
        let fixture = StatusWireFixture::new();
        let flag = Arc::new(AtomicBool::new(false));
        let original_deadline = Instant::now() + Duration::from_secs(5);
        let entered = Cell::new(false);
        let result = run_with_serializer(
            &fixture.arguments(),
            Arc::clone(&flag),
            original_deadline,
            |value, control| {
                entered.set(true);
                assert!(std::ptr::eq(&*control.cancelled, &*flag));
                assert_eq!(control.deadline, original_deadline);
                if expire {
                    std::thread::sleep(
                        original_deadline.saturating_duration_since(Instant::now())
                            + Duration::from_millis(1),
                    );
                } else {
                    flag.store(true, Ordering::Release);
                }
                wire(value, control)
            },
        );
        assert!(
            entered.get(),
            "the original reader must admit before the actual serializer interruption"
        );
        let error = result.unwrap_err();
        assert!(
            error.contains(if expire { "deadline" } else { "cancelled" }),
            "{error}"
        );
        flag.store(false, Ordering::Release);
        assert!(
            inspect_ordinary_one_shot_status_v1(&fixture.arguments(), flag).is_ok(),
            "fresh read has a new independently observed epoch and preserves durable history"
        );
    }
}

#[test]
fn actual_normal_status_typed_recovery_preserves_every_original_phase_wire_and_files() {
    use std::fs;
    use std::os::unix::fs::MetadataExt;
    // Read-only observations exclude access time, which a real read may update.
    #[derive(Debug, PartialEq, Eq)]
    struct FileSnapshot {
        path: PathBuf,
        device: u64,
        inode: u64,
        mode: u32,
        links: u64,
        uid: u32,
        gid: u32,
        size: u64,
        modified: (i64, i64),
        changed: (i64, i64),
        bytes: Vec<u8>,
    }
    fn snapshot(path: &Path) -> Vec<FileSnapshot> {
        // Include the selected root itself, not only its descendants.
        let meta = fs::symlink_metadata(path).unwrap();
        assert!(!meta.file_type().is_symlink());
        let bytes = if meta.is_file() {
            fs::read(path).unwrap()
        } else {
            Vec::new()
        };
        let mut result = vec![FileSnapshot {
            path: path.to_owned(),
            device: meta.dev(),
            inode: meta.ino(),
            mode: meta.mode(),
            links: meta.nlink(),
            uid: meta.uid(),
            gid: meta.gid(),
            size: meta.len(),
            modified: (meta.mtime(), meta.mtime_nsec()),
            changed: (meta.ctime(), meta.ctime_nsec()),
            bytes,
        }];
        if meta.is_dir() {
            let mut paths = fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            paths.sort();
            for child in paths {
                result.extend(snapshot(&child));
            }
        }
        result
    }
    let phases = [
        "attempt_reserved",
        "preconditions_verified",
        "prepare_verified",
        "provider_started",
        "provider_completed",
        "launch_started",
    ];
    let terminals = [
        ("attempt_reserved", "blocked_pre_provider"),
        ("preconditions_verified", "blocked_pre_provider"),
        ("prepare_verified", "blocked_pre_provider"),
        ("provider_started", "recovered_incomplete"),
        ("provider_completed", "blocked_post_provider"),
        ("launch_started", "recovered_incomplete"),
        ("launch_started", "completed"),
        ("launch_started", "failed_terminal"),
    ];
    let mut cases = phases
        .iter()
        .map(|phase| ("head".to_owned(), Some(*phase)))
        .collect::<Vec<_>>();
    cases.extend(
        terminals
            .iter()
            .map(|(phase, status)| (format!("terminal/{phase}/{status}"), None)),
    );
    for (mode, stop_at) in cases {
        let fixture = StatusWireFixture::with_mode(&mode, stop_at);
        let before = snapshot(&fixture.root);
        let args = fixture.arguments();
        let mut original_args = vec![
            preflight::tests::workspace()
                .join("paper-core/bin/autonomous-research-one-shot-campaign-attempt.mjs")
                .to_str()
                .unwrap()
                .to_owned(),
        ];
        original_args.extend(args.clone());
        let (exit, stdout, stderr) = preflight::tests::node(original_args, None);
        assert_eq!(exit, 0, "{mode}:{}", String::from_utf8_lossy(&stderr));
        assert!(
            stderr.is_empty(),
            "{mode}:{}",
            String::from_utf8_lossy(&stderr)
        );
        assert_eq!(
            snapshot(&fixture.root),
            before,
            "original status writes: {mode}"
        );
        let control = ReconciliationReadControlV1::new(
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(120),
        );
        let owner = inspect_report(
            &fixture.root.join("runtime"),
            &fixture.root.join("control"),
            Some("native-fixed-one-shot-journal"),
            &control,
            &mut false,
        )
        .unwrap();
        owner
            .project_recovery(&control, |facts| {
                assert!(!facts.is_absent());
                assert!(is_text_for_test(
                    facts.report(),
                    stop_at.unwrap_or("terminal")
                ));
                use super::recovery::RecoveryState;
                let expected = match stop_at {
                    Some("provider_started") => RecoveryState::ProviderOutcomeUnknown,
                    Some("provider_completed") => {
                        RecoveryState::CompletedCanaryWithoutInvocationAuthority
                    }
                    Some("launch_started") => RecoveryState::LaunchOutcomeUnknown,
                    Some(_) => RecoveryState::BeforeProvider,
                    None => RecoveryState::TerminalReplay,
                };
                assert_eq!(facts.state(), &expected);
                Ok(())
            })
            .unwrap();
        let actual =
            inspect_ordinary_one_shot_status_v1(&args, Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(actual.exit_code, exit, "{mode}");
        assert_eq!(actual.stdout, stdout, "{mode}");
        assert_eq!(actual.stderr, stderr, "{mode}");
        assert_eq!(
            snapshot(&fixture.root),
            before,
            "native status writes: {mode}"
        );
    }
    fn is_text_for_test(
        report: &hepta_legacy_compatibility::ProductionJsonValue,
        phase: &str,
    ) -> bool {
        super::json::is_text(super::json::field(report, "headPhase"), phase)
    }
}
