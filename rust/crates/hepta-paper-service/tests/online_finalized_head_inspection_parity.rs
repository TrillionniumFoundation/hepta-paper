//! Synthetic, signed authority and in-memory databases only. Private key bytes
//! never appear in oracle output or assertion diagnostics.
use base64ct::{Base64, Encoding};
use ed25519_dalek::{
    Signer, SigningKey,
    pkcs8::{EncodePublicKey, spki::der::pem::LineEnding},
};
use hepta_paper_service::sqlite_mutation_coordinator::{
    authority::*, contracts::*, storage::exact_schema_hash_v1, *,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
const NOW: i64 = 1_784_361_600_000;
static NEXT: AtomicU64 = AtomicU64::new(0);
fn hash(kind: &str, value: &Value) -> String {
    hepta_legacy_compatibility::production_hash_record_v1(kind, value)
        .unwrap()
        .as_str()
        .to_owned()
}
fn h(label: &str) -> String {
    hash("SqliteCoordinatorNativeFixture", &json!({"label":label}))
}
fn bytes_hash(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}
fn failure(code: &str) -> SqliteMutationCoordinatorError {
    SqliteMutationCoordinatorError {
        code: code.into(),
        details: json!({}),
        state_recoverability_fatal: false,
        state_recoverability_deferred: false,
        retryable: false,
    }
}
fn oracle(requests: &[Value]) -> Vec<Value> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/sqlite-mutation-coordinator-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(requests).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Node oracle failed without exposing fixture key material"
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&response["profile"]).unwrap();
    response["results"].as_array().unwrap().clone()
}
struct Fixture {
    root: PathBuf,
    configuration: PathBuf,
    pin: String,
    value: Value,
    key: SigningKey,
}
impl Fixture {
    fn new() -> Self {
        let value = oracle(&[json!({"operation":"fixture"})])[0]["value"].clone();
        assert_eq!(clock::iso(NOW).unwrap(), value["now"]);
        let root = std::env::temp_dir().join(format!(
            "hepta-finalized-head-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).unwrap();
        let key = SigningKey::from_bytes(&seed);
        let document = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityPublicKey","authorityId":"authority:test","keyId":"key:test","algorithm":"ed25519","publicKeyPem":key.verifying_key().to_public_key_pem(LineEnding::LF).unwrap()});
        let key_path = root.join("public.json");
        let key_bytes = serde_json::to_vec(&document).unwrap();
        fs::write(&key_path, &key_bytes).unwrap();
        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o444)).unwrap();
        let configuration = root.join("configuration.json");
        let config = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityConfiguration","authorityId":"authority:test","keyId":"key:test","scopeId":"scope:test","databaseScopeHash":value["trust"]["databaseScopeHash"],"writerManifestHash":value["trust"]["writerManifestHash"],"publicKeyPath":key_path,"publicKeySha256":bytes_hash(&key_bytes),"maximumReservationLeaseMs":60000,"maximumObservationAgeMs":60000});
        let bytes = serde_json::to_vec(&config).unwrap();
        fs::write(&configuration, &bytes).unwrap();
        fs::set_permissions(&configuration, fs::Permissions::from_mode(0o600)).unwrap();
        Self {
            root,
            configuration,
            pin: bytes_hash(&bytes),
            value,
            key,
        }
    }
    fn database(&self, scenario: &str) -> Connection {
        let db = Connection::open(self.root.join("state.sqlite")).unwrap();
        if scenario == "commit-unknown" {
            db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE allowed_generations(value INTEGER PRIMARY KEY) STRICT; INSERT INTO allowed_generations VALUES(0);").unwrap();
        }
        for sql in self.value["schema"].as_array().unwrap() {
            let mut sql = sql.as_str().unwrap().to_owned();
            if scenario == "commit-unknown" && sql.starts_with("CREATE TABLE resident_state") {
                sql=sql.replace("generation INTEGER NOT NULL)","generation INTEGER NOT NULL,FOREIGN KEY(generation) REFERENCES allowed_generations(value) DEFERRABLE INITIALLY DEFERRED)");
            }
            db.execute_batch(&sql).unwrap();
        }
        if ["marker-failure", "abort-failure"].contains(&scenario) {
            db.execute_batch("CREATE TRIGGER coordinator_fixture_reject_marker BEFORE INSERT ON autonomous_research_online_mutation_authority_marker BEGIN SELECT RAISE(ABORT, 'injected_marker_failure'); END;").unwrap();
        }
        if scenario == "record-failure" {
            db.execute_batch("CREATE TRIGGER coordinator_fixture_reject_finalization BEFORE INSERT ON autonomous_research_online_mutation_finalization_receipt BEGIN SELECT RAISE(ABORT, 'injected_record_failure'); END;").unwrap();
        }
        let schema = exact_schema_hash_v1(&db).unwrap();
        db.execute("INSERT INTO autonomous_research_online_mutation_authority_metadata(singleton,schema_version,protocol,database_role,database_instance_id,schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,genesis_global_sequence,genesis_global_hash,genesis_database_sequence,genesis_database_hash,genesis_state_hash,provisioned_at) VALUES(1,1,?,?,?,?,?,?,?,0,?,0,?,?,?)",rusqlite::params![ONLINE_MUTATION_PROTOCOL,"resident-instance","resident-instance","resident-instance-schema-v1",schema,self.value["trust"]["databaseScopeHash"].as_str().unwrap(),self.value["trust"]["writerManifestHash"].as_str().unwrap(),h("genesis-global"),h("genesis-database"),h("genesis-state"),self.value["now"].as_str().unwrap()]).unwrap();
        db
    }
    fn coordinator(
        &self,
        db: &Connection,
        scenario: &str,
    ) -> (SqliteMutationCoordinatorV1<Transport>, Arc<Mutex<State>>) {
        self.coordinator_with_runtime(db, scenario, Box::new(|| Ok(NOW)), None)
    }
    fn coordinator_with_runtime(
        &self,
        db: &Connection,
        scenario: &str,
        clock: Box<dyn clock::MutationClockV1>,
        fence: Option<Box<dyn RecoverabilityEpochFenceV1>>,
    ) -> (SqliteMutationCoordinatorV1<Transport>, Arc<Mutex<State>>) {
        let schema = exact_schema_hash_v1(db).unwrap();
        let state = Arc::new(Mutex::new(State {
            scenario: scenario.into(),
            calls: vec![],
            reserved: None,
            allow_finalize: scenario != "finalize-failure",
            sequence: 0,
            database_hash: h("genesis-database"),
            state_hash: h("genesis-state"),
            global_hash: h("genesis-global"),
            schema,
        }));
        let transport = Transport {
            fixture: self.value.clone(),
            key: self.key.clone(),
            state: state.clone(),
        };
        let instances=transport.heads().as_array().unwrap().iter().map(|head|json!({"databaseRole":head["databaseRole"],"databaseInstanceId":head["databaseInstanceId"],"schemaHash":head["schemaHash"]})).collect::<Vec<_>>();
        let authority =
            PinnedMutationAuthorityV1::load(&self.configuration, &self.pin, transport).unwrap();
        let coordinator = SqliteMutationCoordinatorV1::new(
            authority,
            SqliteMutationCoordinatorOptionsV1 {
                manifest: self.value["manifest"].clone(),
                operation_plans: self.value["plans"].clone(),
                database_instances: json!(instances),
                requested_lease_ms: None,
                commit_safety_margin_ms: 1000,
            },
            clock,
            fence,
        )
        .unwrap();
        (coordinator, state)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
struct State {
    scenario: String,
    calls: Vec<Value>,
    reserved: Option<Value>,
    allow_finalize: bool,
    sequence: i64,
    global_hash: String,
    database_hash: String,
    state_hash: String,
    schema: String,
}
struct Transport {
    fixture: Value,
    key: SigningKey,
    state: Arc<Mutex<State>>,
}
impl Transport {
    fn sign(&self, mut value: Value) -> Value {
        let signature = self.key.sign(
            online_mutation_signed_payload_v1(&value)
                .unwrap()
                .as_bytes(),
        );
        value["signature"] = json!(Base64::encode_string(&signature.to_bytes()));
        value
    }
    fn heads(&self) -> Value {
        let state = self.state.lock().unwrap();
        let mut roles = DATABASE_ROLES.to_vec();
        roles.sort();
        json!(roles.into_iter().map(|role|{let local=role=="resident-instance";json!({"databaseRole":role,"databaseInstanceId":role,"sequence":if local{state.sequence}else{0},"hash":if local{state.database_hash.clone()}else{h(&format!("head:{role}"))},"schemaHash":if local{state.schema.clone()}else{h(&format!("schema:{role}"))},"stateHash":if local{state.state_hash.clone()}else{h(&format!("state:{role}"))}})}).collect::<Vec<_>>())
    }
}
impl MutationAuthorityTransportV1 for Transport {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        let kind = request["kind"].as_str().unwrap();
        let method = match kind {
            "AutonomousResearchOnlineMutationCurrentHeadRequest" => "head",
            "AutonomousResearchOnlineMutationReserveRequest" => "reserve",
            "AutonomousResearchOnlineMutationResolutionRequest" => "resolve",
            "AutonomousResearchOnlineMutationFinalizeRequest" => "finalize",
            _ => "abort",
        };
        self.state
            .lock()
            .unwrap()
            .calls
            .push(json!({"method":method,"request":request}));
        if method == "head" {
            let heads = self.heads();
            let state = self.state.lock().unwrap();
            let mut receipt = self.sign(json!({"version":1,"kind":"AutonomousResearchOnlineMutationCurrentHeadReceipt","status":"autonomous_research_online_mutation_current_head_observed","authorityId":"authority:test","keyId":"key:test","requestHash":hash(kind,request),"protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":"scope:test","databaseScopeHash":self.fixture["trust"]["databaseScopeHash"],"writerManifestHash":self.fixture["trust"]["writerManifestHash"],"globalSequence":state.sequence,"globalHash":state.global_hash,"databaseHeads":heads,"unresolvedReservationCount":0,"observedAt":self.fixture["now"],"expiresAt":"2026-07-18T08:01:00.000Z"}));
            if state.scenario == "wrong-head-request" {
                receipt["requestHash"] = json!(h("another-request"));
                receipt = self.sign(receipt);
            }
            if state.scenario == "bad-head-signature" {
                receipt["signature"] = json!(Base64::encode_string(&[0u8; 64]));
            }
            return Ok(receipt);
        }
        let mut state = self.state.lock().unwrap();
        let mut receipt = request.clone();
        receipt["authorityId"] = json!("authority:test");
        receipt["keyId"] = json!("key:test");
        receipt["requestHash"] = json!(hash(kind, request));
        match method {
            "reserve" => {
                if state.scenario == "reserve-not-found" {
                    return Err(failure("injected_reserve_failure"));
                }
                receipt.as_object_mut().unwrap().remove("requestedAt");
                receipt.as_object_mut().unwrap().remove("requestedLeaseMs");
                receipt["kind"] = json!("AutonomousResearchOnlineMutationReservationReceipt");
                receipt["status"] = json!("autonomous_research_online_mutation_reserved");
                receipt["reservationId"] = json!(format!("reservation:{}", state.sequence + 1));
                receipt["globalSequence"] =
                    json!(request["globalPreviousSequence"].as_i64().unwrap() + 1);
                receipt["globalHash"] = json!(h(&format!("global:{}", state.sequence + 1)));
                receipt["databaseSequence"] =
                    json!(request["databasePreviousSequence"].as_i64().unwrap() + 1);
                receipt["databaseHash"] = json!(h(&format!("database:{}", state.sequence + 1)));
                receipt["issuedAt"] = self.fixture["now"].clone();
                receipt["expiresAt"] = json!(if state.scenario == "expiring" {
                    "2026-07-18T08:00:00.500Z"
                } else {
                    "2026-07-18T08:01:00.000Z"
                });
                let receipt = self.sign(receipt);
                state.reserved = Some(receipt.clone());
                if ["reserve-lost", "resolve-failure"].contains(&state.scenario.as_str()) {
                    Err(failure("injected_reserve_failure"))
                } else {
                    Ok(receipt)
                }
            }
            "resolve" => {
                if state.scenario == "resolve-failure" {
                    return Err(failure("injected_resolution_failure"));
                }
                receipt["kind"] = json!("AutonomousResearchOnlineMutationResolutionReceipt");
                receipt["status"] =
                    json!("autonomous_research_online_mutation_resolution_observed");
                receipt["resolution"] = json!(if state.reserved.is_some() {
                    "reserved"
                } else {
                    "not-found"
                });
                receipt["reservation"] = state.reserved.clone().unwrap_or(Value::Null);
                receipt["observedAt"] = self.fixture["now"].clone();
                Ok(self.sign(receipt))
            }
            "finalize" => {
                if !state.allow_finalize {
                    return Err(failure("injected_finalization_failure"));
                }
                receipt.as_object_mut().unwrap().remove("committedAt");
                receipt["kind"] = json!("AutonomousResearchOnlineMutationFinalizationReceipt");
                receipt["status"] = json!("autonomous_research_online_mutation_finalized");
                receipt["sideEffectPermitHash"] = json!(h("permit"));
                receipt["finalizedAt"] = self.fixture["now"].clone();
                state.sequence = request["globalSequence"].as_i64().unwrap();
                state.global_hash = request["globalHash"].as_str().unwrap().into();
                state.database_hash = request["databaseHash"].as_str().unwrap().into();
                state.state_hash = request["postStateHash"].as_str().unwrap().into();
                Ok(self.sign(receipt))
            }
            _ => {
                if state.scenario == "abort-failure" {
                    return Err(failure("injected_abort_failure"));
                }
                receipt["kind"] = json!("AutonomousResearchOnlineMutationAbortReceipt");
                receipt["status"] = json!("autonomous_research_online_mutation_aborted");
                receipt["abortedAt"] = self.fixture["now"].clone();
                Ok(self.sign(receipt))
            }
        }
    }
}

use hepta_paper_service::online_finalized_head_inspection::*;
fn inventory(f: &Fixture, transport: &Transport) -> Value {
    let instances=transport.heads().as_array().unwrap().iter().map(|head|json!({"instanceId":head["databaseInstanceId"],"role":head["databaseRole"],"sourceRelativePath":format!("{}.sqlite",head["databaseInstanceId"].as_str().unwrap()),"schemaContractId":format!("{}-schema-v1",head["databaseRole"].as_str().unwrap()),"schemaHash":head["schemaHash"],"quickCheck":"ok","foreignKeyViolationCount":0,"missingSchemaObjects":[]})).collect::<Vec<_>>();
    let payload = json!({"manifestId":"hepta-paper-autonomous-research-state-databases-v1","manifestHash":h("database-manifest"),"databaseScopeHash":f.value["trust"]["databaseScopeHash"],"instances":instances});
    let mut value = payload.clone();
    value["version"] = json!(1);
    value["kind"] = json!("AutonomousResearchStateDatabaseInventory");
    value["status"] = json!("autonomous_research_state_database_inventory_ready");
    value["blockers"] = json!([]);
    value["inventoryHash"] = json!(hash("AutonomousResearchStateDatabaseInventory", &payload));
    value
}
fn sql_rows(db: &Connection, table: &str) -> Vec<Value> {
    let mut s = db.prepare(&format!("SELECT * FROM {table}")).unwrap();
    let names = s
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect::<Vec<_>>();
    s.query_map([], |row| {
        let mut out = serde_json::Map::new();
        for (i, n) in names.iter().enumerate() {
            out.insert(
                n.clone(),
                match row.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(v) => json!(v),
                    rusqlite::types::ValueRef::Real(v) => json!(v),
                    rusqlite::types::ValueRef::Text(v) => json!(std::str::from_utf8(v).unwrap()),
                    _ => panic!("unexpected blob"),
                },
            );
        }
        Ok(Value::Object(out))
    })
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}
fn snapshot(db: &Connection) -> Value {
    json!({"metadata":sql_rows(db,"autonomous_research_online_mutation_authority_metadata"),"markers":sql_rows(db,"autonomous_research_online_mutation_authority_marker"),"finalizations":sql_rows(db,"autonomous_research_online_mutation_finalization_receipt"),"business":sql_rows(db,"resident_state")})
}
fn head_oracle(requests: &[Value]) -> Vec<Value> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/online-finalized-head-inspection-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(requests).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "head oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&response["profile"]).unwrap();
    response["results"].as_array().unwrap().clone()
}
fn authority(
    f: &Fixture,
    state: &Arc<Mutex<State>>,
) -> (PinnedMutationAuthorityV1<Transport>, Value) {
    let transport = Transport {
        fixture: f.value.clone(),
        key: f.key.clone(),
        state: state.clone(),
    };
    let inventory = inventory(f, &transport);
    (
        PinnedMutationAuthorityV1::load(&f.configuration, &f.pin, transport).unwrap(),
        inventory,
    )
}
#[test]
fn genesis_and_complete_signed_history_match_node_without_local_writes() {
    for mutations in 0..=2 {
        let f = Fixture::new();
        let mut db = f.database("normal");
        let (mut coordinator, state) = f.coordinator(&db, "normal");
        for _ in 0..mutations {
            coordinator
                .execute_mutation(&mut db, &f.value["input"], |tx| {
                    tx.run("increment", &[])?;
                    Ok(json!({"mutated":true}))
                })
                .unwrap();
        }
        db.close().unwrap();
        let mut db = Connection::open(f.root.join("state.sqlite")).unwrap();
        let (mut authority, inventory) = authority(&f, &state);
        let before = snapshot(&db);
        let changes = db.total_changes();
        let verified = inspect_online_finalized_database_head_v1(
            &mut db,
            "resident-instance",
            &inventory,
            &mut authority,
            &f.value["manifest"],
            &mut || Ok(NOW),
        )
        .unwrap();
        assert_eq!(snapshot(&db), before);
        assert_eq!(db.total_changes(), changes);
        assert!(db.is_autocommit());
        assert_eq!(verified.value()["runtimeReady"], false);
        assert_eq!(verified.value()["markerCount"], mutations);
        let request = state.lock().unwrap().calls.last().unwrap()["request"].clone();
        let query = json!({"schema":f.value["schema"],"metadata":before["metadata"],"markers":before["markers"],"finalizations":before["finalizations"],"inventory":inventory,"manifest":f.value["manifest"],"trust":f.value["trust"],"publicKeyPem":f.key.verifying_key().to_public_key_pem(LineEnding::LF).unwrap(),"head":verified.current_head(),"request":request,"now":f.value["now"]});
        assert_eq!(
            head_oracle(&[query])[0],
            json!({"ok":true,"value":verified.value()})
        );
    }
}
fn mutate_protected(db: &Connection, trigger: &str, sql: &str) {
    let original: String = db
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name=?",
            [trigger],
            |r| r.get(0),
        )
        .unwrap();
    db.execute_batch(&format!("PRAGMA ignore_check_constraints=ON;DROP TRIGGER {trigger};{sql};{original};PRAGMA ignore_check_constraints=OFF;"))
        .unwrap();
}
#[test]
fn pending_wrong_genesis_manifest_and_stored_record_mutants_fail_closed() {
    for scenario in [
        "pending",
        "wrong-genesis",
        "wrong-writer",
        "wrong-marker",
        "wrong-finalized-time",
        "bad-finalization-signature",
        "duplicate-json",
    ] {
        let f = Fixture::new();
        let mut db = f.database("normal");
        let (mut coordinator, state) = f.coordinator(
            &db,
            if scenario == "pending" {
                "finalize-failure"
            } else {
                "normal"
            },
        );
        let result = coordinator.execute_mutation(&mut db, &f.value["input"], |tx| {
            tx.run("increment", &[])?;
            Ok(Value::Null)
        });
        if scenario == "pending" {
            assert!(result.is_err());
        } else {
            result.unwrap();
        }
        match scenario {
            "wrong-genesis" => mutate_protected(
                &db,
                "autonomous_research_online_mutation_metadata_no_update",
                "UPDATE autonomous_research_online_mutation_authority_metadata SET genesis_database_sequence=1",
            ),
            "wrong-writer" => mutate_protected(
                &db,
                "autonomous_research_online_mutation_marker_no_update",
                "UPDATE autonomous_research_online_mutation_authority_marker SET writer_id='writer:other'",
            ),
            "wrong-marker" => mutate_protected(
                &db,
                "autonomous_research_online_mutation_marker_no_update",
                "UPDATE autonomous_research_online_mutation_authority_marker SET pre_state_hash='sha256:0000000000000000000000000000000000000000000000000000000000000000'",
            ),
            "wrong-finalized-time" => mutate_protected(
                &db,
                "autonomous_research_online_mutation_finalization_no_update",
                "UPDATE autonomous_research_online_mutation_finalization_receipt SET recorded_at='2026-07-18T07:59:59.000Z'",
            ),
            "bad-finalization-signature" => {
                let text:String=db.query_row("SELECT finalization_receipt_json FROM autonomous_research_online_mutation_finalization_receipt",[],|r|r.get(0)).unwrap();
                let mut value: Value = serde_json::from_str(&text).unwrap();
                value["signature"] = json!(Base64::encode_string(&[0u8; 64]));
                let bytes = serde_json::to_string(&value).unwrap().replace('\'', "''");
                let digest = online_mutation_receipt_hash_v1(&value).unwrap();
                mutate_protected(
                    &db,
                    "autonomous_research_online_mutation_finalization_no_update",
                    &format!(
                        "UPDATE autonomous_research_online_mutation_finalization_receipt SET finalization_receipt_json='{bytes}',finalization_receipt_hash='{digest}'"
                    ),
                );
            }
            "duplicate-json" => mutate_protected(
                &db,
                "autonomous_research_online_mutation_marker_no_update",
                "UPDATE autonomous_research_online_mutation_authority_marker SET reserve_request_json='{'||'\"version\":1,'||substr(reserve_request_json,2)",
            ),
            _ => {}
        }
        db.close().unwrap();
        let mut db = Connection::open(f.root.join("state.sqlite")).unwrap();
        let (mut authority, inventory) = authority(&f, &state);
        let before = snapshot(&db);
        let result = inspect_online_finalized_database_head_v1(
            &mut db,
            "resident-instance",
            &inventory,
            &mut authority,
            &f.value["manifest"],
            &mut || Ok(NOW),
        );
        let failure = result
            .err()
            .unwrap_or_else(|| panic!("accepted {scenario}"));
        if scenario == "bad-finalization-signature" || scenario == "wrong-finalized-time" {
            assert_eq!(
                failure.code,
                "autonomous_research_online_finalized_head_finalization_invalid"
            );
        }
        if scenario == "duplicate-json" {
            assert_eq!(
                failure.code,
                "autonomous_research_online_finalized_head_reserve_request_json_invalid"
            );
        }
        assert_eq!(snapshot(&db), before);
        assert!(db.is_autocommit());
    }
}
#[test]
fn database_surface_and_head_expiry_are_enforced() {
    for scenario in [
        "attached",
        "temporary",
        "hidden-schema",
        "expired-after-transport",
        "foreign-head",
        "wrong-head-request",
        "bad-head-signature",
    ] {
        let f = Fixture::new();
        let mut db = f.database("normal");
        let (_coordinator, state) = f.coordinator(&db, scenario);
        match scenario {
            "attached" => db
                .execute_batch("ATTACH DATABASE ':memory:' AS other;")
                .unwrap(),
            "temporary" => db.execute_batch("CREATE TEMP TABLE hidden(x);").unwrap(),
            "hidden-schema" => db
                .execute_batch("CREATE TABLE sqliteX_hidden(id INTEGER PRIMARY KEY);")
                .unwrap(),
            "foreign-head" => state.lock().unwrap().database_hash = h("foreign"),
            _ => {}
        }
        let (mut authority, inventory) = authority(&f, &state);
        let before = snapshot(&db);
        let mut calls = 0;
        let mut clock = || {
            calls += 1;
            Ok(NOW
                + if scenario == "expired-after-transport" && calls >= 3 {
                    60_001
                } else {
                    0
                })
        };
        let failure = inspect_online_finalized_database_head_v1(
            &mut db,
            "resident-instance",
            &inventory,
            &mut authority,
            &f.value["manifest"],
            &mut clock,
        )
        .err()
        .unwrap_or_else(|| panic!("accepted {scenario}"));
        let expected = match scenario {
            "expired-after-transport" => {
                "autonomous_research_online_finalized_head_authority_evidence_expired"
            }
            "foreign-head" => "autonomous_research_online_finalized_head_local_authority_mismatch",
            "wrong-head-request" | "bad-head-signature" => {
                "autonomous_research_online_mutation_current_head_receipt_invalid"
            }
            _ => "autonomous_research_online_finalized_head_database_surface_invalid",
        };
        assert_eq!(failure.code, expected, "{scenario}");
        assert_eq!(snapshot(&db), before);
        assert!(db.is_autocommit());
    }
}
