//! Actual incumbent resident composition over actual private configuration and
//! repositories. Signed fixtures are synthetic local evidence, never independent
//! qualification or proof that runtime/recovery prerequisites have been met.
#[allow(dead_code)]
mod machine_intake_support;
use hepta_paper_service::resident_prerequisites::{
    ResidentPrerequisiteInspectionOptions,
    inspect_autonomous_research_resident_prerequisites_v1 as inspect,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
const NOW: i64 = 1_790_035_200_000;
const EVIDENCE: &str = "synthetic_local_resident_signature_and_storage_fixture_no_executed_qualification_or_independent_acceptance";
const RUNTIME: &str = "autonomous_research_runtime_reproducibility_receipt_not_current";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    environment: BTreeMap<String, String>,
    recovery: Option<PathBuf>,
    initial: Value,
    renewal_before: Option<Value>,
    now: i64,
}
impl Fixture {
    fn new(scenario: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-resident-prerequisite-parity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            root.join(".owned-resident-prerequisites-fixture"),
            "owned synthetic resident prerequisites fixture\n",
        )
        .unwrap();
        let value = oracle(
            &json!({"action":"setup","root":root,"scenario":scenario}),
            &root,
        );
        assert_eq!(value["evidenceScope"], EVIDENCE);
        Self {
            root,
            environment: serde_json::from_value(value["environment"].clone()).unwrap(),
            recovery: value["recoveryConfigPath"].as_str().map(PathBuf::from),
            initial: value["inspection"].clone(),
            renewal_before: (!value["renewalBefore"].is_null())
                .then(|| value["renewalBefore"].clone()),
            now: value["nowMillis"].as_i64().unwrap(),
        }
    }
    fn config(&self) -> PathBuf {
        self.root.join("configuration.json")
    }
    fn compare(&self, label: &str) -> Value {
        self.compare_at(self.now, Some(&self.config()), &self.environment, label)
    }
    fn compare_at(
        &self,
        now: i64,
        configuration: Option<&Path>,
        environment: &BTreeMap<String, String>,
        label: &str,
    ) -> Value {
        let expected = oracle(
            &json!({"action":"inspect","root":self.root,"nowMillis":now,"configPath":configuration,"environment":environment}),
            &self.root,
        );
        let before = snapshot(&self.root);
        let actual = inspect(&ResidentPrerequisiteInspectionOptions {
            runtime_root: &self.root,
            repository_root: &repository(),
            working_directory: &self.root,
            environment,
            external_qualification_config: configuration,
            external_action_recovery_config: self.recovery.as_deref(),
            now_millis: now,
        })
        .expect("supported actual source observation");
        assert_eq!(
            actual, expected["inspection"],
            "complete report/order/hash: {label}"
        );
        assert_eq!(snapshot(&self.root), before, "source mutation: {label}");
        assert!(
            !self.root.join("executed-marker").exists(),
            "no qualifier/verifier process"
        );
        for flag in [
            "ready",
            "externalActionPerformed",
            "networkActionPerformed",
            "providerCanaryPerformed",
            "releaseSignerChallengePerformed",
        ] {
            assert_eq!(actual[flag], false, "{label}: {flag}");
        }
        actual
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}
fn oracle(input: &Value, root: &Path) -> Value {
    let encoded = serde_json::to_string(input).unwrap();
    assert!(encoded.len() < 64 * 1024);
    let mut command = Command::new("node");
    command
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../oracle/resident-prerequisites-v1.mjs"),
        )
        .arg(encoded)
        .current_dir(root)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").expect("qualified Node"))
        .env("LANG", "en_US.UTF-8");
    let output = machine_intake_support::run(&mut command);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&output["profile"]).unwrap();
    output["value"].clone()
}
fn snapshot(root: &Path) -> Vec<Value> {
    fn visit(path: &Path, rows: &mut Vec<Value>) {
        let m = fs::symlink_metadata(path).unwrap();
        let content = if m.file_type().is_symlink() {
            json!(fs::read_link(path).unwrap())
        } else if m.is_file() {
            json!(hex::encode(Sha256::digest(fs::read(path).unwrap())))
        } else {
            Value::Null
        };
        rows.push(json!({"path":path,"dev":m.dev(),"ino":m.ino(),"uid":m.uid(),"gid":m.gid(),"nlink":m.nlink(),"mode":m.mode(),"size":m.size(),"mtime":m.mtime(),"mtimeNsec":m.mtime_nsec(),"ctime":m.ctime(),"ctimeNsec":m.ctime_nsec(),"content":content}));
        if m.is_dir() {
            let mut paths = fs::read_dir(path)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect::<Vec<_>>();
            paths.sort();
            for path in paths {
                visit(&path, rows);
            }
        }
    }
    let mut rows = Vec::new();
    visit(root, &mut rows);
    rows
}
fn qualification_blockers(value: &Value, expected: &[&str]) {
    assert_eq!(value["globalQualificationBlockers"], json!(expected));
}
#[test]
fn actual_active_signature_storage_and_code_bind_without_inventing_overall_readiness() {
    let fixture = Fixture::new("valid-signed");
    let value = fixture.compare("genuine active signature");
    assert_eq!(value, fixture.initial);
    qualification_blockers(&value, &[RUNTIME]);
    assert_eq!(value["operationMode"], "blocked");
    assert_eq!(value["infrastructureReady"], false);
    assert_eq!(
        value["infrastructureBlockers"],
        json!([
            "autonomous_research_runtime_reproducibility_configuration_not_ready",
            "autonomous_research_supervisor_external_action_recovery_configuration_required"
        ])
    );
}
#[test]
fn actual_signatures_cover_extra_fields_and_node_base64_transports() {
    for scenario in [
        "extra-signed-field",
        "unicode-signature",
        "permissive-signature",
    ] {
        let fixture = Fixture::new(scenario);
        qualification_blockers(&fixture.compare(scenario), &[RUNTIME]);
    }
}
#[test]
fn bad_signature_and_genuinely_signed_retiring_key_fail_the_active_signer_contract() {
    for scenario in ["bad-signature", "retiring-signer"] {
        let fixture = Fixture::new(scenario);
        qualification_blockers(
            &fixture.compare(scenario),
            &[
                "autonomous_research_full_qualification_signature_or_trust_mismatch",
                RUNTIME,
            ],
        );
    }
}
#[test]
fn actual_receipt_time_boundaries_and_code_mismatch_match_separate_original_inspection() {
    for scenario in ["expired", "future"] {
        let fixture = Fixture::new(scenario);
        qualification_blockers(
            &fixture.compare(scenario),
            &[
                "autonomous_research_full_qualification_receipt_not_current",
                RUNTIME,
            ],
        );
    }
    let fixture = Fixture::new("valid-signed");
    qualification_blockers(
        &fixture.compare_at(
            NOW + 3_599_999,
            Some(&fixture.config()),
            &fixture.environment,
            "before exact expiry",
        ),
        &[RUNTIME],
    );
    qualification_blockers(
        &fixture.compare_at(
            NOW + 3_600_000,
            Some(&fixture.config()),
            &fixture.environment,
            "exact expiry",
        ),
        &[
            "autonomous_research_full_qualification_receipt_not_current",
            RUNTIME,
        ],
    );
    let fixture = Fixture::new("code-drift");
    qualification_blockers(
        &fixture.compare("properly resigned different code identity"),
        &[
            "autonomous_research_full_qualification_code_identity_mismatch",
            RUNTIME,
        ],
    );
}
#[test]
fn actual_stored_configuration_and_cost_bindings_are_checked_beyond_reader_validity() {
    for scenario in ["state-config-drift", "state-cost-drift"] {
        let fixture = Fixture::new(scenario);
        qualification_blockers(
            &fixture.compare(scenario),
            &[
                "autonomous_research_full_qualification_state_configuration_drift",
                RUNTIME,
            ],
        );
    }
}
#[test]
fn resident_shape_checks_are_stricter_than_bound_pointer_storage_and_signed_bytes() {
    for scenario in ["wrong-kind", "no-external-action"] {
        let fixture = Fixture::new(scenario);
        qualification_blockers(
            &fixture.compare(scenario),
            &[
                "autonomous_research_full_qualification_pointer_not_ready",
                RUNTIME,
            ],
        );
    }
    let fixture = Fixture::new("missing-pointer");
    let value = fixture.compare("actual pointer absence");
    assert!(
        value["globalQualificationBlockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "autonomous_research_full_qualification_pointer_not_ready")
    );
    assert!(
        !fixture
            .root
            .join("autonomous-research/qualification")
            .exists(),
        "reader must not provision missing storage"
    );
}
#[test]
fn real_recovery_configuration_identity_is_composed_while_capability_stays_blocked() {
    let fixture = Fixture::new("configured-recovery");
    let value = fixture.compare("actual configured recovery");
    qualification_blockers(&value, &[RUNTIME]);
    assert!(
        value["externalActionRecoveryConfigurationIdentityHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(
        value["infrastructureBlockers"],
        json!([
            "autonomous_research_runtime_reproducibility_configuration_not_ready",
            "autonomous_research_supervisor_external_action_recovery_capability_not_verified"
        ])
    );
}
#[test]
fn actual_source_configuration_failures_preserve_blocker_order_and_identity_changes() {
    let fixture = Fixture::new("valid-signed");
    let mut environment = fixture.environment.clone();
    environment.insert(
        "FIXTURE_ALLOWED".into(),
        "changed source observation".into(),
    );
    let changed = fixture.compare_at(
        NOW,
        Some(&fixture.config()),
        &environment,
        "current credential environment drift",
    );
    assert_ne!(
        changed["autonomousResearchResidentPrerequisiteIdentityHash"],
        fixture.initial["autonomousResearchResidentPrerequisiteIdentityHash"]
    );
    assert!(
        changed["globalQualificationBlockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "autonomous_research_full_qualification_state_configuration_drift")
    );
    let absent = fixture.compare_at(
        NOW,
        None,
        &BTreeMap::new(),
        "actual missing configuration with stored receipt",
    );
    assert_eq!(
        absent["infrastructureBlockers"][0],
        "external_qualification_configuration_path_required"
    );
}

#[test]
fn real_signed_receipt_renewal_preserves_infrastructure_identity_and_changes_receipt_hash() {
    let fixture = Fixture::new("renewed-receipt");
    let value = fixture.compare("second real signed publication and CAS generation");
    qualification_blockers(&value, &[RUNTIME]);
    let before = fixture
        .renewal_before
        .as_ref()
        .expect("actual first composition before renewal");
    assert_eq!(
        value["autonomousResearchResidentPrerequisiteIdentityHash"],
        before["autonomousResearchResidentPrerequisiteIdentityHash"]
    );
    assert_ne!(
        value["autonomousResearchResidentPrerequisiteReceiptHash"],
        before["autonomousResearchResidentPrerequisiteReceiptHash"]
    );
    assert_ne!(
        value["fullResearchQualificationExpiresAt"],
        before["fullResearchQualificationExpiresAt"]
    );
}
#[test]
fn actual_storage_failure_precedes_generated_blockers_without_repairing_mirror() {
    let fixture = Fixture::new("valid-signed");
    let path = fixture
        .root
        .join("autonomous-research/qualification/qualification-receipt.json");
    let mut bytes = fs::read(&path).unwrap();
    bytes.push(b' ');
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&path, bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
    let value = fixture.compare("actual authority/mirror byte mismatch");
    let blockers = value["globalQualificationBlockers"].as_array().unwrap();
    assert!(blockers.len() > 6);
    assert_ne!(
        blockers[0],
        "autonomous_research_full_qualification_pointer_not_ready"
    );
    assert_eq!(
        blockers[1],
        "autonomous_research_full_qualification_pointer_not_ready"
    );
}
#[test]
fn explicit_native_clock_path_and_provenance_profiles_fail_without_source_mutation() {
    let fixture = Fixture::new("valid-signed");
    let before = snapshot(&fixture.root);
    let repository = repository();
    let path = fixture.config();
    let mut options = ResidentPrerequisiteInspectionOptions {
        runtime_root: &fixture.root,
        repository_root: &repository,
        working_directory: &fixture.root,
        environment: &fixture.environment,
        external_qualification_config: Some(&path),
        external_action_recovery_config: None,
        now_millis: i64::MAX,
    };
    assert_eq!(
        inspect(&options).unwrap_err().code(),
        "autonomous_research_resident_clock_profile_unsupported"
    );
    options.now_millis = NOW;
    options.working_directory = Path::new("relative");
    assert_eq!(
        inspect(&options).unwrap_err().code(),
        "autonomous_research_resident_path_profile_unsupported"
    );
    options.working_directory = &fixture.root;
    let mut environment = fixture.environment.clone();
    environment.insert(
        "HEPTA_RELEASE_COMMIT".into(),
        "owned-release-override".into(),
    );
    options.environment = &environment;
    assert_eq!(
        inspect(&options).unwrap_err().code(),
        "autonomous_research_resident_release_commit_profile_unsupported"
    );
    let mut environment = fixture.environment.clone();
    environment.insert(
        "HEPTA_RELEASE_ENV_LAUNCHER".into(),
        "owned-unsupported-profile".into(),
    );
    options.environment = &environment;
    assert_eq!(
        inspect(&options).unwrap_err().code(),
        "autonomous_research_resident_provenance_environment_profile_unsupported"
    );
    assert_eq!(snapshot(&fixture.root), before);
    assert!(!fixture.root.join("executed-marker").exists());
}
