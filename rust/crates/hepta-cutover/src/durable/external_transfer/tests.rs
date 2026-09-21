use super::*;
use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_campaign_writer::writer_cutover_signing_bytes_v1;
use hepta_codex_protocol::Sha256Digest;
use rusqlite::ErrorCode;
use std::{
    os::unix::fs::PermissionsExt,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    target: PathBuf,
    storage: PathBuf,
    expected: DurableCutoverStateV1,
    enrollment_hash: String,
    scopes: Vec<String>,
}
impl Fixture {
    fn new(mode: DurableCutoverModeV1, external: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-external-transfer-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let storage = root.join("storage");
        let runtime = root.join("runtime");
        for path in [&storage, &runtime] {
            fs::create_dir(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let target = runtime.join("native.sqlite");
        let db = Connection::open(&target).unwrap();
        db.execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO records VALUES(1,'original');").unwrap();
        db.close().unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let mut coordinator = DurableCutoverCoordinatorV1::create_with_storage_v2(
            &target,
            "safe-transfer",
            "node",
            "rust",
            mode,
            if external {
                DurableCutoverStorageV2::ExternalRoot {
                    root: storage.clone(),
                }
            } else {
                DurableCutoverStorageV2::AdjacentSidecars
            },
        )
        .unwrap();
        coordinator.quiesce(0).unwrap();
        coordinator
            .backup_restore_drill(
                1,
                &root.join("backup.sqlite"),
                &root.join("restored.sqlite"),
            )
            .unwrap();
        coordinator
            .compare_shadow(2, "real-output", b"same", b"same")
            .unwrap();
        let expected = coordinator.inspect().unwrap();
        let enrollment_hash = coordinator
            .external_storage_enrollment_hash_v2()
            .unwrap_or("sha256:none")
            .into();
        drop(coordinator);
        Self {
            root,
            target,
            storage,
            expected,
            enrollment_hash,
            scopes: vec!["campaign:test".into()],
        }
    }
    fn production() -> Self {
        Self::new(DurableCutoverModeV1::Production, true)
    }
    fn policy(&self) -> CampaignWriterPolicyV1 {
        CampaignWriterPolicyV1::strict(nix::unistd::geteuid().as_raw())
    }
    fn request(&self) -> ExternalProductionCanaryTransferRequestV2<'_> {
        ExternalProductionCanaryTransferRequestV2 {
            database_path: &self.target,
            expected_external_root: &self.storage,
            expected_enrollment_hash: &self.enrollment_hash,
            expected_revision: self.expected.revision,
            expected_shadow_state: &self.expected,
            scopes: &self.scopes,
            writer_policy: self.policy(),
        }
    }
    fn journal(&self) -> PathBuf {
        let marker: serde_json::Value =
            serde_json::from_slice(&fs::read(sidecars(&self.target).1).unwrap()).unwrap();
        self.storage
            .join(marker["storageSlot"].as_str().unwrap())
            .join("journal.sqlite")
    }
    fn inspect(&self) -> DurableCutoverStateV1 {
        let coordinator = DurableCutoverCoordinatorV1::open(&self.target).unwrap();
        coordinator.verify_journal().unwrap();
        coordinator.inspect().unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn digest(byte: char) -> Sha256Digest {
    format!("sha256:{}", byte.to_string().repeat(64))
        .parse()
        .unwrap()
}
struct Signed {
    raw: WriterCutoverAuthorizationV1,
    subject: WriterCutoverSubjectV1,
    trust: WriterCutoverTrustStoreV1,
    verified: VerifiedWriterCutoverV1,
}
fn signed(fixture: &Fixture, change: impl FnOnce(&mut WriterCutoverAuthorizationV1)) -> Signed {
    let at = now().unwrap();
    let subject = WriterCutoverSubjectV1 {
        repository: "TrillionniumFoundation/hepta-paper".into(),
        commit_sha: "1".repeat(40),
        tree_sha: "2".repeat(40),
        binary_hash: digest('3'),
        configuration_hash: digest('4'),
        host_identity_hash: digest('5'),
        service_identity_hash: digest('6'),
    };
    let preimage = inspect_writer_database_preimage_v1(&fixture.target, fixture.policy()).unwrap();
    let mut raw = WriterCutoverAuthorizationV1 {
        version: 1,
        cutover_id: fixture.expected.cutover_id.clone(),
        subject: subject.clone(),
        database_preimage_hash: writer_database_preimage_hash_v1(&preimage).unwrap(),
        initial_writer_lease_hash: digest('7'),
        node_writer_disabled: true,
        issued_at_unix_ms: at - 1_000,
        expires_at_unix_ms: at + 120_000,
        nonce: "external-transfer-fixture".into(),
        signer_key_id: "external-transfer-key".into(),
        signature_base64: "AA".into(),
    };
    change(&mut raw);
    let key = SigningKey::from_bytes(&[37; 32]);
    raw.signature_base64 = Base64UrlUnpadded::encode_string(
        &key.sign(&writer_cutover_signing_bytes_v1(&raw).unwrap())
            .to_bytes(),
    );
    let trust =
        WriterCutoverTrustStoreV1::new([(raw.signer_key_id.clone(), key.verifying_key())]).unwrap();
    let verified = verify_writer_cutover_authorization_v1(
        &raw,
        &subject,
        raw.issued_at_unix_ms + 1,
        WriterCutoverPolicyV1::default(),
        &trust,
    )
    .unwrap();
    Signed {
        raw,
        subject,
        trust,
        verified,
    }
}

fn probe(path: &Path, busy: bool) {
    let output = Command::new("/proc/self/exe")
        .args([
            "--exact",
            "durable::external_transfer::tests::external_transfer_lock_probe_child",
            "--nocapture",
        ])
        .env("HEPTA_EXTERNAL_TRANSFER_PROBE", path)
        .env(
            "HEPTA_EXTERNAL_TRANSFER_BUSY",
            if busy { "yes" } else { "no" },
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("actual external transfer lock"));
}
#[test]
fn external_transfer_lock_probe_child() {
    let Some(path) = std::env::var_os("HEPTA_EXTERNAL_TRANSFER_PROBE") else {
        return;
    };
    let db = Connection::open(path).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    let result = db.execute_batch("BEGIN IMMEDIATE");
    if std::env::var("HEPTA_EXTERNAL_TRANSFER_BUSY").unwrap() == "yes" {
        assert_eq!(
            result.unwrap_err().sqlite_error_code(),
            Some(ErrorCode::DatabaseBusy)
        );
    } else {
        result.unwrap();
        db.execute_batch("ROLLBACK").unwrap();
    }
    println!("actual external transfer lock");
}

#[test]
fn genuine_signed_transfer_preserves_incumbent_wire_and_node_rust_fence_behavior() {
    let fixture = Fixture::production();
    let authority = signed(&fixture, |_| {});
    let before = fs::read(&fixture.target).unwrap();
    let state = DurableCutoverCoordinatorV1::start_production_canary_external_v2(
        fixture.request(),
        &authority.verified,
    )
    .unwrap();
    assert_eq!(state.generation, fixture.expected.generation + 1);
    assert_eq!(state.revision, fixture.expected.revision + 1);
    assert_eq!(state.phase, DurableCutoverPhaseV1::Canary);
    assert_eq!(state.canary_scopes, fixture.scopes);
    assert_eq!(
        state.activation_receipt_hash.as_deref(),
        Some(authority.verified.authorization_hash().as_str())
    );
    assert_eq!(fixture.inspect(), state);
    assert_eq!(fs::read(&fixture.target).unwrap(), before);
    let mut coordinator = DurableCutoverCoordinatorV1::open(&fixture.target).unwrap();
    coordinator
        .with_writer(&state.writer_fence().unwrap(), "campaign:test", || Ok(()))
        .unwrap();
    let row: (String, String) = coordinator
        .connection
        .query_row(
            "SELECT event,evidence_json FROM hepta_cutover_journal ORDER BY revision DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(row.0, "production_canary_authorized");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&row.1).unwrap(),
        serde_json::json!({"authorizationHash":authority.verified.authorization_hash(),"productionQualification":false,"schemaTranslationVerified":false})
    );
    drop(coordinator);
    let bridge = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-adapters/migration/rust-cutover-fence.mjs")
        .canonicalize()
        .unwrap();
    let output = Command::new("node").args(["--input-type=module", "-e", "import {pathToFileURL} from 'node:url'; const {createRustCutoverFence}=await import(pathToFileURL(process.env.BRIDGE)); const fence=createRustCutoverFence({dbPath:process.env.DATABASE}); try { fence.withWrite(()=>{throw Error('callback entered');}); process.exitCode=3; } catch(error) { if(String(error).includes('callback entered')) throw error; process.stdout.write('NODE FENCED'); } finally {fence.close();}"]).env("BRIDGE",bridge).env("DATABASE",&fixture.target).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("NODE FENCED"));
    assert!(matches!(
        DurableCutoverCoordinatorV1::start_production_canary_external_v2(
            fixture.request(),
            &authority.verified,
        ),
        Err(DurableCutoverError::RevisionConflict)
    ));
    assert_eq!(fixture.inspect(), state);

    let old = Fixture::production();
    let authority = signed(&old, |_| {});
    let mut coordinator = DurableCutoverCoordinatorV1::open(&old.target).unwrap();
    let legacy = coordinator
        .start_production_canary(
            old.expected.revision,
            old.scopes.clone(),
            &authority.raw,
            &authority.subject,
            &authority.trust,
            old.policy(),
            now().unwrap(),
        )
        .unwrap();
    assert_eq!(
        (
            legacy.phase,
            legacy.generation,
            legacy.revision,
            legacy.canary_scopes
        ),
        (
            state.phase,
            state.generation,
            state.revision,
            state.canary_scopes
        )
    );
}

#[test]
fn a_real_peer_shadow_update_invalidates_the_complete_expected_state() {
    let fixture = Fixture::production();
    let authority = signed(&fixture, |_| {});
    let mut peer = DurableCutoverCoordinatorV1::open(&fixture.target).unwrap();
    peer.compare_shadow(fixture.expected.revision, "peer-output", b"more", b"more")
        .unwrap();
    let latest = peer.inspect().unwrap();
    assert_eq!(latest.revision, fixture.expected.revision + 1);
    assert_eq!(latest.shadow_cases, fixture.expected.shadow_cases + 1);
    drop(peer);
    assert!(matches!(
        DurableCutoverCoordinatorV1::start_production_canary_external_v2(
            fixture.request(),
            &authority.verified,
        ),
        Err(DurableCutoverError::RevisionConflict)
    ));
    assert_eq!(fixture.inspect(), latest);
}

#[test]
fn expected_storage_state_and_authorization_mismatches_never_append() {
    let fixture = Fixture::production();
    let authority = signed(&fixture, |_| {});
    for bad in [
        "root",
        "marker-hash",
        "revision",
        "same-revision-state",
        "empty-scope",
    ] {
        let mut request = fixture.request();
        let mut altered = fixture.expected.clone();
        match bad {
            "root" => request.expected_external_root = &fixture.root,
            "marker-hash" => request.expected_enrollment_hash = "sha256:incorrect",
            "revision" => request.expected_revision += 1,
            "same-revision-state" => {
                altered.shadow_cases += 1;
                request.expected_shadow_state = &altered;
            }
            "empty-scope" => request.scopes = &[],
            _ => unreachable!(),
        }
        assert!(
            DurableCutoverCoordinatorV1::start_production_canary_external_v2(
                request,
                &authority.verified
            )
            .is_err(),
            "{bad}"
        );
        assert_eq!(fixture.inspect(), fixture.expected);
    }
    for bad in ["cutover", "preimage", "expired", "not-yet-valid"] {
        let authority = signed(&fixture, |raw| match bad {
            "cutover" => raw.cutover_id = "different-cutover".into(),
            "preimage" => raw.database_preimage_hash = digest('f'),
            "expired" => {
                raw.issued_at_unix_ms = now().unwrap() - 3_000;
                raw.expires_at_unix_ms = now().unwrap() - 1_000;
            }
            "not-yet-valid" => {
                raw.issued_at_unix_ms = now().unwrap() + 30_000;
                raw.expires_at_unix_ms = raw.issued_at_unix_ms + 10_000;
            }
            _ => unreachable!(),
        });
        assert!(
            DurableCutoverCoordinatorV1::start_production_canary_external_v2(
                fixture.request(),
                &authority.verified
            )
            .is_err(),
            "{bad}"
        );
        assert_eq!(fixture.inspect(), fixture.expected);
    }
}

#[test]
fn legacy_local_and_existing_sidecars_remain_refused() {
    for (mode, external) in [
        (DurableCutoverModeV1::Production, false),
        (DurableCutoverModeV1::LocalDrill, true),
    ] {
        let fixture = Fixture::new(mode, external);
        let authority = signed(&fixture, |_| {});
        assert!(
            DurableCutoverCoordinatorV1::start_production_canary_external_v2(
                fixture.request(),
                &authority.verified
            )
            .is_err()
        );
        assert_eq!(fixture.inspect(), fixture.expected);
    }
    let fixture = Fixture::production();
    let authority = signed(&fixture, |_| {});
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", fixture.target.display()));
        fs::write(&sidecar, []).unwrap();
        assert!(
            DurableCutoverCoordinatorV1::start_production_canary_external_v2(
                fixture.request(),
                &authority.verified
            )
            .is_err()
        );
        fs::remove_file(sidecar).unwrap();
        assert_eq!(fixture.inspect(), fixture.expected);
    }
}

#[test]
fn retained_target_and_journal_alias_rejections_never_release_sqlite_locks() {
    let fixture = Fixture::production();
    let preimage =
        ObservedExternalCutoverPreimageV2::observe(&fixture.target, fixture.policy()).unwrap();
    let database = Connection::open(&fixture.target).unwrap();
    database.execute_batch("BEGIN IMMEDIATE").unwrap();
    preimage.assert_current().unwrap();
    probe(&fixture.target, true);
    database
        .execute_batch("UPDATE records SET value='staged'")
        .unwrap();
    assert!(preimage.assert_current().is_err());
    probe(&fixture.target, true);
    database.execute_batch("ROLLBACK").unwrap();
    database.close().unwrap();
    drop(preimage);
    for alias in ["", "-shm"] {
        let fixture = Fixture::production();
        let journal = fixture.journal();
        let preimage =
            ObservedExternalCutoverPreimageV2::observe(&fixture.target, fixture.policy()).unwrap();
        let mut coordinator = DurableCutoverCoordinatorV1::open(&fixture.target).unwrap();
        let tx = coordinator
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        preimage.assert_current().unwrap();
        let original = fixture.target.with_extension("original");
        fs::rename(&fixture.target, &original).unwrap();
        fs::hard_link(
            PathBuf::from(format!("{}{alias}", journal.display())),
            &fixture.target,
        )
        .unwrap();
        assert!(preimage.assert_current().is_err());
        probe(&journal, true);
        fs::remove_file(&fixture.target).unwrap();
        fs::rename(original, &fixture.target).unwrap();
        drop(tx);
        drop(coordinator);
        drop(preimage);
        probe(&journal, false);
    }
}

#[test]
fn final_time_rejection_rolls_back_the_actual_appended_transition_and_unwind_releases_lock() {
    let fixture = Fixture::production();
    let expired = signed(&fixture, |raw| {
        raw.issued_at_unix_ms = now().unwrap() - 3_000;
        raw.expires_at_unix_ms = now().unwrap() - 1_000;
    });
    let preimage =
        ObservedExternalCutoverPreimageV2::observe(&fixture.target, fixture.policy()).unwrap();
    let mut coordinator = DurableCutoverCoordinatorV1::open(&fixture.target).unwrap();
    // Enter the private storage-safe core directly to exercise its independent
    // terminal time gate after append, not the public early expiry rejection.
    assert!(matches!(
        transfer(
            &mut coordinator,
            &preimage,
            &fixture.request(),
            &expired.verified,
            expired.raw.issued_at_unix_ms
        ),
        Err(DurableCutoverError::Authority(_))
    ));
    assert_eq!(coordinator.inspect().unwrap(), fixture.expected);
    coordinator.verify_journal().unwrap();
    drop(coordinator);
    drop(preimage);
    let current = signed(&fixture, |_| {});
    let at = now().unwrap();
    assert_time(&current.verified, at, at).unwrap();
    assert!(assert_time(&current.verified, at + 1, at).is_err());
    assert!(assert_time(&current.verified, at, current.raw.expires_at_unix_ms).is_err());
    let journal = fixture.journal();
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let preimage =
            ObservedExternalCutoverPreimageV2::observe(&fixture.target, fixture.policy()).unwrap();
        let mut coordinator = DurableCutoverCoordinatorV1::open(&fixture.target).unwrap();
        let _tx = coordinator
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        preimage.assert_current().unwrap();
        probe(&journal, true);
        panic!("owned preimage/journal unwind");
    }));
    assert!(caught.is_err());
    probe(&journal, false);
    assert_eq!(fixture.inspect(), fixture.expected);
}
