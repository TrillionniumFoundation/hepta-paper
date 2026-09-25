use hepta_legacy_compatibility::{production_hash_record_v1, qualify_production_node_profile_v1};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const EXISTING_ROLES: &[&str] = &[
    "external-qualification",
    "native-store",
    "resident-instance",
    "submission-handoff",
    "supervisor-state",
];
const MISSING_ROLES: &[&str] = &[
    "full-research-qualification-publication",
    "machine-intake",
    "runtime-reproducibility-publication",
    "runtime-reproducibility-refresh",
    "topic-producer",
];

struct Fixture {
    root: PathBuf,
    runtime: PathBuf,
    rescue: PathBuf,
    machine: PathBuf,
    topic: PathBuf,
    dataset: PathBuf,
    quiescence: PathBuf,
    empty_bin: PathBuf,
    manifest: Value,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).unwrap();
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "hepta-native-provision-test-partial-root-{label}-{}",
                hex::encode(nonce)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let repository = repository_root();
        let output = Command::new("node")
            .arg(repository.join("rust/oracle/partial-root-v1.mjs"))
            .arg(json!({"root": root}).to_string())
            .env("LANG", "en_US.UTF-8")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "fixture oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        qualify_production_node_profile_v1(&response["profile"]).unwrap();
        let value = &response["value"];
        let empty_bin = root.join("empty-bin");
        fs::create_dir(&empty_bin).unwrap();
        fs::set_permissions(&empty_bin, fs::Permissions::from_mode(0o700)).unwrap();
        let manifest: Value = serde_json::from_slice(
            &fs::read(
                repository.join("paper-core/config/autonomous-research-state-databases.v1.json"),
            )
            .unwrap(),
        )
        .unwrap();
        Self {
            root: root.clone(),
            runtime: PathBuf::from(value["runtimeRoot"].as_str().unwrap()),
            rescue: PathBuf::from(value["rescueRoot"].as_str().unwrap()),
            machine: PathBuf::from(value["machine"].as_str().unwrap()),
            topic: PathBuf::from(value["topic"].as_str().unwrap()),
            dataset: PathBuf::from(value["datasets"].as_str().unwrap()),
            quiescence: PathBuf::from(value["quiescence"].as_str().unwrap()),
            empty_bin,
            manifest,
        }
    }

    fn base_args(&self) -> Vec<String> {
        vec![
            "autonomous-state-partial-root-maintenance".into(),
            "--runtime-root".into(),
            self.runtime.display().to_string(),
            "--rescue-root".into(),
            self.rescue.display().to_string(),
            "--writer-quiescence-receipt".into(),
            self.quiescence.display().to_string(),
            "--machine-intake-config".into(),
            self.machine.display().to_string(),
            "--topic-producer-profile".into(),
            self.topic.display().to_string(),
            "--dataset-root".into(),
            self.dataset.display().to_string(),
            "--runtime-reproducibility-maximum-attempts-per-epoch".into(),
            "2".into(),
            "--runtime-reproducibility-maximum-cost-usd-per-epoch".into(),
            "1".into(),
        ]
    }

    fn plan(&self) -> Value {
        let mut args = self.base_args();
        args.extend(["--action".into(), "plan".into()]);
        let output = self.run(&args, None);
        assert!(
            output.status.success(),
            "plan failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn execute(&self, plan_id: &str, crash_at: Option<&str>) -> Output {
        let mut args = self.base_args();
        args.extend([
            "--action".into(),
            "execute".into(),
            "--maintenance-plan-id".into(),
            plan_id.into(),
            "--execute".into(),
        ]);
        self.run(&args, crash_at)
    }

    fn run(&self, args: &[String], crash_at: Option<&str>) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
        command.args(args).env("PATH", &self.empty_bin);
        if let Some(point) = crash_at {
            command.env("HEPTA_PARTIAL_ROOT_TEST_CRASH_AT", point);
        } else {
            command.env_remove("HEPTA_PARTIAL_ROOT_TEST_CRASH_AT");
        }
        command.output().unwrap()
    }

    fn role_path(&self, role: &str) -> PathBuf {
        let row = self.manifest["databases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["role"] == role)
            .unwrap();
        self.runtime.join(row["relativePath"].as_str().unwrap())
    }

    fn existing_hashes(&self) -> BTreeMap<String, String> {
        EXISTING_ROLES
            .iter()
            .map(|role| ((*role).to_owned(), hash_file(&self.role_path(role))))
            .collect()
    }

    fn assert_missing_absent(&self) {
        for role in MISSING_ROLES {
            assert!(
                !self.role_path(role).exists(),
                "unexpected repaired target remains for {role}"
            );
        }
    }

    fn renew_quiescence(&self) {
        let mut receipt: Value =
            serde_json::from_slice(&fs::read(&self.quiescence).unwrap()).unwrap();
        receipt["observedAt"] = json!("2020-01-01T00:00:00.000Z");
        receipt["expiresAt"] = json!("2999-01-01T00:00:00.000Z");
        let payload = json!({
            "version": receipt["version"],
            "kind": receipt["kind"],
            "status": receipt["status"],
            "runtimeRoot": receipt["runtimeRoot"],
            "databaseScopeHash": receipt["databaseScopeHash"],
            "writerManifestHash": receipt["writerManifestHash"],
            "quiescedWriterServices": receipt["quiescedWriterServices"],
            "activeWriterProcessIds": receipt["activeWriterProcessIds"],
            "serviceInspectionComplete": receipt["serviceInspectionComplete"],
            "processInspectionComplete": receipt["processInspectionComplete"],
            "observedAt": receipt["observedAt"],
            "expiresAt": receipt["expiresAt"],
        });
        receipt["receiptHash"] = json!(
            production_hash_record_v1(
                "AutonomousResearchStatePartialRootWriterQuiescenceReceipt",
                &payload,
            )
            .unwrap()
            .as_str()
        );
        fs::write(&self.quiescence, serde_json::to_vec(&receipt).unwrap()).unwrap();
        fs::set_permissions(&self.quiescence, fs::Permissions::from_mode(0o600)).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

fn hash_file(path: &Path) -> String {
    format!("sha256:{:x}", Sha256::digest(fs::read(path).unwrap()))
}

fn parse_success(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "command failed status={:?}: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn real_five_plus_five_repair_runs_without_node_and_preserves_existing_business_bytes() {
    let fixture = Fixture::new("success");
    let before = fixture.existing_hashes();
    let plan = fixture.plan();
    assert_eq!(plan["ready"], true);
    let plan_id = plan["maintenancePlanId"].as_str().unwrap();

    let receipt = parse_success(&fixture.execute(plan_id, None));
    assert_eq!(receipt["ready"], true);
    assert_eq!(
        receipt["status"],
        "autonomous_research_state_partial_root_business_repair_complete"
    );
    assert_eq!(receipt["maintenancePlanId"], plan_id);
    assert_eq!(receipt["installedRoles"], json!(MISSING_ROLES));
    assert_eq!(receipt["businessStateAndRowsPreserved"], true);
    assert_eq!(receipt["unscopedExistingDatabaseBytesPreserved"], true);
    assert_eq!(receipt["externalAuthorityInvoked"], false);
    assert_eq!(receipt["productionActivation"], false);
    assert_eq!(receipt["nodeRetirement"], false);

    for role in MISSING_ROLES {
        assert!(
            fixture.role_path(role).is_file(),
            "missing repaired role {role}"
        );
    }
    for role in EXISTING_ROLES {
        if *role != "supervisor-state" {
            assert_eq!(
                hash_file(&fixture.role_path(role)),
                before[*role],
                "unscoped existing database changed: {role}"
            );
        }
    }

    let replay = parse_success(&fixture.execute(plan_id, None));
    assert_eq!(
        replay, receipt,
        "terminal replay must be byte-semantic exact"
    );
}

#[test]
fn target_appearance_after_plan_fails_before_rescue_or_existing_mutation() {
    let fixture = Fixture::new("target-race");
    let before = fixture.existing_hashes();
    let plan = fixture.plan();
    let plan_id = plan["maintenancePlanId"].as_str().unwrap();
    let target = fixture.role_path(MISSING_ROLES[0]);
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, b"foreign").unwrap();

    let output = fixture.execute(plan_id, None);
    assert!(!output.status.success());
    assert!(fs::read_dir(&fixture.rescue).unwrap().next().is_none());
    for role in EXISTING_ROLES {
        assert_eq!(hash_file(&fixture.role_path(role)), before[*role]);
    }
    assert_eq!(fs::read(&target).unwrap(), b"foreign");
}

#[test]
fn precommit_crash_rolls_back_owned_publication_and_fresh_fence_retries_once() {
    let fixture = Fixture::new("precommit-crash");
    let before = fixture.existing_hashes();
    let first_plan = fixture.plan();
    let first_id = first_plan["maintenancePlanId"].as_str().unwrap().to_owned();

    let crashed = fixture.execute(&first_id, Some("after_first_publish"));
    assert!(
        !crashed.status.success(),
        "crash cut must not report success"
    );

    let rollback = fixture.execute(&first_id, None);
    assert_eq!(rollback.status.code(), Some(2));
    let rollback: Value = serde_json::from_slice(&rollback.stdout).unwrap();
    assert_eq!(
        rollback["status"],
        "autonomous_research_state_partial_root_interruption_rolled_back"
    );
    assert_eq!(rollback["ready"], false);
    assert_eq!(rollback["interruptedAttemptRolledBack"], true);
    assert_eq!(rollback["retryRequiresFreshPlan"], true);
    fixture.assert_missing_absent();
    for role in EXISTING_ROLES {
        assert_eq!(hash_file(&fixture.role_path(role)), before[*role]);
    }

    fixture.renew_quiescence();
    let second_plan = fixture.plan();
    let second_id = second_plan["maintenancePlanId"].as_str().unwrap();
    assert_ne!(second_id, first_id);
    let success = parse_success(&fixture.execute(second_id, None));
    assert_eq!(success["ready"], true);
    assert_eq!(
        success["status"],
        "autonomous_research_state_partial_root_business_repair_complete"
    );
}

#[test]
fn crash_after_supervisor_commit_recovers_success_without_duplicate_writes() {
    let fixture = Fixture::new("postcommit-crash");
    let plan = fixture.plan();
    let plan_id = plan["maintenancePlanId"].as_str().unwrap();

    let crashed = fixture.execute(plan_id, Some("after_supervisor_commit"));
    assert!(!crashed.status.success());

    let recovered = parse_success(&fixture.execute(plan_id, None));
    assert_eq!(recovered["ready"], true);
    assert_eq!(
        recovered["status"],
        "autonomous_research_state_partial_root_business_repair_complete"
    );
    let replay = parse_success(&fixture.execute(plan_id, None));
    assert_eq!(replay, recovered);
}

#[test]
fn crash_after_terminal_replays_the_persisted_success_receipt() {
    let fixture = Fixture::new("terminal-crash");
    let plan = fixture.plan();
    let plan_id = plan["maintenancePlanId"].as_str().unwrap();

    let crashed = fixture.execute(plan_id, Some("after_terminal"));
    assert!(!crashed.status.success());

    let recovered = parse_success(&fixture.execute(plan_id, None));
    let replay = parse_success(&fixture.execute(plan_id, None));
    assert_eq!(recovered["ready"], true);
    assert_eq!(replay, recovered);
}
