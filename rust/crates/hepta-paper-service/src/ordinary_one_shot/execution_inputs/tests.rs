use super::*;
use std::{
    os::unix::fs::DirBuilderExt,
    time::{SystemTime, UNIX_EPOCH},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "one-shot-input-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::DirBuilder::new().mode(0o700).create(&p).unwrap();
        Self(p.canonicalize().unwrap())
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::atomic::Ordering};
fn oracle(fixture: &Fixture, profile: &str) -> serde_json::Value {
    let request=BoundedProcessRequestV1 {
        executable:PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").expect("qualified Node")).canonicalize().unwrap(),
        arguments:vec!["--input-type=module".into(),"--eval".into(),include_str!("oracle.mjs").into()],
        working_directory:source(),environment:EnvironmentPolicyV1::new("one-shot-business-input-oracle",["PATH"],["PATH"]).unwrap().build(std::env::vars_os(),&BTreeMap::new()).unwrap(),
        stdin:Some(serde_json::to_vec(&serde_json::json!({"source":source(),"runtime":fixture.path("runtime"),"profile":profile})).unwrap()),
    };
    let result = run_bounded_process_capturing_stdout_with_cancellation(
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
    serde_json::from_slice(&result.stdout).unwrap()
}
fn equal(actual: &Json, expected: &serde_json::Value) {
    let expected = parse_production_json_v1(&serde_json::to_vec(expected).unwrap()).unwrap();
    assert_eq!(
        canonical_bytes(actual, 1024 * 1024, &AtomicBool::new(false)).unwrap(),
        canonical_bytes(&expected, 1024 * 1024, &AtomicBool::new(false)).unwrap()
    );
}
#[test]
fn actual_original_node_protected_campaign_and_target_whole_values_match_immutable_projection() {
    for profile in [
        "valid",
        "active",
        "target",
        "missing",
        "malformed-prepared",
        "counts",
        "missing-malformed-ledger",
        "malformed-prepared-and-ledger",
        "malformed-ledger",
    ] {
        let fixture = Fixture::new();
        let expected = oracle(&fixture, profile);
        let cancelled = Arc::new(AtomicBool::new(false));
        let result = OneShotBusinessObservationV1::capture(
            &fixture.path("runtime"),
            &cancelled,
            Instant::now() + Duration::from_secs(120),
        );
        if let Some(error) = expected.get("error") {
            assert_eq!(result.err().unwrap(), error.as_str().unwrap());
        } else {
            let observed = result.unwrap();
            equal(observed.protected_definition(), &expected["definition"]);
            equal(observed.target_campaign(), &expected["target"]);
            observed.assert_current().unwrap();
            assert!(matches!(
                ReadOnlyStoreV1::open_known_installed_v1(
                    fixture.path("runtime/hepta-paper.sqlite")
                )
                .unwrap()
                .fixed_one_shot_business_rows_v1(),
                Err(
                    hepta_readonly_store::ReadOnlyStoreError::OrdinaryBudgetExceeded(
                        "one_shot_original_control_required_v1"
                    )
                )
            ));
            for suffix in ["-journal", "-wal", "-shm"] {
                assert!(
                    !fixture
                        .path(&format!("runtime/hepta-paper.sqlite{suffix}"))
                        .exists()
                );
            }
        }
    }
}
#[test]
fn retained_business_inputs_refuse_cancel_expiry_replacement_and_missing_sidecar_epoch_then_fresh_retry()
 {
    let fixture = Fixture::new();
    let expected = oracle(&fixture, "valid");
    let runtime = fixture.path("runtime");
    let cancelled = Arc::new(AtomicBool::new(false));
    let observed = OneShotBusinessObservationV1::capture(
        &runtime,
        &cancelled,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap();
    let marker = runtime.join("hepta-paper.sqlite-wal");
    fs::write(&marker, b"unknown foreign WAL").unwrap();
    assert!(observed.assert_current().is_err());
    fs::remove_file(&marker).unwrap();
    assert!(observed.assert_current().is_err());
    drop(observed);
    let observed = OneShotBusinessObservationV1::capture(
        &runtime,
        &cancelled,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap();
    equal(observed.protected_definition(), &expected["definition"]);
    let database = runtime.join("hepta-paper.sqlite");
    let displaced = runtime.join("original-held-database");
    fs::rename(&database, &displaced).unwrap();
    fs::copy(&displaced, &database).unwrap();
    assert!(observed.assert_current().is_err());
    fs::remove_file(&database).unwrap();
    fs::rename(&displaced, &database).unwrap();
    assert!(observed.assert_current().is_err());
    drop(observed);
    let observed = OneShotBusinessObservationV1::capture(
        &runtime,
        &cancelled,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap();
    cancelled.store(true, Ordering::SeqCst);
    assert!(observed.assert_current().is_err());
    assert!(
        OneShotBusinessObservationV1::capture(
            &runtime,
            &cancelled,
            Instant::now() + Duration::from_secs(120)
        )
        .is_err()
    );
    let fresh = Arc::new(AtomicBool::new(false));
    assert!(OneShotBusinessObservationV1::capture(&runtime, &fresh, Instant::now()).is_err());
    assert!(
        OneShotBusinessObservationV1::capture(
            &runtime,
            &fresh,
            Instant::now() + Duration::from_secs(121)
        )
        .is_err()
    );
    let reopened = OneShotBusinessObservationV1::capture(
        &runtime,
        &fresh,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap();
    equal(reopened.protected_definition(), &expected["definition"]);
}

#[test]
fn original_node_large_inputs_are_explicitly_bounded_and_unknown_aliases_remain_unchanged() {
    for profile in ["large-cell", "large-logical"] {
        let fixture = Fixture::new();
        let original = oracle(&fixture, profile);
        assert!(
            original.get("definition").is_some(),
            "original Node accepts this input"
        );
        let database = fixture.path("runtime/hepta-paper.sqlite");
        let before = fs::read(&database).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let refused = OneShotBusinessObservationV1::capture(
            &fixture.path("runtime"),
            &cancelled,
            Instant::now() + Duration::from_secs(120),
        )
        .err()
        .unwrap_or_else(|| panic!("expected bounded refusal for {profile}"));
        assert!(
            refused.contains("budget") || refused.contains("limit") || refused.contains("bound"),
            "{refused}"
        );
        assert_eq!(before, fs::read(&database).unwrap());
        for suffix in ["-wal", "-shm", "-journal"] {
            assert!(
                !fixture
                    .path(&format!("runtime/hepta-paper.sqlite{suffix}"))
                    .exists()
            );
        }
    }
    let fixture = Fixture::new();
    let expected = oracle(&fixture, "valid");
    let runtime = fixture.path("runtime");
    let database = runtime.join("hepta-paper.sqlite");
    let before = fs::read(&database).unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let original = runtime.join("displaced");
    fs::rename(&database, &original).unwrap();
    std::os::unix::fs::symlink(&original, &database).unwrap();
    assert!(
        OneShotBusinessObservationV1::capture(
            &runtime,
            &cancelled,
            Instant::now() + Duration::from_secs(120)
        )
        .is_err()
    );
    assert_eq!(before, fs::read(&original).unwrap());
    assert!(
        fs::symlink_metadata(&database)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    fs::remove_file(&database).unwrap();
    fs::rename(&original, &database).unwrap();
    let extra = fixture.path("hardlinked");
    fs::hard_link(&database, &extra).unwrap();
    assert!(
        OneShotBusinessObservationV1::capture(
            &runtime,
            &cancelled,
            Instant::now() + Duration::from_secs(120)
        )
        .is_err()
    );
    assert_eq!(before, fs::read(&database).unwrap());
    fs::remove_file(&extra).unwrap();
    let alias = fixture.path("runtime-alias");
    std::os::unix::fs::symlink(&runtime, &alias).unwrap();
    assert!(
        OneShotBusinessObservationV1::capture(
            &alias,
            &cancelled,
            Instant::now() + Duration::from_secs(120)
        )
        .is_err()
    );
    let unknown = runtime.join("hepta-paper.sqlite-journal");
    fs::write(&unknown, b"unknown").unwrap();
    assert!(
        OneShotBusinessObservationV1::capture(
            &runtime,
            &cancelled,
            Instant::now() + Duration::from_secs(120)
        )
        .is_err()
    );
    assert_eq!(fs::read(&unknown).unwrap(), b"unknown");
    fs::remove_file(&unknown).unwrap();
    let fresh = OneShotBusinessObservationV1::capture(
        &runtime,
        &cancelled,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap();
    equal(fresh.protected_definition(), &expected["definition"]);
}
