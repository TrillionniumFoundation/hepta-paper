//! Non-empty aggregate recovery: one real pending marker is finalized and the
//! aggregate rejects a later business-table mutation.
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_paper_service::{
    online_runtime_activation::startup_inventory::reconcile_online_mutation_startup_set_v1,
    sqlite_mutation_coordinator::{
        ONLINE_MUTATION_PROTOCOL, Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::iso,
        contracts::{
            self, activation::unresolved_reservation_set_hash_v1, assert_reserve_request_v1,
            online_mutation_state_hash_v1,
        },
        storage::exact_schema_hash_v1,
    },
    state_database_inventory::observe_state_database_inventory_v1,
};
use rusqlite::{Connection, types::ValueRef};
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

const NOW: i64 = 1_789_560_000_000;
static NEXT: AtomicU64 = AtomicU64::new(0);
fn hash(kind: &str, value: &Value) -> String {
    hepta_legacy_compatibility::production_hash_record_v1(kind, value)
        .unwrap()
        .as_str()
        .into()
}
fn h(label: &str) -> String {
    hash("StartupAggregateNonemptyFixture", &json!({"label":label}))
}
fn bytes_hash(value: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(value)))
}
fn oracle(name: &str, input: &Value) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle").join(name))
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
struct Fixture {
    root: PathBuf,
    value: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-backup-cli-e2e-startup-nonempty-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let out = oracle(
            "state-safety-composition-v1.mjs",
            &json!({"mode":"fixture","root":root}),
        );
        assert_eq!(out["ok"], true, "{}", out["error"]);
        Self {
            root,
            value: out["value"].clone(),
        }
    }
    fn path(&self, key: &str) -> PathBuf {
        self.value[key].as_str().unwrap().into()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn row_value(row: &rusqlite::Row<'_>, index: usize) -> Value {
    match row.get_ref(index).unwrap() {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(v) => json!(v),
        ValueRef::Real(v) => json!(v),
        ValueRef::Text(v) => json!(String::from_utf8(v.to_vec()).unwrap()),
        ValueRef::Blob(v) => json!(format!("base64:{}", Base64::encode_string(v))),
    }
}
fn metadata(db: &Connection) -> Value {
    let mut statement = db.prepare("SELECT * FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1").unwrap();
    let names = statement
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect::<Vec<_>>();
    let mut rows = statement.query([]).unwrap();
    let row = rows.next().unwrap().unwrap();
    names
        .iter()
        .enumerate()
        .map(|(i, n)| (n.clone(), row_value(row, i)))
        .collect::<serde_json::Map<_, _>>()
        .into()
}
fn pending_entry(f: &Fixture, db: &Connection) -> Value {
    let meta = metadata(db);
    let schema = exact_schema_hash_v1(db).unwrap();
    let operations = f.value["writerManifest"]["operations"].as_array().unwrap();
    let operation = operations
        .iter()
        .find(|v| v["databaseRole"] == "resident-instance" && v["coordinatorIntegrated"] == true)
        .unwrap();
    let operation_id = operation["operationId"].as_str().unwrap();
    let writer = f.value["writerManifest"]["writers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| {
            v["operationIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(operation_id)))
        })
        .unwrap();
    let config: Value =
        serde_json::from_slice(&fs::read(f.path("onlineConfiguration")).unwrap()).unwrap();
    let trust = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityTrust","authorityId":"authority:cli","keyId":"key:cli","protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":config["scopeId"],"databaseScopeHash":config["databaseScopeHash"],"writerManifestHash":config["writerManifestHash"],"maximumReservationLeaseMs":60000,"maximumObservationAgeMs":60000});
    db.execute_batch("BEGIN IMMEDIATE;").unwrap();
    let mut session = rusqlite::session::Session::new(db).unwrap();
    session.attach(Some("records")).unwrap();
    db.execute("UPDATE records SET value='after' WHERE id='subject'", [])
        .unwrap();
    let mut changeset = Vec::new();
    session.changeset_strm(&mut changeset).unwrap();
    drop(session);
    db.execute_batch("ROLLBACK;").unwrap();
    let changeset_base64 = Base64::encode_string(&changeset);
    let empty_hash = bytes_hash(&changeset);
    let mut request = json!({"version":1,"kind":"AutonomousResearchOnlineMutationReserveRequest","protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":trust["scopeId"],"databaseScopeHash":trust["databaseScopeHash"],"writerManifestHash":trust["writerManifestHash"],"databaseRole":"resident-instance","databaseInstanceId":"resident-instance","writerId":writer["writerId"],"operationId":operation["operationId"],"codeProvenanceHash":writer["implementationHash"],"mutationAttemptId":"startup-set:nonempty","globalPreviousSequence":meta["genesis_global_sequence"],"globalPreviousHash":meta["genesis_global_hash"],"databasePreviousSequence":meta["genesis_database_sequence"],"databasePreviousHash":meta["genesis_database_hash"],"schemaContractId":meta["schema_contract_id"],"schemaHash":schema,"preStateHash":meta["genesis_state_hash"],"changesetEncoding":"base64","changesetBase64":changeset_base64,"changesetByteLength":changeset.len(),"changesetHash":empty_hash,"authorizationReceiptHashes":[],"sideEffectReservationHashes":[],"requestedAt":f.value["now"],"requestedLeaseMs":60000});
    let state = json!({"databaseRole":request["databaseRole"],"databaseInstanceId":request["databaseInstanceId"],"writerId":request["writerId"],"operationId":request["operationId"],"schemaHash":schema,"previousStateHash":request["preStateHash"],"changesetHash":empty_hash,"databaseSequence":1,"authorizationReceiptHashes":[],"sideEffectReservationHashes":[]});
    request["postStateHash"] = json!(online_mutation_state_hash_v1(&state).unwrap());
    assert_reserve_request_v1(&request, &trust).unwrap();
    let mut receipt = request.clone();
    receipt.as_object_mut().unwrap().remove("requestedAt");
    receipt.as_object_mut().unwrap().remove("requestedLeaseMs");
    receipt["kind"] = json!("AutonomousResearchOnlineMutationReservationReceipt");
    receipt["status"] = json!("autonomous_research_online_mutation_reserved");
    receipt["authorityId"] = json!("authority:cli");
    receipt["keyId"] = json!("key:cli");
    receipt["requestHash"] = json!(hash(
        "AutonomousResearchOnlineMutationReserveRequest",
        &request
    ));
    receipt["reservationId"] = json!("reservation:startup-set-nonempty");
    receipt["globalSequence"] = json!(1);
    receipt["globalHash"] = json!(h("global:1"));
    receipt["databaseSequence"] = json!(1);
    receipt["databaseHash"] = json!(h("database:resident-instance:1"));
    receipt["issuedAt"] = f.value["now"].clone();
    receipt["expiresAt"] = json!(iso(NOW + 60_000).unwrap());
    let key = SigningKey::from_bytes(&[92; 32]);
    receipt["signature"] = json!(Base64::encode_string(
        &key.sign(
            contracts::online_mutation_signed_payload_v1(&receipt)
                .unwrap()
                .as_bytes()
        )
        .to_bytes()
    ));
    json!({"reserveRequest":request,"reservation":receipt})
}
fn install_marker(db: &Connection, entry: &Value) {
    let r = &entry["reservation"];
    let q = &entry["reserveRequest"];
    let committed = json!(iso(NOW).unwrap());
    let finalize = contracts::build_finalize_request_v1(r, &committed).unwrap();
    db.execute("INSERT INTO autonomous_research_online_mutation_authority_marker(reservation_id,database_role,database_instance_id,writer_id,operation_id,global_sequence,global_hash,database_sequence,database_hash,schema_hash,pre_state_hash,post_state_hash,changeset_hash,reserve_request_hash,reserve_request_json,reservation_receipt_hash,reservation_receipt_json,local_marker_hash,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",rusqlite::params![r["reservationId"].as_str().unwrap(),r["databaseRole"].as_str().unwrap(),r["databaseInstanceId"].as_str().unwrap(),r["writerId"].as_str().unwrap(),r["operationId"].as_str().unwrap(),r["globalSequence"].as_i64().unwrap(),r["globalHash"].as_str().unwrap(),r["databaseSequence"].as_i64().unwrap(),r["databaseHash"].as_str().unwrap(),r["schemaHash"].as_str().unwrap(),r["preStateHash"].as_str().unwrap(),r["postStateHash"].as_str().unwrap(),r["changesetHash"].as_str().unwrap(),hash("AutonomousResearchOnlineMutationReserveRequest",q),q.to_string(),contracts::online_mutation_receipt_hash_v1(r).unwrap(),r.to_string(),finalize["localMarkerHash"].as_str().unwrap(),committed.as_str().unwrap()]).unwrap();
}
struct Broker {
    entry: Value,
    pending: bool,
    calls: Arc<Mutex<usize>>,
    key: SigningKey,
}
fn failure(
    code: &str,
) -> hepta_paper_service::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    hepta_paper_service::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
        code: code.into(),
        details: json!({}),
        state_recoverability_fatal: false,
        state_recoverability_deferred: false,
        retryable: false,
    }
}
impl MutationAuthorityTransportV1 for Broker {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        *self.calls.lock().unwrap() += 1;
        let mut receipt = request.clone();
        receipt["authorityId"] = json!("authority:cli");
        receipt["keyId"] = json!("key:cli");
        receipt["requestHash"] = json!(hash(request["kind"].as_str().unwrap(), request));
        match request["kind"].as_str().unwrap() {
            "AutonomousResearchOnlineUnresolvedReservationListRequest" => {
                let rows = if self.pending
                    && request["databaseRole"] == self.entry["reservation"]["databaseRole"]
                {
                    json!([self.entry.clone()])
                } else {
                    json!([])
                };
                receipt["kind"] = json!("AutonomousResearchOnlineUnresolvedReservationListReceipt");
                receipt["status"] =
                    json!("autonomous_research_online_unresolved_reservations_observed");
                receipt["unresolvedReservationCount"] = json!(rows.as_array().unwrap().len());
                receipt["unresolvedReservationSetHash"] =
                    json!(unresolved_reservation_set_hash_v1(&rows)?);
                receipt["unresolvedReservations"] = rows;
                receipt["observedAt"] = request["requestedAt"].clone();
                receipt["expiresAt"] = json!(iso(NOW + 60_000)?);
            }
            "AutonomousResearchOnlineMutationFinalizeRequest" => {
                self.pending = false;
                receipt.as_object_mut().unwrap().remove("committedAt");
                receipt["kind"] = json!("AutonomousResearchOnlineMutationFinalizationReceipt");
                receipt["status"] = json!("autonomous_research_online_mutation_finalized");
                receipt["finalizedAt"] = json!(iso(NOW)?);
                receipt["sideEffectPermitHash"] = json!(h("permit"));
            }
            _ => return Err(failure("unexpected_startup_set_nonempty_rpc")),
        }
        receipt["signature"] = json!(Base64::encode_string(
            &self
                .key
                .sign(contracts::online_mutation_signed_payload_v1(&receipt)?.as_bytes())
                .to_bytes()
        ));
        Ok(receipt)
    }
}
#[test]
fn aggregate_recovers_real_pending_marker_and_rejects_extra_business_write() {
    let fixture = Fixture::new();
    let discovered =
        observe_state_database_inventory_v1(&fixture.path("runtime"), &fixture.value["manifest"])
            .unwrap();
    let resident = discovered.value()["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["instanceId"] == "resident-instance")
        .unwrap();
    let path = fixture
        .path("runtime")
        .join(resident["sourceRelativePath"].as_str().unwrap());
    let db = Connection::open(&path).unwrap();
    let entry = pending_entry(&fixture, &db);
    install_marker(&db, &entry);
    drop(db);
    let inventory =
        observe_state_database_inventory_v1(&fixture.path("runtime"), &fixture.value["manifest"])
            .unwrap();
    let config = fixture.path("onlineConfiguration");
    let pin = bytes_hash(&fs::read(&config).unwrap());
    let calls = Arc::new(Mutex::new(0));
    let key = SigningKey::from_bytes(&[92; 32]);
    let mut authority = PinnedMutationAuthorityV1::load(
        &config,
        &pin,
        Broker {
            entry,
            pending: true,
            calls: calls.clone(),
            key,
        },
    )
    .unwrap();
    let proof = reconcile_online_mutation_startup_set_v1(
        &inventory,
        &fixture.value["writerManifest"],
        &mut authority,
        &mut || Ok(NOW),
    )
    .unwrap();
    assert_eq!(proof.value()["runtimeReady"], false);
    assert_eq!(
        proof.value()["reconciliations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["databaseInstanceId"] == "resident-instance")
            .unwrap()["receipt"]["recoveredReservationIds"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(*calls.lock().unwrap() >= 21);
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM autonomous_research_online_mutation_finalization_receipt",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    db.execute("UPDATE records SET value='tampered' WHERE id='subject'", [])
        .unwrap();
    drop(db);
    assert!(
        proof
            .assert_current(&inventory, &authority, &mut || Ok(NOW))
            .is_err()
    );
}
