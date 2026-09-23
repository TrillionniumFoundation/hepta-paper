use super::super::source_rows::read_source_rows;
use super::*;
use ed25519_dalek::{
    Signer, SigningKey,
    pkcs8::{DecodePrivateKey, DecodePublicKey},
};
use rusqlite::{Connection, params};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    value: Value,
    key: VerifyingKey,
}
impl Fixture {
    fn new(scenario: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-schema-history-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let service = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo = service.ancestors().nth(3).unwrap();
        let output = Command::new("node")
            .arg(service.join("src/local_state_authority/migration/schema_history/oracle.mjs"))
            .arg(repo)
            .arg(&root)
            .arg(scenario)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&value["profile"]).unwrap();
        let key =
            VerifyingKey::from_public_key_pem(value["publicKeyPem"].as_str().unwrap()).unwrap();
        Self { root, value, key }
    }
    fn open(&self) -> Connection {
        let db = Connection::open(
            self.value["configuration"]["stateDatabasePath"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        db
    }
    fn inspect(&self, db: &Connection) -> Result<VerifiedLegacySchemaHistoryV1> {
        verify_schema_history_v1(
            &read_source_rows(db)?,
            &self.value["configuration"],
            &self.key,
        )
    }
    fn signer(&self) -> SigningKey {
        SigningKey::from_pkcs8_pem(
            &fs::read_to_string(
                self.value["configuration"]["privateKeyPath"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn actual_node_uninitialized_initial_and_two_activated_rebinds_reconstruct_exact_genesis() {
    for (mode, count) in [
        ("uninitialized", 0),
        ("genesis", 0),
        ("rebind", 1),
        ("rebind2", 2),
        ("rebind-permuted", 1),
    ] {
        let fixture = Fixture::new(mode);
        let db = fixture.open();
        let before = read_source_rows(&db).unwrap();
        let changes = db.total_changes();
        let result = fixture.inspect(&db).unwrap();
        assert_eq!(result.genesis(), &fixture.value["genesis"], "{mode}");
        assert_eq!(result.initialized(), mode != "uninitialized");
        assert_eq!(result.report()["rebindCount"], count);
        assert_eq!(
            result.report()["evidenceScope"],
            "schema_epoch_only_no_migration_authority"
        );
        assert_eq!(
            result.trust()["writerManifestHash"],
            fixture.value["configuration"]["writerManifestHash"]
        );
        assert_eq!(
            read_source_rows(&db).unwrap().logical_hash(),
            before.logical_hash()
        );
        assert_eq!(db.total_changes(), changes);
        assert_eq!(
            db.transaction_state(Some("main")).unwrap(),
            rusqlite::TransactionState::Write
        );
        if mode == "rebind-permuted" {
            let roles = result.genesis()["databaseHeads"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["databaseRole"].as_str().unwrap())
                .collect::<Vec<_>>();
            let mut sorted = roles.clone();
            sorted.sort();
            assert_ne!(roles, sorted);
        }
    }
}

#[test]
fn actual_node_pending_initial_and_pending_or_unactivated_rebinds_are_refused() {
    for mode in ["reserved-initial", "reserved-rebind", "finalized-rebind"] {
        let fixture = Fixture::new(mode);
        let db = fixture.open();
        let before = read_source_rows(&db).unwrap().logical_hash().to_owned();
        assert!(fixture.inspect(&db).is_err(), "{mode}");
        assert_eq!(read_source_rows(&db).unwrap().logical_hash(), before);
        assert!(!db.is_autocommit());
    }
}

#[test]
fn sql_keys_null_pairs_orphans_rowid_order_and_unrecoverable_configuration_are_refused() {
    let fixture = Fixture::new("rebind2");
    let db = fixture.open();
    for sql in [
        "UPDATE authority_schema_transition SET finalize_request_json=NULL",
        "UPDATE authority_schema_transition SET finalization_receipt_json=NULL",
        "UPDATE authority_schema_rebind SET finalize_request_json=NULL WHERE rowid=1",
        "UPDATE authority_schema_rebind SET finalization_receipt_json=NULL WHERE rowid=1",
        "UPDATE authority_schema_rebind SET transition_id='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE rowid=1",
        "UPDATE authority_schema_rebind SET target_configuration_hash='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE rowid=1",
        "UPDATE authority_schema_rebind SET rowid=99 WHERE rowid=1",
        "DELETE FROM authority_schema_rebind WHERE rowid=1",
        "DELETE FROM authority_schema_transition",
        "UPDATE authority_schema_transition SET reserve_request_json='{}'",
        "UPDATE authority_schema_transition SET reservation_receipt_json='{\"version\":1,\"version\":1}'",
        "UPDATE authority_schema_rebind SET finalization_receipt_json=json_set(finalization_receipt_json,'$.signature','broken') WHERE rowid=1",
    ] {
        db.execute_batch("SAVEPOINT changed").unwrap();
        db.execute_batch(sql).unwrap();
        assert!(fixture.inspect(&db).is_err(), "accepted {sql}");
        db.execute_batch("ROLLBACK TO changed; RELEASE changed")
            .unwrap();
        fixture.inspect(&db).unwrap();
    }
    let rows = read_source_rows(&db).unwrap();
    for key in ["privateKeyPath", "stateDatabasePath", "socketPath"] {
        let mut config = fixture.value["configuration"].clone();
        config[key] = json!("/different/retained/installation");
        assert!(
            verify_schema_history_v1(&rows, &config, &fixture.key).is_err(),
            "{key}"
        );
    }
    let mut config = fixture.value["configuration"].clone();
    config["maximumObservationAgeMs"] = json!(30001);
    assert!(verify_schema_history_v1(&rows, &config, &fixture.key).is_err());
    assert!(
        verify_schema_history_v1(
            &rows,
            &fixture.value["configuration"],
            &SigningKey::from_bytes(&[74; 32]).verifying_key()
        )
        .is_err()
    );
}

fn sign(value: &mut Value, key: &SigningKey) {
    value["signature"] = json!(Base64::encode_string(
        &key.sign(online_mutation_signed_payload_v1(value).unwrap().as_bytes())
            .to_bytes()
    ));
}
fn replace_chain_receipts(
    db: &Connection,
    rebind: bool,
    request: &Value,
    reservation: &mut Value,
    finalize: &mut Value,
    finalization: &mut Value,
    key: &SigningKey,
) {
    sign(reservation, key);
    let reservation_hash = schema_transition_receipt_hash_v1(reservation).unwrap();
    finalize["reservationReceiptHash"] = json!(reservation_hash);
    for row in finalize["installations"].as_array_mut().unwrap() {
        let mut payload = row.clone();
        payload.as_object_mut().unwrap().remove("installationHash");
        payload["transitionId"] = request["transitionId"].clone();
        payload["reservationReceiptHash"] = json!(reservation_hash);
        row["installationHash"] = json!(
            hash(
                "AutonomousResearchOnlineSchemaTransitionDatabaseInstallation",
                &payload
            )
            .unwrap()
        );
    }
    finalization["reservationReceiptHash"] = json!(reservation_hash);
    finalization["installations"] = finalize["installations"].clone();
    finalization["requestHash"] = json!(
        hash(
            "AutonomousResearchOnlineSchemaTransitionFinalizeRequest",
            finalize
        )
        .unwrap()
    );
    sign(finalization, key);
    let table = if rebind {
        "authority_schema_rebind"
    } else {
        "authority_schema_transition"
    };
    db.execute(&format!("UPDATE {table} SET reservation_receipt_json=?1,finalize_request_json=?2,finalization_receipt_json=?3 WHERE rowid=1"),params![reservation.to_string(),finalize.to_string(),finalization.to_string()]).unwrap();
}

#[test]
fn genuinely_signed_but_false_initial_and_disconnected_rebind_genesis_are_rejected() {
    for mode in ["genesis", "rebind"] {
        let fixture = Fixture::new(mode);
        // Test-only actual fixture signing key is read before the SQLite handle.
        let signer = fixture.signer();
        let db = fixture.open();
        let index = if mode == "genesis" { 0 } else { 1 };
        let original = &fixture.value["transitions"][index];
        let request = original["request"].clone();
        let mut reservation = original["reservation"].clone();
        let mut finalize = original["finalize"].clone();
        let mut finalization = original["finalization"].clone();
        if index == 0 {
            reservation["databaseGenesis"][0]["databaseHash"] = json!(hash_bytes(b"false genesis"));
        } else {
            reservation["previousGlobalHash"] =
                json!(hash_bytes(b"detached genuine signed branch"));
            reservation["databaseGenesis"] = build_pristine_schema_rebind_genesis_v2(
                &request,
                &reservation["previousGlobalHash"],
                &reservation["previousDatabaseHeads"],
            )
            .unwrap();
            finalization["globalHash"] = reservation["databaseGenesis"][0]["globalHash"].clone();
        }
        replace_chain_receipts(
            &db,
            index != 0,
            &request,
            &mut reservation,
            &mut finalize,
            &mut finalization,
            &signer,
        );
        let mut config = fixture.value["configuration"].clone();
        config["writerManifestHash"] = if index == 0 {
            request["writerManifestHash"].clone()
        } else {
            request["sourceWriterManifestHash"].clone()
        };
        let authority_trust = trust(&config).unwrap();
        // Every individual contract and actual Ed25519 signature still passes.
        assert!(
            verify_schema_transition_reservation_v1(
                &reservation,
                &request,
                &authority_trust,
                timestamp(&reservation["issuedAt"]).unwrap(),
                &|r| verify_online_signature_v1(r, &fixture.key)
            )
            .unwrap()
        );
        assert!(
            verify_schema_transition_finalization_v1(
                &finalization,
                &finalize,
                &reservation,
                &authority_trust,
                timestamp(&finalization["finalizedAt"]).unwrap(),
                &|r| verify_online_signature_v1(r, &fixture.key)
            )
            .unwrap()
        );
        assert!(fixture.inspect(&db).is_err());
    }
}

#[test]
fn genuine_node_signature_base64_and_integral_wire_spellings_keep_protocol_meaning() {
    let fixture = Fixture::new("genesis");
    let db = fixture.open();
    let expected = fixture.inspect(&db).unwrap().genesis().clone();
    let original = &fixture.value["transitions"][0]["reservation"];
    let raw = original["signature"]
        .as_str()
        .unwrap()
        .trim_end_matches('=');
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let last = ALPHABET
        .iter()
        .position(|b| *b == raw.as_bytes()[85])
        .unwrap();
    for padding in ["", "=", "=="] {
        let mut encoded = raw.as_bytes().to_vec();
        encoded[85] = ALPHABET[(last & 0b110000) | 0b001111];
        let mut altered = original.clone();
        altered["signature"] = json!(format!("{}{padding}", String::from_utf8(encoded).unwrap()));
        assert!(verify_online_signature_v1(&altered, &fixture.key));
    }
    for malformed in [
        "broken",
        " AAAAAAAAAA",
        "______________________________________________________________________________________==",
    ] {
        let mut altered = original.clone();
        altered["signature"] = json!(malformed);
        assert!(!verify_online_signature_v1(&altered, &fixture.key));
    }
    // Canonical record signing gives JSON integer spellings the same meaning;
    // retain the original SQL TEXT while normalizing only the verified values.
    db.execute("UPDATE authority_schema_transition SET reservation_receipt_json=replace(reservation_receipt_json,'\"globalSequence\":0','\"globalSequence\":0.0')",[]).unwrap();
    assert_eq!(fixture.inspect(&db).unwrap().genesis(), &expected);
}
