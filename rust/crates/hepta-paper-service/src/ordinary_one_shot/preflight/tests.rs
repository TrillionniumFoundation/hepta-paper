use super::*;
use crate::native_research_source::{
    NativeResearchSourceSnapshotRequestV1, inspect_native_research_source_snapshot_v1,
};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::DirBuilderExt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "os-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }
    fn path(&self, leaf: &str) -> PathBuf {
        self.0.join(leaf)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub(in crate::ordinary_one_shot) fn workspace() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}
pub(in crate::ordinary_one_shot) fn node(
    arguments: Vec<String>,
    input: Option<Vec<u8>>,
) -> (i32, Vec<u8>, Vec<u8>) {
    let request = BoundedProcessRequestV1 {
        executable: PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").expect("qualified Node"))
            .canonicalize()
            .unwrap(),
        arguments: arguments.into_iter().map(Into::into).collect(),
        working_directory: workspace(),
        environment: EnvironmentPolicyV1::new(
            "one-shot-normal-preflight-node-oracle",
            ["PATH", "NODE_NO_WARNINGS"],
            ["PATH"],
        )
        .unwrap()
        .build(
            std::env::vars_os(),
            &BTreeMap::from([("NODE_NO_WARNINGS".into(), "1".into())]),
        )
        .unwrap(),
        stdin: input,
    };
    let result = run_bounded_process_capturing_stdout_with_cancellation(
        &request,
        ProcessLimitsV1 {
            timeout_ms: 30_000,
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
    assert!(result.process.process_group_cleanup_verified);
    (
        result.process.exit_code.unwrap(),
        result.stdout,
        result.process.stderr_tail,
    )
}
fn create_runtime(fixture: &Fixture, profile: &str) {
    let (exit, _, stderr) = node(vec!["--input-type=module".into(), "--eval".into(),
        include_str!("../execution_inputs/oracle.mjs").into()],
        Some(serde_json::to_vec(&serde_json::json!({"source":workspace(),"runtime":fixture.path("runtime"),"profile":profile})).unwrap()));
    assert_eq!(exit, 0, "{}", String::from_utf8_lossy(&stderr));
}
fn arguments(fixture: &Fixture, action: &str, mount: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "--action".into(),
        action.into(),
        "--runtime-root".into(),
        fixture.path("runtime").to_str().unwrap().into(),
        "--control-root".into(),
        fixture.path("control").to_str().unwrap().into(),
    ];
    if let Some(mount) = mount {
        args.extend([
            "--dataset-mount-file".into(),
            fixture.path(mount).to_str().unwrap().into(),
        ]);
    }
    args
}
fn original(args: &[String]) -> (i32, Vec<u8>, Vec<u8>) {
    let mut selected = vec![
        workspace()
            .join("paper-core/bin/autonomous-research-one-shot-campaign-attempt.mjs")
            .to_str()
            .unwrap()
            .to_owned(),
    ];
    selected.extend_from_slice(args);
    node(selected, None)
}

#[test]
fn actual_normal_plan_and_preflight_missing_malformed_mounts_match_original_wire_exit_and_sql_refusals()
 {
    for (action, profile, file) in [
        ("plan", "valid", None),
        ("preflight", "active", Some("malformed.json")),
        ("plan", "target", Some("empty.json")),
        ("preflight", "missing", Some("absent.json")),
        ("plan", "malformed-ledger", None),
        (
            "preflight",
            "malformed-prepared-and-ledger",
            Some("wrong.json"),
        ),
        ("plan", "counts", None),
    ] {
        let fixture = Fixture::new();
        create_runtime(&fixture, profile);
        fs::write(fixture.path("malformed.json"), b"{").unwrap();
        fs::write(fixture.path("empty.json"), b"[]").unwrap();
        fs::write(fixture.path("wrong.json"), b"{}").unwrap();
        let args = arguments(&fixture, action, file);
        let expected = original(&args);
        assert_eq!(expected.0, 2, "{}", String::from_utf8_lossy(&expected.2));
        assert!(
            expected.2.is_empty(),
            "{}",
            String::from_utf8_lossy(&expected.2)
        );
        let actual = super::super::inspect_ordinary_one_shot_status_v1(
            &args,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(actual.exit_code, expected.0, "{profile}");
        assert_eq!(
            actual.stdout,
            expected.1,
            "{action}:{profile}:{}",
            String::from_utf8_lossy(&actual.stdout)
        );
        assert!(actual.stderr.is_empty());
        let report: serde_json::Value = serde_json::from_slice(&actual.stdout).unwrap();
        assert_eq!(report["executionAuthorized"], false);
        assert_eq!(report["sideEffects"]["providerInvocationPerformed"], false);
        assert_eq!(report["sideEffects"]["networkAccessPerformed"], false);
        assert!(!fixture.path("control").exists());
        for suffix in ["-journal", "-wal", "-shm"] {
            assert!(
                !fixture
                    .path(&format!("runtime/hepta-paper.sqlite{suffix}"))
                    .exists()
            );
        }
    }
}

#[test]
fn actual_normal_execute_rejects_mount_load_before_any_journal_or_provider_side_effect() {
    for (file, code) in [
        (
            None,
            "autonomous_research_one_shot_dataset_mount_file_required",
        ),
        (
            Some("absent.json"),
            "autonomous_research_one_shot_dataset_mount_file_invalid",
        ),
        (
            Some("malformed.json"),
            "autonomous_research_one_shot_dataset_mount_file_invalid",
        ),
        (
            Some("empty.json"),
            "autonomous_research_one_shot_dataset_mounts_invalid",
        ),
        (
            Some("wrong.json"),
            "autonomous_research_one_shot_dataset_mounts_invalid",
        ),
    ] {
        let fixture = Fixture::new();
        fs::write(fixture.path("malformed.json"), b"{").unwrap();
        fs::write(fixture.path("empty.json"), b"[]").unwrap();
        fs::write(fixture.path("wrong.json"), b"{}").unwrap();
        let args = arguments(&fixture, "execute", file);
        let expected = original(&args);
        assert_eq!(expected.0, 1);
        assert!(expected.1.is_empty());
        assert!(String::from_utf8_lossy(&expected.2).starts_with(&format!("Error: {code}\n")));
        let actual = super::super::inspect_ordinary_one_shot_status_v1(
            &args,
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(actual.err().unwrap(), code);
        assert!(!fixture.path("control").exists());
        assert!(!fixture.path("runtime").exists());
    }
}

#[test]
fn held_whole_workspace_snapshot_matches_original_beyond_paper_domain_and_refuses_cancel_replace_restore()
 {
    let fixture = Fixture::new();
    let root = fixture.path("workspace");
    fs::create_dir(&root).unwrap();
    for index in 0..4100 {
        fs::write(root.join(format!("f-{index:04}")), b"x").unwrap();
    }
    fs::write(root.join("large"), vec![b'x'; 4 * 1024 * 1024 + 1]).unwrap();
    let code = r#"import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';const input=JSON.parse(fs.readFileSync(0,'utf8'));const {inspectWorkspaceExecutionSnapshot,sourceTreeExcludedNames}=await import(pathToFileURL(path.join(input.source,'paper-adapters/runtime/execution-snapshot.mjs')));const value=inspectWorkspaceExecutionSnapshot(input.root,{excludeNames:sourceTreeExcludedNames(input.root)});process.stdout.write(JSON.stringify({merkleHash:value.merkleHash,manifestHash:value.manifestHash}));"#;
    let (exit, bytes, stderr) = node(
        vec!["--input-type=module".into(), "--eval".into(), code.into()],
        Some(serde_json::to_vec(&serde_json::json!({"source":workspace(),"root":root})).unwrap()),
    );
    assert_eq!(exit, 0, "{}", String::from_utf8_lossy(&stderr));
    let expected: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let cancelled = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(120);
    assert!(
        inspect_native_research_source_snapshot_v1(
            NativeResearchSourceSnapshotRequestV1 {
                version: 1,
                source_root: root.clone()
            },
            &cancelled,
            deadline
        )
        .is_err()
    );
    let actual =
        inspect_native_one_shot_workspace_snapshot_v1(root.clone(), &cancelled, deadline).unwrap();
    assert_eq!(
        actual.snapshot()["workspaceSnapshot"]["merkleHash"],
        expected["merkleHash"]
    );
    assert_eq!(
        actual.snapshot()["workspaceSnapshot"]["manifestHash"],
        expected["manifestHash"]
    );
    actual.verify_unchanged().unwrap();
    let leaf = root.join("f-0000");
    fs::rename(&leaf, root.join("held")).unwrap();
    fs::write(&leaf, b"x").unwrap();
    fs::remove_file(&leaf).unwrap();
    fs::rename(root.join("held"), &leaf).unwrap();
    assert!(actual.verify_unchanged().is_err());
    drop(actual);
    let fresh =
        inspect_native_one_shot_workspace_snapshot_v1(root.clone(), &cancelled, deadline).unwrap();
    fresh.verify_unchanged().unwrap();
    cancelled.store(true, Ordering::SeqCst);
    assert!(fresh.verify_unchanged().is_err());
    assert!(inspect_native_one_shot_workspace_snapshot_v1(root, &cancelled, deadline).is_err());
}

#[test]
fn actual_normal_preflight_serializer_retains_successful_business_and_journal_missing_edges() {
    use std::{cell::Cell, os::unix::fs::PermissionsExt};
    for variant in ["database", "control-absence", "journal-absence"] {
        let fixture = Fixture::new();
        create_runtime(&fixture, "valid");
        if variant == "journal-absence" {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(fixture.path("control"))
                .unwrap();
        }
        let args = arguments(&fixture, "preflight", None);
        let baseline = super::super::inspect_ordinary_one_shot_status_v1(
            &args,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let baseline_report: serde_json::Value = serde_json::from_slice(&baseline.stdout).unwrap();
        assert_eq!(
            baseline_report["sideEffects"]["nativeStoreImmutableSnapshotVerified"],
            true
        );
        assert_eq!(
            baseline_report["sideEffects"]["journalReadOnlyInspectionPerformed"],
            true
        );
        assert_eq!(baseline_report["executionAuthorized"], false);
        let entered = Cell::new(false);
        let bounded_wire_completed = Cell::new(false);
        let result = super::super::inspect_ordinary_one_shot_with_serializer(
            &args,
            Arc::new(AtomicBool::new(false)),
            |value, control| {
                entered.set(true);
                match variant {
                    "database" => {
                        let leaf = fixture.path("runtime/hepta-paper.sqlite");
                        let prior = fixture.path("runtime/prior.sqlite");
                        fs::rename(&leaf, &prior).unwrap();
                        fs::copy(&prior, &leaf).unwrap();
                        fs::set_permissions(&leaf, fs::Permissions::from_mode(0o600)).unwrap();
                    }
                    "control-absence" => {
                        fs::DirBuilder::new()
                            .mode(0o700)
                            .create(fixture.path("control"))
                            .unwrap();
                        fs::remove_dir(fixture.path("control")).unwrap();
                    }
                    "journal-absence" => {
                        let leaf = fixture.path("control").join(super::super::JOURNAL_NAME);
                        fs::write(&leaf, b"never an authority or valid journal").unwrap();
                        fs::remove_file(leaf).unwrap();
                    }
                    _ => unreachable!(),
                }
                let bytes = super::super::wire(value, control)?;
                bounded_wire_completed.set(true);
                Ok(bytes)
            },
        );
        assert!(
            entered.get() && bounded_wire_completed.get(),
            "normal parsed preflight and real serializer must run"
        );
        assert!(
            result.is_err(),
            "successful original business and journal absence observations must survive to wire final guards"
        );
    }
}
#[test]
fn actual_preflight_serializer_retains_successful_workspace_and_original_provenance_through_real_replace_restore()
 {
    use std::cell::Cell;
    let fixture = Fixture::new();
    create_runtime(&fixture, "valid");
    let workspace_root = fixture.path("clean-workspace");
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&workspace_root)
        .unwrap();
    fs::write(
        workspace_root.join("package.json"),
        b"{\"name\":\"local-status-source-fixture\",\"version\":\"0.21.0\"}\n",
    )
    .unwrap();
    fs::write(
        workspace_root.join("content.txt"),
        b"local readonly source fixture",
    )
    .unwrap();
    let script = r#"import fs from 'node:fs';import {spawnSync} from 'node:child_process';const {root}=JSON.parse(fs.readFileSync(0,'utf8'));for(const args of [['init','--quiet'],['add','package.json','content.txt'],['-c','user.name=LocalSourceFixture','-c','user.email=local-source-fixture@invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Local readonly fixture']]){const result=spawnSync('git',['-C',root,...args],{timeout:5000,encoding:'utf8'});if(result.error||result.status!==0)throw new Error('owned_fixture_git_failed:'+result.stderr);}process.stdout.write('owned_fixture_ready');"#;
    let (exit, _, stderr) = node(
        vec!["--input-type=module".into(), "--eval".into(), script.into()],
        Some(serde_json::to_vec(&serde_json::json!({"root":workspace_root})).unwrap()),
    );
    assert_eq!(exit, 0, "{}", String::from_utf8_lossy(&stderr));
    let flag = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(120);
    let control = ReconciliationReadControlV1::new(Arc::clone(&flag), deadline);
    let entered = Cell::new(false);
    let bounded_wire_completed = Cell::new(false);
    let result = super::run(
        &workspace_root,
        &fixture.path("runtime"),
        &fixture.path("control"),
        None,
        "preflight",
        &control,
        |value, observed_control| {
            entered.set(true);
            assert!(std::ptr::eq(&*observed_control.cancelled, &*flag));
            assert_eq!(observed_control.deadline, deadline);
            let bytes = super::super::wire(value, observed_control)?;
            let report: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert!(
                report["checks"]["source"]["sourceExecutionSnapshotHash"].is_string(),
                "real accepted clean workspace observation must reach the serializer"
            );
            assert_eq!(report["executionAuthorized"], false);
            let leaf = workspace_root.join("content.txt");
            let held = workspace_root.join("held.txt");
            fs::rename(&leaf, &held).unwrap();
            fs::rename(&held, &leaf).unwrap();
            bounded_wire_completed.set(true);
            Ok(bytes)
        },
    );
    assert!(
        entered.get() && bounded_wire_completed.get(),
        "real workspace observation must reach its serializer"
    );
    assert!(
        result.is_err(),
        "original held workspace epoch may not be replaced or restored after serialization"
    );
}

#[test]
fn retained_collector_checks_original_controls_and_identity_even_when_projection_fails() {
    use std::sync::atomic::Ordering;
    for variant in ["projection-error", "cancel", "changed-database"] {
        let fixture = Fixture::new();
        create_runtime(&fixture, "valid");
        let cancelled = Arc::new(AtomicBool::new(false));
        let control = ReconciliationReadControlV1::new(
            cancelled.clone(),
            Instant::now() + Duration::from_secs(120),
        );
        let result: Result<(), String> = super::super::inputs::with_retained_preflight_facts(
            &workspace(),
            &fixture.path("runtime"),
            &fixture.path("control"),
            None,
            &control,
            |facts| {
                assert!(facts.native_inspected);
                assert!(facts.native_unchanged);
                assert!(facts.journal_inspected);
                match variant {
                    "cancel" => cancelled.store(true, Ordering::Release),
                    "changed-database" => {
                        let file = fixture.path("runtime/hepta-paper.sqlite");
                        let prior = fixture.path("runtime/prior.sqlite");
                        fs::rename(&file, &prior).unwrap();
                        fs::copy(&prior, &file).unwrap();
                    }
                    _ => {}
                }
                Err("projection_failed_for_test".into())
            },
        );
        let error = result.unwrap_err();
        let expected_error = match variant {
            "projection-error" => "projection_failed_for_test",
            "cancel" => "automation_reconciliation_cancelled",
            "changed-database" => "r_runtime_source_cas_input_changed",
            _ => unreachable!(),
        };
        assert_eq!(error, expected_error, "{variant}");
        assert!(!fixture.path("control").exists());
    }
}
