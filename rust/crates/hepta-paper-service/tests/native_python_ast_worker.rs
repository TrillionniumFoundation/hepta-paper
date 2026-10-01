//! The native ordinary ELF parses data; independent Python is only a differential
//! observer. Both children use the existing bounded process-group owner.
use hepta_codex_runtime::{
    BoundedProcessRequestV1, CapturedBoundedProcessResultV1, EnvironmentPolicyV1, ProcessLimitsV1,
    ProcessTerminationReason, run_bounded_process_capturing_stdout_with_cancellation,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn binary_observation(path: &Path) -> Value {
    let metadata = fs::metadata(path).unwrap();
    assert!(metadata.is_file());
    assert!(metadata.len() <= 256 * 1024 * 1024);
    let raw = fs::read(path).unwrap();
    assert_eq!(metadata.len(), raw.len() as u64);
    json!({"dev":metadata.dev(),"ino":metadata.ino(),"mode":metadata.mode(),"nlink":metadata.nlink(),"bytes":metadata.len(),"mtime":metadata.mtime(),"mtimeNsec":metadata.mtime_nsec(),"ctime":metadata.ctime(),"ctimeNsec":metadata.ctime_nsec(),"sha256":format!("{:x}",Sha256::digest(raw))})
}
struct Fixture(PathBuf, PathBuf, Value);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-native-python-ast-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        // Cargo's ambient umask can make the debug artifact group writable;
        // test the existing kernel against an actual private shipping copy.
        let binary = root.join("hepta-paper-rust");
        let original = Path::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
        let before = binary_observation(original);
        fs::copy(env!("CARGO_BIN_EXE_hepta-paper-rust"), &binary).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o555)).unwrap();
        assert_eq!(binary_observation(original), before);
        assert_eq!(binary_observation(&binary)["sha256"], before["sha256"]);
        Self(root, binary, before)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        assert_eq!(
            binary_observation(Path::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))),
            self.2
        );
        let copy = binary_observation(&self.1);
        assert_eq!(copy["sha256"], self.2["sha256"]);
        assert_eq!(copy["mode"].as_u64().unwrap() & 0o777, 0o555);
        assert_eq!(copy["nlink"], 1);
        println!(
            "{}",
            json!({"actualCargoElfRawAndMetadataUnchanged":true,"actualPrivateShippingElfSha256":copy["sha256"],"kernelPermissionsLoosened":false})
        );
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn run(
    fixture: &Fixture,
    executable: &Path,
    arguments: Vec<OsString>,
    input: Option<Vec<u8>>,
    cancelled: &AtomicBool,
) -> CapturedBoundedProcessResultV1 {
    let values = BTreeMap::from([
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("LANG".into(), "C.UTF-8".into()),
        ("LC_ALL".into(), "C.UTF-8".into()),
        ("PYTHONDONTWRITEBYTECODE".into(), "1".into()),
    ]);
    let environment = EnvironmentPolicyV1::new(
        "native-ast-data-only-existing-process-differential-v1",
        values.keys().cloned(),
        ["PATH", "LANG", "LC_ALL"],
    )
    .unwrap()
    .build(std::iter::empty::<(OsString, OsString)>(), &values)
    .unwrap();
    let request = BoundedProcessRequestV1 {
        executable: executable.to_owned(),
        arguments,
        working_directory: fixture.0.clone(),
        environment,
        stdin: input,
    };
    run_bounded_process_capturing_stdout_with_cancellation(
        &request,
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            maximum_stdin_bytes: 16 * 1024 * 1024,
            maximum_stdout_bytes: 4 * 1024 * 1024,
            maximum_stderr_bytes: 1024 * 1024,
            maximum_tail_bytes: 65_536,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2_000,
            ..ProcessLimitsV1::default()
        },
        cancelled,
    )
    .unwrap()
}
fn native(
    fixture: &Fixture,
    bytes: Vec<u8>,
    cancelled: &AtomicBool,
) -> CapturedBoundedProcessResultV1 {
    run(
        fixture,
        &fixture.1,
        vec!["__hepta_internal_retirement_python_ast_v1".into()],
        Some(bytes),
        cancelled,
    )
}
fn exited(result: &CapturedBoundedProcessResultV1, code: i32) {
    assert_eq!(
        result.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(
        result.process.exit_code,
        Some(code),
        "{}",
        String::from_utf8_lossy(&result.process.stderr_tail)
    );
    assert_eq!(result.process.signal, None);
    assert!(result.process.process_group_cleanup_verified);
    assert!(!result.process.stderr_truncated);
    assert_eq!(result.process.stdout_bytes, result.stdout.len() as u64);
}

#[test]
fn actual_worker_matches_75_same_input_ast_values_from_five_independent_original_oracles() {
    let fixture = Fixture::new();
    let corpus: Value =
        serde_json::from_str(include_str!("native_python_ast_worker/corpus-v1.json")).unwrap();
    let rows = corpus["cases"].as_array().unwrap();
    assert_eq!(rows.len(), 75);
    let mut cases = Vec::new();
    let mut files = Vec::new();
    let mut groups: BTreeMap<String, Vec<(usize, PathBuf)>> = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        let path = fixture.0.join(format!("source-{index}.py"));
        let source = row["request"]["source"].as_str().unwrap().as_bytes();
        fs::write(&path, source).unwrap();
        files.push((path.clone(), source.to_vec()));
        let mut case = row["request"].clone();
        case["sourcePath"] = json!(path);
        groups
            .entry(case["profile"].as_str().unwrap().to_owned())
            .or_default()
            .push((index, path));
        cases.push(case);
    }
    let request = serde_json::to_vec(
        &json!({"version":1,"kind":"NativePythonRetirementAstBatchRequest","cases":cases}),
    )
    .unwrap();
    let actual = native(&fixture, request, &AtomicBool::new(false));
    exited(&actual, 0);
    let actual: Value = serde_json::from_slice(&actual.stdout).unwrap();
    assert_eq!(actual["caseCount"], 75);
    assert_eq!(actual["parser"]["name"], "rustpython-parser");
    assert_eq!(actual["parser"]["version"], "0.4.0");
    for field in [
        "sourceExecuted",
        "productPythonDelegationPerformed",
        "fullRustProductImplementationClaimed",
    ] {
        assert_eq!(actual[field], false);
    }
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let python = fs::canonicalize("/usr/bin/python3").unwrap();
    for (profile, suite, sha) in [
        (
            "build_package_v1",
            "p1-build-package-retirements",
            "412e96088e2160068df2d8ef239fd930b9ab5c75b034518edcbce05003abeadd",
        ),
        (
            "referee_revise_v1",
            "p1-referee-revise-retirements",
            "63a2666c2c2d5f8887596a11b81b009bb5434de3ab359cdfff3c22ed8fd5467f",
        ),
        (
            "research_verify_v1",
            "p1-research-verify-retirements",
            "c8dd3c9205f94c90e65b4779f5848c449d287e01a676943182431cf27326adda",
        ),
        (
            "submission_v1",
            "p1-submission-boundaries",
            "47ae1829163c5e99e1d6bb84d96c68e9e9d8fe74662ee127dc60544a1cd2222a",
        ),
        (
            "venue_resolve_v1",
            "p1-venue-resolve-retirements",
            "6846f412f1ffa598ef414a81ae1339a38fe66186421a87f846cc380b660f1da5",
        ),
    ] {
        let source_path = workspace.join(format!("migration/tests/{suite}.mjs"));
        let raw = fs::read(&source_path).unwrap();
        let text = std::str::from_utf8(&raw).unwrap();
        let marker = "const pythonAudit = String.raw`";
        assert_eq!(text.matches(marker).count(), 1);
        let script = text
            .split_once(marker)
            .unwrap()
            .1
            .split_once("`;")
            .unwrap()
            .0;
        assert_eq!(format!("{:x}", Sha256::digest(script.as_bytes())), sha);
        let inputs = &groups[profile];
        assert_eq!(inputs.len(), 15);
        let mut arguments = vec!["-c".into(), script.into()];
        arguments.extend(inputs.iter().map(|(_, path)| path.clone().into_os_string()));
        let oracle = run(&fixture, &python, arguments, None, &AtomicBool::new(false));
        exited(&oracle, 0);
        let expected: Vec<Value> = serde_json::from_slice(&oracle.stdout).unwrap();
        assert_eq!(expected.len(), inputs.len());
        for ((index, _), audit) in inputs.iter().zip(expected) {
            assert_eq!(actual["audits"][*index], audit, "{}", rows[*index]["id"]);
        }
        assert_eq!(fs::read(source_path).unwrap(), raw);
    }
    for (path, bytes) in files {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn actual_worker_refusal_and_running_cancellation_close_existing_process_group() {
    let fixture = Fixture::new();
    for input in [
        json!({"version":1,"kind":"NativePythonRetirementAstBatchRequest","cases":[],"callerAcceptedCaseCount":245}),
        json!({"version":1,"kind":"NativePythonRetirementAstBatchRequest","cases":[{"version":1,"kind":"NativePythonRetirementAstRequest","profile":"build_package_v1","source":"broken ="}]}),
    ] {
        let result = native(
            &fixture,
            serde_json::to_vec(&input).unwrap(),
            &AtomicBool::new(false),
        );
        exited(&result, 1);
        assert!(result.stdout.is_empty());
    }
    let case = json!({"version":1,"kind":"NativePythonRetirementAstRequest","profile":"build_package_v1","source":"pass\n".repeat(10_000)});
    let input = serde_json::to_vec(
        &json!({"version":1,"kind":"NativePythonRetirementAstBatchRequest","cases":vec![case;100]}),
    )
    .unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancelled);
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        flag.store(true, Ordering::Release);
    });
    let result = native(&fixture, input, &cancelled);
    thread.join().unwrap();
    assert_eq!(
        result.process.termination_reason,
        ProcessTerminationReason::Cancelled
    );
    assert!(result.process.process_group_cleanup_verified);
    assert!(result.stdout.is_empty());
}
