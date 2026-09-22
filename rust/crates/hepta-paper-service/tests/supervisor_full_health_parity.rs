//! Actual original CLI comparison. Fixtures are owned synthetic data; no provider,
//! recovery command, acceptance principal or installed service is exercised.
mod machine_intake_support;
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    os::unix::{
        ffi::OsStringExt,
        fs::{MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    process::Command,
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
static NODE: OnceLock<PathBuf> = OnceLock::new();
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-full-health-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn node() -> &'static Path {
    NODE.get_or_init(|| {
        let mut command = Command::new("node");
        command.args(["--input-type=module","-e",
            "import {productionOracleProfile} from './rust/oracle/production-record-hash-v1.mjs'; process.stdout.write(JSON.stringify({profile:productionOracleProfile(),path:process.execPath}));"])
            .current_dir(repository()).env_clear().env("PATH",std::env::var_os("PATH").unwrap()).env("LANG","en_US.UTF-8");
        let result = machine_intake_support::run(&mut command);
        assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
        let value: Value = serde_json::from_slice(&result.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&value["profile"]).unwrap();
        PathBuf::from(value["path"].as_str().unwrap())
    })
}
fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}
fn environment() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("LANG".into(), "en_US.UTF-8".into()),
    ])
}
fn oracle(script: &str, input: Value, root: &Path) -> Value {
    let encoded = input.to_string();
    assert!(encoded.len() < 64 * 1024);
    let mut command = Command::new(node());
    command
        .arg(repository().join("rust/oracle").join(script))
        .arg(encoded)
        .current_dir(root)
        .env_clear()
        .envs(environment());
    let result = machine_intake_support::run(&mut command);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let value: Value = serde_json::from_slice(&result.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&value["profile"]).unwrap();
    value["value"].clone()
}
fn snapshot(root: &Path) -> Vec<Value> {
    fn visit(path: &Path, rows: &mut Vec<Value>) {
        let m = fs::symlink_metadata(path).unwrap();
        let content = if m.is_file() {
            json!(hex::encode(Sha256::digest(fs::read(path).unwrap())))
        } else if m.file_type().is_symlink() {
            json!(fs::read_link(path).unwrap())
        } else {
            Value::Null
        };
        rows.push(json!({"path":path,"dev":m.dev(),"ino":m.ino(),"uid":m.uid(),"gid":m.gid(),"nlink":m.nlink(),"mode":m.mode(),"size":m.size(),"mtime":m.mtime(),"mtimeNsec":m.mtime_nsec(),"ctime":m.ctime(),"ctimeNsec":m.ctime_nsec(),"content":content}));
        if m.is_dir() {
            let mut children = fs::read_dir(path)
                .unwrap()
                .map(|v| v.unwrap().path())
                .collect::<Vec<_>>();
            children.sort();
            for child in children {
                visit(&child, rows);
            }
        }
    }
    let mut rows = Vec::new();
    visit(root, &mut rows);
    rows
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap()
}
fn normalize(value: &mut Value, begin: i64, end: i64) {
    let report_time = value["inspectedAt"].as_str().unwrap();
    let parsed =
        hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis(
            report_time,
        )
        .expect("actual canonical CLI clock");
    assert!(
        begin <= parsed && parsed <= end,
        "actual observation clock outside command interval"
    );
    assert_eq!(value["residentPrerequisites"]["inspectedAt"], report_time);
    let mut payload = value["residentPrerequisites"].as_object().unwrap().clone();
    let digest = payload
        .remove("autonomousResearchResidentPrerequisiteReceiptHash")
        .unwrap();
    assert_eq!(
        digest,
        production_hash_record_v1(
            "AutonomousResearchResidentPrerequisiteReceipt",
            &Value::Object(payload)
        )
        .unwrap()
        .as_str(),
        "validate real own hash BEFORE normalizing independent command times"
    );
    if !value["strictMachineIntakeReconciliation"].is_null() {
        assert_eq!(
            value["strictMachineIntakeReconciliation"]["inspectedAt"],
            report_time
        );
    }
    value["inspectedAt"] = Value::Null;
    value["residentPrerequisites"]["inspectedAt"] = Value::Null;
    value["residentPrerequisites"]["autonomousResearchResidentPrerequisiteReceiptHash"] =
        Value::Null;
    if !value["strictMachineIntakeReconciliation"].is_null() {
        value["strictMachineIntakeReconciliation"]["inspectedAt"] = Value::Null;
    }
}
fn compare(root: &Path, env: &BTreeMap<String, String>, extra: &[&str]) -> Value {
    let mut original = Command::new(node());
    original.arg(repository().join("paper-core/bin/autonomous-research-supervisor-health.mjs"));
    let mut native = Command::new(env!("CARGO_BIN_EXE_hepta-autonomous-supervisor-health"));
    for command in [&mut original, &mut native] {
        command
            .current_dir(root)
            .env_clear()
            .envs(env)
            .arg("--runtime-root")
            .arg(root)
            .arg("--require-fully-autonomous")
            .args(extra);
    }
    let start = now();
    let expected = machine_intake_support::run(&mut original);
    let before = snapshot(root);
    let actual = machine_intake_support::run(&mut native);
    let end = now();
    assert_eq!(
        actual.status.code(),
        expected.status.code(),
        "native={} node={}",
        String::from_utf8_lossy(&actual.stderr),
        String::from_utf8_lossy(&expected.stderr)
    );
    assert_eq!(
        actual.status.code(),
        Some(2),
        "actual prerequisite blockers must affect process exit"
    );
    let mut expected: Value = serde_json::from_slice(&expected.stdout).unwrap();
    let mut actual: Value = serde_json::from_slice(&actual.stdout).unwrap();
    normalize(&mut expected, start, end);
    normalize(&mut actual, start, end);
    assert_eq!(
        actual, expected,
        "complete actual CLI report including blocker order and remaining hashes"
    );
    assert_eq!(
        snapshot(root),
        before,
        "native source bytes and metadata unchanged"
    );
    assert_eq!(actual["fullyAutonomousReady"], false);
    assert!(!root.join("executed-marker").exists());
    actual
}
#[test]
fn full_cli_empty_sources_match_actual_node_without_provisioning() {
    let fixture = Fixture::new();
    let report = compare(&fixture.0, &environment(), &[]);
    assert_eq!(report["currentMachineIntakeReady"], false);
    assert_eq!(report["residentPrerequisites"]["ready"], false);
    assert_eq!(report["autonomousStateSafetyReady"], false);
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
}
#[test]
fn full_cli_observes_real_intake_and_full_exit_wins_over_ready_strict_receipt() {
    for resident in [false, true] {
        let fixture = Fixture::new();
        let setup = machine_intake_support::oracle(
            &json!({"action":"intake","mode":"setup","runtimeRoot":fixture.0,"scenario":"ready"}),
            &fixture.0,
        );
        let strict = machine_intake_support::oracle(
            &json!({"action":"strict","mode":"publish","runtimeRoot":fixture.0,"environment":setup["environment"],"scenario":"ready"}),
            &fixture.0,
        );
        assert_eq!(
            strict["evidenceScope"],
            "actual_intake_and_original_receipt_data_contract_not_executed_cycle"
        );
        if resident {
            machine_intake_support::oracle(
                &json!({"action":"intake","mode":"resident","runtimeRoot":fixture.0,"configurationHash":setup["configuration"]["configurationHash"]}),
                &fixture.0,
            );
        }
        let mut env = environment();
        env.extend(
            serde_json::from_value::<BTreeMap<String, String>>(strict["environment"].clone())
                .unwrap(),
        );
        let report = compare(
            &fixture.0,
            &env,
            &[
                "--require-strict-machine-intake-reconciliation",
                "--require-current-machine-intake",
                "--require-machine-intake-reconciliation",
                "--require-startup-reconciliation",
            ],
        );
        assert_eq!(report["currentMachineIntakeReady"], resident);
        assert_eq!(report["strictMachineIntakeReconciliationReady"], true);
        assert_eq!(report["residentPrerequisiteIdentityCurrent"], false);
    }
}
#[test]
fn full_cli_uses_actual_v3_config_selection_and_dynamic_command_environment() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join(".owned-qualification-configuration-fixture"),
        "owned nonsecret fixture\n",
    )
    .unwrap();
    let setup = oracle(
        "external-qualification-configuration-v3.mjs",
        json!({"action":"setup","root":fixture.0}),
        &fixture.0,
    );
    let mut env: BTreeMap<String, String> =
        serde_json::from_value(setup["environment"].clone()).unwrap();
    let config = setup["configPath"].as_str().unwrap();
    let explicit = compare(
        &fixture.0,
        &env,
        &["--external-qualification-config", config],
    );
    assert_eq!(
        explicit["residentPrerequisites"]["externalQualificationConfigurationIdentityHash"],
        setup["inspection"]["configurationIdentityHash"]
    );
    env.insert(
        "HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG".into(),
        config.into(),
    );
    let selected = compare(&fixture.0, &env, &[]);
    assert_eq!(selected, explicit, "actual default environment selection");
    env.insert(
        "FIXTURE_ALLOWED".into(),
        "changed-owned-allowlisted-value".into(),
    );
    let changed = compare(&fixture.0, &env, &[]);
    assert_ne!(
        changed["residentPrerequisites"]["externalQualificationConfigurationIdentityHash"],
        selected["residentPrerequisites"]["externalQualificationConfigurationIdentityHash"]
    );
    assert_ne!(
        changed["residentPrerequisites"]["autonomousResearchResidentPrerequisiteIdentityHash"],
        selected["residentPrerequisites"]["autonomousResearchResidentPrerequisiteIdentityHash"]
    );
    env.insert(
        "FIXTURE_IGNORED".into(),
        "changed-owned-excluded-value".into(),
    );
    assert_eq!(
        compare(&fixture.0, &env, &[]),
        changed,
        "unlisted environment value excluded from command identity"
    );
}
#[test]
fn full_cli_composes_actual_configured_recovery_without_executing_it() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join(".owned-resident-prerequisites-fixture"),
        "owned synthetic resident prerequisites fixture\n",
    )
    .unwrap();
    let setup = oracle(
        "resident-prerequisites-v1.mjs",
        json!({"action":"setup","root":fixture.0,"scenario":"configured-recovery"}),
        &fixture.0,
    );
    assert_eq!(
        setup["evidenceScope"],
        "synthetic_local_resident_signature_and_storage_fixture_no_executed_qualification_or_independent_acceptance"
    );
    let mut env: BTreeMap<String, String> =
        serde_json::from_value(setup["environment"].clone()).unwrap();
    env.insert(
        "HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG".into(),
        setup["configPath"].as_str().unwrap().into(),
    );
    env.insert(
        "HEPTA_AUTONOMOUS_RESEARCH_EXTERNAL_ACTION_RECOVERY_CONFIG".into(),
        setup["recoveryConfigPath"].as_str().unwrap().into(),
    );
    let report = compare(&fixture.0, &env, &[]);
    assert!(
        report["residentPrerequisites"]["externalActionRecoveryConfigurationIdentityHash"]
            .is_string()
    );
    assert!(report["residentPrerequisites"]["infrastructureBlockers"].as_array().unwrap().iter().any(|v| v == "autonomous_research_supervisor_external_action_recovery_capability_not_verified"));
    assert_eq!(
        report["residentPrerequisites"]["externalActionPerformed"],
        false
    );
}

