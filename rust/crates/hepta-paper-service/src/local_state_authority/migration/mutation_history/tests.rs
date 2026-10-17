use super::super::{source_profile::inspect_source_schema, source_rows::read_source_rows};
use super::*;
use crate::sqlite_mutation_coordinator::hash_bytes;
use base64ct::{Base64, Encoding};
use ed25519_dalek::{
    Signer, SigningKey,
    pkcs8::{DecodePrivateKey, DecodePublicKey},
};
use rusqlite::{Connection, OpenFlags, params};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    value: Value,
    key: SigningKey,
    public: VerifyingKey,
}
impl Fixture {
    fn node(mode: &str) -> Self {
        let root = PathBuf::from(format!(
            "/tmp/hepta-schema-history-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let service = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo = service.ancestors().nth(3).unwrap();
        let output = Command::new("node")
            .arg(service.join("src/local_state_authority/migration/mutation_history/oracle.mjs"))
            .arg(repo)
            .arg(&root)
            .arg(mode)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&value["profile"]).unwrap();
        // Actual fixture key captured before any SQLite connection. This key is
        // used only to test correctly signed but semantically false history.
        let key = SigningKey::from_pkcs8_pem(
            &fs::read_to_string(value["configuration"]["privateKeyPath"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let public =
            VerifyingKey::from_public_key_pem(value["publicKeyPem"].as_str().unwrap()).unwrap();
        assert_eq!(key.verifying_key(), public);
        Self {
            root,
            value,
            key,
            public,
        }
    }
    fn path(&self) -> PathBuf {
        PathBuf::from(
            self.value["configuration"]["stateDatabasePath"]
                .as_str()
                .unwrap(),
        )
    }
    fn db(&self) -> Connection {
        Connection::open_with_flags(self.path(), OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap()
    }
    fn trust(&self) -> Value {
        let mut value =
            json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityTrust"});
        for k in [
            "authorityId",
            "keyId",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "maximumReservationLeaseMs",
            "maximumObservationAgeMs",
        ] {
            value[k] = self.value["configuration"][k].clone();
        }
        value
    }
    fn inspect(&self, db: &Connection) -> Result<MutationHistoryObservationV1> {
        inspect_source_schema(db)?;
        verify_mutation_history_v1(
            &read_source_rows(db)?,
            &self.value["genesis"],
            &self.trust(),
            &self.public,
        )
    }
    fn sign(&self, value: &mut Value) {
        value.as_object_mut().unwrap().remove("signature");
        let payload = contracts::online_mutation_signed_payload_v1(value).unwrap();
        value["signature"] = json!(Base64::encode_string(
            &self.key.sign(payload.as_bytes()).to_bytes()
        ));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn begin(db: &Connection) {
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
}
fn saved(db: &Connection, column: &str, sequence: i64) -> Value {
    // Test-only source-owned column selection.
    assert!(
        [
            "reserve_request_json",
            "reservation_receipt_json",
            "finalize_request_json",
            "finalization_receipt_json"
        ]
        .contains(&column)
    );
    let raw: String = db
        .query_row(
            &format!("SELECT {column} FROM authority_mutation WHERE global_sequence=?1"),
            [sequence],
            |r| r.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}
fn update(db: &Connection, column: &str, sequence: i64, value: &Value) {
    assert!(
        [
            "reserve_request_json",
            "reservation_receipt_json",
            "finalize_request_json",
            "finalization_receipt_json"
        ]
        .contains(&column)
    );
    db.execute(
        &format!("UPDATE authority_mutation SET {column}=?1 WHERE global_sequence=?2"),
        params![value.to_string(), sequence],
    )
    .unwrap();
}

#[test]
fn actual_node_finalized_empty_rebound_and_aborted_histories_replay_all_ten_heads() {
    for mode in ["empty", "finalized", "rebound", "tail", "regressing-clock"] {
        let fixture = Fixture::node(mode);
        let before = fs::read(fixture.path()).unwrap();
        {
            let db = fixture.db();
            begin(&db);
            let rows = read_source_rows(&db).unwrap();
            let changes = db.total_changes();
            let observed = fixture.inspect(&db).unwrap();
            if mode != "empty" {
                let reservation = saved(&db, "reservation_receipt_json", 2);
                let finalization = saved(&db, "finalization_receipt_json", 2);
                let request = saved(&db, "finalize_request_json", 2);
                assert!(
                    timestamp(&finalization["finalizedAt"]) > timestamp(&reservation["expiresAt"])
                );
                assert!(timestamp(&request["committedAt"]) <= timestamp(&reservation["expiresAt"]));
                if mode == "regressing-clock" {
                    let later = saved(&db, "reservation_receipt_json", 3);
                    assert!(
                        timestamp(&later["issuedAt"]) < timestamp(&finalization["finalizedAt"])
                    );
                }
            }
            assert_eq!(
                observed.head()["globalSequence"],
                fixture.value["terminal"]["globalSequence"]
            );
            assert_eq!(
                observed.head()["globalHash"],
                fixture.value["terminal"]["globalHash"]
            );
            let mut projected = observed.head()["databaseHeads"].clone();
            for head in projected.as_array_mut().unwrap() {
                head.as_object_mut().unwrap().remove("schemaContractId");
            }
            assert_eq!(projected, fixture.value["terminal"]["databaseHeads"]);
            assert_eq!(
                observed.report()["finalizedMutations"],
                if mode == "empty" { 0 } else { 3 }
            );
            assert_eq!(
                observed.report()["abortedTailMutations"],
                if mode == "tail" { 1 } else { 0 }
            );
            assert_eq!(
                rows.logical_hash(),
                read_source_rows(&db).unwrap().logical_hash()
            );
            assert_eq!(changes, db.total_changes());
            db.execute_batch("ROLLBACK").unwrap();
        }
        assert_eq!(
            hash_bytes(&before),
            hash_bytes(&fs::read(fixture.path()).unwrap())
        );
    }
}

#[test]
fn unresolved_and_transplanted_or_incomplete_sql_rows_are_rejected() {
    let reserved = Fixture::node("reserved");
    let db = reserved.db();
    begin(&db);
    assert_eq!(
        reserved.inspect(&db).err().unwrap().code,
        "local_authority_mutation_history_unresolved"
    );
    drop(db);
    let fixture = Fixture::node("tail");
    let db = fixture.db();
    begin(&db);
    for sql in [
        "UPDATE authority_mutation SET mutation_attempt_id='mutation:transplanted' WHERE global_sequence=1",
        "UPDATE authority_mutation SET reservation_id='reservation:transplanted' WHERE global_sequence=1",
        "UPDATE authority_mutation SET database_instance_id='instance:transplanted' WHERE global_sequence=1",
        "UPDATE authority_mutation SET global_sequence=99 WHERE global_sequence=1",
        "UPDATE authority_mutation SET finalization_receipt_json=NULL WHERE global_sequence=1",
        "UPDATE authority_mutation SET abort_request_json='{}' WHERE global_sequence=1",
        "DELETE FROM authority_mutation WHERE global_sequence=1",
        "DELETE FROM authority_database_head WHERE database_instance_id=(SELECT database_instance_id FROM authority_database_head ORDER BY database_instance_id LIMIT 1)",
        "UPDATE authority_metadata SET global_hash='sha256:0000000000000000000000000000000000000000000000000000000000000000'",
    ] {
        db.execute_batch("SAVEPOINT corrupt").unwrap();
        db.execute_batch(sql).unwrap();
        assert!(fixture.inspect(&db).is_err(), "accepted {sql}");
        db.execute_batch("ROLLBACK TO corrupt; RELEASE corrupt")
            .unwrap();
    }
    fixture.inspect(&db).unwrap();
}

#[test]
fn real_signatures_do_not_substitute_for_node_head_and_permit_derivation() {
    let fixture = Fixture::node("finalized");
    let db = fixture.db();
    begin(&db);
    db.execute_batch("SAVEPOINT corrupt").unwrap();
    let request = saved(&db, "reserve_request_json", 1);
    let mut receipt = saved(&db, "reservation_receipt_json", 1);
    receipt["globalHash"] = json!(hash_bytes(b"signed but not incumbent head derivation"));
    fixture.sign(&mut receipt);
    assert!(
        contracts::verify_reservation_v1(
            &receipt,
            &request,
            &fixture.trust(),
            timestamp(&receipt["issuedAt"]).unwrap(),
            &|r| verify_online_signature_v1(r, &fixture.public)
        )
        .unwrap()
    );
    update(&db, "reservation_receipt_json", 1, &receipt);
    assert!(fixture.inspect(&db).is_err());
    db.execute_batch("ROLLBACK TO corrupt; RELEASE corrupt")
        .unwrap();
    let reservation = saved(&db, "reservation_receipt_json", 1);
    let request = saved(&db, "finalize_request_json", 1);
    let mut receipt = saved(&db, "finalization_receipt_json", 1);
    receipt["sideEffectPermitHash"] = json!(hash_bytes(b"signed but wrong permit"));
    fixture.sign(&mut receipt);
    assert!(
        contracts::verify_finalization_v1(
            &receipt,
            &request,
            &reservation,
            &fixture.trust(),
            timestamp(&receipt["finalizedAt"]).unwrap(),
            &|r| verify_online_signature_v1(r, &fixture.public)
        )
        .unwrap()
    );
    update(&db, "finalization_receipt_json", 1, &receipt);
    assert!(fixture.inspect(&db).is_err());
}

#[test]
fn signatures_epoch_contract_and_ambiguous_json_are_checked_independently() {
    let fixture = Fixture::node("finalized");
    let db = fixture.db();
    begin(&db);
    let rows = read_source_rows(&db).unwrap();
    assert!(
        verify_mutation_history_v1(
            &rows,
            &fixture.value["genesis"],
            &fixture.trust(),
            &SigningKey::from_bytes(&[19; 32]).verifying_key()
        )
        .is_err()
    );
    let mut genesis = fixture.value["genesis"].clone();
    for head in genesis["databaseHeads"].as_array_mut().unwrap() {
        head["schemaContractId"] = json!("schema:different-epoch");
    }
    assert!(
        verify_mutation_history_v1(&rows, &genesis, &fixture.trust(), &fixture.public).is_err()
    );
    db.execute_batch("SAVEPOINT corrupt").unwrap();
    let raw: String = db
        .query_row(
            "SELECT reserve_request_json FROM authority_mutation WHERE global_sequence=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let ambiguous = format!("{{\"version\":1,{}", &raw[1..]);
    db.execute(
        "UPDATE authority_mutation SET reserve_request_json=?1 WHERE global_sequence=1",
        [ambiguous],
    )
    .unwrap();
    assert!(fixture.inspect(&db).is_err());
    db.execute_batch("ROLLBACK TO corrupt; RELEASE corrupt")
        .unwrap();
    let mut receipt = saved(&db, "reservation_receipt_json", 1);
    receipt["signature"] = json!(Base64::encode_string(&[0; 64]));
    update(&db, "reservation_receipt_json", 1, &receipt);
    assert!(fixture.inspect(&db).is_err());
}

#[test]
fn correctly_signed_abort_before_a_later_row_is_rejected() {
    let fixture = Fixture::node("finalized");
    let db = fixture.db();
    begin(&db);
    let reservation = saved(&db, "reservation_receipt_json", 1);
    let request = contracts::build_abort_request_v1(
        &reservation,
        "local-apply-failed",
        &reservation["issuedAt"],
    )
    .unwrap();
    let mut receipt = request.clone();
    receipt["kind"] = json!("AutonomousResearchOnlineMutationAbortReceipt");
    receipt["status"] = json!("autonomous_research_online_mutation_aborted");
    receipt["authorityId"] = fixture.trust()["authorityId"].clone();
    receipt["keyId"] = fixture.trust()["keyId"].clone();
    receipt["requestHash"] =
        json!(hash("AutonomousResearchOnlineMutationAbortRequest", &request).unwrap());
    receipt["abortedAt"] = reservation["issuedAt"].clone();
    fixture.sign(&mut receipt);
    assert!(
        contracts::verify_abort_v1(
            &receipt,
            &request,
            &reservation,
            &fixture.trust(),
            timestamp(&receipt["abortedAt"]).unwrap(),
            &|r| verify_online_signature_v1(r, &fixture.public)
        )
        .unwrap()
    );
    db.execute("UPDATE authority_mutation SET status='aborted',finalize_request_json=NULL,finalization_receipt_json=NULL,abort_request_json=?1,abort_receipt_json=?2 WHERE global_sequence=1",params![request.to_string(),receipt.to_string()]).unwrap();
    assert!(fixture.inspect(&db).is_err());
}

#[test]
fn equivalent_json_integer_spellings_preserve_original_signatures_and_replay() {
    fn floating(value: &mut Value) {
        match value {
            Value::Number(number) => *value = json!(number.as_f64().unwrap()),
            Value::Array(values) => values.iter_mut().for_each(floating),
            Value::Object(values) => values.values_mut().for_each(floating),
            _ => {}
        }
    }
    let fixture = Fixture::node("tail");
    let db = fixture.db();
    begin(&db);
    let before = fixture.inspect(&db).unwrap();
    let rows = read_source_rows(&db).unwrap();
    for row in rows.mutations() {
        for (offset, column) in [
            "reserve_request_json",
            "reservation_receipt_json",
            "finalize_request_json",
            "finalization_receipt_json",
            "abort_request_json",
            "abort_receipt_json",
        ]
        .iter()
        .enumerate()
        {
            if let Some(raw) = row[6 + offset].as_str() {
                let mut value: Value = serde_json::from_str(raw).unwrap();
                floating(&mut value);
                db.execute(
                    &format!("UPDATE authority_mutation SET {column}=?1 WHERE rowid=?2"),
                    params![value.to_string(), row[0].as_i64().unwrap()],
                )
                .unwrap();
            }
        }
    }
    let after = fixture.inspect(&db).unwrap();
    assert_eq!(before.head(), after.head());
    assert_eq!(before.report(), after.report());
    assert_ne!(
        rows.logical_hash(),
        read_source_rows(&db).unwrap().logical_hash()
    );
}

#[test]
fn sqlite_peer() {
    let Some(path) = std::env::var_os("HEPTA_MUTATION_HISTORY_PEER_PATH") else {
        return;
    };
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    assert_eq!(
        db.execute_batch("BEGIN IMMEDIATE")
            .unwrap_err()
            .sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy)
    );
    println!("mutation_history_peer_checked");
}
fn peer(fixture: &Fixture) {
    let name = format!(
        "{}::sqlite_peer",
        module_path!().split_once("::").unwrap().1
    );
    let output = Command::new("/proc/self/exe")
        .args(["--exact", &name, "--nocapture"])
        .env("HEPTA_MUTATION_HISTORY_PEER_PATH", fixture.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("mutation_history_peer_checked"));
}
#[test]
fn snapshot_and_pure_replay_preserve_delete_and_wal_locks_on_success_and_failure() {
    for mode in ["DELETE", "WAL"] {
        let fixture = Fixture::node("tail");
        {
            let db = fixture.db();
            db.pragma_update(None, "journal_mode", mode).unwrap();
        }
        let original = fs::read(fixture.path()).unwrap();
        {
            let db = fixture.db();
            begin(&db);
            peer(&fixture);
            fixture.inspect(&db).unwrap();
            peer(&fixture);
            db.execute("UPDATE authority_mutation SET mutation_attempt_id='mutation:transplanted' WHERE global_sequence=1",[]).unwrap();
            let snapshot = read_source_rows(&db).unwrap();
            let changes = db.total_changes();
            assert!(fixture.inspect(&db).is_err());
            peer(&fixture);
            assert_eq!(changes, db.total_changes());
            assert_eq!(
                snapshot.logical_hash(),
                read_source_rows(&db).unwrap().logical_hash()
            );
            db.execute_batch("ROLLBACK").unwrap();
        }
        assert_eq!(original, fs::read(fixture.path()).unwrap());
    }
}
