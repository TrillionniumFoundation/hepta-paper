use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    runtime: PathBuf,
    assets: PathBuf,
}
fn git(root: &Path, args: &[&str]) {
    let env = BTreeMap::from([
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        ("HOME".to_owned(), root.to_str().unwrap().to_owned()),
        ("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned()),
    ]);
    let policy = EnvironmentPolicyV1::new("trust-unit-git", env.keys().cloned(), ["PATH"]).unwrap();
    let req = BoundedProcessRequestV1 {
        executable: "/usr/bin/git".into(),
        arguments: args.iter().map(OsString::from).collect(),
        working_directory: root.to_owned(),
        environment: policy
            .build(std::iter::empty::<(OsString, OsString)>(), &env)
            .unwrap(),
        stdin: None,
    };
    let result = run_bounded_process_capturing_stdout_with_cancellation(
        &req,
        ProcessLimitsV1 {
            timeout_ms: 30_000,
            maximum_stdout_bytes: 2 * 1024 * 1024,
            maximum_stderr_bytes: 2 * 1024 * 1024,
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
        "{:?}",
        result.process.stderr_tail
    );
    assert!(result.process.process_group_cleanup_verified);
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "hepta-trust-controls-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let f = Self {
            root: base.join("workspace"),
            runtime: base.join("runtime"),
            assets: base.join("assets"),
        };
        fs::create_dir_all(&f.root).unwrap();
        fs::create_dir_all(&f.runtime).unwrap();
        fs::create_dir_all(&f.assets).unwrap();
        fs::write(
            f.root.join("package.json"),
            r#"{"name":"hepta-paper","version":"0.1.0"}"#,
        )
        .unwrap();
        for (_, target) in super::super::OPERATIONAL_CAPABILITIES_V1 {
            let p = f.root.join(target);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, "// local integrity fixture\n").unwrap();
        }
        // Zero bytes are a valid source hash input (unlike imported JSON).
        fs::write(f.root.join("test.mjs"), "").unwrap();
        git(&f.root, &["init"]);
        git(
            &f.root,
            &["config", "user.email", "fixture@example.invalid"],
        );
        git(&f.root, &["config", "user.name", "Local fixture"]);
        git(&f.root, &["add", "."]);
        git(&f.root, &["commit", "-m", "Local observed source fixture"]);
        let current = super::super::current_operational_code_provenance_v1(&f.root).unwrap();
        assert!(conformance::provenance_valid(&current), "{current}");
        assert_eq!(current["treeDirty"], false, "{current}");
        let ph = record_hash("CapabilityVerificationCodeProvenance", &current).unwrap();
        let receipts=super::super::OPERATIONAL_CAPABILITIES_V1.iter().map(|(id,target)|{
      let mut value=json!({"version":2,"kind":"CapabilityVerificationReceipt","capabilityId":id,"status":"capability_implementation_verified","codeProvenance":current,"codeProvenanceHash":ph,"test":{"path":"test.mjs","sha256":super::super::hash(b""),"result":"passed"},"targets":[{"path":target,"sha256":super::super::hash(&fs::read(f.root.join(target)).unwrap())}]});
      value["capabilityVerificationReceiptHash"]=record_hash("CapabilityVerificationReceipt",&value).unwrap().into();value
    }).collect::<Vec<_>>();
        let mut manifest = json!({"version":2,"kind":"CapabilityVerificationManifest","codeProvenance":current,"codeProvenanceHash":ph,"receipts":receipts});
        manifest["capabilityVerificationManifestHash"] =
            record_hash("CapabilityVerificationManifest", &manifest)
                .unwrap()
                .into();
        let production = f.production_source();
        fs::create_dir_all(production.parent().unwrap()).unwrap();
        fs::write(production, "Local source-bound subject.\n").unwrap();
        let file = f.manifest();
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, serde_json::to_vec(&manifest).unwrap()).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        f
    }
    fn production_source(&self) -> PathBuf {
        self.assets
            .join("submission/AoM/A_Theory_of__Expectations/main.tex")
    }
    fn manifest(&self) -> PathBuf {
        self.runtime
            .join("audits/capability-verification/CAPABILITY_VERIFICATION_MANIFEST.json")
    }
    fn inspect(&self, c: &AtomicBool, d: Instant, hook: impl FnOnce()) -> Result<Value> {
        inspect_with_final_check(&self.root, &self.runtime, &self.assets, c, d, hook)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.root.parent().unwrap());
    }
}
#[test]
fn ordinary_trust_terminal_material_source_cancellation_and_expiry_reject_with_fresh_retry() {
    let f = Fixture::new();
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    let first = f.inspect(&c, d, || {}).unwrap();
    assert_eq!(first["implementation"]["verified"], 16);
    assert_eq!(first["status"], "code_release_trust_layers_blocked");
    let production = fs::read(f.production_source()).unwrap();
    let error = f
        .inspect(&c, d, || {
            fs::write(f.production_source(), &production).unwrap();
        })
        .unwrap_err();
    assert!(error.to_string().contains("changed_after_read"), "{error}");
    assert_eq!(f.inspect(&c, d, || {}).unwrap(), first);
    let alias = f.root.parent().unwrap().join("assets-link");
    std::os::unix::fs::symlink(&f.assets, &alias).unwrap();
    assert_eq!(
        inspect_with_final_check(&f.root, &f.runtime, &alias, &c, d, || {}).unwrap(),
        first
    );
    let error = inspect_with_final_check(&f.root, &f.runtime, &alias, &c, d, || {
        fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&f.assets, &alias).unwrap();
    })
    .unwrap_err();
    assert!(
        error.to_string().contains("path_changed_after_read"),
        "{error}"
    );
    assert_eq!(
        inspect_with_final_check(&f.root, &f.runtime, &alias, &c, d, || {}).unwrap(),
        first
    );
    let original = fs::read(f.manifest()).unwrap();
    let error = f
        .inspect(&c, d, || {
            fs::write(f.manifest(), &original).unwrap();
        })
        .unwrap_err();
    assert!(error.to_string().contains("changed_after_read"), "{error}");
    assert_eq!(f.inspect(&c, d, || {}).unwrap(), first);
    let error = f
        .inspect(&c, d, || {
            fs::write(f.root.join("test.mjs"), "changed").unwrap();
        })
        .unwrap_err();
    assert!(error.to_string().contains("source_changed"), "{error}");
    fs::write(f.root.join("test.mjs"), "").unwrap();
    assert_eq!(f.inspect(&c, d, || {}).unwrap(), first);
    let error = f
        .inspect(&c, d, || c.store(true, Ordering::Release))
        .unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    c.store(false, Ordering::Release);
    assert_eq!(f.inspect(&c, d, || {}).unwrap(), first);
    let short = Instant::now() + Duration::from_secs(3);
    let error = f
        .inspect(&c, short, || {
            std::thread::sleep(
                short.saturating_duration_since(Instant::now()) + Duration::from_millis(50),
            )
        })
        .unwrap_err();
    assert!(error.to_string().contains("deadline"), "{error}");
    assert_eq!(
        f.inspect(&c, Instant::now() + Duration::from_secs(120), || {})
            .unwrap(),
        first
    );
}

