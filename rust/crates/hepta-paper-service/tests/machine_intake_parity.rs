//! Actual incumbent Node builders/repository and native readonly current-intake
//! inspection. Fixtures are owned temporary state, never installation qualification.
mod machine_intake_support;

use hepta_paper_service::machine_intake::inspect_machine_intake_status_v1;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-machine-intake-parity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn oracle(&self, mode: &str, scenario: Option<&str>) -> Value {
        let mut input = json!({"action":"intake","mode":mode,"runtimeRoot":self.0});
        if let Some(scenario) = scenario {
            input["scenario"] = json!(scenario);
        }
        machine_intake_support::oracle(&input, &self.0)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn environment(value: &Value) -> BTreeMap<String, String> {
    serde_json::from_value(value.clone()).unwrap()
}
fn inspect(root: &Path, case: &Value, now: i64) -> Value {
    inspect_machine_intake_status_v1(root, &environment(&case["environment"]), root, now)
}
fn tree_snapshot(root: &Path) -> BTreeMap<PathBuf, (Vec<u8>, u32)> {
    fn visit(root: &Path, path: &Path, result: &mut BTreeMap<PathBuf, (Vec<u8>, u32)>) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            assert!(!metadata.is_symlink(), "fixture does not contain aliases");
            if metadata.is_dir() {
                visit(root, &path, result);
            } else {
                assert!(metadata.is_file());
                result.insert(
                    path.strip_prefix(root).unwrap().to_owned(),
                    (fs::read(&path).unwrap(), metadata.mode() & 0o7777),
                );
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, root, &mut result);
    result
}

#[test]
fn actual_node_v1_configuration_static_intake_and_database_are_ready_without_source_changes() {
    for scenario in ["ready", "optional-mounts", "numeric-versions"] {
        let fixture = Fixture::new();
        let oracle = fixture.oracle("setup", Some(scenario));
        assert_eq!(oracle["expected"]["coldStartAutonomyReady"], true);
        assert_eq!(oracle["expected"]["configurationValid"], true);
        assert_eq!(oracle["expected"]["state"]["pendingCount"], 1);
        assert_eq!(
            oracle["expected"]["state"]["pending"][0]["sourceKind"],
            "static-file"
        );
        let before = tree_snapshot(&fixture.0);
        let actual = inspect(&fixture.0, &oracle, oracle["nowMillis"].as_i64().unwrap());
        assert_eq!(actual, oracle["expected"]);
        assert_eq!(tree_snapshot(&fixture.0), before);
        assert_eq!(actual["statusReadOnly"], true);
        assert_eq!(actual["configuredIntakesLoadedByStatus"], false);
        assert_eq!(actual["repositoryAuthorityGeneration"], 1);
        assert_eq!(actual["topicProducerDatasetSnapshotHash"], Value::Null);
    }
}

#[test]
fn real_static_provider_and_database_identity_failures_match_original_node() {
    let scenarios = [
        (
            "static-drift",
            "autonomous_research_machine_intake_configuration_invalid_or_drifted",
        ),
        (
            "provider-mismatch",
            "autonomous_research_recurring_golden_provider_configuration_mismatch",
        ),
        (
            "db-binding-mismatch",
            "autonomous_research_machine_intake_repository_configuration_authority_mismatch",
        ),
        (
            "tampered-intake",
            "autonomous_research_machine_intake_state_invalid_or_migration_required",
        ),
        (
            "tampered-admission",
            "autonomous_research_machine_intake_state_invalid_or_migration_required",
        ),
        (
            "missing-state",
            "autonomous_research_machine_intake_repository_configuration_authority_unbound",
        ),
    ];
    for (scenario, blocker) in scenarios {
        let fixture = Fixture::new();
        let oracle = fixture.oracle("setup", Some(scenario));
        let before = tree_snapshot(&fixture.0);
        let actual = inspect(&fixture.0, &oracle, oracle["nowMillis"].as_i64().unwrap());
        assert_eq!(actual, oracle["expected"], "{scenario}");
        assert_eq!(actual["coldStartAutonomyReady"], false, "{scenario}");
        assert!(
            actual["blockers"]
                .as_array()
                .unwrap()
                .contains(&json!(blocker)),
            "{scenario}"
        );
        assert_eq!(tree_snapshot(&fixture.0), before, "{scenario}");
        if scenario == "missing-state" {
            assert!(
                !fixture
                    .0
                    .join("autonomous-research/machine-intake/machine-intake.sqlite")
                    .exists()
            );
        }
    }
}

#[test]
fn original_due_pending_order_counts_backoff_and_durable_lease_match_in_full() {
    let fixture = Fixture::new();
    let oracle = fixture.oracle("setup", Some("ordered-pending"));
    let before = tree_snapshot(&fixture.0);
    let actual = inspect(&fixture.0, &oracle, oracle["nowMillis"].as_i64().unwrap());
    assert_eq!(actual, oracle["expected"]);
    assert_eq!(tree_snapshot(&fixture.0), before);
    assert_eq!(actual["coldStartAutonomyReady"], true);
    assert_eq!(actual["state"]["pendingCount"], 6);
    assert_eq!(actual["state"]["pendingProductionCount"], 4);
    assert_eq!(actual["state"]["enqueuedCount"], 1);
    assert_eq!(actual["state"]["invalidCount"], 1);
    let pending = actual["state"]["pending"].as_array().unwrap();
    assert_eq!(pending.len(), 5, "future retry is counted but not listed");
    assert_eq!(pending[0]["sourceKind"], "recurring-golden");
    assert_eq!(
        pending[0]["intake"]["recurringGoldenProvenance"]["templateId"],
        "golden-second"
    );
    assert_eq!(
        pending[1]["intake"]["recurringGoldenProvenance"]["templateId"],
        "golden-first"
    );
    assert_eq!(pending[2]["intakeId"], "intake:machine-b");
    assert_eq!(pending[3]["intakeId"], "intake:static");
    assert_eq!(pending[4]["intakeId"], "intake:machine-a");
    assert_eq!(pending[4]["failureCount"], 2);
    assert_eq!(pending[4]["lastError"], "fixture-backoff");
    assert_eq!(pending[3]["leaseGeneration"], 1);
    assert_eq!(pending[3]["lease"]["ownerId"], "fixture-worker");
    assert!(
        pending[3]["lease"]["leaseToken"]
            .as_str()
            .unwrap()
            .starts_with("intake-lease:")
    );
    assert_eq!(pending[3]["lease"]["leaseGeneration"], 1);
}

#[test]
fn every_builtin_resource_topology_and_rehashed_budget_boundaries_match_actual_node() {
    let fixture = Fixture::new();
    let oracle = fixture.oracle("budget-matrix", None);
    let now = oracle["nowMillis"].as_i64().unwrap();
    let cases = oracle["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 313);
    let before = tree_snapshot(&fixture.0);
    let mut valid_topologies = 0;
    let mut invalid_topologies = 0;
    let mut closed_budget_refusals = 0;
    for case in cases {
        let label = case["label"].as_str().unwrap();
        let actual = inspect(&fixture.0, case, now);
        assert_eq!(actual, case["expected"], "{label}");
        assert_eq!(
            actual["configurationValid"], case["configurationValid"],
            "{label}"
        );
        if label.contains(":below-") {
            closed_budget_refusals += 1;
            assert_eq!(case["templateValid"], false, "{label}");
            assert_eq!(actual["configurationValid"], false, "{label}");
        } else if label.contains(':') {
            if case["templateValid"] == true {
                valid_topologies += 1;
            } else {
                invalid_topologies += 1;
            }
        } else if label == "daily-agent-exact" {
            assert_eq!(case["templateValid"], true);
            assert_eq!(actual["configurationValid"], true);
        } else {
            assert_eq!(
                case["templateValid"], true,
                "per-template contracts remain valid"
            );
            assert_eq!(actual["configurationValid"], false, "{label}");
        }
        assert_eq!(
            actual["coldStartAutonomyReady"], false,
            "no DB authority was provisioned in matrix"
        );
    }
    assert_eq!(closed_budget_refusals, 10);
    assert_eq!(valid_topologies + invalid_topologies, 300);
    assert!(valid_topologies > 0 && invalid_topologies > 0);
    assert_eq!(tree_snapshot(&fixture.0), before);
}

#[test]
fn committed_wal_is_consumed_and_original_database_bytes_are_unchanged() {
    let fixture = Fixture::new();
    let setup = fixture.oracle("setup", Some("ready"));
    let path = fixture
        .0
        .join("autonomous-research/machine-intake/machine-intake.sqlite");
    let keeper = rusqlite::Connection::open(&path).unwrap();
    keeper
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    for source in [
        format!("sha256:{}", "f".repeat(64)),
        setup["configuration"]["configurationHash"]
            .as_str()
            .unwrap()
            .to_owned(),
    ] {
        keeper.execute("UPDATE autonomous_research_machine_intake_metadata SET configured_source_authority_hash=?1 WHERE singleton=1", [&source]).unwrap();
        assert!(
            fs::metadata(path.with_extension("sqlite-wal"))
                .unwrap()
                .len()
                > 32
        );
        let expected = machine_intake_support::oracle(
            &json!({"action":"intake","mode":"inspect","runtimeRoot":fixture.0,"environment":setup["environment"]}),
            &fixture.0,
        );
        let before = tree_snapshot(&fixture.0);
        let actual = inspect(&fixture.0, &setup, expected["nowMillis"].as_i64().unwrap());
        assert_eq!(actual, expected["expected"]);
        assert_eq!(
            actual["coldStartAutonomyReady"],
            source
                == setup["configuration"]["configurationHash"]
                    .as_str()
                    .unwrap()
        );
        assert_eq!(tree_snapshot(&fixture.0), before);
    }
}

#[test]
fn real_current_intake_health_cli_matches_node_exit_and_full_report() {
    use std::process::Command;
    let node_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-core/bin/autonomous-research-supervisor-health.mjs");
    for scenario in ["ready", "provider-mismatch", "resident-drift"] {
        let fixture = Fixture::new();
        let setup = fixture.oracle(
            "setup",
            Some(if scenario == "resident-drift" {
                "ready"
            } else {
                scenario
            }),
        );
        let bound = if scenario == "resident-drift" {
            json!(format!("sha256:{}", "e".repeat(64)))
        } else {
            setup["configuration"]["configurationHash"].clone()
        };
        machine_intake_support::oracle(
            &json!({"action":"intake","mode":"resident","runtimeRoot":fixture.0,"configurationHash":bound}),
            &fixture.0,
        );
        let env = environment(&setup["environment"]);
        let mut expected_command = Command::new("node");
        expected_command.arg(&node_script);
        let mut actual_command =
            Command::new(env!("CARGO_BIN_EXE_hepta-autonomous-supervisor-health"));
        for command in [&mut expected_command, &mut actual_command] {
            command
                .current_dir(&fixture.0)
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap())
                .env("LANG", "en_US.UTF-8")
                .envs(&env)
                .arg("--runtime-root")
                .arg(&fixture.0)
                .arg("--require-current-machine-intake");
        }
        let expected = machine_intake_support::run(&mut expected_command);
        let before = tree_snapshot(&fixture.0);
        let actual = machine_intake_support::run(&mut actual_command);
        assert_eq!(
            actual.status.code(),
            expected.status.code(),
            "{scenario}: {}",
            String::from_utf8_lossy(&actual.stderr)
        );
        assert_eq!(
            actual.status.code(),
            Some(if scenario == "ready" { 0 } else { 2 })
        );
        let mut actual: Value = serde_json::from_slice(&actual.stdout).unwrap();
        let mut expected: Value = serde_json::from_slice(&expected.stdout).unwrap();
        actual["inspectedAt"] = Value::Null;
        expected["inspectedAt"] = Value::Null;
        assert_eq!(actual, expected, "{scenario}");
        assert_eq!(tree_snapshot(&fixture.0), before, "{scenario}");
    }
}

#[test]
fn missing_configuration_and_invalid_provider_match_actual_node_without_bootstrap() {
    for populated in [false, true] {
        let fixture = Fixture::new();
        if populated {
            fixture.oracle("setup", Some("ready"));
        }
        for environment in [
            json!({}),
            json!({"HEPTA_RESEARCH_AUTHOR_PROVIDER":"unsupported-provider"}),
        ] {
            let expected = machine_intake_support::oracle(
                &json!({"action":"intake","mode":"inspect","runtimeRoot":fixture.0,"environment":environment}),
                &fixture.0,
            );
            let before = tree_snapshot(&fixture.0);
            let actual = inspect(
                &fixture.0,
                &expected,
                expected["nowMillis"].as_i64().unwrap(),
            );
            assert_eq!(actual, expected["expected"]);
            assert_eq!(actual["coldStartAutonomyReady"], false);
            assert_eq!(tree_snapshot(&fixture.0), before);
        }
    }
}

#[test]
fn original_persisted_retry_time_spellings_match_without_rewriting_or_resorting_rows() {
    let fixture = Fixture::new();
    let setup = fixture.oracle("setup", Some("ready"));
    let path = fixture
        .0
        .join("autonomous-research/machine-intake/machine-intake.sqlite");
    for spelling in [
        "2026-01-01T00:00:00Z",
        "2026-01-01T01:00:00+01:00",
        "2026-01-01T01:00:00+0100",
        "2026-01-01 00:00:00",
        "2026-01-01t00:00:00z",
        "2026-01-01T00:00:00.1Z",
        "2026-01-01T00:00:00.12Z",
        "2026-01-01T00:00:00.123456Z",
    ] {
        let writer = rusqlite::Connection::open(&path).unwrap();
        writer
            .execute(
                "UPDATE autonomous_research_machine_intake SET next_attempt_at=?1",
                [spelling],
            )
            .unwrap();
        drop(writer);
        let expected = machine_intake_support::oracle(
            &json!({"action":"intake","mode":"inspect","runtimeRoot":fixture.0,"environment":setup["environment"]}),
            &fixture.0,
        );
        let before = tree_snapshot(&fixture.0);
        let actual = inspect(&fixture.0, &setup, expected["nowMillis"].as_i64().unwrap());
        assert_eq!(actual, expected["expected"], "{spelling}");
        assert_eq!(actual["coldStartAutonomyReady"], true, "{spelling}");
        assert_eq!(actual["state"]["pending"][0]["nextAttemptAt"], spelling);
        assert_eq!(tree_snapshot(&fixture.0), before);
    }
}
