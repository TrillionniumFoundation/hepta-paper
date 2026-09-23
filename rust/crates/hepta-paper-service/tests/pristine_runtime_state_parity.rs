//! Real original provisioning, temporary SQLite databases, and full Node reports.
use hepta_paper_service::pristine_runtime_state::*;
use hepta_paper_service::sqlite_mutation_coordinator::Result;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = PathBuf::from(format!(
            "/tmp/hepta-pristine-rust-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn oracle(request: &Value) -> Value {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(repo.join("rust/oracle/pristine-runtime-state-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(child.stdin.take().unwrap(), "{request}").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"]).unwrap();
    result
}
fn inspect(input: &Value) -> Result<PristineDatabaseInspectionV1> {
    let mut connection = Connection::open_with_flags(
        input["databasePath"].as_str().unwrap(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    inspect_pristine_database_state_v1(
        &mut connection,
        PristineDatabaseOptionsV1 {
            database_role: input["databaseRole"].as_str().unwrap(),
            database_instance_id: input["databaseInstanceId"].as_str().unwrap(),
            schema_contract_id: input["schemaContractId"].as_str().unwrap(),
            schema_hash: input["schemaHash"].as_str().unwrap(),
            state_database_manifest_hash: input["stateDatabaseManifestHash"].as_str().unwrap(),
            phase: input["phase"].as_str().unwrap(),
            machine_genesis: None,
        },
    )
}
fn difference(a: &Value, b: &Value, p: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => {
            if a.keys().collect::<Vec<_>>() != b.keys().collect::<Vec<_>>() {
                return Some(format!("{p}:keys"));
            }
            a.iter()
                .find_map(|(k, v)| difference(v, &b[k], &format!("{p}.{k}")))
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(format!("{p}:length"));
            }
            a.iter()
                .zip(b)
                .enumerate()
                .find_map(|(i, (a, b))| difference(a, b, &format!("{p}[{i}]")))
        }
        (Value::Number(a), Value::Number(b)) if a.as_f64() == b.as_f64() => None,
        _ if a == b => None,
        _ => Some(format!("{p}: {a} != {b}")),
    }
}
#[test]
fn actual_ten_database_pristine_observation_and_cross_bindings_match_node() {
    for phase in ["pre-rebind", "post-rebind", "adoption"] {
        let root = Temp::new();
        let fixture = oracle(&json!({"operation":"fixture","root":root.0,"phase":phase}));
        assert_eq!(fixture["ok"], true, "{fixture}");
        let fixture = &fixture["value"];
        let mut inspections = Vec::new();
        for (index, input) in fixture["instances"].as_array().unwrap().iter().enumerate() {
            let before = fs::read(input["databasePath"].as_str().unwrap()).unwrap();
            let observed = inspect(input).unwrap();
            assert_eq!(
                difference(observed.value(), &fixture["inspections"][index], "$"),
                None,
                "{phase}/{}",
                input["databaseRole"]
            );
            assert_eq!(
                fs::read(input["databasePath"].as_str().unwrap()).unwrap(),
                before
            );
            inspections.push(observed);
        }
        assert_eq!(
            pristine_runtime_state_hash_v1(&inspections).unwrap(),
            fixture["pristineRuntimeStateHash"]
        );
        assert_eq!(
            pristine_runtime_state_policy_hash_v1(
                fixture["instances"][0]["stateDatabaseManifestHash"]
                    .as_str()
                    .unwrap()
            )
            .unwrap(),
            fixture["policyHash"]
        );
    }
}
#[test]
fn pristine_observer_rejects_real_corruption_and_business_rows_at_matching_node_stage() {
    let root = Temp::new();
    let fixture = oracle(&json!({"operation":"fixture","root":root.0,"phase":"pre-rebind"}));
    assert_eq!(fixture["ok"], true, "{fixture}");
    let instances = fixture["value"]["instances"].as_array().unwrap();
    let cases = [
        (
            "native-store",
            "UPDATE schema_migrations SET migration_sha256='sha256:bad' WHERE version=1",
            "native_migrations_invalid",
        ),
        (
            "native-store",
            "UPDATE store_metadata SET value='unsafe' WHERE key='schema_version'",
            "native_metadata_invalid",
        ),
        (
            "native-store",
            "UPDATE automation_resource_limits SET agent_limit=5",
            "native_resource_baseline_invalid",
        ),
        (
            "submission-handoff",
            "DROP TRIGGER handoff_instance_no_update; UPDATE handoff_instance SET instance_nonce='not-uuid'",
            "handoff_baseline_invalid",
        ),
        (
            "topic-producer",
            "UPDATE autonomous_research_topic_producer_metadata SET generation_high_watermark=1",
            "topic_producer_metadata_invalid",
        ),
        (
            "topic-producer",
            "ALTER TABLE autonomous_research_topic_producer_metadata DROP COLUMN last_produced_at",
            "topic_producer_metadata_invalid",
        ),
        (
            "runtime-reproducibility-refresh",
            "UPDATE runtime_reproducibility_refresh_state SET consecutive_failures=1",
            "runtime_refresh_baseline_invalid",
        ),
        (
            "full-research-qualification-publication",
            "UPDATE full_research_qualification_pointer_lease SET lease_generation=1",
            "qualification_lease_baseline_invalid",
        ),
        (
            "supervisor-state",
            "CREATE TABLE extra_empty(id INTEGER); INSERT INTO extra_empty VALUES(1)",
            "business_rows_present",
        ),
        (
            "resident-instance",
            "UPDATE autonomous_research_online_authority_journal_metadata SET schema_contract_hash='sha256:bad'",
            "online_authority_journal_invalid",
        ),
        (
            "supervisor-state",
            "DROP TRIGGER autonomous_research_online_mutation_metadata_no_update; UPDATE autonomous_research_online_mutation_authority_metadata SET genesis_global_sequence=1",
            "online_authority_metadata_invalid",
        ),
    ];
    for (index, (role, sql, suffix)) in cases.iter().enumerate() {
        let mut input = instances
            .iter()
            .find(|v| v["databaseRole"] == *role)
            .unwrap()
            .clone();
        let copy = root.0.join(format!("case-{index}.sqlite"));
        fs::copy(input["databasePath"].as_str().unwrap(), &copy).unwrap();
        input["databasePath"] = json!(copy);
        {
            let db = Connection::open(&copy).unwrap();
            db.execute_batch(sql).unwrap();
        }
        let node = oracle(&json!({"operation":"inspect","input":input}));
        let rust = inspect(&input).err().unwrap();
        let code = format!("autonomous_research_pristine_state_{suffix}");
        assert_eq!(node["ok"], false, "case {index}");
        assert_eq!(node["error"], code, "case {index}");
        assert_eq!(rust.code, code, "case {index}");
    }
}

#[test]
fn real_native_receipt_ledger_causality_hashes_and_raw_member_order_match_node() {
    let root = Temp::new();
    let fixture = oracle(&json!({"operation":"fixture","root":root.0,"phase":"pre-rebind"}));
    assert_eq!(fixture["ok"], true, "{fixture}");
    let input = fixture["value"]["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["databaseRole"] == "native-store")
        .unwrap();
    for scenario in [
        "valid-v2",
        "valid-v3",
        "v3-integral-number",
        "orphan-backup",
        "causal-future-backup",
        "v3-member-order",
        "duplicate-field",
    ] {
        let case = oracle(
            &json!({"operation":"ledger-case","input":input,"root":root.0,"scenario":scenario}),
        );
        assert_eq!(case["ok"], true, "{scenario}: {case}");
        let case = &case["value"];
        let actual = inspect(&case["input"]);
        let expected = &case["result"];
        if scenario == "duplicate-field" {
            assert_eq!(expected["ok"], true);
            assert_eq!(
                actual.err().unwrap().code,
                "autonomous_research_pristine_state_receipt_ledger_json_invalid"
            );
            continue;
        }
        if expected["ok"] == true {
            let actual = actual.unwrap();
            assert_eq!(
                difference(actual.value(), &expected["value"], "$"),
                None,
                "{scenario}"
            );
        } else {
            assert_eq!(actual.err().unwrap().code, expected["error"], "{scenario}");
        }
    }
}

#[test]
fn actual_external_genesis_requires_pinned_documents_two_signatures_and_persisted_binding() {
    let root = Temp::new();
    let fixture = oracle(&json!({"operation":"fixture","root":root.0,"phase":"pre-rebind"}));
    assert_eq!(fixture["ok"], true, "{fixture}");
    let input = fixture["value"]["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["databaseRole"] == "machine-intake")
        .unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(repo.join("rust/oracle/pristine-machine-genesis-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.take().unwrap(),
        "{}",
        json!({"input":input,"root":root.0})
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["ok"], true, "{result}");
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"]).unwrap();
    for case in result["cases"].as_array().unwrap() {
        let pins = &case["pins"];
        let pair = |key| {
            let value = &pins[key];
            (
                Path::new(value["path"].as_str().unwrap()),
                value["hash"].as_str().unwrap(),
            )
        };
        let proof = PinnedMachineGenesisDocumentsV1::load(
            pair("ownerTrustStore"),
            pair("genesisEnvelope"),
            pair("rotationTrustStore"),
            pair("bootstrapReceipt"),
        )
        .unwrap();
        let input = &case["input"];
        let mut db = Connection::open_with_flags(
            input["databasePath"].as_str().unwrap(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let actual = inspect_pristine_database_state_v1(
            &mut db,
            PristineDatabaseOptionsV1 {
                database_role: "machine-intake",
                database_instance_id: input["databaseInstanceId"].as_str().unwrap(),
                schema_contract_id: input["schemaContractId"].as_str().unwrap(),
                schema_hash: input["schemaHash"].as_str().unwrap(),
                state_database_manifest_hash: input["stateDatabaseManifestHash"].as_str().unwrap(),
                phase: "pre-rebind",
                machine_genesis: Some(&proof),
            },
        );
        let expected = &case["result"];
        if expected["ok"] == true {
            assert_eq!(
                difference(actual.unwrap().value(), &expected["value"], "$"),
                None,
                "{}",
                case["scenario"]
            );
        } else {
            assert_eq!(
                actual.err().unwrap().code,
                expected["error"],
                "{}",
                case["scenario"]
            );
        }
    }
}

#[test]
fn actual_snapshot_scope_table_limits_and_caller_transaction_are_enforced() {
    let root = Temp::new();
    let fixture = oracle(&json!({"operation":"fixture","root":root.0,"phase":"pre-rebind"}));
    assert_eq!(fixture["ok"], true, "{fixture}");
    let fixture = &fixture["value"];
    let mut inputs = fixture["instances"].as_array().unwrap().clone();
    let position = inputs
        .iter()
        .position(|v| v["databaseRole"] == "supervisor-state")
        .unwrap();
    let copy = root.0.join("scope.sqlite");
    fs::copy(inputs[position]["databasePath"].as_str().unwrap(), &copy).unwrap();
    inputs[position]["databasePath"] = json!(copy);
    {
        let database = Connection::open(&copy).unwrap();
        database.execute_batch("DROP TRIGGER autonomous_research_online_mutation_metadata_no_update; UPDATE autonomous_research_online_mutation_authority_metadata SET genesis_global_hash='sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';").unwrap();
    }
    let observations = inputs
        .iter()
        .map(|v| inspect(v).unwrap())
        .collect::<Vec<_>>();
    let values = observations
        .iter()
        .map(|v| v.value().clone())
        .collect::<Vec<_>>();
    let node = oracle(&json!({"operation":"aggregate","inspections":values}));
    assert_eq!(node["ok"], false);
    assert_eq!(
        pristine_runtime_state_hash_v1(&observations)
            .unwrap_err()
            .code,
        node["error"]
    );
    {
        let database = Connection::open(&copy).unwrap();
        for i in 0..260 {
            database
                .execute_batch(&format!("CREATE TABLE extra_{i}(value TEXT)"))
                .unwrap();
        }
    }
    let node = oracle(&json!({"operation":"inspect","input":inputs[position]}));
    assert_eq!(node["ok"], false);
    assert_eq!(
        node["error"],
        "autonomous_research_pristine_state_table_limit_exceeded"
    );
    assert_eq!(
        inspect(&inputs[position]).err().unwrap().code,
        node["error"]
    );
    let input = &fixture["instances"][position];
    let mut database = Connection::open_in_memory().unwrap();
    database
        .execute_batch("CREATE TABLE caller(value INTEGER); BEGIN; INSERT INTO caller VALUES(7)")
        .unwrap();
    let error = inspect_pristine_database_state_v1(
        &mut database,
        PristineDatabaseOptionsV1 {
            database_role: input["databaseRole"].as_str().unwrap(),
            database_instance_id: input["databaseInstanceId"].as_str().unwrap(),
            schema_contract_id: input["schemaContractId"].as_str().unwrap(),
            schema_hash: input["schemaHash"].as_str().unwrap(),
            state_database_manifest_hash: input["stateDatabaseManifestHash"].as_str().unwrap(),
            phase: "pre-rebind",
            machine_genesis: None,
        },
    )
    .err()
    .unwrap();
    assert_eq!(
        error.code,
        "autonomous_research_pristine_state_caller_transaction_active"
    );
    assert!(!database.is_autocommit());
    assert_eq!(
        database
            .query_row("SELECT value FROM caller", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        7
    );
}

#[test]
fn ordinary_tables_hidden_by_legacy_like_wildcard_never_yield_pristine_evidence() {
    let root = Temp::new();
    let fixture = oracle(&json!({"operation":"fixture","root":root.0,"phase":"pre-rebind"}));
    assert_eq!(fixture["ok"], true, "{fixture}");
    let original = fixture["value"]["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["databaseRole"] == "supervisor-state")
        .unwrap();
    for (index, name) in ["sqliteXbusiness", "SQLITExbusiness", "sqlite雪business"]
        .iter()
        .enumerate()
    {
        let mut input = original.clone();
        let copy = root.0.join(format!("hidden-{index}.sqlite"));
        fs::copy(input["databasePath"].as_str().unwrap(), &copy).unwrap();
        input["databasePath"] = json!(copy);
        {
            let database = Connection::open(&copy).unwrap();
            database.execute_batch(&format!("CREATE TABLE \"{name}\"(value TEXT); INSERT INTO \"{name}\" VALUES('live business state');")).unwrap();
        }
        let node = oracle(&json!({"operation":"inspect","input":input}));
        assert_eq!(node["ok"], true, "{name}");
        let error = inspect(&input).err().unwrap();
        assert_eq!(
            error.code,
            "autonomous_research_pristine_state_hidden_user_table"
        );
        assert_eq!(error.details["tableName"], *name);
    }
}