#[test]
fn ordinary_trust_retained_report_rechecks_after_stdout_serialization() {
    let f = Fixture::new();
    let c = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(120);
    let baseline = f.inspect(&c, deadline, || {}).unwrap();
    let expected_wire =
        crate::release_trust_normal::serialize_observed_ordinary_release_trust_gate_for_test_v1(
            &baseline, &c,
        )
        .unwrap();
    let mut expected = serde_json::from_slice::<Value>(&expected_wire).unwrap();
    assert_eq!(expected, baseline);
    for drift in [
        "manifest",
        "production_source",
        "code_source",
        "cancel",
        "deadline",
    ] {
        let d = if drift == "deadline" {
            Instant::now() + Duration::from_secs(3)
        } else {
            Instant::now() + Duration::from_secs(120)
        };
        let observed = observe_ordinary_release_trust_gate_with_control_v1(
            &f.root, &f.runtime, &f.assets, &c, d,
        )
        .unwrap();
        assert_eq!(observed.report(), &baseline);
        let encoded = crate::release_trust_normal::serialize_observed_ordinary_release_trust_gate_for_test_v1(observed.report(), &c).unwrap();
        assert_eq!(encoded, expected_wire);
        let source = fs::read(f.production_source()).unwrap();
        let manifest = fs::read(f.manifest()).unwrap();
        match drift {
            "manifest" => fs::write(f.manifest(), &manifest).unwrap(),
            "production_source" => fs::write(f.production_source(), &source).unwrap(),
            "code_source" => {
                fs::write(f.root.join("test.mjs"), "actual source drift after stdout").unwrap()
            }
            "cancel" => c.store(true, Ordering::Release),
            "deadline" => std::thread::sleep(
                d.saturating_duration_since(Instant::now()) + Duration::from_millis(50),
            ),
            _ => unreachable!(),
        }
        let failure = observed.finish().unwrap_err().to_string();
        assert!(
            failure.contains("changed")
                || failure.contains("cancelled")
                || failure.contains("deadline"),
            "{drift}:{failure}"
        );
        if drift == "code_source" {
            fs::write(f.root.join("test.mjs"), "").unwrap();
        }
        c.store(false, Ordering::Release);
        let retry = observe_ordinary_release_trust_gate_with_control_v1(
            &f.root,
            &f.runtime,
            &f.assets,
            &c,
            Instant::now() + Duration::from_secs(120),
        )
        .unwrap();
        let wire = crate::release_trust_normal::serialize_observed_ordinary_release_trust_gate_for_test_v1(retry.report(), &c).unwrap();
        expected = retry.finish().unwrap();
        assert_eq!(expected, baseline);
        assert_eq!(wire, expected_wire);
    }
}
