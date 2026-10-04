//! Actual nullary Node/Rust reports use local synthetic integrity material.
//! Fixture roles are not live research/release/submission qualification.
use hepta_codex_runtime::{
    BoundedProcessRequestV1, CapturedBoundedProcessResultV1, EnvironmentPolicyV1, ProcessLimitsV1,
    ProcessTerminationReason, run_bounded_process_capturing_stdout_with_cancellation,
};
use hepta_paper_service::operational_status::inspect_ordinary_release_trust_gate_with_control_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn source() -> PathBuf {
    fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")).unwrap()
}
fn node() -> PathBuf {
    fs::canonicalize(std::env::var_os("HEPTA_TEST_NODE").expect("qualified Node")).unwrap()
}
fn run(
    exe: &Path,
    args: &[String],
    cwd: &Path,
    environment: BTreeMap<String, String>,
) -> CapturedBoundedProcessResultV1 {
    let policy = EnvironmentPolicyV1::new(
        "trust-normal-fixture-v1",
        environment.keys().cloned(),
        ["PATH"],
    )
    .unwrap();
    let request = BoundedProcessRequestV1 {
        executable: exe.to_owned(),
        arguments: args.iter().map(OsString::from).collect(),
        working_directory: cwd.to_owned(),
        environment: policy
            .build(std::iter::empty::<(OsString, OsString)>(), &environment)
            .unwrap(),
        stdin: None,
    };
    let output = run_bounded_process_capturing_stdout_with_cancellation(
        &request,
        ProcessLimitsV1 {
            timeout_ms: 30_000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2_000,
            maximum_stdin_bytes: 1,
            maximum_stdout_bytes: 2 * 1024 * 1024,
            maximum_stderr_bytes: 2 * 1024 * 1024,
            maximum_tail_bytes: 8 * 1024,
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
    output
}
fn base_env() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("LANG".into(), "C.UTF-8".into()),
    ])
}
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let result = Self(std::env::temp_dir().join(format!(
            "hepta-trust-normal-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )));
        let prepared = result.oracle("prepare", None, false, false);
        assert_eq!(prepared["node"], "v22.23.1");
        assert_eq!(prepared["realAuthorityCreated"], false);
        assert_eq!(prepared["closure"].as_array().unwrap().len(), 43);
        result
    }
    fn workspace(&self) -> PathBuf {
        self.0.join("workspace")
    }
    fn runtime(&self) -> PathBuf {
        self.0.join("hepta-paper-runtime/native-runtime")
    }
    fn assets(&self) -> PathBuf {
        self.0.join("hepta-paper-assets")
    }
    fn oracle(
        &self,
        operation: &str,
        mutate: Option<&str>,
        defaults: bool,
        relative: bool,
    ) -> Value {
        let request = json!({"root":self.0,"operation":operation,"mutate":mutate,"defaults":defaults,"relative":relative});
        let output = run(
            &node(),
            &[
                source()
                    .join("rust/oracle/release-trust-normal-v1.mjs")
                    .to_str()
                    .unwrap()
                    .into(),
                request.to_string(),
            ],
            &source(),
            base_env(),
        );
        assert_eq!(
            output.process.exit_code,
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.process.stderr_tail)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["node"], "v22.23.1");
        result
    }
    fn shipping(&self) -> PathBuf {
        let target = self.workspace().join("bin/hepta-paper-rust");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        let from = Path::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
        let before = fs::metadata(from).unwrap();
        let bytes = fs::read(from).unwrap();
        if target.exists() {
            let existing = fs::symlink_metadata(&target).unwrap();
            assert!(existing.is_file());
            assert_eq!(existing.mode() & 0o777, 0o555);
            assert_eq!(existing.nlink(), 1);
            assert_eq!(fs::read(&target).unwrap(), bytes);
        } else {
            fs::write(&target, &bytes).unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o555)).unwrap();
        }
        assert_eq!(fs::read(from).unwrap(), bytes);
        let after = fs::metadata(from).unwrap();
        assert_eq!(
            (
                before.dev(),
                before.ino(),
                before.mode(),
                before.mtime_nsec(),
                before.ctime_nsec()
            ),
            (
                after.dev(),
                after.ino(),
                after.mode(),
                after.mtime_nsec(),
                after.ctime_nsec()
            )
        );
        assert_ne!(before.ino(), fs::metadata(&target).unwrap().ino());
        target
    }
    fn native(
        &self,
        shipping: &Path,
        relative: bool,
        explicit: bool,
    ) -> CapturedBoundedProcessResultV1 {
        let mut environment = base_env();
        if relative {
            environment.insert(
                "HEPTA_PAPER_RUNTIME_ROOT".into(),
                "../hepta-paper-runtime/native-runtime".into(),
            );
            environment.insert(
                "HEPTA_PAPER_ASSET_ROOT".into(),
                "../hepta-paper-assets".into(),
            );
        }
        if explicit {
            environment.insert(
                "HEPTA_PAPER_WORKSPACE_ROOT".into(),
                self.workspace().to_str().unwrap().into(),
            );
        }
        run(
            shipping,
            &["verify".into(), "trust".into()],
            &self.0,
            environment,
        )
    }
    fn compare(&self, relative: bool, explicit: bool, ready: bool) {
        let expected = self.oracle("run", None, !relative, relative);
        assert_eq!(
            expected["exitCode"],
            if ready { 0 } else { 1 },
            "{expected}"
        );
        let shipping = self.shipping();
        let before = inventory(&self.0);
        let actual = self.native(&shipping, relative, explicit);
        assert_eq!(
            actual.process.exit_code,
            expected["exitCode"].as_i64().map(|v| v as i32),
            "{}",
            String::from_utf8_lossy(&actual.process.stderr_tail)
        );
        assert_eq!(
            actual.stdout,
            expected["stdout"].as_str().unwrap().as_bytes(),
            "{}",
            String::from_utf8_lossy(&actual.process.stderr_tail)
        );
        assert!(
            actual.process.stderr_tail.is_empty(),
            "{:?}",
            actual.process.stderr_tail
        );
        assert_eq!(
            inventory(&self.0),
            before,
            "ordinary trust changed fixture namespace/source/proofs"
        );
        let report: Value = serde_json::from_slice(&actual.stdout).unwrap();
        assert_eq!(
            report["releaseBoundConformance"]["productionEligible"],
            false
        );
        assert_eq!(
            report["independentProductionOperational"]["releaseBlocking"],
            false
        );
        assert_eq!(
            report["operationalProofCannotSubstituteForReleaseBoundConformance"],
            true
        );
    }
}
fn inventory(root: &Path) -> BTreeMap<PathBuf, Value> {
    fn collect(root: &Path, at: &Path, out: &mut BTreeMap<PathBuf, Value>) {
        let m = fs::symlink_metadata(at).unwrap();
        let bytes = if m.is_file() {
            format!("{:x}", Sha256::digest(fs::read(at).unwrap()))
        } else {
            String::new()
        };
        out.insert(
            at.strip_prefix(root).unwrap().to_owned(),
            json!([
                m.dev(),
                m.ino(),
                m.mode(),
                m.uid(),
                m.gid(),
                m.nlink(),
                m.len(),
                m.mtime(),
                m.mtime_nsec(),
                m.ctime(),
                m.ctime_nsec(),
                bytes
            ]),
        );
        if m.is_dir() {
            for entry in fs::read_dir(at).unwrap() {
                collect(root, &entry.unwrap().path(), out);
            }
        }
    }
    let mut result = BTreeMap::new();
    collect(root, root, &mut result);
    result
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn ordinary_trust_matches_current_three_layers_and_original_stdout() {
    let f = Fixture::new();
    f.compare(false, false, true);
    f.compare(true, false, true);
    f.compare(false, true, true);
    f.oracle("mutate", Some("missing_operational"), false, false);
    f.compare(false, false, true);
}
#[test]
fn ordinary_trust_imported_refusal_and_revocation_match_complete_node_gate() {
    for mutation in [
        "missing_manifest",
        "bad_manifest_hash",
        "bad_receipt_hash",
        "null_receipts",
        "zero_receipts",
        "string_receipts",
        "bad_test_result",
        "missing_test",
        "tamper_signature",
        "retired_key",
        "missing_trust",
        "bad_conformance",
        "historic_conformance",
        "dirty_source",
        "changed_production",
        "duplicate_implementation",
        "numeric_lexemes",
    ] {
        let f = Fixture::new();
        f.oracle("mutate", Some(mutation), false, false);
        f.compare(
            false,
            false,
            matches!(
                mutation,
                "tamper_signature" | "retired_key" | "duplicate_implementation" | "numeric_lexemes"
            ),
        );
    }
}
#[test]
fn ordinary_trust_arguments_unknown_copy_and_control_refuse_before_success() {
    let f = Fixture::new();
    let shipping = f.shipping();
    let mut args = vec!["verify".into(), "trust".into(), "--help".into()];
    let output = run(&shipping, &args, &f.0, base_env());
    assert_eq!(output.process.exit_code, Some(2));
    assert!(output.stdout.is_empty());
    let unknown = f.0.join("copy");
    fs::copy(&shipping, &unknown).unwrap();
    fs::set_permissions(&unknown, fs::Permissions::from_mode(0o555)).unwrap();
    args.truncate(2);
    let result = run(&unknown, &args, &f.0, base_env());
    assert_eq!(result.process.exit_code, Some(1));
    assert!(
        String::from_utf8_lossy(&result.process.stderr_tail)
            .contains("native_workspace_root_required")
    );
    let mut env = base_env();
    env.insert(
        "HEPTA_PAPER_WORKSPACE_ROOT".into(),
        f.workspace().to_str().unwrap().into(),
    );
    let expected = f.oracle("run", None, true, false);
    let result = run(&unknown, &args, &f.0, env);
    assert_eq!(
        result.stdout,
        expected["stdout"].as_str().unwrap().as_bytes(),
        "{}",
        String::from_utf8_lossy(&result.process.stderr_tail)
    );
    let before = inventory(&f.0);
    let cancelled = AtomicBool::new(true);
    assert!(
        inspect_ordinary_release_trust_gate_with_control_v1(
            &f.workspace(),
            &f.runtime(),
            &f.assets(),
            &cancelled,
            Instant::now() + Duration::from_secs(120)
        )
        .unwrap_err()
        .to_string()
        .contains("cancelled")
    );
    let cancelled = AtomicBool::new(false);
    assert!(
        inspect_ordinary_release_trust_gate_with_control_v1(
            &f.workspace(),
            &f.runtime(),
            &f.assets(),
            &cancelled,
            Instant::now() - Duration::from_millis(1)
        )
        .unwrap_err()
        .to_string()
        .contains("deadline")
    );
    assert_eq!(inventory(&f.0), before);
    let retried = inspect_ordinary_release_trust_gate_with_control_v1(
        &f.workspace(),
        &f.runtime(),
        &f.assets(),
        &cancelled,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap();
    assert_eq!(
        retried,
        serde_json::from_str::<Value>(expected["stdout"].as_str().unwrap()).unwrap()
    );
    let f2 = Fixture::new();
    f2.oracle("mutate", Some("unsafe_target"), false, false);
    let original = f2.oracle("run", None, true, false);
    assert_eq!(original["exitCode"], 1);
    let original: Value = serde_json::from_str(original["stdout"].as_str().unwrap()).unwrap();
    assert_eq!(original["status"], "code_release_trust_layers_blocked");
    let error = inspect_ordinary_release_trust_gate_with_control_v1(
        &f2.workspace(),
        &f2.runtime(),
        &f2.assets(),
        &cancelled,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap_err();
    assert!(error.to_string().contains("source_path_rejected"));
}
