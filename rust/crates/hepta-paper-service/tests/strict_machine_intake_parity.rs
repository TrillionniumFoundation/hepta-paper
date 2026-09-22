//! Real V1 intake state plus original Node receipt publication/inspection. The
//! fixture constructs cycle data; it does not claim a supervisor cycle executed.
mod machine_intake_support;
use hepta_paper_service::{
    machine_intake::inspect_machine_intake_status_v1,
    strict_machine_intake_reconciliation::inspect_strict_machine_intake_reconciliation_v1,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf, Value);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-strict-intake-parity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let setup = machine_intake_support::oracle(
            &json!({"action":"intake","mode":"setup","runtimeRoot":root,"scenario":"ready"}),
            &root,
        );
        Self(root, setup)
    }
    fn publish(&self, scenario: &str) -> Value {
        let case = machine_intake_support::oracle(
            &json!({"action":"strict","mode":"publish","runtimeRoot":self.0,"environment":self.1["environment"],"scenario":scenario}),
            &self.0,
        );
        assert_eq!(
            case["evidenceScope"],
            "actual_intake_and_original_receipt_data_contract_not_executed_cycle"
        );
        case
    }
    fn native(&self, case: &Value, now: i64) -> Value {
        let environment: BTreeMap<String, String> =
            serde_json::from_value(case["environment"].clone()).unwrap();
        let actual = inspect_machine_intake_status_v1(
            &self.0,
            &environment,
            &self.0,
            case["nowMillis"].as_i64().unwrap(),
        );
        assert_eq!(
            actual, case["machineIntake"],
            "actual native intake observation"
        );
        inspect_strict_machine_intake_reconciliation_v1(
            &self.0,
            environment
                .get("HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH")
                .map(String::as_str),
            environment
                .get("HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY")
                .map(String::as_str),
            &actual,
            now,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn snapshot(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, u32)> {
    fn walk(root: &Path, path: &Path, out: &mut BTreeMap<PathBuf, (Vec<u8>, u32)>) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            assert!(!metadata.is_symlink());
            if metadata.is_dir() {
                walk(root, &path, out);
            } else {
                assert!(metadata.is_file());
                out.insert(
                    path.strip_prefix(root).unwrap().to_owned(),
                    (fs::read(&path).unwrap(), metadata.mode() & 0o7777),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

#[test]
fn actual_original_publisher_hashes_and_binding_failures_match_native_with_unchanged_source() {
    for scenario in [
        "ready",
        "numeric-versions",
        "uppercase-hash",
        "array-cycle-hash",
        "extra-outer-key",
        "tampered-inner",
        "missing-nullable",
        "configuration-mismatch",
        "provider-mismatch",
        "missing-plan",
        "wrong-step",
        "invalid-json",
        "missing-file",
    ] {
        let fixture = Fixture::new();
        let case = fixture.publish(scenario);
        let before = snapshot(&fixture.0);
        let actual = fixture.native(&case, case["nowMillis"].as_i64().unwrap());
        assert_eq!(actual, case["expected"], "{scenario}");
        assert_eq!(
            actual["ready"],
            matches!(
                scenario,
                "ready" | "numeric-versions" | "uppercase-hash" | "array-cycle-hash"
            ),
            "{scenario}"
        );
        assert_eq!(snapshot(&fixture.0), before, "{scenario}");
    }
}

#[test]
fn parsed_falsy_json_is_refused_instead_of_preserving_original_false_readiness() {
    for scenario in ["null", "false", "zero", "empty-string"] {
        let fixture = Fixture::new();
        let case = fixture.publish(scenario);
        let before = snapshot(&fixture.0);
        assert_eq!(
            case["expected"]["ready"], true,
            "actual incumbent defect: {scenario}"
        );
        let actual = fixture.native(&case, case["nowMillis"].as_i64().unwrap());
        assert_eq!(actual["ready"], false);
        assert_eq!(actual["receipt"], Value::Null);
        assert_eq!(
            actual["blockers"],
            json!(["autonomous_research_strict_machine_intake_receipt_invalid"])
        );
        assert_eq!(snapshot(&fixture.0), before);
    }
}

#[test]
fn original_inspection_clock_limits_do_not_invent_receipt_age_or_future_requirements() {
    let fixture = Fixture::new();
    let case = fixture.publish("ready");
    for now in [
        0,
        -8_640_000_000_000_000,
        8_640_000_000_000_000,
        8_640_000_000_000_001,
        i64::MAX,
    ] {
        let expected = machine_intake_support::oracle(
            &json!({"action":"strict","mode":"inspect","runtimeRoot":fixture.0,"environment":case["environment"],"nowMillis":now}),
            &fixture.0,
        );
        let before = snapshot(&fixture.0);
        let actual = fixture.native(&case, now);
        assert_eq!(actual, expected["expected"], "{now}");
        assert_eq!(actual["ready"], now <= 8_640_000_000_000_000);
        assert_eq!(snapshot(&fixture.0), before);
    }
}

#[test]
fn actual_strict_health_cli_matches_node_and_preserves_strict_exit_precedence() {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-core/bin/autonomous-research-supervisor-health.mjs");
    for (scenario, resident) in [
        ("ready", false),
        ("ready", true),
        ("provider-mismatch", true),
        ("tampered-inner", true),
        ("missing-plan", true),
        ("invalid-json", true),
    ] {
        let fixture = Fixture::new();
        let case = fixture.publish(scenario);
        if resident {
            machine_intake_support::oracle(
                &json!({"action":"intake","mode":"resident","runtimeRoot":fixture.0,"configurationHash":fixture.1["configuration"]["configurationHash"]}),
                &fixture.0,
            );
        }
        let environment: BTreeMap<String, String> =
            serde_json::from_value(case["environment"].clone()).unwrap();
        let mut node = Command::new("node");
        node.arg(&script);
        let mut native = Command::new(env!("CARGO_BIN_EXE_hepta-autonomous-supervisor-health"));
        for command in [&mut node, &mut native] {
            command
                .current_dir(&fixture.0)
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap())
                .env("LANG", "en_US.UTF-8")
                .envs(&environment)
                .arg("--runtime-root")
                .arg(&fixture.0)
                .args([
                    "--require-strict-machine-intake-reconciliation",
                    "--require-current-machine-intake",
                    "--require-machine-intake-reconciliation",
                    "--require-startup-reconciliation",
                ]);
        }
        let expected = machine_intake_support::run(&mut node);
        let before = snapshot(&fixture.0);
        let actual = machine_intake_support::run(&mut native);
        assert_eq!(
            actual.status.code(),
            expected.status.code(),
            "{scenario} resident={resident}: {}",
            String::from_utf8_lossy(&actual.stderr)
        );
        assert_eq!(
            actual.status.code(),
            Some(if scenario == "ready" { 0 } else { 2 })
        );
        let mut actual: Value = serde_json::from_slice(&actual.stdout).unwrap();
        let mut expected: Value = serde_json::from_slice(&expected.stdout).unwrap();
        for value in [&mut actual, &mut expected] {
            value["inspectedAt"] = Value::Null;
            value["strictMachineIntakeReconciliation"]["inspectedAt"] = Value::Null;
        }
        assert_eq!(actual, expected, "{scenario} resident={resident}");
        if !resident {
            assert_eq!(actual["currentMachineIntakeReady"], false);
            assert_eq!(actual["strictMachineIntakeReconciliationReady"], true);
        }
        assert_eq!(snapshot(&fixture.0), before);
    }
}
