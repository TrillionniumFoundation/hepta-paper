//! Synthetic, signed authority and in-memory databases only. Private key bytes
//! never appear in oracle output or assertion diagnostics.
use base64ct::{Base64, Encoding};
use ed25519_dalek::{
    Signer, SigningKey,
    pkcs8::{EncodePrivateKey, EncodePublicKey, spki::der::pem::LineEnding},
};
use hepta_paper_service::sqlite_mutation_coordinator::{
    authority::*, contracts::activation::unresolved_reservation_set_hash_v1, contracts::*,
    startup::*, storage::exact_schema_hash_v1, *,
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
        db.execute("INSERT INTO autonomous_research_online_mutation_authority_metadata(singleton,schema_version,protocol,database_role,database_instance_id,schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,genesis_global_sequence,genesis_global_hash,genesis_database_sequence,genesis_database_hash,genesis_state_hash,provisioned_at) VALUES(1,1,?,?,?,?,?,?,?,0,?,0,?,?,?)",rusqlite::params![ONLINE_MUTATION_PROTOCOL,if scenario=="wrong-role"{"native-store"}else{"resident-instance"},"resident-instance","resident-instance-schema-v1",schema,self.value["trust"]["databaseScopeHash"].as_str().unwrap(),self.value["trust"]["writerManifestHash"].as_str().unwrap(),h("genesis-global"),h("genesis-database"),if scenario=="wrong-head"{h("wrong")}else{h("genesis-state")},self.value["now"].as_str().unwrap()]).unwrap();
        db
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn sign(key: &SigningKey, mut value: Value) -> Value {
    value["signature"] = json!(Base64::encode_string(
        &key.sign(
            online_mutation_signed_payload_v1(&value)
                .unwrap()
                .as_bytes()
        )
        .to_bytes()
    ));
    value
}
struct BrokerState {
    entry: Value,
    unresolved: bool,
    calls: Vec<Value>,
    scenario: String,
}
struct Broker {
    state: Arc<Mutex<BrokerState>>,
    key: SigningKey,
}
impl MutationAuthorityTransportV1 for Broker {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(request.clone());
        let kind = request["kind"].as_str().unwrap();
        let mut receipt = request.clone();
        receipt["authorityId"] = json!("authority:test");
        receipt["keyId"] = json!("key:test");
        receipt["requestHash"] = json!(hash(kind, request));
        if kind == "AutonomousResearchOnlineUnresolvedReservationListRequest" {
            let entries = if state.unresolved {
                json!([state.entry])
            } else {
                json!([])
            };
            receipt["kind"] = json!("AutonomousResearchOnlineUnresolvedReservationListReceipt");
            receipt["status"] =
                json!("autonomous_research_online_unresolved_reservations_observed");
            receipt["unresolvedReservationCount"] = json!(entries.as_array().unwrap().len());
            receipt["unresolvedReservationSetHash"] =
                json!(unresolved_reservation_set_hash_v1(&entries).unwrap());
            receipt["unresolvedReservations"] = entries;
            receipt["observedAt"] = request["requestedAt"].clone();
            receipt["expiresAt"] = json!("2026-07-18T08:01:00.000Z");
        } else if kind == "AutonomousResearchOnlineMutationAbortRequest" {
            if state.scenario == "abort-failure" {
                return Err(failure("injected_abort_failure"));
            }
            if state.scenario != "confirmation-unresolved" {
                state.unresolved = false;
            }
            receipt["kind"] = json!("AutonomousResearchOnlineMutationAbortReceipt");
            receipt["status"] = json!("autonomous_research_online_mutation_aborted");
            receipt["abortedAt"] = request["requestedAt"].clone();
        } else if kind == "AutonomousResearchOnlineMutationFinalizeRequest" {
            if state.scenario == "finalize-failure" {
                return Err(failure("injected_finalization_failure"));
            }
            state.unresolved = false;
            receipt.as_object_mut().unwrap().remove("committedAt");
            receipt["kind"] = json!("AutonomousResearchOnlineMutationFinalizationReceipt");
            receipt["status"] = json!("autonomous_research_online_mutation_finalized");
            receipt["finalizedAt"] = json!("2026-07-18T08:00:00.000Z");
            receipt["sideEffectPermitHash"] = json!(h("permit"));
        } else {
            return Err(failure("unexpected_broker_operation"));
        }
        let mut result = sign(&self.key, receipt);
        if state.scenario == "bad-list-signature"
            && kind == "AutonomousResearchOnlineUnresolvedReservationListRequest"
        {
            result["signature"] = json!(Base64::encode_string(&[0_u8; 64]));
        }
        Ok(result)
    }
}
fn entry(f: &Fixture, db: &Connection, scenario: &str) -> Value {
    db.execute_batch("BEGIN IMMEDIATE;").unwrap();
    let mut session = rusqlite::session::Session::new(db).unwrap();
    session.attach(Some("resident_state")).unwrap();
    db.execute(
        "UPDATE resident_state SET generation=1 WHERE singleton=1",
        [],
    )
    .unwrap();
    let mut changeset = Vec::new();
    session.changeset_strm(&mut changeset).unwrap();
    drop(session);
    db.execute_batch("ROLLBACK;").unwrap();
    let schema = exact_schema_hash_v1(db).unwrap();
    let op = if scenario == "unknown-operation" {
        "resident-instance.unknown.v1"
    } else {
        "resident-instance.commit.v1"
    };
    let mut request = json!({"version":1,"kind":"AutonomousResearchOnlineMutationReserveRequest","protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":"scope:test","databaseScopeHash":f.value["trust"]["databaseScopeHash"],"writerManifestHash":f.value["trust"]["writerManifestHash"],"databaseRole":"resident-instance","databaseInstanceId":"resident-instance","writerId":"writer:resident-instance","operationId":op,"codeProvenanceHash":f.value["manifest"]["writers"][0]["implementationHash"],"mutationAttemptId":"mutation:startup-test","globalPreviousSequence":0,"globalPreviousHash":h("genesis-global"),"databasePreviousSequence":0,"databasePreviousHash":h("genesis-database"),"schemaContractId":"resident-instance-schema-v1","schemaHash":schema,"preStateHash":h("genesis-state"),"changesetEncoding":"base64","changesetBase64":Base64::encode_string(&changeset),"changesetByteLength":changeset.len(),"changesetHash":bytes_hash(&changeset),"authorizationReceiptHashes":[],"sideEffectReservationHashes":[],"requestedAt":f.value["now"],"requestedLeaseMs":60000});
    let mut state = json!({});
    for field in [
        "databaseRole",
        "databaseInstanceId",
        "writerId",
        "operationId",
        "schemaHash",
        "changesetHash",
        "authorizationReceiptHashes",
        "sideEffectReservationHashes",
    ] {
        state[field] = request[field].clone();
    }
    state["previousStateHash"] = request["preStateHash"].clone();
    state["databaseSequence"] = json!(1);
    request["postStateHash"] = json!(online_mutation_state_hash_v1(&state).unwrap());
    assert_reserve_request_v1(&request, &f.value["trust"]).unwrap();
    let mut receipt = request.clone();
    receipt.as_object_mut().unwrap().remove("requestedAt");
    receipt.as_object_mut().unwrap().remove("requestedLeaseMs");
    receipt["kind"] = json!("AutonomousResearchOnlineMutationReservationReceipt");
    receipt["status"] = json!("autonomous_research_online_mutation_reserved");
    receipt["authorityId"] = json!("authority:test");
    receipt["keyId"] = json!("key:test");
    receipt["requestHash"] = json!(hash(
        "AutonomousResearchOnlineMutationReserveRequest",
        &request
    ));
    receipt["reservationId"] = json!("reservation:startup-test");
    receipt["globalSequence"] = json!(1);
    receipt["globalHash"] = json!(h("global:1"));
    receipt["databaseSequence"] = json!(1);
    receipt["databaseHash"] = json!(h("database:1"));
    receipt["issuedAt"] = f.value["now"].clone();
    receipt["expiresAt"] = json!("2026-07-18T08:01:00.000Z");
    json!({"reserveRequest":request,"reservation":sign(&f.key,receipt)})
}
fn install_marker(db: &Connection, e: &Value, scenario: &str) {
    let r = &e["reservation"];
    let request = &e["reserveRequest"];
    let finalized = build_finalize_request_v1(r, &json!("2026-07-18T08:00:00.000Z")).unwrap();
    let mut stored_request = request.clone();
    if scenario == "oversized-journal" {
        stored_request["padding"] = json!("x".repeat(32 * 1024 * 1024 + 1));
    }
    let stored_request = if scenario == "duplicate-json" {
        stored_request
            .to_string()
            .replacen('{', "{\"version\":0,", 1)
    } else {
        stored_request.to_string()
    };
    let mut stored_reservation = r.clone();
    if scenario == "bad-marker" {
        stored_reservation["requestHash"] = json!(h("wrong"));
    }
    db.execute("INSERT INTO autonomous_research_online_mutation_authority_marker(reservation_id,database_role,database_instance_id,writer_id,operation_id,global_sequence,global_hash,database_sequence,database_hash,schema_hash,pre_state_hash,post_state_hash,changeset_hash,reserve_request_hash,reserve_request_json,reservation_receipt_hash,reservation_receipt_json,local_marker_hash,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",rusqlite::params![r["reservationId"].as_str().unwrap(),"resident-instance","resident-instance","writer:resident-instance",r["operationId"].as_str().unwrap(),1,r["globalHash"].as_str().unwrap(),1,r["databaseHash"].as_str().unwrap(),r["schemaHash"].as_str().unwrap(),r["preStateHash"].as_str().unwrap(),r["postStateHash"].as_str().unwrap(),r["changesetHash"].as_str().unwrap(),if scenario=="bad-marker"{h("wrong")}else{hash("AutonomousResearchOnlineMutationReserveRequest",request)},stored_request,online_mutation_receipt_hash_v1(r).unwrap(),stored_reservation.to_string(),finalized["localMarkerHash"].as_str().unwrap(),"2026-07-18T08:00:00.000Z"]).unwrap();
    db.execute("UPDATE resident_state SET generation=1", [])
        .unwrap();
}
fn run(f: &Fixture, scenario: &str) -> (Value, Value) {
    let mut db = f.database(if ["wrong-head", "wrong-role"].contains(&scenario) {
        scenario
    } else {
        ""
    });
    let e = entry(f, &db, scenario);
    if [
        "committed",
        "finalize-failure",
        "bad-marker",
        "duplicate-json",
    ]
    .contains(&scenario)
    {
        install_marker(&db, &e, scenario);
    }
    let state = Arc::new(Mutex::new(BrokerState {
        entry: e.clone(),
        unresolved: scenario != "empty",
        calls: vec![],
        scenario: scenario.into(),
    }));
    let mut authority = PinnedMutationAuthorityV1::load(
        &f.configuration,
        &f.pin,
        Broker {
            state: state.clone(),
            key: f.key.clone(),
        },
    )
    .unwrap();
    let result = match reconcile_online_mutation_database_startup_v1(
        &mut db,
        "resident-instance",
        "resident-instance",
        &mut authority,
        &f.value["manifest"],
        &mut || Ok(NOW),
    ) {
        Ok(proof) => {
            assert_eq!(
                proof.authority_configuration_hash(),
                authority.configuration_hash()
            );
            proof.assert_confirmation_current(&authority, NOW).unwrap();
            assert!(
                proof
                    .assert_confirmation_current(&authority, NOW + 60_001)
                    .is_err()
            );
            json!({"ok":proof.value()})
        }
        Err(e) => json!({"error":e.code}),
    };
    assert!(db.is_autocommit(), "transaction leaked in {scenario}");
    let counts = json!({"generation":db.query_row("SELECT generation FROM resident_state",[],|r|r.get::<_,i64>(0)).unwrap(),"markers":db.query_row("SELECT count(*) FROM autonomous_research_online_mutation_authority_marker",[],|r|r.get::<_,i64>(0)).unwrap(),"finalized":db.query_row("SELECT count(*) FROM autonomous_research_online_mutation_finalization_receipt",[],|r|r.get::<_,i64>(0)).unwrap()});
    let calls = state.lock().unwrap().calls.clone();
    (json!({"result":result,"calls":calls,"counts":counts}), e)
}
fn startup_oracle(input: &Value) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/online-mutation-startup-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn actual_signed_startup_recovery_abort_confirmation_and_failures_match_node() {
    let fixture = Fixture::new();
    for scenario in [
        "empty",
        "remote-only",
        "committed",
        "finalize-failure",
        "abort-failure",
        "confirmation-unresolved",
        "unknown-operation",
        "bad-list-signature",
        "bad-marker",
        "wrong-head",
    ] {
        let (actual, entry) = run(&fixture, scenario);
        let nonces: Vec<_> = actual["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["kind"] == "AutonomousResearchOnlineUnresolvedReservationListRequest")
            .map(|c| {
                c["nonce"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("unresolved:")
                    .unwrap()
            })
            .collect();
        let expected = startup_oracle(
            &json!({"fixture":fixture.value,"scenario":scenario,"entry":entry,"privateKeyPath":fixture.private_path,"nonces":nonces}),
        );
        assert_eq!(actual, expected, "{scenario}");
        if let Some(ok) = actual["result"].get("ok") {
            assert_eq!(ok["runtimeReady"], false);
            assert_eq!(ok["businessDmlReplayed"], false);
        }
    }
}
#[test]
fn malformed_persisted_json_and_invalid_configuration_fail_without_abort() {
    let fixture = Fixture::new();
    let (actual, _) = run(&fixture, "duplicate-json");
    assert_eq!(
        actual["result"]["error"],
        "autonomous_research_online_mutation_startup_local_request_invalid"
    );
    assert_eq!(actual["calls"].as_array().unwrap().len(), 1);
    let mut db = fixture.database("");
    let e = entry(&fixture, &db, "");
    let state = Arc::new(Mutex::new(BrokerState {
        entry: e,
        unresolved: true,
        calls: vec![],
        scenario: String::new(),
    }));
    let mut authority = PinnedMutationAuthorityV1::load(
        &fixture.configuration,
        &fixture.pin,
        Broker {
            state: state.clone(),
            key: fixture.key.clone(),
        },
    )
    .unwrap();
    db.execute_batch("BEGIN;").unwrap();
    assert!(
        reconcile_online_mutation_database_startup_v1(
            &mut db,
            "resident-instance",
            "resident-instance",
            &mut authority,
            &fixture.value["manifest"],
            &mut || Ok(NOW)
        )
        .is_err()
    );
    assert!(state.lock().unwrap().calls.is_empty());
    db.execute_batch("ROLLBACK;").unwrap();
    let failure = reconcile_online_mutation_database_startup_v1(
        &mut db,
        "resident-instance",
        "resident-instance",
        &mut authority,
        &fixture.value["manifest"],
        &mut || Ok(i64::MAX),
    )
    .err()
    .unwrap();
    assert_eq!(
        failure.code,
        "autonomous_research_online_mutation_startup_clock_invalid"
    );
    assert!(state.lock().unwrap().calls.is_empty());
}
#[test]
fn wrong_database_identity_and_post_call_expiry_never_mint_startup_proof() {
    let f = Fixture::new();
    for mode in [
        "wrong-role",
        "wrong-instance",
        "initial-expiry",
        "confirmation-expiry",
        "clock-rollback",
    ] {
        let mut db = f.database(if mode == "wrong-role" {
            "wrong-role"
        } else {
            ""
        });
        let e = entry(&f, &db, "");
        let state = Arc::new(Mutex::new(BrokerState {
            entry: e,
            unresolved: false,
            calls: vec![],
            scenario: String::new(),
        }));
        let mut authority = PinnedMutationAuthorityV1::load(
            &f.configuration,
            &f.pin,
            Broker {
                state: state.clone(),
                key: f.key.clone(),
            },
        )
        .unwrap();
        let mut ticks = 0;
        let mut clock = || {
            ticks += 1;
            Ok(NOW
                + match mode {
                    "initial-expiry" if ticks >= 3 => 60_001,
                    "confirmation-expiry" if ticks >= 6 => 60_001,
                    "clock-rollback" if ticks >= 3 => -1,
                    _ => 0,
                })
        };
        let err = reconcile_online_mutation_database_startup_v1(
            &mut db,
            "resident-instance",
            if mode == "wrong-instance" {
                "wrong-instance"
            } else {
                "resident-instance"
            },
            &mut authority,
            &f.value["manifest"],
            &mut clock,
        )
        .err()
        .expect(mode);
        let expected = if mode.starts_with("wrong") {
            "autonomous_research_online_mutation_startup_database_binding_invalid"
        } else if mode == "clock-rollback" {
            "autonomous_research_online_mutation_startup_clock_invalid"
        } else {
            "autonomous_research_online_unresolved_reservation_list_receipt_invalid"
        };
        assert_eq!(err.code, expected, "{mode}");
        assert!(db.is_autocommit());
        assert_eq!(
            state.lock().unwrap().calls.len(),
            if mode.starts_with("wrong") {
                0
            } else if mode == "confirmation-expiry" {
                2
            } else {
                1
            }
        );
    }
}
#[test]
fn direct_recovery_rejects_duplicate_keys_and_bounds_json_before_external_effects() {
    let f = Fixture::new();
    for scenario in ["duplicate-json", "oversized-journal"] {
        let mut db = f.database("");
        let e = entry(&f, &db, "");
        install_marker(&db, &e, scenario);
        let state = Arc::new(Mutex::new(BrokerState {
            entry: e,
            unresolved: true,
            calls: vec![],
            scenario: String::new(),
        }));
        let mut authority = PinnedMutationAuthorityV1::load(
            &f.configuration,
            &f.pin,
            Broker {
                state: state.clone(),
                key: f.key.clone(),
            },
        )
        .unwrap();
        let err = recovery::recover_sqlite_mutations_v1(&mut db, &mut authority, &mut || Ok(NOW))
            .err()
            .unwrap();
        assert_eq!(
            err.code,
            if scenario == "duplicate-json" {
                "externally_fenced_sqlite_mutation_recovery_request_invalid"
            } else {
                "externally_fenced_sqlite_mutation_recovery_journal_limit"
            }
        );
        assert!(state.lock().unwrap().calls.is_empty());
        assert!(db.is_autocommit());
    }
}
struct ConcurrentProbe {
    inner: Broker,
    database: PathBuf,
    attempted: Arc<Mutex<usize>>,
    panic_during_finalize: bool,
}
impl MutationAuthorityTransportV1 for ConcurrentProbe {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        if request["kind"] == "AutonomousResearchOnlineMutationFinalizeRequest" {
            let other = Connection::open(&self.database).unwrap();
            other.busy_timeout(std::time::Duration::ZERO).unwrap();
            for sql in [
                "CREATE TABLE raced_schema(id INTEGER)",
                "UPDATE resident_state SET generation=99",
            ] {
                let failed = other
                    .execute_batch(sql)
                    .expect_err("recovery must hold its IMMEDIATE lock across the RPC");
                assert_eq!(
                    failed.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy)
                );
                *self.attempted.lock().unwrap() += 1;
            }
            assert!(!self.panic_during_finalize, "synthetic transport unwind");
        }
        self.inner.invoke(request)
    }
}
#[test]
fn recovery_holds_current_marker_and_schema_lock_across_rpc_and_unwind() {
    let f = Fixture::new();
    for should_panic in [false, true] {
        let original = f.database("");
        let e = entry(&f, &original, "");
        install_marker(&original, &e, "committed");
        let path = f.root.join(if should_panic {
            "panic.sqlite"
        } else {
            "locked.sqlite"
        });
        original
            .execute("VACUUM INTO ?", [path.to_str().unwrap()])
            .unwrap();
        drop(original);
        let mut db = Connection::open(&path).unwrap();
        let attempted = Arc::new(Mutex::new(0));
        let state = Arc::new(Mutex::new(BrokerState {
            entry: e,
            unresolved: true,
            calls: vec![],
            scenario: String::new(),
        }));
        let transport = ConcurrentProbe {
            inner: Broker {
                state,
                key: f.key.clone(),
            },
            database: path,
            attempted: attempted.clone(),
            panic_during_finalize: should_panic,
        };
        let mut authority =
            PinnedMutationAuthorityV1::load(&f.configuration, &f.pin, transport).unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            recovery::recover_sqlite_mutations_v1(&mut db, &mut authority, &mut || Ok(NOW))
        }));
        assert_eq!(result.is_err(), should_panic);
        if let Ok(value) = result {
            value.unwrap();
        }
        assert_eq!(*attempted.lock().unwrap(), 2);
        assert!(db.is_autocommit());
        assert_eq!(
            db.query_row("SELECT generation FROM resident_state", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM autonomous_research_online_mutation_finalization_receipt",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            i64::from(!should_panic)
        );
    }
}
