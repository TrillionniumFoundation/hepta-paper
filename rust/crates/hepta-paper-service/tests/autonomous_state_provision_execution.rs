//! Real Node constructors versus the native CLI. Fixture signatures grant no production authority.
#[allow(dead_code)]
mod machine_intake_support;
use hepta_paper_service::autonomous_state_provision::{
    AutonomousStateProvisioningOptions, execute_autonomous_state_provisioning_v1 as execute,
    inspect_autonomous_state_provisioning_v1 as plan,
    parse_autonomous_state_provisioning_arguments as parse,
};
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
};
struct Fixture {
    root: PathBuf,
    expected: Value,
    args: Vec<String>,
}
impl Fixture {
    fn new() -> Self {
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).unwrap();
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "hepta-native-provision-test-{}",
                hex::encode(nonce)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let mut command = Command::new("node");
        command
            .arg(repository.join("rust/oracle/state-provision-v1.mjs"))
            .arg(json!({"root":root}).to_string())
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("LANG", "en_US.UTF-8")
            .current_dir(&root);
        let output = machine_intake_support::run(&mut command);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&response["profile"])
            .unwrap();
        let expected = response["value"].clone();
        let args = vec![
            "--root".into(),
            repository.display().to_string(),
            "--runtime-root".into(),
            root.join("rust-runtime").display().to_string(),
            "--machine-intake-config".into(),
            expected["machine"].as_str().unwrap().into(),
            "--topic-producer-profile".into(),
            expected["topic"].as_str().unwrap().into(),
            "--dataset-root".into(),
            expected["datasets"].as_str().unwrap().into(),
            "--genesis-inputs".into(),
            expected["genesisInputs"]["path"].as_str().unwrap().into(),
            "--genesis-inputs-sha256".into(),
            expected["genesisInputs"]["sha256"].as_str().unwrap().into(),
            "--runtime-reproducibility-maximum-attempts-per-epoch".into(),
            "2".into(),
            "--runtime-reproducibility-maximum-cost-usd-per-epoch".into(),
            "1".into(),
        ];
        Self {
            root,
            expected,
            args,
        }
    }
    fn options(&self) -> AutonomousStateProvisioningOptions {
        parse(&self.args).unwrap().unwrap()
    }
    fn runtime(&self) -> PathBuf {
        self.root.join("rust-runtime")
    }
    fn repin_document(&self, key: &str, value: &Value) -> AutonomousStateProvisioningOptions {
        let document = PathBuf::from(self.expected["documents"][key]["path"].as_str().unwrap());
        fs::write(&document, serde_json::to_vec(value).unwrap()).unwrap();
        let manifest = PathBuf::from(self.expected["genesisInputs"]["path"].as_str().unwrap());
        let mut body: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        body[key]["sha256"] = json!(format!(
            "sha256:{:x}",
            Sha256::digest(fs::read(document).unwrap())
        ));
        fs::write(&manifest, serde_json::to_vec(&body).unwrap()).unwrap();
        let mut options = self.options();
        options.genesis_inputs_sha256 = Some(format!(
            "sha256:{:x}",
            Sha256::digest(fs::read(manifest).unwrap())
        ));
        options
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn sql_rows(db: &Connection, sql: &str) -> Value {
    let mut statement = db.prepare(sql).unwrap();
    let names = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut rows = statement.query([]).unwrap();
    let mut values = Vec::new();
    while let Some(row) = rows.next().unwrap() {
        let mut value = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            value.insert(
                name.clone(),
                match row.get_ref(i).unwrap() {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(bytes) => json!(std::str::from_utf8(bytes).unwrap()),
                    ValueRef::Blob(_) => panic!("unexpected seed blob"),
                },
            );
        }
        values.push(Value::Object(value));
    }
    json!(values)
}
fn normalized_rows(table: &str, mut rows: Value) -> Value {
    let clock_tables = [
        "schema_migrations",
        "store_metadata",
        "automation_resource_limits",
        "automation_resource_peaks",
        "autonomous_submission_handoff_cutover",
        "handoff_instance",
        "handoff_cutover",
        "handoff_schema_migrations",
    ];
    for row in rows.as_array_mut().unwrap() {
        for (key, value) in row.as_object_mut().unwrap() {
            if key.ends_with("_json") {
                if let Some(text) = value.as_str() {
                    *value = serde_json::from_str(text).unwrap();
                }
            } else if key == "instance_nonce" {
                *value = json!("independent_nonce");
            } else if key == "handoff_database_identity_hash"
                || key == "native_cutover_identity_hash"
            {
                *value = json!("paired_random_identity");
            } else if clock_tables.contains(&table)
                && [
                    "applied_at",
                    "created_at",
                    "updated_at",
                    "activated_at",
                    "prepared_at",
                    "provisioned_at",
                ]
                .contains(&key.as_str())
            {
                assert!(value.is_string());
                *value = json!("execution_clock");
            }
        }
    }
    rows
}
#[test]
fn native_cli_creates_all_ten_canonical_databases_without_node_at_execution() {
    let fixture = Fixture::new();
    let options = fixture.options();
    let selected = plan(&options).expect("signed source plan");
    assert_eq!(selected, plan(&options).unwrap());
    assert!(!fixture.runtime().exists());
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("autonomous-state-provision")
        .args(&fixture.args)
        .args([
            "--action",
            "execute",
            "--execute",
            "--plan-id",
            selected["provisioningPlanId"].as_str().unwrap(),
        ])
        .env_clear()
        .env("PATH", "/no-node-or-external-tools")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["freshRuntimeInstalled"], true);
    assert_eq!(receipt["productionActivation"], false);
    assert_eq!(receipt["nodeRetirement"], false);
    assert_eq!(receipt["databaseInstances"].as_array().unwrap().len(), 10);
    let retained: Value = serde_json::from_slice(
        &fs::read(fixture.runtime().join("native-provisioning-receipt.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(retained["freshRuntimeInstalled"], false);
    assert_eq!(retained["ready"], false);
    assert_eq!(retained["publicationState"], "prepared");
    assert_eq!(receipt["publicationState"], "published");
    assert_eq!(
        receipt["preparedReceiptHash"],
        retained["provisioningReceiptHash"]
    );
    let terminal: Value = serde_json::from_slice(
        &fs::read(
            fixture
                .runtime()
                .join("native-provisioning-publication.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(terminal, receipt);
    for expected in fixture.expected["databases"].as_array().unwrap() {
        let path = fixture
            .runtime()
            .join(expected["relative"].as_str().unwrap());
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(
            sql_rows(
                &db,
                "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name"
            ),
            expected["schema"],
            "schema role {}",
            expected["role"]
        );
        for (name, rows) in expected["rows"].as_object().unwrap() {
            assert_eq!(
                normalized_rows(
                    name,
                    sql_rows(&db, &format!("SELECT * FROM \"{name}\" ORDER BY rowid"))
                ),
                normalized_rows(name, rows.clone()),
                "seed rows {}:{name}",
                expected["role"]
            );
        }
        assert_eq!(
            db.query_row::<String, _, _>("PRAGMA quick_check", [], |r| r.get(0))
                .unwrap(),
            "ok"
        );
        assert!(
            !db.prepare("PRAGMA foreign_key_check")
                .unwrap()
                .exists([])
                .unwrap()
        );
    }
    let native = Connection::open_with_flags(
        fixture.runtime().join("hepta-paper.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let handoff = Connection::open_with_flags(
        fixture
            .runtime()
            .join("autonomous-research/submission-handoff/submission-handoff.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let identity: String = native
        .query_row(
            "SELECT handoff_database_identity_hash FROM autonomous_submission_handoff_cutover",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        identity,
        handoff
            .query_row::<String, _, _>(
                "SELECT native_cutover_identity_hash FROM handoff_cutover",
                [],
                |r| r.get(0)
            )
            .unwrap()
    );
    assert!(
        plan(&options)
            .unwrap_err()
            .to_string()
            .contains("fresh_runtime_required")
    );
}
#[test]
fn genuine_genesis_verifier_rejects_bad_signatures_and_wrong_subjects_before_publication() {
    for fault in ["signature", "configuration"] {
        let fixture = Fixture::new();
        let path = fixture.expected["documents"]["genesisEnvelope"]["path"]
            .as_str()
            .unwrap();
        let mut envelope: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        if fault == "signature" {
            envelope["signatures"][0]["value"] = json!("AA==");
        } else {
            envelope["configurationHash"] = json!(format!("sha256:{}", "a".repeat(64)));
        }
        let options = fixture.repin_document("genesisEnvelope", &envelope);
        assert!(
            plan(&options)
                .unwrap_err()
                .to_string()
                .contains("genesis_authority_rejected")
        );
        assert!(!fixture.runtime().exists());
    }
}
#[test]
fn source_change_missing_pin_and_unsigned_profile_never_install() {
    let fixture = Fixture::new();
    let mut options = fixture.options();
    let selected = plan(&options).unwrap();
    options.action = "execute".into();
    options.execute = true;
    options.expected_plan_id = Some(selected["provisioningPlanId"].as_str().unwrap().into());
    options.genesis_inputs_sha256 = None;
    assert!(execute(&options).is_err());
    options = fixture.options();
    options.machine_intake_genesis_authority = "root-owned-configuration".into();
    assert!(plan(&options).is_err());
    options = fixture.options();
    let profile = PathBuf::from(fixture.expected["topic"].as_str().unwrap());
    let original = fs::read(&profile).unwrap();
    fs::write(&profile, [original.as_slice(), b" "].concat()).unwrap();
    options.action = "execute".into();
    options.execute = true;
    options.expected_plan_id = Some(selected["provisioningPlanId"].as_str().unwrap().into());
    assert!(
        execute(&options)
            .unwrap_err()
            .to_string()
            .contains("plan_mismatch")
    );
    assert!(!fixture.runtime().exists());
}
#[test]
fn existing_or_symlinked_targets_never_get_overwritten() {
    let fixture = Fixture::new();
    let options = fixture.options();
    symlink(fixture.root.join("missing"), fixture.runtime()).unwrap();
    assert!(plan(&options).is_err());
    fs::remove_file(fixture.runtime()).unwrap();
    fs::create_dir(fixture.runtime()).unwrap();
    fs::write(fixture.runtime().join("keep"), b"committed data").unwrap();
    assert!(plan(&options).is_err());
    assert_eq!(
        fs::read(fixture.runtime().join("keep")).unwrap(),
        b"committed data"
    );
}

#[test]
fn direct_api_cannot_bypass_positive_budget_or_execution_confirmation() {
    let fixture = Fixture::new();
    for cost in [0.0, -1.0, f64::NAN, f64::INFINITY, 100_000_001.0] {
        let mut options = fixture.options();
        options.maximum_cost_usd_per_epoch = cost;
        assert!(
            plan(&options)
                .unwrap_err()
                .to_string()
                .contains("refresh_policy_invalid")
        );
        assert!(!fixture.runtime().exists());
    }
    let mut options = fixture.options();
    let selected = plan(&options).unwrap();
    options.expected_plan_id = Some(selected["provisioningPlanId"].as_str().unwrap().into());
    assert!(
        execute(&options)
            .unwrap_err()
            .to_string()
            .contains("confirmation_required")
    );
    options.action = "execute".into();
    assert!(
        execute(&options)
            .unwrap_err()
            .to_string()
            .contains("confirmation_required")
    );
    assert!(!fixture.runtime().exists());
}
