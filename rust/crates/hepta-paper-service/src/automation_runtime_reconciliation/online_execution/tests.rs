//! Real schema25 business paths and signed test-authority differential checks.
//! Dedicated temporary databases and fixture keys never establish production
//! admission. Private key bytes never appear in output or assertion diagnostics.
use super::*;
use crate::sqlite_mutation_coordinator::{
    authority::*, contracts::*, storage::exact_schema_hash_v1, *,
};
use base64ct::{Base64, Encoding};
use ed25519_dalek::{
    Signer, SigningKey,
    pkcs8::{EncodePrivateKey, EncodePublicKey, spki::der::pem::LineEnding},
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
        .arg(root.join("rust/oracle/automation-reconciliation-online-v1.mjs"))
        .env_remove("HEPTA_RELEASE_COMMIT")
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
    fn new(legacy: bool) -> Self {
        let value = oracle(&[json!({"operation":"fixture"})])[0]["value"].clone();
        assert_eq!(clock::iso(NOW).unwrap(), value["now"]);
        let root = std::env::temp_dir().join(format!(
            "hepta-online-reconciliation-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let initial = root.join("initial.sqlite");
        let mut command = Command::new("node");
        command
            .arg(repository.join(if legacy {
                "rust/oracle/legacy-terminal-active-residue-v1.mjs"
            } else {
                "rust/oracle/automation-runtime-reconciliation-v1.mjs"
            }))
            .args(["--database", initial.to_str().unwrap(), "--prepare"]);
        if legacy {
            command.args(["--prepare-only", "--queued", "513"]);
        }
        let prepared = command.env_remove("HEPTA_RELEASE_COMMIT").output().unwrap();
        assert!(
            prepared.status.success(),
            "fixture preparation failed: {}",
            String::from_utf8_lossy(&prepared.stderr)
        );
        fs::copy(&initial, root.join("node.sqlite")).unwrap();
        fs::copy(&initial, root.join("rust.sqlite")).unwrap();
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
        let db = Connection::open(self.root.join("rust.sqlite")).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
            .unwrap();
        for sql in self.value["schema"].as_array().unwrap() {
            db.execute_batch(sql.as_str().unwrap()).unwrap();
        }
        if ["marker-failure", "abort-failure"].contains(&scenario) {
            db.execute_batch("CREATE TRIGGER coordinator_fixture_reject_marker BEFORE INSERT ON autonomous_research_online_mutation_authority_marker BEGIN SELECT RAISE(ABORT, 'injected_marker_failure'); END;").unwrap();
        }
        if scenario == "record-failure" {
            db.execute_batch("CREATE TRIGGER coordinator_fixture_reject_finalization BEFORE INSERT ON autonomous_research_online_mutation_finalization_receipt BEGIN SELECT RAISE(ABORT, 'injected_record_failure'); END;").unwrap();
        }
        if scenario == "receipt-failure" {
            db.execute_batch("CREATE TEMP TRIGGER reconciliation_online_receipt_failure BEFORE INSERT ON receipt_ledger BEGIN SELECT RAISE(ABORT,'fixture_receipt_failure'); END").unwrap();
        }
        if scenario == "event-failure" {
            db.execute_batch("CREATE TEMP TRIGGER reconciliation_online_event_failure BEFORE INSERT ON campaign_events BEGIN SELECT RAISE(ABORT,'fixture_event_failure'); END").unwrap();
        }
        let schema = exact_schema_hash_v1(&db).unwrap();
        db.execute("INSERT INTO autonomous_research_online_mutation_authority_metadata(singleton,schema_version,protocol,database_role,database_instance_id,schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,genesis_global_sequence,genesis_global_hash,genesis_database_sequence,genesis_database_hash,genesis_state_hash,provisioned_at) VALUES(1,1,?,?,?,?,?,?,?,0,?,0,?,?,?)",rusqlite::params![ONLINE_MUTATION_PROTOCOL,"native-store","native-store","native-store-schema25-fixture-v1",schema,self.value["trust"]["databaseScopeHash"].as_str().unwrap(),self.value["trust"]["writerManifestHash"].as_str().unwrap(),h("genesis-global"),h("genesis-database"),h("genesis-state"),self.value["now"].as_str().unwrap()]).unwrap();
        db
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
        let mut transport_fixture = self.value.clone();
        transport_fixture["nativeDatabasePath"] = json!(self.root.join("rust.sqlite"));
        let transport = Transport {
            fixture: transport_fixture,
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
        json!(roles.into_iter().map(|role|{let local=role=="native-store";json!({"databaseRole":role,"databaseInstanceId":role,"sequence":if local{state.sequence}else{0},"hash":if local{state.database_hash.clone()}else{h(&format!("head:{role}"))},"schemaHash":if local{state.schema.clone()}else{h(&format!("schema:{role}"))},"stateHash":if local{state.state_hash.clone()}else{h(&format!("state:{role}"))}})}).collect::<Vec<_>>())
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
            let scenario = self.state.lock().unwrap().scenario.clone();
            let sql = match scenario.as_str() {
                "stale-parent-revision" => Some(
                    "UPDATE paper_campaigns SET revision=revision+1 WHERE campaign_id IN ('campaign-2','legacy-campaign')",
                ),
                "stale-node-generation" => Some(
                    "UPDATE campaign_nodes SET lease_generation=lease_generation+1 WHERE node_id IN ('node-1','legacy:expired-a')",
                ),
                "same-count-queued" => Some(
                    "UPDATE campaign_nodes SET node_revision=node_revision+1 WHERE node_id IN ('node-3','legacy:queued-0000')",
                ),
                _ => None,
            };
            // Real competing connection runs after business planning, before
            // the coordinator begins its transaction, matching the Node oracle.
            if let Some(sql) = sql {
                Connection::open(self.fixture["nativeDatabasePath"].as_str().unwrap())
                    .unwrap()
                    .execute_batch(sql)
                    .unwrap();
            }
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
            json!({"ok":false,"error":error.code,"committed":error.details.get("committed").cloned().unwrap_or(Value::Null),"stateRecoverabilityFatal":error.state_recoverability_fatal,"stateRecoverabilityDeferred":error.state_recoverability_deferred,"retryable":error.retryable})
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

struct BusinessClock {
    now: &'static str,
    calls: Vec<&'static str>,
    fail_at: Option<usize>,
}
impl super::super::offline_execution::ReconciliationClockV1 for BusinessClock {
    fn now_iso(
        &mut self,
    ) -> std::result::Result<String, super::super::AutomationRuntimeReconciliationError> {
        self.calls.push("nowIso");
        if self.fail_at == Some(self.calls.len()) {
            return Err(
                super::super::AutomationRuntimeReconciliationError::Precondition(
                    "fixture_after_plan_clock_failure",
                ),
            );
        }
        Ok(self.now.into())
    }
    fn now_millis(
        &mut self,
    ) -> std::result::Result<i64, super::super::AutomationRuntimeReconciliationError> {
        self.calls.push("now");
        if self.fail_at == Some(self.calls.len()) {
            return Err(
                super::super::AutomationRuntimeReconciliationError::Precondition(
                    "fixture_after_plan_clock_failure",
                ),
            );
        }
        Ok(
            crate::journal_connector_coverage::qualification::canonical_instant_millis(self.now)
                .unwrap(),
        )
    }
}
struct EpochFence {
    log: Arc<Mutex<Vec<Value>>>,
    fatal: bool,
}
impl RecoverabilityEpochFenceV1 for EpochFence {
    fn mark_mutation_finalized(&mut self, head: &Value) -> Result<()> {
        self.log
            .lock()
            .unwrap()
            .push(json!({"method":"finalized","value":head}));
        if self.fatal {
            let mut e = failure("fixture_epoch_lost");
            e.state_recoverability_fatal = true;
            return Err(e);
        }
        Ok(())
    }
    fn mark_mutation_reconciliation_required(&mut self, requirement: &Value) -> Result<()> {
        self.log
            .lock()
            .unwrap()
            .push(json!({"method":"required","value":requirement}));
        Ok(())
    }
    fn assert_current(&mut self) -> Result<Value> {
        self.log.lock().unwrap().push(json!({"method":"current"}));
        Ok(json!({"status":"current"}))
    }
    fn reconcile(&mut self) -> Result<Value> {
        self.log.lock().unwrap().push(json!({"method":"reconcile"}));
        Ok(json!({"status":"current"}))
    }
}
fn snapshot(db: &Connection) -> Value {
    let tables=super::super::rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB 'autonomous_research_online_mutation_*' ORDER BY name",[]).unwrap();
    let mut value = json!({});
    for table in tables {
        let name = table["name"].as_str().unwrap();
        let mut records = super::super::rows(
            db,
            &format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")),
            [],
        )
        .unwrap();
        for record in &mut records {
            for v in record.as_object_mut().unwrap().values_mut() {
                if let Some(n) = v.as_f64() {
                    *v = serde_json::from_str(ryu_js::Buffer::new().format(n)).unwrap();
                }
            }
        }
        records.sort_by_key(|a| serde_json::to_string(a).unwrap());
        value[name] = json!(records);
    }
    value
}
fn canonical_snapshot(value: &Value) -> Value {
    let mut value = value.clone();
    for rows in value.as_object_mut().unwrap().values_mut() {
        rows.as_array_mut()
            .unwrap()
            .sort_by_key(|a| serde_json::to_string(a).unwrap());
    }
    value
}
fn request(legacy: bool) -> OnlineReconciliationRequestV1 {
    OnlineReconciliationRequestV1 {
        operation: if legacy {
            LocalReconciliationOperationV1::LegacyTerminalActiveResidue
        } else {
            LocalReconciliationOperationV1::Standard
        },
        campaign_id: legacy.then(|| "legacy-campaign".into()),
        no_progress_seconds: 1800.0,
        release_commit: None,
    }
}
fn binding() -> OnlineReconciliationBindingV1 {
    OnlineReconciliationBindingV1 {
        database_instance_id: "native-store".into(),
        schema_contract_id: "native-store-schema25-fixture-v1".into(),
    }
}
fn business_clock(legacy: bool) -> BusinessClock {
    BusinessClock {
        now: if legacy {
            "2026-08-01T05:00:00.000Z"
        } else {
            "2026-07-13T08:00:00.000Z"
        },
        calls: vec![],
        fail_at: None,
    }
}
fn run_differential(legacy: bool, scenario: &str, epoch_fence: bool) {
    run_differential_with_numeric(legacy, scenario, epoch_fence, None);
}
fn run_differential_with_numeric(
    legacy: bool,
    scenario: &str,
    epoch_fence: bool,
    numeric: Option<(&str, &str)>,
) {
    let fixture = Fixture::new(legacy);
    if let Some((column, text)) = numeric {
        assert!(["lease_generation", "node_revision"].contains(&column));
        let node = if legacy { "legacy:expired-a" } else { "node-4" };
        for file in ["rust.sqlite", "node.sqlite"] {
            let connection = Connection::open(fixture.root.join(file)).unwrap();
            connection
                .execute(
                    &format!("UPDATE campaign_nodes SET {column}=? WHERE node_id=?"),
                    [text, node],
                )
                .unwrap();
            assert_eq!(
                connection
                    .query_row(
                        &format!("SELECT typeof({column}) FROM campaign_nodes WHERE node_id=?"),
                        [node],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                "text"
            );
        }
    }
    let mut db = fixture.database(scenario);
    let before = snapshot(&db);
    let epoch_log = Arc::new(Mutex::new(vec![]));
    let fence = epoch_fence.then(|| {
        Box::new(EpochFence {
            log: epoch_log.clone(),
            fatal: scenario == "fatal-epoch",
        }) as Box<dyn RecoverabilityEpochFenceV1>
    });
    let (mut coordinator, state) =
        fixture.coordinator_with_runtime(&db, scenario, Box::new(|| Ok(NOW)), fence);
    let mut clock = business_clock(legacy);
    let result = normalized(execute_with_coordinator(
        &mut db,
        &mut coordinator,
        &binding(),
        &request(legacy),
        &mut clock,
        || {
            if scenario == "before-apply" {
                Err(failure("fixture_scope_lost_before"))
            } else {
                Ok(())
            }
        },
        || {
            if scenario == "after-apply" {
                Err(failure("fixture_scope_lost_after"))
            } else {
                Ok(())
            }
        },
        || Ok(()),
    ));
    let recovery = if scenario == "finalize-failure" {
        state.lock().unwrap().allow_finalize = true;
        Some(match coordinator.recover_pending_mutations(&mut db) {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(e) => json!({"ok":false,"error":e.code}),
        })
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
    let native = json!({"result":result,"recovery":recovery,"calls":calls,"status":coordinator.inspect_status(),"snapshot":snapshot(&db),"businessCalls":clock.calls,"epochCalls":epoch_log.lock().unwrap().clone(),"markerCount":count(&db,"autonomous_research_online_mutation_authority_marker"),"finalizationCount":count(&db,"autonomous_research_online_mutation_finalization_receipt")});
    let expected = oracle(&[
        json!({"operation":"coordinator","privateKeyPath":fixture.private_path,"databasePath":fixture.root.join("node.sqlite"),"scenario":scenario,"nonces":nonces,"recover":scenario=="finalize-failure","legacy":legacy,"campaignId":if legacy {Some("legacy-campaign")}else{None},"businessNow":clock.now,"epochFence":epoch_fence}),
    ]);
    assert_eq!(
        expected[0]["ok"], true,
        "oracle {scenario}: {}",
        expected[0]["error"]
    );
    let mut expected = expected[0]["value"].clone();
    expected["snapshot"] = canonical_snapshot(&expected["snapshot"]);
    assert!(
        first_difference(&native, &expected, "$").is_none(),
        "legacy={legacy} scenario={scenario} epoch={epoch_fence}: {}",
        first_difference(&native, &expected, "$").unwrap_or_default()
    );
    assert!(db.is_autocommit());
    if [
        "receipt-failure",
        "event-failure",
        "before-apply",
        "after-apply",
        "marker-failure",
        "abort-failure",
        "reserve-not-found",
        "resolve-failure",
        "expiring",
    ]
    .contains(&scenario)
    {
        assert_eq!(snapshot(&db), before, "rollback {scenario}");
    }
    if numeric.is_some() {
        assert_eq!(result["ok"], false, "numeric fence must reject {numeric:?}");
        assert_eq!(snapshot(&db), before, "numeric rollback {numeric:?}");
        assert_eq!(native["markerCount"], 0);
        assert_eq!(native["finalizationCount"], 0);
        assert!(
            calls.iter().all(|call| call["method"] == "head"),
            "numeric fence must fail before any reservation"
        );
    }
    if result["ok"] == true {
        assert_eq!(native["markerCount"], 1);
        assert_eq!(native["finalizationCount"], 1);
        assert_ne!(snapshot(&db), before);
        assert_eq!(
            coordinator
                .verify_latest_finalized_mutation(&db, "native-store")
                .unwrap()
                .value()["kind"],
            "AutonomousResearchOnlineMutationFinalizationReceipt"
        );
    }
}
#[test]
fn real_signed_online_standard_and_legacy_business_receipts_changesets_and_state_match_node() {
    for legacy in [false, true] {
        run_differential(legacy, "success", false);
    }
}
#[test]
fn real_online_statement_and_callback_failures_roll_back_business_receipt_and_events() {
    for legacy in [false, true] {
        for scenario in [
            "receipt-failure",
            "event-failure",
            "before-apply",
            "after-apply",
        ] {
            run_differential(legacy, scenario, false);
        }
    }
}
#[test]
fn real_signed_reservation_abort_and_finalization_recovery_match_node() {
    for legacy in [false, true] {
        for scenario in [
            "reserve-lost",
            "reserve-not-found",
            "resolve-failure",
            "expiring",
            "marker-failure",
            "abort-failure",
            "record-failure",
            "finalize-failure",
        ] {
            run_differential(legacy, scenario, false);
        }
    }
}
#[test]
fn recoverability_control_flags_and_fatal_epoch_survive_online_business_wrapper() {
    for legacy in [false, true] {
        for scenario in ["success", "finalize-failure", "fatal-epoch"] {
            run_differential(legacy, scenario, true);
        }
    }
}
#[test]
fn post_reservation_scope_loss_rolls_back_business_and_receipt_and_aborts_signed_reservation() {
    for legacy in [false, true] {
        let fixture = Fixture::new(legacy);
        let mut db = fixture.database("success");
        let before = snapshot(&db);
        let (mut coordinator, state) =
            fixture.coordinator_with_runtime(&db, "success", Box::new(|| Ok(NOW)), None);
        let error = execute_with_coordinator(
            &mut db,
            &mut coordinator,
            &binding(),
            &request(legacy),
            &mut business_clock(legacy),
            || Ok(()),
            || Ok(()),
            || Err(failure("fixture_precommit_scope_lost")),
        )
        .unwrap_err();
        assert_eq!(error.code, "fixture_precommit_scope_lost");
        assert_eq!(snapshot(&db), before);
        assert!(db.is_autocommit());
        assert_eq!(
            count(&db, "autonomous_research_online_mutation_authority_marker"),
            0
        );
        assert_eq!(
            state
                .lock()
                .unwrap()
                .calls
                .iter()
                .map(|c| c["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["head", "reserve", "abort"]
        );
    }
}

#[test]
fn actual_online_registered_predicates_preserve_node_stale_plan_semantics() {
    for legacy in [false, true] {
        for scenario in [
            "stale-parent-revision",
            "stale-node-generation",
            "same-count-queued",
        ] {
            run_differential(legacy, scenario, false);
        }
    }
}

#[test]
fn online_text_in_integer_affinity_fences_match_node_and_roll_back() {
    for legacy in [false, true] {
        for column in ["lease_generation", "node_revision"] {
            for value in ["bogus", "0x10", "\u{feff}17", "inf", "Infinity"] {
                run_differential_with_numeric(
                    legacy,
                    "numeric-fence",
                    false,
                    Some((column, value)),
                );
            }
        }
    }
}

#[test]
fn after_plan_clock_failure_reports_exact_signed_committed_identity_without_retryability() {
    for (legacy, fail_at) in [(false, 5), (false, 6), (true, 3)] {
        for epoch_fence in [false, true] {
            let fixture = Fixture::new(legacy);
            let mut db = fixture.database("success");
            let before = snapshot(&db);
            let receipt_count = count(&db, "receipt_ledger");
            let epoch_log = Arc::new(Mutex::new(vec![]));
            let fence = epoch_fence.then(|| {
                Box::new(EpochFence {
                    log: epoch_log.clone(),
                    fatal: false,
                }) as Box<dyn RecoverabilityEpochFenceV1>
            });
            let (mut coordinator, state) =
                fixture.coordinator_with_runtime(&db, "success", Box::new(|| Ok(NOW)), fence);
            let mut clock = business_clock(legacy);
            clock.fail_at = Some(fail_at);
            let error = execute_with_coordinator(
                &mut db,
                &mut coordinator,
                &binding(),
                &request(legacy),
                &mut clock,
                || Ok(()),
                || Ok(()),
                || Ok(()),
            )
            .unwrap_err();
            assert_eq!(error.code, "fixture_after_plan_clock_failure");
            assert_eq!(error.details["committed"], true);
            assert!(
                !error.retryable
                    && !error.state_recoverability_deferred
                    && !error.state_recoverability_fatal
            );
            assert!(db.is_autocommit());
            assert_eq!(count(&db, "receipt_ledger"), receipt_count + 1);
            assert_eq!(
                count(&db, "autonomous_research_online_mutation_authority_marker"),
                1
            );
            assert_eq!(
                count(
                    &db,
                    "autonomous_research_online_mutation_finalization_receipt"
                ),
                1
            );
            assert_ne!(snapshot(&db), before);
            let finalized = coordinator
                .verify_latest_finalized_mutation(&db, "native-store")
                .unwrap();
            let calls = state.lock().unwrap().calls.clone();
            assert_eq!(
                calls
                    .iter()
                    .map(|call| call["method"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["head", "reserve", "finalize"]
            );
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
            let expected = oracle(&[
                json!({"operation":"coordinator","privateKeyPath":fixture.private_path,"databasePath":fixture.root.join("node.sqlite"),"scenario":"success","nonces":nonces,"legacy":legacy,"campaignId":if legacy {Some("legacy-campaign")}else {None},"businessNow":clock.now,"epochFence":epoch_fence,"businessClockFailureAt":fail_at,"captureFinalized":true}),
            ]);
            assert_eq!(expected[0]["ok"], true, "{}", expected[0]["error"]);
            let expected = &expected[0]["value"];
            assert_eq!(expected["result"]["ok"], false);
            assert_eq!(expected["result"]["error"], error.code);
            // The incumbent throws its clock error after finalization without
            // commit metadata. The native wrapper deliberately enriches that
            // error from the already verified coordinator receipt, preserving
            // the identical committed state and avoiding a dangerous retry.
            assert_eq!(expected["result"]["committed"], Value::Null);
            assert_eq!(expected["result"]["retryable"], false);
            assert_eq!(snapshot(&db), canonical_snapshot(&expected["snapshot"]));
            assert_eq!(json!(calls), expected["calls"]);
            assert_eq!(json!(clock.calls), expected["businessCalls"]);
            assert_eq!(
                json!(epoch_log.lock().unwrap().clone()),
                expected["epochCalls"]
            );
            let signed = &expected["finalizedMutation"];
            assert_eq!(
                signed["status"],
                "externally_fenced_sqlite_mutation_finalized"
            );
            for key in [
                "reservationId",
                "reservationReceiptHash",
                "finalizationReceiptHash",
            ] {
                assert_eq!(error.details[key], signed[key], "{key}");
            }
            assert_eq!(
                error.details["finalizationReceiptHash"],
                online_mutation_receipt_hash_v1(finalized.value()).unwrap()
            );
            let (id,reservation_hash):(String,String)=db.query_row("SELECT reservation_id,reservation_receipt_hash FROM autonomous_research_online_mutation_authority_marker",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
            assert_eq!(error.details["reservationId"], id);
            assert_eq!(error.details["reservationReceiptHash"], reservation_hash);
        }
    }
}
