use super::super::{
    LegacyAuthorityJournalVerifierV1, schema_history::verify_online_signature_v1,
    source_profile::inspect_source_schema, source_rows::read_source_rows,
};
use super::*;
use crate::{
    local_state_authority::LocalStateAuthorityRuntimeV1,
    sqlite_mutation_coordinator::{ONLINE_MUTATION_PROTOCOL, contracts, timestamp},
};
use base64ct::{Base64, Encoding};
use ed25519_dalek::{
    SigningKey,
    pkcs8::{DecodePublicKey, EncodePublicKey},
};
use rusqlite::{OpenFlags, TransactionState};
use std::{
    fs,
    io::{Cursor, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const NOW: &str = "2026-09-21T02:00:00.000Z";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    oracle: Value,
    daemon_hash: String,
    online_hash: String,
    public: VerifyingKey,
}
impl Fixture {
    fn node(scenario: &str) -> Self {
        let root = PathBuf::from(format!(
            "/tmp/hepta-offline-image-{}-{}-{}",
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
            .arg(service.join("src/local_state_authority/migration/offline_image/oracle.mjs"))
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
        let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&oracle["profile"]).unwrap();
        let public =
            VerifyingKey::from_public_key_pem(oracle["publicKeyPem"].as_str().unwrap()).unwrap();
        let daemon_hash = hash_bytes(&fs::read(root.join("configuration.json")).unwrap());
        let mut fixture = Self {
            root,
            oracle,
            daemon_hash,
            online_hash: String::new(),
            public,
        };
        fixture.pin_public(public);
        fixture
    }
    fn pin_public(&mut self, key: VerifyingKey) {
        let config = &self.oracle["configuration"];
        let document = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityPublicKey",
            "authorityId":config["authorityId"],"keyId":config["keyId"],"algorithm":"ed25519",
            "publicKeyPem":key.to_public_key_pem(Default::default()).unwrap()});
        let bytes = serde_json::to_vec(&document).unwrap();
        let path = self.root.join("public-key.json");
        private_file(&path, &bytes);
        let mut online = config.as_object().unwrap().clone();
        for name in ["privateKeyPath", "stateDatabasePath", "socketPath"] {
            online.remove(name);
        }
        online.insert(
            "kind".into(),
            json!("AutonomousResearchOnlineMutationAuthorityConfiguration"),
        );
        online.insert("publicKeyPath".into(), json!(path));
        online.insert("publicKeySha256".into(), json!(hash_bytes(&bytes)));
        let bytes = serde_json::to_vec(&online).unwrap();
        private_file(&self.root.join("online.json"), &bytes);
        self.online_hash = hash_bytes(&bytes);
    }
    fn load(&self) -> LegacyAuthorityJournalVerifierV1 {
        LegacyAuthorityJournalVerifierV1::load(
            &self.root.join("configuration.json"),
            &self.daemon_hash,
            &self.root.join("online.json"),
            &self.online_hash,
        )
        .unwrap()
    }
    fn path(&self) -> PathBuf {
        PathBuf::from(
            self.oracle["configuration"]["stateDatabasePath"]
                .as_str()
                .unwrap(),
        )
    }
    fn source(&self, write: bool) -> Connection {
        let db = Connection::open_with_flags(
            self.path(),
            if write {
                OpenFlags::SQLITE_OPEN_READ_WRITE
            } else {
                OpenFlags::SQLITE_OPEN_READ_ONLY
            },
        )
        .unwrap();
        if !write {
            db.pragma_update(None, "query_only", true).unwrap();
        }
        db.execute_batch(if write {
            "BEGIN IMMEDIATE"
        } else {
            "BEGIN DEFERRED"
        })
        .unwrap();
        db.query_row("SELECT count(*) FROM main.sqlite_schema", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap();
        db
    }
    fn install_detached_image(&self, bytes: &[u8]) {
        // Test-only publication: every source and verifier SQLite scope was
        // closed by the caller. Let SQLite finish WAL work; never copy/delete
        // a live WAL family or treat a main-only copy as a backup.
        assert!(self.path().starts_with(&self.root));
        let checkpoint = Connection::open(self.path()).unwrap();
        let (busy, _, _): (i64, i64, i64) = checkpoint
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(busy, 0);
        checkpoint.close().unwrap();
        for suffix in ["-wal", "-shm", "-journal"] {
            assert!(!PathBuf::from(format!("{}{suffix}", self.path().display())).exists());
        }
        fs::rename(self.path(), self.root.join("retained-original-node.sqlite")).unwrap();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.path())
            .unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn private_file(path: &std::path::Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn exact_rows(db: &Connection) -> Vec<Vec<Vec<Value>>> {
    let rows = read_source_rows(db).unwrap();
    [
        rows.metadata(),
        rows.heads(),
        rows.schema_transition(),
        rows.schema_rebind(),
        rows.mutations(),
        rows.backups(),
    ]
    .iter()
    .map(|r| r.to_vec())
    .collect()
}
fn deserialize(bytes: &[u8], readonly: bool) -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    db.deserialize_read_exact(MAIN_DB, Cursor::new(bytes), bytes.len(), readonly)
        .unwrap();
    db
}
fn begin_read(db: &Connection) {
    db.execute_batch("BEGIN DEFERRED").unwrap();
    db.query_row("SELECT count(*) FROM main.sqlite_schema", [], |r| {
        r.get::<_, i64>(0)
    })
    .unwrap();
}
fn check_image(
    image: &OfflineNativeAuthorityImageV1,
    source: &[Vec<Vec<Value>>],
    public: &VerifyingKey,
) {
    assert_eq!(&image.bytes()[..16], b"SQLite format 3\0");
    assert_eq!(image.bytes()[18..20], [1, 1]);
    assert_eq!(
        image.report()["kind"],
        "HeptaLocalStateAuthorityOfflineNativeImageV1"
    );
    assert_eq!(
        image.report()["evidenceScope"],
        "offline_native_image_no_publication_authority"
    );
    assert_eq!(
        image.report()["sourceLogicalHash"],
        image.report()["nativeLogicalHash"]
    );
    assert_eq!(
        image.report()["publicKeySha256"],
        hash_bytes(public.as_bytes())
    );
    assert_eq!(image.report()["userVersion"], 1);
    assert_eq!(image.report()["imageSha256"], hash_bytes(image.bytes()));
    assert_eq!(image.report()["imageByteLength"], image.bytes().len());
    let db = deserialize(image.bytes(), true);
    begin_read(&db);
    assert_native_image(&db, &hash_bytes(public.as_bytes())).unwrap();
    assert_eq!(exact_rows(&db), source);
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn actual_node_images_preserve_every_legacy_sql_value_and_boot_the_real_native_runtime() {
    for scenario in [
        "uninitialized",
        "genesis",
        "rebind2",
        "multirole",
        "aborted-tail",
    ] {
        let fixture = Fixture::node(scenario);
        let original = fs::read(fixture.path()).unwrap();
        let config = fs::read(fixture.root.join("configuration.json")).unwrap();
        let image;
        {
            let verifier = fixture.load();
            let db = fixture.source(false);
            let source = exact_rows(&db);
            let rows = read_source_rows(&db).unwrap();
            let changes = db.total_changes();
            image = verifier.build_offline_native_image(&db).unwrap();
            check_image(&image, &source, &fixture.public);
            assert_eq!(image.report()["sourceLogicalHash"], rows.logical_hash());
            assert_eq!(image.report()["rowCounts"], rows.counts());
            assert_eq!(exact_rows(&db), source);
            inspect_source_schema(&db).unwrap();
            assert_eq!(db.total_changes(), changes);
            assert_eq!(
                db.transaction_state(Some("main")).unwrap(),
                TransactionState::Read
            );
            assert_eq!(
                db.pragma_query_value(None, "query_only", |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            db.execute_batch("ROLLBACK").unwrap();
            db.close().unwrap();
        }
        assert_eq!(fs::read(fixture.path()).unwrap(), original);
        fixture.install_detached_image(image.bytes());
        {
            let mut runtime =
                LocalStateAuthorityRuntimeV1::open(&fixture.root.join("configuration.json"))
                    .unwrap();
            runtime.context.fixed_now.set(timestamp(&json!(NOW)));
            let inspected = runtime.inspect().unwrap();
            assert_eq!(
                inspected["globalSequence"],
                fixture.oracle["terminal"]["globalSequence"]
            );
            assert_eq!(
                inspected["globalHash"],
                fixture.oracle["terminal"]["globalHash"]
            );
            assert_eq!(
                inspected["databaseHeads"],
                fixture.oracle["terminal"]["databaseHeads"]
            );
            if scenario != "uninitialized" {
                let config = &fixture.oracle["configuration"];
                let request = json!({"version":1,"kind":"AutonomousResearchOnlineMutationCurrentHeadRequest","protocol":ONLINE_MUTATION_PROTOCOL,
                    "scopeId":config["scopeId"],"databaseScopeHash":config["databaseScopeHash"],"writerManifestHash":config["writerManifestHash"],"nonce":"nonce:offline-native-image","requestedAt":NOW});
                let receipt = runtime.handle(&request).unwrap();
                assert!(
                    contracts::verify_current_head_v1(
                        &receipt,
                        &request,
                        &runtime.context.trust,
                        timestamp(&json!(NOW)).unwrap(),
                        None,
                        &|r| verify_online_signature_v1(r, &fixture.public)
                    )
                    .unwrap()
                );
            } else {
                assert_eq!(inspected["schemaTransitionState"], "uninitialized");
            }
        }
        assert_eq!(
            fs::read(fixture.root.join("configuration.json")).unwrap(),
            config
        );
    }
}

fn next_reservation(fixture: &Fixture, head: &Value) -> Value {
    let db = head["databaseHeads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["databaseRole"] == "native-store")
        .unwrap();
    let epoch = fixture.oracle["genesis"]["databaseHeads"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["databaseInstanceId"] == db["databaseInstanceId"])
        .unwrap();
    let changes = b"actual Rust authority continuation after offline fixture conversion";
    let post=contracts::online_mutation_state_hash_v1(&json!({"databaseRole":db["databaseRole"],"databaseInstanceId":db["databaseInstanceId"],
        "writerId":"writer:offline-continuation","operationId":"operation:offline-continuation","schemaHash":db["schemaHash"],"previousStateHash":db["stateHash"],
        "changesetHash":hash_bytes(changes),"databaseSequence":db["sequence"].as_i64().unwrap()+1,"authorizationReceiptHashes":[],"sideEffectReservationHashes":[]})).unwrap();
    let config = &fixture.oracle["configuration"];
    json!({"version":1,"kind":"AutonomousResearchOnlineMutationReserveRequest","protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":config["scopeId"],
        "databaseScopeHash":config["databaseScopeHash"],"writerManifestHash":config["writerManifestHash"],"databaseRole":db["databaseRole"],"databaseInstanceId":db["databaseInstanceId"],
        "writerId":"writer:offline-continuation","operationId":"operation:offline-continuation","codeProvenanceHash":hash_bytes(b"fixture code"),"mutationAttemptId":"mutation:after-old-abort",
        "globalPreviousSequence":head["globalSequence"],"globalPreviousHash":head["globalHash"],"databasePreviousSequence":db["sequence"],"databasePreviousHash":db["hash"],
        "schemaContractId":epoch["schemaContractId"],"schemaHash":db["schemaHash"],"preStateHash":db["stateHash"],"postStateHash":post,
        "changesetEncoding":"base64","changesetBase64":Base64::encode_string(changes),"changesetByteLength":changes.len(),"changesetHash":hash_bytes(changes),
        "authorizationReceiptHashes":[],"sideEffectReservationHashes":[],"requestedAt":NOW,"requestedLeaseMs":1000})
}

#[test]
fn actual_native_reserve_finalize_reuses_the_old_aborted_slot_without_deleting_evidence() {
    let fixture = Fixture::node("aborted-tail");
    let image;
    let aborted;
    {
        let verifier = fixture.load();
        let db = fixture.source(false);
        aborted = read_source_rows(&db)
            .unwrap()
            .mutations()
            .iter()
            .find(|r| r[3] == "aborted")
            .unwrap()
            .clone();
        image = verifier.build_offline_native_image(&db).unwrap();
        db.execute_batch("ROLLBACK").unwrap();
        db.close().unwrap();
    }
    fixture.install_detached_image(image.bytes());
    let mut runtime =
        LocalStateAuthorityRuntimeV1::open(&fixture.root.join("configuration.json")).unwrap();
    runtime.context.fixed_now.set(timestamp(&json!(NOW)));
    let head = runtime.inspect().unwrap();
    let request = next_reservation(&fixture, &head);
    let reservation = runtime.handle(&request).unwrap();
    assert_eq!(reservation["globalSequence"], aborted[4]);
    assert!(
        contracts::verify_reservation_v1(
            &reservation,
            &request,
            &runtime.context.trust,
            timestamp(&json!(NOW)).unwrap(),
            &|r| verify_online_signature_v1(r, &fixture.public)
        )
        .unwrap()
    );
    let request = contracts::build_finalize_request_v1(&reservation, &json!(NOW)).unwrap();
    let finalization = runtime.handle(&request).unwrap();
    assert!(
        contracts::verify_finalization_v1(
            &finalization,
            &request,
            &reservation,
            &runtime.context.trust,
            timestamp(&json!(NOW)).unwrap(),
            &|r| verify_online_signature_v1(r, &fixture.public)
        )
        .unwrap()
    );
    assert_eq!(runtime.inspect().unwrap()["globalSequence"], 4);
    begin_read(&runtime.connection);
    let rows = read_source_rows(&runtime.connection).unwrap();
    assert_eq!(rows.mutations().len(), 5);
    assert_eq!(
        rows.mutations().iter().find(|r| r[3] == "aborted").unwrap(),
        &aborted
    );
    let same_slot = rows
        .mutations()
        .iter()
        .filter(|r| r[4] == aborted[4])
        .map(|r| r[3].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(same_slot, vec!["aborted", "finalized"]);
    runtime.connection.execute_batch("ROLLBACK").unwrap();
    drop(runtime);
    let mut reopened =
        LocalStateAuthorityRuntimeV1::open(&fixture.root.join("configuration.json")).unwrap();
    assert_eq!(reopened.inspect().unwrap()["globalSequence"], 4);
}

#[test]
fn pending_wrong_key_backup_and_tampering_never_yield_an_image_or_change_source() {
    for scenario in [
        "pending-schema",
        "pending-rebind",
        "unactivated-rebind",
        "pending-mutation",
        "completed-backup",
        "wrong-key",
        "tampered-head",
    ] {
        let mut fixture = Fixture::node(if matches!(scenario, "wrong-key" | "tampered-head") {
            "genesis"
        } else {
            scenario
        });
        if scenario == "wrong-key" {
            fixture.pin_public(SigningKey::from_bytes(&[17; 32]).verifying_key());
        }
        let before = fs::read(fixture.path()).unwrap();
        {
            let verifier = fixture.load();
            let db = fixture.source(scenario == "tampered-head");
            if scenario == "tampered-head" {
                db.execute(
                    "UPDATE authority_metadata SET global_hash=?1",
                    [hash_bytes(b"tampered")],
                )
                .unwrap();
            }
            let source = exact_rows(&db);
            let changes = db.total_changes();
            assert!(
                verifier.build_offline_native_image(&db).is_err(),
                "accepted {scenario}"
            );
            assert_eq!(exact_rows(&db), source);
            assert_eq!(db.total_changes(), changes);
            assert!(!db.is_autocommit());
            db.execute_batch("ROLLBACK").unwrap();
            db.close().unwrap();
        }
        assert_eq!(fs::read(fixture.path()).unwrap(), before);
    }
}

#[test]
fn internal_report_misbinding_and_native_identity_version_changes_are_rejected() {
    let fixture = Fixture::node("genesis");
    let verifier = fixture.load();
    let db = fixture.source(false);
    let source = read_source_rows(&db).unwrap();
    let genuine = verifier.inspect(&db).unwrap();
    for field in [
        "sourceLogicalHash",
        "publicKeySha256",
        "kind",
        "evidenceScope",
        "rowCounts",
    ] {
        let mut report = genuine.clone();
        report[field] = json!("incorrect internal binding");
        assert!(build_image(&source, &fixture.public, &report).is_err());
    }
    let image = verifier.build_offline_native_image(&db).unwrap();
    for change in [
        "PRAGMA user_version=0",
        "DELETE FROM authority_native_identity",
        "UPDATE authority_native_identity SET key_hash='wrong-key'",
        "CREATE TABLE extra(x)",
    ] {
        let altered = deserialize(image.bytes(), false);
        altered.execute_batch(change).unwrap();
        assert!(
            assert_native_image(&altered, &hash_bytes(fixture.public.as_bytes())).is_err(),
            "accepted {change}"
        );
    }
    assert_eq!(
        source.logical_hash(),
        read_source_rows(&db).unwrap().logical_hash()
    );
}

#[test]
fn sqlite_peer() {
    let Some(path) = std::env::var_os("HEPTA_OFFLINE_IMAGE_PEER_PATH") else {
        return;
    };
    let blocked = std::env::var("HEPTA_OFFLINE_IMAGE_PEER_BLOCKED").unwrap() == "1";
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    let result = db.execute_batch("BEGIN IMMEDIATE");
    if blocked {
        assert_eq!(
            result.unwrap_err().sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
    } else {
        result.unwrap();
        db.execute_batch("ROLLBACK").unwrap();
    }
    println!("offline_image_peer_checked");
}
fn peer(fixture: &Fixture, blocked: bool) {
    let test = format!(
        "{}::sqlite_peer",
        module_path!().split_once("::").unwrap().1
    );
    let output = Command::new("/proc/self/exe")
        .args(["--exact", &test, "--nocapture"])
        .env("HEPTA_OFFLINE_IMAGE_PEER_PATH", fixture.path())
        .env(
            "HEPTA_OFFLINE_IMAGE_PEER_BLOCKED",
            if blocked { "1" } else { "0" },
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("offline_image_peer_checked"));
}
#[test]
fn image_construction_keeps_delete_and_existing_wal_writer_locks_on_success_and_failure() {
    for mode in ["DELETE", "WAL"] {
        let fixture = Fixture::node("aborted-tail");
        {
            let db = Connection::open(fixture.path()).unwrap();
            db.pragma_update(None, "journal_mode", mode).unwrap();
        }
        let before = fs::read(fixture.path()).unwrap();
        {
            let verifier = fixture.load();
            let db = fixture.source(true);
            let original = exact_rows(&db);
            peer(&fixture, true);
            let image = verifier.build_offline_native_image(&db).unwrap();
            check_image(&image, &original, &fixture.public);
            peer(&fixture, true);
            inspect_source_schema(&db).unwrap();
            assert_eq!(exact_rows(&db), original);
            db.execute("UPDATE authority_metadata SET global_sequence=99", [])
                .unwrap();
            let failed = exact_rows(&db);
            let changes = db.total_changes();
            assert!(verifier.build_offline_native_image(&db).is_err());
            peer(&fixture, true);
            assert_eq!(exact_rows(&db), failed);
            assert_eq!(db.total_changes(), changes);
            assert_eq!(
                db.transaction_state(Some("main")).unwrap(),
                TransactionState::Write
            );
            db.execute_batch("ROLLBACK").unwrap();
            peer(&fixture, false);
            db.close().unwrap();
        }
        assert_eq!(before, fs::read(fixture.path()).unwrap());
    }
}

#[test]
fn committed_rows_still_only_in_wal_are_copied_from_the_new_held_snapshot() {
    let fixture = Fixture::node("aborted-tail");
    let verifier = fixture.load();
    // Every file observation precedes these SQLite connections. No raw main,
    // WAL or SHM descriptor is opened or closed for the rest of this test.
    let keeper = Connection::open(fixture.path()).unwrap();
    keeper.pragma_update(None, "journal_mode", "WAL").unwrap();
    keeper.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    begin_read(&keeper);
    let old_rows = exact_rows(&keeper);
    let old_hash = read_source_rows(&keeper).unwrap().logical_hash().to_owned();

    let writer = Connection::open(fixture.path()).unwrap();
    writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert_eq!(writer.execute(
        "UPDATE authority_mutation SET reserve_request_json=' '||reserve_request_json||char(10) WHERE global_sequence=1",
        [],
    ).unwrap(), 1);
    writer.execute_batch("COMMIT").unwrap();
    let (busy, log, checkpointed): (i64, i64, i64) = writer
        .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!(busy, 0);
    assert!(
        log > checkpointed,
        "old reader must retain uncheckpointed committed frames"
    );
    assert_eq!(exact_rows(&keeper), old_rows);
    assert_eq!(read_source_rows(&keeper).unwrap().logical_hash(), old_hash);

    let source = fixture.source(false);
    let new_rows = exact_rows(&source);
    let new_hash = read_source_rows(&source).unwrap().logical_hash().to_owned();
    assert_ne!(new_hash, old_hash);
    assert_ne!(new_rows[4][0][6], old_rows[4][0][6]);
    assert_eq!(
        new_rows[4][0][6].as_str().unwrap(),
        format!(" {}\n", old_rows[4][0][6].as_str().unwrap())
    );
    // Canonical signed meaning has not changed, so the independently pinned
    // full verifier still accepts it. Its artifact must retain the new TEXT.
    let image = verifier.build_offline_native_image(&source).unwrap();
    check_image(&image, &new_rows, &fixture.public);
    assert_eq!(image.report()["sourceLogicalHash"], new_hash);
    assert_eq!(image.report()["nativeLogicalHash"], new_hash);
    assert_ne!(image.report()["sourceLogicalHash"], old_hash);
    assert_eq!(exact_rows(&source), new_rows);
    assert_eq!(exact_rows(&keeper), old_rows);
    assert_eq!(source.total_changes(), 0);
    assert_eq!(
        source.transaction_state(Some("main")).unwrap(),
        TransactionState::Read
    );

    source.execute_batch("ROLLBACK").unwrap();
    source.close().unwrap();
    writer.close().unwrap();
    keeper.execute_batch("ROLLBACK").unwrap();
    keeper.close().unwrap();
    drop(verifier);
}
