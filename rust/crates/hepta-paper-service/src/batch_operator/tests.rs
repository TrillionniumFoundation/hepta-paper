use super::*;
use crate::native_inventory::discover_native_inventory_v1;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{
    ffi::OsString,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    sync::{Mutex, MutexGuard},
};
static FIXTURE_LIFECYCLE: Mutex<()> = Mutex::new(());
pub(crate) struct Fixture {
    pub(crate) base: PathBuf,
    pub(crate) code: PathBuf,
    _lifecycle: MutexGuard<'static, ()>,
}
fn run(
    executable: PathBuf,
    arguments: Vec<OsString>,
    cwd: &Path,
    input: Option<&Value>,
) -> Vec<u8> {
    let environment = EnvironmentPolicyV1::new(
        "native-batch-facade-actual-oracle-v1",
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
            executable,
            arguments,
            working_directory: cwd.into(),
            environment,
            stdin: input.map(|v| serde_json::to_vec(v).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 30_000,
            maximum_stdin_bytes: 1024 * 1024,
            maximum_stdout_bytes: 16 * 1024 * 1024,
            maximum_stderr_bytes: 1024 * 1024,
            maximum_tail_bytes: 64 * 1024,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(
        result.process.termination_reason == ProcessTerminationReason::Exited
            && result.process.exit_code == Some(0)
            && result.process.signal.is_none()
            && result.process.process_group_cleanup_verified,
        "actual oracle failed: {:?}: {}",
        result.process.termination_reason,
        String::from_utf8_lossy(&result.process.stderr_tail)
    );
    result.stdout
}
fn node() -> PathBuf {
    PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").expect("qualified producer Node input"))
        .canonicalize()
        .unwrap()
}
fn actual_node_packages_root(source: &Path) -> PathBuf {
    // CI installs its locked observer graph in the candidate's exclusive
    // parent. The package bytes still enter the private fixture and the same
    // existing exact 64-file policy; no production source policy is relaxed.
    let candidates = [
        source.join("node_modules"),
        source.parent().unwrap().join("node_modules"),
    ];
    let mut selected = None;
    for candidate in candidates {
        match candidate.symlink_metadata() {
            Ok(metadata) => {
                assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
                assert_eq!(candidate.canonicalize().unwrap(), candidate);
                assert!(
                    selected.is_none(),
                    "ambiguous actual locked Node package directories"
                );
                selected = Some(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("actual Node package directory: {error}"),
        }
    }
    selected.expect("actual locked Node package directory")
}
fn copy(source: &Path, target: &Path, entries: &mut usize, bytes: &mut u64) {
    *entries += 1;
    assert!(*entries <= 10_000);
    let before = source.symlink_metadata().unwrap();
    assert!(!before.file_type().is_symlink());
    if before.is_dir() {
        fs::create_dir(target).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            copy(
                &entry.path(),
                &target.join(entry.file_name()),
                entries,
                bytes,
            );
        }
    } else {
        assert!(before.is_file() && before.nlink() == 1 && before.len() <= 16 * 1024 * 1024);
        *bytes += before.len();
        assert!(*bytes <= 64 * 1024 * 1024);
        assert_eq!(fs::copy(source, target).unwrap(), before.len());
        fs::set_permissions(target, fs::Permissions::from_mode(before.mode() & 0o7777)).unwrap();
        let after = source.symlink_metadata().unwrap();
        assert_eq!(
            (
                before.dev(),
                before.ino(),
                before.len(),
                before.mtime(),
                before.mtime_nsec(),
                before.ctime(),
                before.ctime_nsec()
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
    }
}
fn copy_runtime_registry_metadata(
    original: &Path,
    target: &Path,
    entries: &mut usize,
    bytes: &mut u64,
) {
    let rows = run(
        "/usr/bin/git".into(),
        ["ls-files", "--stage", "-z", "--", "runtime-images"]
            .into_iter()
            .map(OsString::from)
            .collect(),
        original,
        None,
    );
    for row in rows.split(|byte| *byte == 0).filter(|row| !row.is_empty()) {
        let row = std::str::from_utf8(row).unwrap();
        let (header, name) = row.split_once('\t').unwrap();
        let header = header.split(' ').collect::<Vec<_>>();
        assert_eq!(header.len(), 3);
        assert_eq!(header[2], "0");
        let relative = Path::new(name);
        assert!(relative.starts_with("runtime-images"));
        assert!(
            relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
        );
        if header[0] == "160000" {
            assert_eq!(name, "runtime-images/r-scientific/source-cas");
            // Deliberately uninitialized scientific input, with no scientific
            // execution/qualification claim. Do not recurse into materialized
            // dataset bytes when comparing local report component functions.
            continue;
        }
        assert!(matches!(header[0], "100644" | "100755"));
        let selected = original.join(relative);
        let destination = target.join(relative);
        assert!(selected.symlink_metadata().unwrap().is_file());
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        copy(&selected, &destination, entries, bytes);
    }
}
impl Fixture {
    pub(crate) fn new() -> Self {
        let lifecycle = FIXTURE_LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = PathBuf::from(format!(
            "/dev/shm/hepta-native-batch-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir(&base).unwrap();
        let code = base.join("code");
        fs::create_dir(&code).unwrap();
        let original = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let (mut entries, mut bytes) = (0, 0);
        for name in [
            "paper-core",
            "paper-domain",
            "paper-application",
            "paper-adapters",
            "paper-composition",
            "paper-ports",
            "workflow-kernel",
            "package.json",
            "store",
        ] {
            copy(
                &original.join(name),
                &code.join(name),
                &mut entries,
                &mut bytes,
            );
        }
        let scripts = code.join("rust/crates/hepta-paper-service/src");
        fs::create_dir_all(scripts.join("batch_operator")).unwrap();
        fs::create_dir(scripts.join("native_inventory")).unwrap();
        fs::write(
            scripts.join("batch_operator/oracle.mjs"),
            include_bytes!("oracle.mjs"),
        )
        .unwrap();
        fs::write(
            scripts.join("native_inventory/oracle.mjs"),
            include_bytes!("../native_inventory/oracle.mjs"),
        )
        .unwrap();
        for args in [
            vec!["init", "--quiet"],
            vec!["config", "gc.auto", "0"],
            vec!["config", "maintenance.auto", "false"],
            vec!["add", "--all"],
            vec![
                "-c",
                "user.name=Native test fixture",
                "-c",
                "user.email=fixture@localhost",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "Actual isolated Node graph",
            ],
        ] {
            run(
                "/usr/bin/git".into(),
                args.into_iter().map(OsString::from).collect(),
                &code,
                None,
            );
        }
        Self {
            base,
            code,
            _lifecycle: lifecycle,
        }
    }
    pub(crate) fn new_with_actual_node_packages() -> Self {
        let fixture = Self::new();
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        fs::create_dir(fixture.code.join("node_modules")).unwrap();
        let packages = actual_node_packages_root(&source);
        let (mut entries, mut bytes) = (0, 0);
        for package in [
            "acorn",
            "acorn-jsx",
            "eslint-scope",
            "eslint-visitor-keys",
            "espree",
            "esrecurse",
            "estraverse",
        ] {
            copy(
                &packages.join(package),
                &fixture.code.join("node_modules").join(package),
                &mut entries,
                &mut bytes,
            );
        }
        // These component oracles use the ordinary registry's committed metadata.
        // Scientific source datasets are separately observed by the normal-entry
        // owners; this fixture cannot execute or qualify a scientific runtime.
        copy_runtime_registry_metadata(&source, &fixture.code, &mut entries, &mut bytes);
        for name in ["migration", "docs", "package-lock.json"] {
            copy(
                &source.join(name),
                &fixture.code.join(name),
                &mut entries,
                &mut bytes,
            );
        }
        for args in [
            vec!["add", "--all"],
            vec![
                "-c",
                "user.name=Native test fixture",
                "-c",
                "user.email=fixture@localhost",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "Actual fixed Node package graph",
            ],
        ] {
            run(
                "/usr/bin/git".into(),
                args.into_iter().map(OsString::from).collect(),
                &fixture.code,
                None,
            );
        }
        fixture
    }
    fn request(&self) -> NativeInventoryRequestV1 {
        NativeInventoryRequestV1 {
            version: 1,
            root: self.base.join("assets"),
            database: Some(self.base.join("runtime/hepta-paper.sqlite")),
            inventory_source: "hepta".into(),
            include_loose_drafts: true,
            include_retired: false,
            include_quarantined: false,
            include_proposal_staging: true,
            proposal_staging_root: Some(self.base.join("runtime/proposal-staging")),
            paper_ids: vec![],
            limit: None,
            observed_at: Some("2026-10-02T00:00:00.000Z".into()),
        }
    }
    fn oracle(&self, script: &str, input: &Value) -> Value {
        serde_json::from_slice(&run(
            node(),
            vec![
                self.code
                    .join(format!(
                        "rust/crates/hepta-paper-service/src/{script}/oracle.mjs"
                    ))
                    .into_os_string(),
            ],
            &self.code,
            Some(input),
        ))
        .unwrap()
    }
    fn prepare(&self, name: &str) -> NativeInventoryRequestV1 {
        let request = self.request();
        let mut v = serde_json::to_value(&request).unwrap();
        v["action"] = json!("prepare");
        v["name"] = json!(name);
        assert_eq!(self.oracle("native_inventory", &v)["registered"], true);
        request
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.base).unwrap();
    }
}
#[test]
fn actual_node_batch_scope_complete_report_and_console_match_held_inventory_values() {
    let fixture = Fixture::new();
    let request = fixture.prepare("external-proposal");
    fs::write(
        request.root.join("drafts/local-paper/paper.json"),
        br#"{"paper_production":{"profile":"survey_or_position_paper"}}"#,
    )
    .unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let observation =
        discover_native_inventory_v1(&request, &cancel, Instant::now() + Duration::from_secs(300))
            .unwrap();
    let mut whole_positive = 0;
    for args in [
        vec![
            "--mode",
            "local-dry-run",
            "--quality-profile",
            "survey_or_position",
        ],
        vec![
            "--mode",
            "local-build",
            "--quality-profile",
            "theorem_or_proof",
        ],
        vec![
            "--mode",
            "research-verify",
            "--quality-profile",
            "formal_theorem_or_proof",
        ],
        vec![
            "--mode",
            "referee-autopilot",
            "--max-rounds",
            "2",
            "--quality-profile",
            "survey_or_position",
        ],
        vec!["--mode", "local-dry-run", "--paper", "missing"],
        vec![
            "--mode",
            "local-dry-run",
            "--limit",
            "2",
            "--quality-profile",
            "survey_or_position",
        ],
        vec!["--mode", "inventory"],
    ] {
        let options = normalize_native_batch_cli_arguments_v1(
            &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            fixture.code.to_str().unwrap(),
            request.root.to_str().unwrap(),
            request
                .database
                .as_ref()
                .unwrap()
                .parent()
                .unwrap()
                .to_str()
                .unwrap(),
        )
        .unwrap();
        let expected = fixture.oracle(
            "batch_operator",
            &json!({"options":options,"scan":observation.scan()}),
        );
        let mut scan = observation.scan().clone();
        if let Some(profile) = &options.quality_profile {
            for row in scan["rows"].as_array_mut().unwrap() {
                row["task"] =
                    crate::native_inventory::bind_native_inventory_task_quality_profile_v1(
                        &row["task"],
                        profile,
                    )
                    .unwrap();
            }
        }
        assert_eq!(scan, expected["scan"], "actual quality binding");
        let target = scope::build(&options, &scan).unwrap();
        assert_eq!(target, expected["target"], "actual target scope");
        let mut results = vec![];
        let mut refusal = None;
        for (row_index, row) in scan["rows"].as_array().unwrap().iter().enumerate() {
            let source = row["sourceDir"].as_str();
            let command = if target["status"] == "target_scope_verified"
                && let Some(source) = source
            {
                match build_native_batch_campaign_command_v1(&NativeBatchCampaignCommandInputV1 {
                    version: 1,
                    paper_task: row["task"].clone(),
                    paper_state: Some(row["state"].clone()),
                    source_workspace: source.into(),
                    options: options.clone(),
                    target_scope_receipt: target.clone(),
                }) {
                    Ok(v) => Some(v),
                    Err(e) => {
                        refusal = Some(e);
                        break;
                    }
                }
            } else {
                None
            };
            let time = expected["results"][row_index]["workflowAuthorityLineage"]["recordedAt"]
                .as_str()
                .unwrap();
            results.push(report::result(row, command.as_ref(), &options.mode, time).unwrap());
        }
        if let Some(error) = refusal {
            assert_eq!(expected["ok"], false);
            assert_eq!(json!(error), expected["error"]);
        } else {
            assert_eq!(expected["ok"], true, "{expected}");
            whole_positive += 1;
            assert_eq!(json!(results), expected["results"]);
            let expected_report = &expected["report"];
            let report = report::build(
                &options,
                &scan,
                &results,
                target,
                expected_report["codeProvenance"].clone(),
                expected_report["generatedAt"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!(&report, expected_report, "complete observed input report");
            assert_eq!(
                report::console(&report).unwrap(),
                expected["console"].as_str().unwrap(),
                "actual console bytes"
            );
        }
        observation.verify_unchanged().unwrap();
    }
    assert_eq!(
        whole_positive, 6,
        "all legal complete reports must actually be constructed"
    );
    eprintln!(
        "actual batch observer scope=held_inventory+original_Node_whole_calculations; timestamps/provenance are actual observed helper inputs, not normalCLI authority; routeAccepted=false"
    );
}

#[test]
fn repeated_scope_and_result_bytes_refuse_before_clone_append_and_cancellation() {
    let cancelled = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(30);
    let ids = (0..1000)
        .map(|i| json!(format!("{i:04}{}", "x".repeat(252))))
        .collect::<Vec<_>>();
    let scan =
        json!({"rows":(0..1000).map(|_|json!({"sourceDir":"/actual/source"})).collect::<Vec<_>>()});
    let target =
        json!({"status":"target_scope_verified","selectedPaperIds":ids,"requestedPaperIds":[]});
    assert_eq!(
        budget::ResultsBudgetV1::new(&scan, &target, &cancelled, deadline)
            .err()
            .unwrap(),
        "native_batch_operator_result_budget_v1"
    );
    let small = json!({"rows":[]});
    let mut budget = budget::ResultsBudgetV1::new(
        &small,
        &json!({"selectedPaperIds":[],"requestedPaperIds":[]}),
        &cancelled,
        deadline,
    )
    .unwrap();
    let large = json!({"task":{"text":"x".repeat(4*1024*1024)},"state":{}});
    assert_eq!(
        budget
            .reserve_before_result_clone(&large, None, &cancelled, deadline)
            .unwrap_err(),
        "native_batch_operator_result_budget_v1"
    );
    cancelled.store(true, Ordering::Release);
    assert_eq!(
        budget
            .reserve_before_result_clone(&json!({"task":{},"state":{}}), None, &cancelled, deadline)
            .unwrap_err(),
        "native_batch_operator_cancelled"
    );
    let expired = crate::operational_status::current_operational_code_provenance_with_deadline_v1(
        Path::new("/definitely/not/opened"),
        &AtomicBool::new(false),
        Instant::now() - Duration::from_millis(1),
    )
    .unwrap_err();
    assert!(
        expired
            .to_string()
            .contains("code_provenance_deadline_exceeded")
    );
}
