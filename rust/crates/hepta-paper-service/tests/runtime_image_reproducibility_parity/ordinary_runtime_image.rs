use super::{Fixture, files};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, CapturedBoundedProcessResultV1, EnvironmentPolicyV1, ProcessLimitsV1,
    ProcessTerminationReason, run_bounded_process_capturing_stdout_with_cancellation,
    run_bounded_process_with_spawn_hook,
};
use hepta_paper_service::runtime_image_reproducibility::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

fn source() -> PathBuf {
    fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")).unwrap()
}
fn node() -> PathBuf {
    fs::canonicalize(std::env::var_os("HEPTA_TEST_NODE").expect("qualified Node")).unwrap()
}
fn request(executable: &Path, args: &[String], cwd: &Path, env: &Value) -> BoundedProcessRequestV1 {
    let environment: BTreeMap<String, String> = env
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned()))
        .collect();
    let policy = EnvironmentPolicyV1::new(
        "runtime-image-normal-fixture-v1",
        environment.keys().cloned(),
        ["PATH"],
    )
    .unwrap();
    BoundedProcessRequestV1 {
        executable: executable.to_owned(),
        arguments: args.iter().map(OsString::from).collect(),
        working_directory: cwd.to_owned(),
        environment: policy
            .build(std::iter::empty::<(OsString, OsString)>(), &environment)
            .unwrap(),
        stdin: None,
    }
}
fn limits() -> ProcessLimitsV1 {
    ProcessLimitsV1 {
        timeout_ms: 30_000,
        termination_grace_ms: 100,
        cleanup_timeout_ms: 2_000,
        maximum_stdin_bytes: 1,
        maximum_stdout_bytes: 2 * 1024 * 1024,
        maximum_stderr_bytes: 2 * 1024 * 1024,
        maximum_tail_bytes: 8 * 1024,
        ..ProcessLimitsV1::default()
    }
}
fn run(
    executable: &Path,
    args: &[String],
    cwd: &Path,
    env: &Value,
) -> CapturedBoundedProcessResultV1 {
    let output = run_bounded_process_capturing_stdout_with_cancellation(
        &request(executable, args, cwd, env),
        limits(),
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
    output
}
fn oracle(script: &str, input: &Value) -> Value {
    let encoded = input.to_string();
    assert!(encoded.len() <= 64 * 1024);
    let output = run(
        &node(),
        &[source().join(script).to_str().unwrap().to_owned(), encoded],
        &source(),
        &json!({"PATH":"/usr/bin:/bin","LANG":"C.UTF-8"}),
    );
    assert_eq!(
        output.process.exit_code,
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.process.stderr_tail)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn fixture(sleep: bool, builtin_three: bool) -> (Fixture, Value) {
    fixture_with_response_wire(sleep, builtin_three, false)
}
fn fixture_with_response_wire(sleep: bool, builtin_three: bool, reverse: bool) -> (Fixture, Value) {
    let data = oracle(
        "rust/oracle/runtime-image-reproducibility-v2.mjs",
        &json!({"operation":"fixture","scenario":"valid"}),
    );
    assert_eq!(data["oracleRuntime"], "v22.23.1");
    let root = PathBuf::from(data["root"].as_str().unwrap());
    let keys = data["publicKeys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect();
    let fixture = Fixture { data, root, keys };
    let plugin = if builtin_three {
        json!({"environment":{}})
    } else {
        oracle(
            "rust/oracle/runtime-image-reproducibility-v2.mjs",
            &json!({"operation":"external-plugin","root":fixture.root,"scenario":"subset"}),
        )
    };
    let setup = oracle(
        "rust/oracle/runtime-image-reproducibility-v2.mjs",
        &json!({"operation":"workflow","root":fixture.root,"environment":plugin["environment"]}),
    );
    let setup = oracle(
        "rust/oracle/runtime-image-normal-v1.mjs",
        &json!({"operation":"configure-fixture","root":fixture.root,"setup":setup,"sleep":sleep,"builtinThree":builtin_three,"reverseResponseWire":reverse}),
    );
    (fixture, setup)
}

fn executable_snapshot(path: &Path) -> Value {
    let m = fs::symlink_metadata(path).unwrap();
    assert!(m.is_file() && !m.is_symlink());
    let bytes = fs::read(path).unwrap();
    assert!(bytes.starts_with(b"\x7fELF"));
    json!({"dev":m.dev(),"inode":m.ino(),"mode":m.mode(),"uid":m.uid(),"gid":m.gid(),
        "nlink":m.nlink(),"bytes":m.len(),"mtime":[m.mtime(),m.mtime_nsec()],
        "ctime":[m.ctime(),m.ctime_nsec()],"sha256":hex::encode(Sha256::digest(bytes))})
}
fn shipping(root: &Path) -> (PathBuf, PathBuf, Value) {
    let original = fs::canonicalize(env!("CARGO_BIN_EXE_hepta-paper-rust")).unwrap();
    let before = executable_snapshot(&original);
    fs::create_dir_all(root.join("bin")).unwrap();
    for dir in ["paper-core/bin", "paper-core/config"] {
        fs::create_dir_all(root.join(dir)).unwrap();
    }
    fs::write(
        root.join("package.json"),
        b"{\"name\":\"hepta-paper-workspace\",\"version\":\"1.0.0\",\"type\":\"module\"}",
    )
    .unwrap();
    // This synthetic source fixture explicitly treats the copied, untracked ELF
    // as a deployment artifact. Production provenance never excludes a tracked
    // binary and its existing 32MiB/member bound remains unchanged.
    fs::write(root.join(".gitignore"), b"/bin/hepta-paper-rust\n").unwrap();
    let shipping = root.join("bin/hepta-paper-rust");
    fs::copy(&original, &shipping).unwrap();
    fs::set_permissions(&shipping, fs::Permissions::from_mode(0o550)).unwrap();
    assert_ne!(before["inode"], executable_snapshot(&shipping)["inode"]);
    assert_eq!(before["sha256"], executable_snapshot(&shipping)["sha256"]);
    assert_eq!(before, executable_snapshot(&original));
    (shipping, original, before)
}
fn normal_args(action: &str, setup: &Value) -> Vec<String> {
    [
        "operator",
        "runtime-image-reproducibility",
        "--",
        "--action",
        action,
        "--root",
        setup["root"].as_str().unwrap(),
        "--config",
        setup["configPath"].as_str().unwrap(),
        "--runtime-root",
        setup["runtimeRoot"].as_str().unwrap(),
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}
fn parsed(output: CapturedBoundedProcessResultV1) -> Value {
    assert_eq!(
        output.process.exit_code,
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.process.stderr_tail)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn options(action: &str, setup: &Value) -> Value {
    json!({"action":action,"repositoryRoot":setup["root"],"configPath":setup["configPath"],
        "runtimeRoot":setup["runtimeRoot"],"environment":setup["environment"]})
}

#[test]
fn actual_original_r_source_cas_status_matches_whole_node_manifest_and_indexes() {
    let expected = oracle(
        "rust/oracle/runtime-image-normal-v1.mjs",
        &json!({"operation":"source-cas","root":source()}),
    );
    let actual =
        hepta_paper_service::runtime_source_cas::inspect_runtime_source_cas_with_cancellation_v1(
            &source(),
            &AtomicBool::new(false),
        );
    assert_eq!(expected["ready"], true, "{expected}");
    assert_eq!(expected["packageCount"], 104);
    assert_eq!(actual, expected);
    eprintln!(
        "actual_original_cas_files=107 bytes=93548999 packages=104 full_status_value_equal=true"
    );
}

#[test]
fn ordinary_four_modes_replay_actual_node_whole_values_and_shipping_defaults() {
    for reverse in [false, true] {
        replay_four_modes(reverse);
    }
}
fn replay_four_modes(reverse: bool) {
    let (fixture, setup) = fixture_with_response_wire(false, true, reverse);
    let root = Path::new(setup["root"].as_str().unwrap());
    let (shipping, original, before_elf) = shipping(root);
    let cwd = fixture.root.join("unrelated-caller");
    fs::create_dir(&cwd).unwrap();
    let before = files(&fixture.root);
    let value = parsed(run(
        &shipping,
        &normal_args("request", &setup),
        &cwd,
        &setup["environment"],
    ));
    let expected = oracle(
        "rust/oracle/runtime-image-normal-v1.mjs",
        &json!({
        "operation":"compose","options":options("request",&setup),
        "clocks":[value["request"]["requestedAt"]],"nonce":value["request"]["nonce"]}),
    );
    assert_eq!(value, expected);
    assert_eq!(files(&fixture.root), before);
    let verified = parsed(run(
        &shipping,
        &normal_args("verify", &setup),
        &cwd,
        &setup["environment"],
    ));
    assert_eq!(verified["ready"], true);
    let expected = oracle(
        "rust/oracle/runtime-image-normal-v1.mjs",
        &json!({
        "operation":"compose","options":options("verify",&setup),
        "clocks":[verified["receipt"]["request"]["requestedAt"],verified["receipt"]["issuedAt"]],
        "nonce":verified["receipt"]["request"]["nonce"]}),
    );
    assert_eq!(verified, expected);
    assert_eq!(files(&fixture.root), before);
    let published = parsed(run(
        &shipping,
        &normal_args("publish", &setup),
        &cwd,
        &setup["environment"],
    ));
    assert_eq!(published["ready"], true);
    assert_eq!(published["publication"]["publicationGeneration"], 1);
    let runtime = Path::new(setup["runtimeRoot"].as_str().unwrap());
    let receipt_member = "autonomous-research/runtime-image-reproducibility/receipt.json";
    let native_receipt_bytes = fs::read(runtime.join(receipt_member)).unwrap();
    let receipt: Value = serde_json::from_slice(&native_receipt_bytes).unwrap();
    // Preserve the real native publication, then independently run the original
    // publisher at the same fixture path so complete path/hash fields agree.
    let retained = fixture.root.join("native-publication-preserved");
    fs::rename(runtime, &retained).unwrap();
    let expected = oracle(
        "rust/oracle/runtime-image-normal-v1.mjs",
        &json!({
        "operation":"compose","options":options("publish",&setup),
        "clocks":[receipt["request"]["requestedAt"],receipt["issuedAt"]],
        "nonce":receipt["request"]["nonce"]}),
    );
    let original_receipt_bytes = fs::read(runtime.join(receipt_member)).unwrap();
    if native_receipt_bytes != original_receipt_bytes {
        let first = native_receipt_bytes
            .iter()
            .zip(&original_receipt_bytes)
            .position(|(native, original)| native != original)
            .unwrap_or(0);
        let start = first.saturating_sub(80);
        eprintln!(
            "receipt wire first mismatch {first}; native {} original {}",
            String::from_utf8_lossy(
                &native_receipt_bytes[start..native_receipt_bytes.len().min(first + 180)]
            ),
            String::from_utf8_lossy(
                &original_receipt_bytes[start..original_receipt_bytes.len().min(first + 180)]
            )
        );
    }
    assert_eq!(
        native_receipt_bytes, original_receipt_bytes,
        "original publication bytes"
    );
    assert_eq!(published, expected);
    let before_status = files(&fixture.root);
    let status = parsed(run(
        &shipping,
        &normal_args("status", &setup),
        &cwd,
        &setup["environment"],
    ));
    let expected = oracle(
        "rust/oracle/runtime-image-normal-v1.mjs",
        &json!({
        "operation":"compose","options":options("status",&setup),"statusInspection":status["inspection"],
        "clocks":[receipt["issuedAt"]],"nonce":receipt["request"]["nonce"]}),
    );
    assert_eq!(status, expected);
    assert_eq!(files(&fixture.root), before_status);
    assert_eq!(before_elf, executable_snapshot(&original));
    eprintln!(
        "actual_normal_runtime_modes=4 whole_original_values=4 retained_native_publication=true response_reverse_order={reverse}"
    );
}

fn started(root: &Path, deadline: Instant) -> Option<Vec<Value>> {
    loop {
        let values = (1..=2)
            .map(|index| {
                fs::read(root.join(format!("started-{index}.json")))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            })
            .collect::<Option<Vec<Value>>>();
        if values.is_some() {
            return values;
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(5));
    }
}
fn no_verifiers(values: &[Value]) {
    for value in values {
        let pid = value["pid"].as_u64().unwrap();
        assert!(
            !Path::new("/proc").join(pid.to_string()).exists(),
            "verifier {pid} survived"
        );
    }
}
#[test]
fn inherited_cancel_and_single_deadline_cleanup_both_actual_pinned_verifiers() {
    for cancel in [true, false] {
        let (fixture, setup) = fixture(true, false);
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(if cancel { 20 } else { 8 });
        let mut observed = None;
        let error = thread::scope(|scope| {
            let toggle = scope.spawn(|| {
                let values = started(&fixture.root, Instant::now() + Duration::from_secs(15));
                if cancel {
                    cancelled.store(true, Ordering::Release);
                }
                values
            });
            let error = runtime_image_reproducibility_report_with_control_v2(
                &options("verify", &setup),
                &cancelled,
                deadline,
            )
            .unwrap_err();
            observed = toggle.join().unwrap();
            error
        });
        assert_eq!(
            error.to_string(),
            if cancel {
                "runtime_reproducibility_cancelled"
            } else {
                "runtime_reproducibility_deadline_exceeded"
            }
        );
        let values = observed.expect("both actual verifier processes started");
        no_verifiers(&values);
        assert!(!Path::new(setup["runtimeRoot"].as_str().unwrap()).exists());
        // Fresh control reuses the ordinary read-only request, not a saved success.
        let fresh = runtime_image_reproducibility_report_with_control_v2(
            &options("request", &setup),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(20),
        )
        .unwrap();
        assert_eq!(fresh["externalActionPerformed"], false);
        eprintln!(
            "actual_parallel_verifiers={} interruption={} fresh_request=true",
            values.len(),
            error
        );
    }
}

#[test]
fn normal_signal_cleanup_restores_incumbent_sigint_sigterm_exit() {
    for signal in [
        nix::sys::signal::Signal::SIGINT,
        nix::sys::signal::Signal::SIGTERM,
    ] {
        let (fixture, setup) = fixture(true, true);
        let root = Path::new(setup["root"].as_str().unwrap());
        let (shipping, original, before) = shipping(root);
        let prepared = parsed(run(
            &shipping,
            &normal_args("request", &setup),
            root,
            &setup["environment"],
        ));
        assert_eq!(
            prepared["request"]["requiredProfiles"],
            json!(["python", "pythonGpu", "r"])
        );
        let mut values = None;
        let result = run_bounded_process_with_spawn_hook(
            &request(
                &shipping,
                &normal_args("verify", &setup),
                root,
                &setup["environment"],
            ),
            limits(),
            |pid| {
                values = started(&fixture.root, Instant::now() + Duration::from_secs(15));
                let Some(values) = &values else {
                    return Err(hepta_codex_runtime::BoundedProcessError::SpawnHookRejected);
                };
                assert!(values.iter().all(|value| value["ppid"] == pid));
                nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), signal)
                    .map_err(|_| hepta_codex_runtime::BoundedProcessError::SpawnHookRejected)
            },
        )
        .unwrap();
        assert_eq!(result.signal, Some(signal as i32));
        assert_eq!(result.termination_reason, ProcessTerminationReason::Exited);
        assert!(result.process_group_cleanup_verified);
        no_verifiers(&values.unwrap());
        assert_eq!(before, executable_snapshot(&original));
        assert!(!Path::new(setup["runtimeRoot"].as_str().unwrap()).exists());
    }
}

#[test]
fn resource_control_and_isolated_external_actions_refuse_before_io() {
    let cancelled = AtomicBool::new(true);
    let env = BTreeMap::new();
    let args = vec!["--action".to_owned(), "request".to_owned()];
    assert_eq!(
        runtime_image_reproducibility_cli_with_control_v1(
            &args,
            &env,
            &cancelled,
            Instant::now() + Duration::from_secs(120)
        )
        .unwrap_err()
        .to_string(),
        "runtime_reproducibility_cancelled"
    );
    let active = AtomicBool::new(false);
    assert_eq!(
        runtime_image_reproducibility_cli_with_control_v1(
            &args,
            &env,
            &active,
            Instant::now() - Duration::from_millis(1)
        )
        .unwrap_err()
        .to_string(),
        "runtime_reproducibility_deadline_exceeded"
    );
    assert_eq!(
        runtime_image_reproducibility_cli_with_control_v1(
            &args,
            &env,
            &active,
            Instant::now() + Duration::from_secs(121)
        )
        .unwrap_err()
        .to_string(),
        "runtime_reproducibility_normal_deadline_exceeds_profile"
    );
    let isolated = BTreeMap::from([("HEPTA_PAPER_RUNTIME_ISOLATED".into(), "1".into())]);
    for action in ["verify", "publish"] {
        assert_eq!(
            runtime_image_reproducibility_cli_with_control_v1(
                &["--action".into(), action.into()],
                &isolated,
                &active,
                Instant::now() + Duration::from_secs(120)
            )
            .unwrap_err()
            .to_string(),
            "runtime_reproducibility_external_action_forbidden_in_isolated_runtime"
        );
    }
    let huge = BTreeMap::from([
        (
            "HEPTA_PAPER_WORKSPACE_ROOT".into(),
            source().to_str().unwrap().to_owned(),
        ),
        ("LARGE".into(), "a".repeat(65537)),
    ]);
    assert_eq!(
        runtime_image_reproducibility_cli_with_control_v1(
            &[],
            &huge,
            &active,
            Instant::now() + Duration::from_secs(120)
        )
        .unwrap_err()
        .to_string(),
        "runtime_reproducibility_environment_invalid"
    );
    let too_many = vec!["--help".to_owned(); 33];
    assert_eq!(
        runtime_image_reproducibility_cli_with_control_v1(
            &too_many,
            &env,
            &active,
            Instant::now() + Duration::from_secs(120)
        )
        .unwrap_err()
        .to_string(),
        "runtime_reproducibility_argument_resource_limit"
    );
    assert!(
        runtime_image_reproducibility_cli_with_control_v1(
            &["--help".into()],
            &env,
            &active,
            Instant::now() + Duration::from_secs(120)
        )
        .unwrap()
        .text
        .is_some()
    );
}

#[test]
fn ordinary_flag_grammar_and_help_match_actual_original_node_cli_before_io() {
    let (fixture, setup) = fixture(false, true);
    let root = Path::new(setup["root"].as_str().unwrap());
    let (shipping, original, before_elf) = shipping(root);
    let before = files(&fixture.root);
    let cases: Vec<(Vec<&str>, &str)> = vec![
        (
            vec!["--help=true"],
            "boolean_cli_option_does_not_take_value:--help",
        ),
        (vec!["--help", "--help"], "duplicate_cli_option:--help"),
        (vec!["--root"], "missing_cli_option_value:--root"),
        (vec!["--root="], "empty_cli_option_value:--root"),
        (vec!["--unknown"], "unknown_cli_option:--unknown"),
        (vec!["--"], "unexpected_cli_argument_separator"),
        (vec!["paper"], "unexpected_cli_positional:paper"),
        (
            vec!["--action", "other"],
            "runtime_reproducibility_action_invalid:other",
        ),
        (
            vec!["--config", "a", "--config", "b"],
            "duplicate_cli_option:--config",
        ),
    ];
    for (args, error) in &cases {
        let forwarded: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        let native_args: Vec<String> = ["operator", "runtime-image-reproducibility", "--"]
            .into_iter()
            .map(str::to_owned)
            .chain(forwarded.iter().cloned())
            .collect();
        let actual = run(&shipping, &native_args, root, &setup["environment"]);
        let legacy = run(
            &node(),
            &std::iter::once(
                source()
                    .join("paper-core/bin/runtime-image-reproducibility.mjs")
                    .to_str()
                    .unwrap()
                    .to_owned(),
            )
            .chain(forwarded)
            .collect::<Vec<_>>(),
            root,
            &setup["environment"],
        );
        assert_ne!(actual.process.exit_code, Some(0));
        assert_eq!(legacy.process.exit_code, Some(1));
        assert!(String::from_utf8_lossy(&actual.process.stderr_tail).contains(error));
        assert!(String::from_utf8_lossy(&legacy.process.stderr_tail).contains(error));
    }
    let native = run(
        &shipping,
        &[
            "operator".into(),
            "runtime-image-reproducibility".into(),
            "--".into(),
            "--help".into(),
        ],
        root,
        &setup["environment"],
    );
    let legacy = run(
        &node(),
        &[
            source()
                .join("paper-core/bin/runtime-image-reproducibility.mjs")
                .to_str()
                .unwrap()
                .to_owned(),
            "--help".into(),
        ],
        root,
        &setup["environment"],
    );
    assert_eq!(native.process.exit_code, Some(0));
    assert_eq!(legacy.process.exit_code, Some(0));
    assert_eq!(native.stdout, legacy.stdout);
    assert_eq!(files(&fixture.root), before);
    assert_eq!(executable_snapshot(&original), before_elf);
    eprintln!(
        "actual_native_and_original_cli_grammar_cases=9 help_bytes_equal=true no_namespace_mutation=true"
    );
}

#[test]
fn ordinary_shipping_root_relative_flags_and_unknown_copy_refusal_are_actual() {
    let (fixture, setup) = fixture(false, true);
    let root = Path::new(setup["root"].as_str().unwrap());
    let (shipping, original, before_elf) = shipping(root);
    let cwd = fixture.root.join("unrelated-caller");
    fs::create_dir(&cwd).unwrap();
    let relative = vec![
        "operator".into(),
        "runtime-image-reproducibility".into(),
        "--".into(),
        "--action=request".into(),
        "--root=.".into(),
        "--config=../configuration.json".into(),
        "--runtime-root=../runtime".into(),
        "--receipt=../runtime/custom-receipt.json".into(),
    ];
    let before = files(&fixture.root);
    let value = parsed(run(&shipping, &relative, &cwd, &setup["environment"]));
    let expected = oracle(
        "rust/oracle/runtime-image-normal-v1.mjs",
        &json!({"operation":"compose",
        "options":options("request",&setup),"clocks":[value["request"]["requestedAt"]],"nonce":value["request"]["nonce"]}),
    );
    assert_eq!(value, expected);
    // ROOT selection is physical shipping layout, even without the --root flag.
    let default = parsed(run(
        &shipping,
        &[
            "operator".into(),
            "runtime-image-reproducibility".into(),
            "--".into(),
            "--action".into(),
            "request".into(),
            "--config".into(),
            "../configuration.json".into(),
        ],
        &cwd,
        &setup["environment"],
    ));
    let expected = oracle(
        "rust/oracle/runtime-image-normal-v1.mjs",
        &json!({"operation":"compose",
        "options":options("request",&setup),"clocks":[default["request"]["requestedAt"]],"nonce":default["request"]["nonce"]}),
    );
    assert_eq!(default, expected);
    assert_eq!(files(&fixture.root), before);
    let unknown = fixture.root.join("unknown-front-end");
    fs::copy(&shipping, &unknown).unwrap();
    fs::set_permissions(&unknown, fs::Permissions::from_mode(0o550)).unwrap();
    let unknown_before = files(&fixture.root);
    let args = normal_args("request", &setup);
    let rejected = run(&unknown, &args, &cwd, &setup["environment"]);
    assert_ne!(rejected.process.exit_code, Some(0));
    assert!(
        String::from_utf8_lossy(&rejected.process.stderr_tail)
            .contains("native_workspace_root_required")
    );
    assert_eq!(files(&fixture.root), unknown_before);
    let mut explicit = setup["environment"].clone();
    explicit["HEPTA_PAPER_WORKSPACE_ROOT"] = setup["root"].clone();
    let accepted = parsed(run(&unknown, &args, &cwd, &explicit));
    assert_eq!(
        accepted["request"]["requiredProfiles"],
        json!(["python", "pythonGpu", "r"])
    );
    assert_eq!(files(&fixture.root), unknown_before);
    assert_eq!(executable_snapshot(&original), before_elf);
    eprintln!(
        "actual_physical_root_defaults=1 relative_flags=4 unknown_copy_required_root=true explicit_root_retry=true"
    );
}

#[test]
fn ordinary_subset_scope_refuses_and_tracked_elf_is_never_silently_excluded() {
    let (subset, setup) = fixture(false, false);
    let root = Path::new(setup["root"].as_str().unwrap());
    let (subset_shipping, original, before_elf) = shipping(root);
    let before = files(&subset.root);
    let value = run(
        &subset_shipping,
        &normal_args("request", &setup),
        root,
        &setup["environment"],
    );
    assert_ne!(value.process.exit_code, Some(0));
    assert!(
        String::from_utf8_lossy(&value.process.stderr_tail)
            .contains("runtime_reproducibility_normal_builtin_three_profiles_required")
    );
    assert_eq!(files(&subset.root), before);
    // A real tracked deployment ELF stays in both provenance inventories. Its
    // bytes exceed the existing native 32MiB member domain and must be refused.
    let (full, setup) = fixture(false, true);
    let root = Path::new(setup["root"].as_str().unwrap());
    let (shipping, _, _) = shipping(root);
    let git = run(
        Path::new("/usr/bin/git"),
        &[
            "add".into(),
            "--force".into(),
            "bin/hepta-paper-rust".into(),
        ],
        root,
        &json!({"PATH":"/usr/bin:/bin"}),
    );
    assert_eq!(git.process.exit_code, Some(0));
    let tracked_before = files(&full.root);
    let rejected = run(
        &shipping,
        &normal_args("request", &setup),
        root,
        &setup["environment"],
    );
    assert_ne!(rejected.process.exit_code, Some(0));
    assert!(
        String::from_utf8_lossy(&rejected.process.stderr_tail)
            .contains("runtime_reproducibility_code_provenance_invalid")
    );
    let node_value = oracle(
        "rust/oracle/runtime-image-reproducibility-v2.mjs",
        &json!({"operation":"release","root":root}),
    );
    assert!(node_value["codeProvenance"]["treeDirty"].as_bool().unwrap());
    assert_eq!(files(&full.root), tracked_before);
    assert_eq!(executable_snapshot(&original), before_elf);
    eprintln!(
        "normal_required_three_refusal=true actual_tracked_elf_explicit_native_32mib_domain_refusal=true"
    );
}
