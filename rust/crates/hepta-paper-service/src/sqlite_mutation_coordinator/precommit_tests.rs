//! Synthetic, signed authority and in-memory databases only. Private key bytes
//! never appear in oracle output or assertion diagnostics.
use crate::sqlite_mutation_coordinator::{
    authority::*, contracts::*, storage::exact_schema_hash_v1, *,
};
use base64ct::{Base64, Encoding};
use ed25519_dalek::{
    Signer, SigningKey,
    pkcs8::{EncodePublicKey, spki::der::pem::LineEnding},
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
            "hepta-sqlite-precommit-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let key = SigningKey::from_bytes(&[45u8; 32]);
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
        let db = Connection::open_in_memory().unwrap();
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
            return Ok(self.sign(json!({"version":1,"kind":"AutonomousResearchOnlineMutationCurrentHeadReceipt","status":"autonomous_research_online_mutation_current_head_observed","authorityId":"authority:test","keyId":"key:test","requestHash":hash(kind,request),"protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":"scope:test","databaseScopeHash":self.fixture["trust"]["databaseScopeHash"],"writerManifestHash":self.fixture["trust"]["writerManifestHash"],"globalSequence":state.sequence,"globalHash":state.global_hash,"databaseHeads":heads,"unresolvedReservationCount":0,"observedAt":self.fixture["now"],"expiresAt":"2026-07-18T08:01:00.000Z"})));
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
                receipt["reservationId"] = json!("reservation:one");
                receipt["globalSequence"] =
                    json!(request["globalPreviousSequence"].as_i64().unwrap() + 1);
                receipt["globalHash"] = json!(h("global:1"));
                receipt["databaseSequence"] =
                    json!(request["databasePreviousSequence"].as_i64().unwrap() + 1);
                receipt["databaseHash"] = json!(h("database:1"));
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

fn assert_rolled_back(database: &Connection) {
    assert!(database.is_autocommit());
    assert_eq!(
        database
            .query_row("SELECT generation FROM resident_state", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    for table in [
        "autonomous_research_online_mutation_authority_marker",
        "autonomous_research_online_mutation_finalization_receipt",
    ] {
        assert_eq!(
            database
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    // Also prove the failed/unwound invocation released its local writer lock.
    database
        .execute_batch("BEGIN IMMEDIATE; UPDATE resident_state SET generation=9; ROLLBACK;")
        .unwrap();
}
fn methods(state: &Arc<Mutex<State>>) -> Vec<String> {
    state
        .lock()
        .unwrap()
        .calls
        .iter()
        .map(|c| c["method"].as_str().unwrap().to_owned())
        .collect()
}
#[test]
fn accepted_precommit_scope_runs_after_reserve_and_before_finalization() {
    let fixture = Fixture::new();
    let mut database = fixture.database("success");
    let (mut coordinator, state) = fixture.coordinator(&database, "success");
    let mut checks = 0;
    let result = coordinator
        .execute_mutation_with_precommit_guard_v1(
            &mut database,
            &fixture.value["input"],
            |tx| {
                tx.run("increment", &[])?;
                Ok(Value::Null)
            },
            || {
                checks += 1;
                assert_eq!(methods(&state), ["head", "reserve"]);
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(checks, 1);
    assert_eq!(
        result["status"],
        "externally_fenced_sqlite_mutation_finalized"
    );
    assert!(database.is_autocommit());
    assert_eq!(
        database
            .query_row("SELECT generation FROM resident_state", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(methods(&state), ["head", "reserve", "finalize"]);
}
#[test]
fn rejected_precommit_scope_preserves_rich_error_and_rolls_back_reserved_mutation() {
    let fixture = Fixture::new();
    let mut database = fixture.database("success");
    let (mut coordinator, state) = fixture.coordinator(&database, "success");
    let expected = SqliteMutationCoordinatorError {
        code: "synthetic_precommit_scope_lost".into(),
        details: json!({"scope":"source-owned:test", "reason":"epoch_changed", "committed":false}),
        state_recoverability_fatal: true,
        state_recoverability_deferred: true,
        retryable: false,
    }
    .projection();
    let failure = coordinator.execute_mutation_with_precommit_guard_v1(
        &mut database, &fixture.value["input"],
        |tx| { tx.run("increment", &[])?; Ok(json!({"mutated":true})) },
        || {
            assert_eq!(methods(&state), ["head", "reserve"]);
            Err(SqliteMutationCoordinatorError {
                code: "synthetic_precommit_scope_lost".into(),
                details: json!({"scope":"source-owned:test", "reason":"epoch_changed", "committed":false}),
                state_recoverability_fatal: true,
                state_recoverability_deferred: true,
                retryable: false,
            })
        },
    ).unwrap_err();
    assert_eq!(failure.projection(), expected);
    assert_rolled_back(&database);
    assert_eq!(methods(&state), ["head", "reserve", "abort"]);
    let state = state.lock().unwrap();
    assert_eq!(
        state.calls[2]["request"]["reservationId"],
        state.reserved.as_ref().unwrap()["reservationId"]
    );
}
#[test]
fn precommit_scope_io_cannot_hide_expiring_reservation() {
    use std::{cell::Cell, rc::Rc};
    let fixture = Fixture::new();
    let mut database = fixture.database("success");
    let time = Rc::new(Cell::new(NOW));
    let clock_time = Rc::clone(&time);
    let (mut coordinator, state) = fixture.coordinator_with_runtime(
        &database,
        "success",
        Box::new(move || Ok(clock_time.get())),
        None,
    );
    let failure = coordinator
        .execute_mutation_with_precommit_guard_v1(
            &mut database,
            &fixture.value["input"],
            |tx| {
                tx.run("increment", &[])?;
                Ok(Value::Null)
            },
            || {
                assert_eq!(methods(&state), ["head", "reserve"]);
                time.set(NOW + 59_501);
                Ok(())
            },
        )
        .unwrap_err();
    assert_eq!(
        failure.code,
        "externally_fenced_sqlite_mutation_reservation_expiring"
    );
    assert_rolled_back(&database);
    assert_eq!(methods(&state), ["head", "reserve", "abort"]);
}
#[test]
fn precommit_unwind_releases_local_transaction_but_does_not_claim_external_abort() {
    let fixture = Fixture::new();
    let mut database = fixture.database("success");
    let (mut coordinator, state) = fixture.coordinator(&database, "success");
    let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        coordinator.execute_mutation_with_precommit_guard_v1(
            &mut database,
            &fixture.value["input"],
            |tx| {
                tx.run("increment", &[])?;
                Ok(Value::Null)
            },
            || {
                assert_eq!(methods(&state), ["head", "reserve"]);
                panic!("synthetic precommit scope unwind")
            },
        )
    }));
    assert!(unwound.is_err());
    assert_rolled_back(&database);
    // The actual signed reservation exists remotely. The owner must explicitly
    // reconcile it; Drop only guarantees local rollback, never network RPC.
    assert_eq!(methods(&state), ["head", "reserve"]);
    assert!(state.lock().unwrap().reserved.is_some());
}
#[test]
fn no_change_does_not_reserve_or_invoke_precommit_scope() {
    let fixture = Fixture::new();
    let mut database = fixture.database("success");
    let (mut coordinator, state) = fixture.coordinator(&database, "success");
    let result = coordinator
        .execute_mutation_with_precommit_guard_v1(
            &mut database,
            &fixture.value["input"],
            |_| Ok(Value::Null),
            || panic!("no durable commit has no precommit scope hook"),
        )
        .unwrap();
    assert_eq!(
        result["status"],
        "externally_fenced_sqlite_mutation_no_change"
    );
    assert_rolled_back(&database);
    assert_eq!(methods(&state), ["head"]);
}
