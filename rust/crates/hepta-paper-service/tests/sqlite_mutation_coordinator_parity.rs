//! Synthetic, signed authority and in-memory databases only. Private key bytes
//! never appear in oracle output or assertion diagnostics.
use base64ct::{Base64, Encoding};
use ed25519_dalek::{
    Signer, SigningKey,
    pkcs8::{EncodePrivateKey, EncodePublicKey, spki::der::pem::LineEnding},
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
    private_path: PathBuf,
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
            "hepta-sqlite-coordinator-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let key = SigningKey::from_bytes(&[45u8; 32]);
        let private_path = root.join("synthetic-private.pem");
        let private = key.to_pkcs8_pem(LineEnding::LF).unwrap();
        fs::write(&private_path, private.as_bytes()).unwrap();
        fs::set_permissions(&private_path, fs::Permissions::from_mode(0o600)).unwrap();
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
            private_path,
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
fn normalized(result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => {
            json!({"ok":false,"error":error.code,"committed":error.details.get("committed").cloned().unwrap_or(Value::Null)})
        }
    }
}
fn first_difference(actual: &Value, expected: &Value, path: &str) -> Option<String> {
    if actual == expected {
        return None;
    }
    match (actual, expected) {
        (Value::Object(a), Value::Object(b)) => {
            if a.keys().collect::<Vec<_>>() != b.keys().collect::<Vec<_>>() {
                return Some(format!(
                    "{path}: object keys differ {:?} != {:?}",
                    a.keys().collect::<Vec<_>>(),
                    b.keys().collect::<Vec<_>>()
                ));
            }
            for (key, v) in a {
                if let Some(diff) = first_difference(v, &b[key], &format!("{path}.{key}")) {
                    return Some(diff);
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(format!("{path}: length {} != {}", a.len(), b.len()));
            }
            for (index, (a, b)) in a.iter().zip(b).enumerate() {
                if let Some(diff) = first_difference(a, b, &format!("{path}[{index}]")) {
                    return Some(diff);
                }
            }
        }
        _ => return Some(format!("{path}: {actual} != {expected}")),
    }
    None
}
fn count(db: &Connection, table: &str) -> i64 {
    db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
#[test]
fn signed_coordinator_commit_no_change_resolution_abort_and_recovery_match_node() {
    for scenario in [
        "success",
        "no-change",
        "reserve-lost",
        "reserve-not-found",
        "resolve-failure",
        "expiring",
        "marker-failure",
        "record-failure",
        "finalize-failure",
        "abort-failure",
        "lease-before-marker",
        "lease-before-commit",
        "commit-unknown",
    ] {
        let fixture = Fixture::new();
        let mut db = fixture.database(scenario);
        let advance_at = match scenario {
            "lease-before-marker" => Some(5),
            "lease-before-commit" => Some(6),
            _ => None,
        };
        let mut calls_to_clock = 0;
        let clock = Box::new(move || {
            calls_to_clock += 1;
            Ok(NOW
                + if advance_at.is_some_and(|step| calls_to_clock >= step) {
                    59501
                } else {
                    0
                })
        });
        let (mut coordinator, state) = fixture.coordinator_with_runtime(&db, scenario, clock, None);
        let result = normalized(coordinator.execute_mutation(
            &mut db,
            &fixture.value["input"],
            |transaction| {
                if scenario != "no-change" {
                    transaction.run("increment", &[])?;
                }
                Ok(json!({"mutated":scenario!="no-change"}))
            },
        ));
        let recovery = if scenario == "finalize-failure" {
            state.lock().unwrap().allow_finalize = true;
            Some(normalized(coordinator.recover_pending_mutations(&mut db)))
        } else {
            None
        };
        let calls = state.lock().unwrap().calls.clone();
        let nonces = calls
            .iter()
            .filter_map(|c| {
                c["request"]
                    .get("nonce")
                    .or_else(|| c["request"].get("mutationAttemptId"))
                    .and_then(Value::as_str)
                    .filter(|_| c["method"] == "head" || c["method"] == "reserve")
                    .map(|s| s.split_once(':').unwrap().1.to_owned())
            })
            .collect::<Vec<_>>();
        let native = json!({"result":result,"recovery":recovery,"calls":calls,"status":coordinator.inspect_status(),"generation":db.query_row("SELECT generation FROM resident_state",[],|r|r.get::<_,i64>(0)).unwrap(),"markerCount":count(&db,"autonomous_research_online_mutation_authority_marker"),"finalizationCount":count(&db,"autonomous_research_online_mutation_finalization_receipt")});
        let expected = oracle(&[
            json!({"operation":"coordinator","privateKeyPath":fixture.private_path,"scenario":scenario,"nonces":nonces,"recover":scenario=="finalize-failure","advanceClockAt":advance_at}),
        ]);
        assert_eq!(
            expected[0]["ok"], true,
            "oracle {scenario}: {}",
            expected[0]["error"]
        );
        assert!(
            first_difference(&native, &expected[0]["value"], "$").is_none(),
            "scenario {scenario}: {}",
            first_difference(&native, &expected[0]["value"], "$").unwrap_or_default()
        );
        assert!(db.is_autocommit());
    }
}
#[test]
fn manifest_validation_and_hashes_match_node_for_coverage_and_assignment_attacks() {
    let fixture = Fixture::new();
    let original = fixture.value["manifest"].clone();
    let mut variants = vec![original.clone()];
    for path in [
        "kind",
        "manifestId",
        "protocol",
        "requiredDatabaseRoles",
        "coverage",
        "writers",
        "operations",
    ] {
        let mut v = original.clone();
        v[path] = Value::Null;
        variants.push(v);
    }
    for case in 0..7 {
        let mut v = original.clone();
        match case {
            0 => v["operations"][0]["extra"] = json!(true),
            1 => v["operations"][1] = v["operations"][0].clone(),
            2 => v["writers"][0]["implementationHash"] = json!("bad"),
            3 => v["writers"][0]["operationIds"] = json!([]),
            4 => v["coverage"]["percent"] = json!(100),
            5 => v["writers"] = json!([]),
            _ => v["operations"][0]["coordinatorIntegrated"] = json!(true),
        }
        variants.push(v);
    }
    let requests = variants
        .iter()
        .map(|v| json!({"operation":"manifest","value":v}))
        .collect::<Vec<_>>();
    let expected = oracle(&requests);
    for (index, value) in variants.iter().enumerate() {
        let actual = match manifest::writer_manifest_hash_v1(value) {
            Ok(hash) => json!({"ok":true,"value":hash}),
            Err(e) => json!({"ok":false,"error":e.code}),
        };
        assert_eq!(actual, expected[index], "case {index}");
    }
}

#[derive(Default)]
struct FenceLog {
    requirements: Vec<Value>,
    heads: Vec<Value>,
    fatal: bool,
}
struct Fence(Arc<Mutex<FenceLog>>);
impl RecoverabilityEpochFenceV1 for Fence {
    fn mark_mutation_finalized(&mut self, head: &Value) -> Result<()> {
        let mut log = self.0.lock().unwrap();
        log.heads.push(head.clone());
        if log.fatal {
            let mut error = failure("injected_fatal_epoch");
            error.state_recoverability_fatal = true;
            return Err(error);
        }
        Ok(())
    }
    fn mark_mutation_reconciliation_required(&mut self, requirement: &Value) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .requirements
            .push(requirement.clone());
        Ok(())
    }
    fn assert_current(&mut self) -> Result<Value> {
        Ok(json!({"status":"current"}))
    }
    fn reconcile(&mut self) -> Result<Value> {
        Ok(json!({"status":"ready"}))
    }
}
#[test]
fn pending_recovery_requires_retry_before_callback_and_preserves_fatal_fence() {
    let fixture = Fixture::new();
    let mut db = fixture.database("finalize-failure");
    let log = Arc::new(Mutex::new(FenceLog::default()));
    let (mut coordinator, state) = fixture.coordinator_with_runtime(
        &db,
        "finalize-failure",
        Box::new(|| Ok(NOW)),
        Some(Box::new(Fence(log.clone()))),
    );
    let error = coordinator
        .execute_mutation(&mut db, &fixture.value["input"], |transaction| {
            transaction.run("increment", &[])?;
            Ok(json!(1))
        })
        .unwrap_err();
    assert_eq!(
        error.code,
        "externally_fenced_sqlite_mutation_committed_finalization_pending"
    );
    assert!(error.retryable && error.state_recoverability_deferred);
    assert_eq!(log.lock().unwrap().requirements.len(), 1);
    assert_eq!(log.lock().unwrap().requirements[0]["committed"], true);
    state.lock().unwrap().allow_finalize = true;
    let mut invoked = false;
    let error = coordinator
        .execute_mutation(&mut db, &fixture.value["input"], |_| {
            invoked = true;
            Ok(json!(2))
        })
        .unwrap_err();
    assert!(!invoked);
    assert_eq!(
        error.code,
        "externally_fenced_sqlite_mutation_pending_recovery_completed_retry_required"
    );
    assert!(error.retryable);
    assert_eq!(log.lock().unwrap().requirements.len(), 1);
    assert_eq!(log.lock().unwrap().heads.len(), 1);
    assert_eq!(
        count(
            &db,
            "autonomous_research_online_mutation_finalization_receipt"
        ),
        1
    );
    // A separate clean transaction reaches the epoch callback after durable commit.
    let other = Fixture::new();
    let mut other_db = other.database("success");
    let fatal_log = Arc::new(Mutex::new(FenceLog {
        fatal: true,
        ..FenceLog::default()
    }));
    let (mut coordinator, _) = other.coordinator_with_runtime(
        &other_db,
        "success",
        Box::new(|| Ok(NOW)),
        Some(Box::new(Fence(fatal_log))),
    );
    let error = coordinator
        .execute_mutation(&mut other_db, &other.value["input"], |transaction| {
            transaction.run("increment", &[])?;
            Ok(json!(1))
        })
        .unwrap_err();
    assert!(error.state_recoverability_fatal);
    assert!(!error.state_recoverability_deferred);
    assert_eq!(error.details["committed"], true);
    assert_eq!(
        count(
            &other_db,
            "autonomous_research_online_mutation_finalization_receipt"
        ),
        1
    );
}
#[test]
fn recovery_rejects_corrupted_request_receipt_marker_and_signature() {
    for scenario in ["request-json", "receipt-json", "marker-hash", "signature"] {
        let fixture = Fixture::new();
        let mut db = fixture.database("finalize-failure");
        let (mut coordinator, state) = fixture.coordinator(&db, "finalize-failure");
        assert!(
            coordinator
                .execute_mutation(&mut db, &fixture.value["input"], |tx| {
                    tx.run("increment", &[])?;
                    Ok(Value::Null)
                })
                .is_err()
        );
        state.lock().unwrap().allow_finalize = true;
        let trigger:String=db.query_row("SELECT sql FROM sqlite_schema WHERE name='autonomous_research_online_mutation_marker_no_update'",[],|r|r.get(0)).unwrap();
        db.execute_batch("DROP TRIGGER autonomous_research_online_mutation_marker_no_update;")
            .unwrap();
        db.execute_batch("PRAGMA ignore_check_constraints=ON;")
            .unwrap();
        match scenario {
            "request-json" => {
                db.execute("UPDATE autonomous_research_online_mutation_authority_marker SET reserve_request_json='{'",[]).unwrap();
            }
            "receipt-json" => {
                db.execute("UPDATE autonomous_research_online_mutation_authority_marker SET reservation_receipt_json='{'",[]).unwrap();
            }
            "marker-hash" => {
                db.execute("UPDATE autonomous_research_online_mutation_authority_marker SET local_marker_hash=?",[h("wrong-marker")]).unwrap();
            }
            _ => {
                let value:String=db.query_row("SELECT reservation_receipt_json FROM autonomous_research_online_mutation_authority_marker",[],|r|r.get(0)).unwrap();
                let mut receipt: Value = serde_json::from_str(&value).unwrap();
                receipt["signature"] = json!(Base64::encode_string(&[0u8; 64]));
                db.execute("UPDATE autonomous_research_online_mutation_authority_marker SET reservation_receipt_json=?,reservation_receipt_hash=?",rusqlite::params![receipt.to_string(),online_mutation_receipt_hash_v1(&receipt).unwrap()]).unwrap();
            }
        }
        db.execute_batch("PRAGMA ignore_check_constraints=OFF;")
            .unwrap();
        db.execute_batch(&trigger).unwrap();
        let before = state.lock().unwrap().calls.len();
        let error = coordinator.recover_pending_mutations(&mut db).unwrap_err();
        assert_eq!(
            error.code,
            match scenario {
                "request-json" => "externally_fenced_sqlite_mutation_recovery_request_invalid",
                "marker-hash" => "externally_fenced_sqlite_mutation_recovery_marker_mismatch",
                _ => "externally_fenced_sqlite_mutation_recovery_reservation_invalid",
            }
        );
        assert_eq!(state.lock().unwrap().calls.len(), before);
        assert_eq!(
            count(
                &db,
                "autonomous_research_online_mutation_finalization_receipt"
            ),
            0
        );
        assert!(db.is_autocommit());
    }
}
#[test]
fn invalid_input_nested_transaction_and_local_metadata_fail_before_authority() {
    let fixture = Fixture::new();
    let mut db = fixture.database("success");
    let (mut coordinator, state) = fixture.coordinator(&db, "success");
    let mut input = fixture.value["input"].clone();
    input["codeProvenanceHash"] = json!(h("wrong-code"));
    assert_eq!(
        coordinator
            .execute_mutation(&mut db, &input, |_| panic!("invalid callback reached"))
            .unwrap_err()
            .code,
        "externally_fenced_sqlite_mutation_input_invalid"
    );
    db.execute_batch("BEGIN;").unwrap();
    assert_eq!(
        coordinator
            .execute_mutation(&mut db, &fixture.value["input"], |_| panic!(
                "nested callback reached"
            ))
            .unwrap_err()
            .code,
        "externally_fenced_sqlite_mutation_nested_forbidden"
    );
    assert!(!db.is_autocommit());
    db.execute_batch("ROLLBACK;").unwrap();
    let mut input = fixture.value["input"].clone();
    input["databaseInstanceId"] = json!("other-instance");
    assert_eq!(
        coordinator
            .execute_mutation(&mut db, &input, |_| panic!("metadata callback reached"))
            .unwrap_err()
            .code,
        "externally_fenced_sqlite_mutation_metadata_mismatch"
    );
    assert!(state.lock().unwrap().calls.is_empty());
}

#[test]
fn unexpected_callback_unwind_rolls_back_without_reserving_external_authority() {
    let fixture = Fixture::new();
    let mut db = fixture.database("success");
    let (mut coordinator, state) = fixture.coordinator(&db, "success");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        coordinator.execute_mutation(&mut db, &fixture.value["input"], |tx| {
            tx.run("increment", &[])?;
            panic!("synthetic callback failure")
        })
    }));
    assert!(result.is_err());
    assert!(db.is_autocommit());
    assert_eq!(
        db.query_row("SELECT generation FROM resident_state", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(state.lock().unwrap().calls.len(), 1);
    assert_eq!(state.lock().unwrap().calls[0]["method"], "head");
}