#[test]
fn full_cli_native_environment_profiles_fail_before_source_io_and_help_still_wins() {
    let fixture = Fixture::new();
    for profile in ["encoding", "entries", "bytes"] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-autonomous-supervisor-health"));
        command
            .current_dir(&fixture.0)
            .env_clear()
            .envs(environment())
            .arg("--runtime-root")
            .arg(&fixture.0)
            .arg("--require-fully-autonomous");
        match profile {
            "encoding" => {
                command.env("OWNED_INVALID_ENCODING", OsString::from_vec(vec![0xff]));
            }
            "entries" => {
                for index in 0..4097 {
                    command.env(format!("OWNED_ENTRY_{index}"), "");
                }
            }
            "bytes" => {
                for index in 0..17 {
                    command.env(format!("OWNED_BYTES_{index}"), "x".repeat(65536));
                }
            }
            _ => unreachable!(),
        }
        let before = snapshot(&fixture.0);
        let output = machine_intake_support::run(&mut command);
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        let expected = if profile == "encoding" {
            "autonomous_research_supervisor_health_environment_encoding_invalid"
        } else {
            "autonomous_research_supervisor_health_environment_bound_exceeded"
        };
        assert_eq!(String::from_utf8(output.stderr).unwrap().trim(), expected);
        assert_eq!(snapshot(&fixture.0), before);
    }
    let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-autonomous-supervisor-health"));
    command
        .current_dir(&fixture.0)
        .env_clear()
        .env("OWNED_INVALID_ENCODING", OsString::from_vec(vec![0xff]))
        .args(["--require-fully-autonomous", "--help"])
        .arg("--runtime-root")
        .arg(fixture.0.join("absent"));
    let output = machine_intake_support::run(&mut command);
    assert!(output.status.success());
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
}
