use super::*;
use rusqlite::{OpenFlags, TransactionState};
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
    oracle: Value,
    daemon_hash: String,
    online_hash: String,
}
impl Fixture {
    fn node(scenario: &str) -> Self {
        Self::from_oracle("schema_history", scenario)
    }
    fn from_oracle(module: &str, scenario: &str) -> Self {
        let root = PathBuf::from(format!(
            "/tmp/hepta-history-owner-{}-{}-{}",
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
            .arg(service.join(format!(
                "src/local_state_authority/migration/{module}/oracle.mjs"
            )))
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
        let configuration = &oracle["configuration"];
        let public = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityPublicKey",
            "authorityId":configuration["authorityId"],"keyId":configuration["keyId"],
            "algorithm":"ed25519","publicKeyPem":oracle["publicKeyPem"]});
        let public_bytes = serde_json::to_vec(&public).unwrap();
        let public_path = root.join("public-key.json");
        fs::write(&public_path, &public_bytes).unwrap();
        fs::set_permissions(&public_path, fs::Permissions::from_mode(0o600)).unwrap();
        let mut online = configuration.as_object().unwrap().clone();
        for name in ["privateKeyPath", "stateDatabasePath", "socketPath"] {
            online.remove(name);
        }
        online.insert(
            "kind".into(),
            json!("AutonomousResearchOnlineMutationAuthorityConfiguration"),
        );
        online.insert("publicKeyPath".into(), json!(public_path));
        online.insert("publicKeySha256".into(), json!(hash_bytes(&public_bytes)));
        let online_bytes = serde_json::to_vec(&online).unwrap();
        fs::write(root.join("online.json"), &online_bytes).unwrap();
        fs::set_permissions(root.join("online.json"), fs::Permissions::from_mode(0o600)).unwrap();
        let daemon_hash = hash_bytes(&fs::read(root.join("configuration.json")).unwrap());
        // Verification must work without any private key available to load.
        fs::remove_file(configuration["privateKeyPath"].as_str().unwrap()).unwrap();
        Self {
            root,
            oracle,
            daemon_hash,
            online_hash: hash_bytes(&online_bytes),
        }
    }
    fn load(&self) -> Result<LegacyAuthorityJournalVerifierV1> {
        LegacyAuthorityJournalVerifierV1::load(
            &self.root.join("configuration.json"),
            &self.daemon_hash,
            &self.root.join("online.json"),
            &self.online_hash,
        )
    }
    fn database(&self) -> PathBuf {
        self.root.join("authority.sqlite")
    }
    fn begin(&self, write: bool) -> Connection {
        let db = Connection::open_with_flags(
            self.database(),
            if write {
                OpenFlags::SQLITE_OPEN_READ_WRITE
            } else {
                OpenFlags::SQLITE_OPEN_READ_ONLY
            },
        )
        .unwrap();
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
}

#[test]
fn pinned_owner_replays_actual_multirole_mutations_after_rebind_and_abort_tail() {
    for scenario in ["rebound", "tail"] {
        let fixture = Fixture::from_oracle("mutation_history", scenario);
        let verifier = fixture.load().unwrap();
        let db = fixture.begin(false);
        let report = verifier.inspect(&db).unwrap();
        assert_eq!(
            report["head"]["globalSequence"],
            fixture.oracle["terminal"]["globalSequence"]
        );
        assert_eq!(
            report["head"]["globalHash"],
            fixture.oracle["terminal"]["globalHash"]
        );
        let mut heads = report["head"]["databaseHeads"].clone();
        for value in heads.as_array_mut().unwrap() {
            value.as_object_mut().unwrap().remove("schemaContractId");
        }
        assert_eq!(heads, fixture.oracle["terminal"]["databaseHeads"]);
        assert_eq!(report["mutationHistory"]["finalizedMutations"], 3);
        assert_eq!(
            report["mutationHistory"]["abortedTailMutations"],
            if scenario == "tail" { 1 } else { 0 }
        );
        assert_eq!(db.total_changes(), 0);
    }
    let fixture = Fixture::from_oracle("mutation_history", "reserved");
    let verifier = fixture.load().unwrap();
    let db = fixture.begin(false);
    assert_eq!(
        verifier.inspect(&db).err().unwrap().code,
        "local_authority_mutation_history_unresolved"
    );
    assert_eq!(db.total_changes(), 0);
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn integral_float_configuration_spellings_keep_pins_and_historical_identity_distinct() {
    let mut fixture = Fixture::node("genesis");
    let original_pin = fixture.daemon_hash.clone();
    for name in ["configuration.json", "online.json"] {
        let path = fixture.root.join(name);
        let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for field in [
            "version",
            "maximumReservationLeaseMs",
            "maximumObservationAgeMs",
        ] {
            value[field] = json!(value[field].as_f64().unwrap());
        }
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("1.0"));
        fs::write(path, &bytes).unwrap();
        if name == "configuration.json" {
            fixture.daemon_hash = hash_bytes(&bytes);
        } else {
            fixture.online_hash = hash_bytes(&bytes);
        }
    }
    assert_ne!(fixture.daemon_hash, original_pin);
    let verifier = fixture.load().unwrap();
    let db = fixture.begin(false);
    let report = verifier.inspect(&db).unwrap();
    assert_eq!(report["head"], fixture.oracle["genesis"]);
    assert_eq!(
        report["configurationHash"],
        hash(
            "HeptaLocalAutonomousResearchStateAuthorityConfiguration",
            &fixture.oracle["configuration"]
        )
        .unwrap()
    );
    assert_eq!(report["configurationFileSha256"], fixture.daemon_hash);
}

#[test]
fn independently_pinned_public_key_replays_real_node_schema_epochs_without_private_key() {
    for scenario in ["uninitialized", "genesis", "rebind2"] {
        let fixture = Fixture::node(scenario);
        let verifier = fixture.load().unwrap();
        let before = fs::read(fixture.database()).unwrap();
        let db = fixture.begin(false);
        let report = verifier.inspect(&db).unwrap();
        assert_eq!(report["head"], fixture.oracle["genesis"]);
        assert_eq!(
            report["evidenceScope"],
            "signed_history_observation_no_migration_authority"
        );
        assert_eq!(report["configurationFileSha256"], fixture.daemon_hash);
        assert_eq!(report["rowCounts"]["authority_backup_reservation"], 0);
        assert_eq!(db.total_changes(), 0);
        assert_eq!(
            db.transaction_state(Some("main")).unwrap(),
            TransactionState::Read
        );
        assert_eq!(report, verifier.inspect(&db).unwrap());
        drop(db);
        assert_eq!(before, fs::read(fixture.database()).unwrap());
        assert!(!report.to_string().contains("PRIVATE KEY"));
    }
}

#[test]
fn pending_schema_backup_rows_and_unsigned_terminal_tampering_fail_without_changes() {
    for scenario in ["reserved-initial", "reserved-rebind", "finalized-rebind"] {
        let fixture = Fixture::node(scenario);
        let verifier = fixture.load().unwrap();
        let db = fixture.begin(false);
        assert!(verifier.inspect(&db).is_err(), "{scenario}");
        assert_eq!(db.total_changes(), 0);
        assert_eq!(
            db.transaction_state(Some("main")).unwrap(),
            TransactionState::Read
        );
    }
    let fixture = Fixture::node("genesis");
    let verifier = fixture.load().unwrap();
    let db = fixture.begin(true);
    db.execute_batch("SAVEPOINT damaged").unwrap();
    db.execute(
        "UPDATE authority_metadata SET global_hash=?1",
        [format!("sha256:{}", "f".repeat(64))],
    )
    .unwrap();
    let changes = db.total_changes();
    assert!(verifier.inspect(&db).is_err());
    assert_eq!(db.total_changes(), changes);
    db.execute_batch("ROLLBACK TO damaged; RELEASE damaged")
        .unwrap();
    verifier.inspect(&db).unwrap();
    db.execute(
        "INSERT INTO authority_backup_reservation VALUES('backup:unsupported','{}','{}',NULL,NULL)",
        [],
    )
    .unwrap();
    assert_eq!(
        verifier.inspect(&db).err().unwrap().code,
        "local_authority_history_backup_provenance_unsupported"
    );
}

#[test]
fn pin_mismatch_trust_mismatch_and_changed_input_refuse_observation() {
    let fixture = Fixture::node("genesis");
    let wrong = format!("sha256:{}", "0".repeat(64));
    assert!(
        LegacyAuthorityJournalVerifierV1::load(
            &fixture.root.join("configuration.json"),
            &wrong,
            &fixture.root.join("online.json"),
            &fixture.online_hash
        )
        .is_err()
    );
    let verifier = fixture.load().unwrap();
    let db = fixture.begin(false);
    let mut online: Value =
        serde_json::from_slice(&fs::read(fixture.root.join("online.json")).unwrap()).unwrap();
    online["writerManifestHash"] = json!(format!("sha256:{}", "f".repeat(64)));
    let bytes = serde_json::to_vec(&online).unwrap();
    // These are public configuration files, never aliases of the SQL source.
    fs::write(fixture.root.join("online.json"), &bytes).unwrap();
    assert!(verifier.inspect(&db).is_err());
    assert_eq!(db.total_changes(), 0);
    drop(db);
    drop(verifier);
    assert_eq!(
        LegacyAuthorityJournalVerifierV1::load(
            &fixture.root.join("configuration.json"),
            &fixture.daemon_hash,
            &fixture.root.join("online.json"),
            &hash_bytes(&bytes)
        )
        .err()
        .unwrap()
        .code,
        "local_authority_history_configuration_trust_mismatch"
    );
}

fn peer(fixture: &Fixture, blocked: bool) {
    let test = format!(
        "{}::sqlite_peer",
        module_path!().split_once("::").unwrap().1
    );
    let output = Command::new("/proc/self/exe")
        .args(["--exact", &test, "--nocapture"])
        .env("HEPTA_HISTORY_PEER_PATH", fixture.database())
        .env(
            "HEPTA_HISTORY_PEER_BLOCKED",
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
    assert!(String::from_utf8_lossy(&output.stdout).contains("history_peer_checked"));
}
#[test]
fn sqlite_peer() {
    let Some(path) = std::env::var_os("HEPTA_HISTORY_PEER_PATH") else {
        return;
    };
    let blocked = std::env::var("HEPTA_HISTORY_PEER_BLOCKED").unwrap() == "1";
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
    println!("history_peer_checked");
}
#[test]
fn complete_observation_preserves_actual_delete_and_wal_writer_exclusion() {
    for mode in ["DELETE", "WAL"] {
        let fixture = Fixture::node("genesis");
        let verifier = fixture.load().unwrap();
        let db = Connection::open(fixture.database()).unwrap();
        db.pragma_update(None, "journal_mode", mode).unwrap();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        verifier.inspect(&db).unwrap();
        peer(&fixture, true);
        db.execute("UPDATE authority_metadata SET global_sequence=1", [])
            .unwrap();
        assert!(verifier.inspect(&db).is_err());
        peer(&fixture, true);
        db.execute_batch("ROLLBACK").unwrap();
        peer(&fixture, false);
        drop(db);
    }
}

#[test]
fn configuration_alias_replacement_cannot_release_a_live_sqlite_writer_lock() {
    for name in ["configuration.json", "online.json", "public-key.json"] {
        for mode in ["DELETE", "WAL"] {
            let fixture = Fixture::node("genesis");
            let verifier = fixture.load().unwrap();
            let db = Connection::open(fixture.database()).unwrap();
            db.pragma_update(None, "journal_mode", mode).unwrap();
            db.execute_batch("BEGIN IMMEDIATE").unwrap();
            verifier.inspect(&db).unwrap();
            let path = fixture.root.join(name);
            fs::rename(&path, fixture.root.join(format!("{name}.retained"))).unwrap();
            fs::hard_link(fixture.database(), &path).unwrap();
            // Inspect must only lstat the replacement; opening then closing
            // this alias would release all process-scoped main-file locks.
            assert!(verifier.inspect(&db).is_err(), "{name}/{mode}");
            peer(&fixture, true);
            fs::remove_file(path).unwrap();
            db.execute_batch("ROLLBACK").unwrap();
            peer(&fixture, false);
            drop(db);
        }
    }
}
