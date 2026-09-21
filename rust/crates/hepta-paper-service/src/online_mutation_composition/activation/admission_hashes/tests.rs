use super::*;
use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_campaign_writer::{
    CampaignWriterPolicyV1, WriterCutoverAuthorizationV1, WriterCutoverPolicyV1,
    WriterCutoverSubjectV1, WriterCutoverTrustStoreV1, inspect_writer_database_preimage_v1,
    verify_writer_cutover_authorization_v1, writer_cutover_signing_bytes_v1,
    writer_database_preimage_hash_v1,
};
use hepta_cutover::{
    DurableCutoverCoordinatorV1, DurableCutoverStorageV2, ExternalProductionCanaryTransferRequestV2,
};
use rusqlite::Connection;
use std::{
    fs,
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

fn digest(byte: char) -> Sha256Digest {
    format!("sha256:{}", byte.to_string().repeat(64))
        .parse()
        .unwrap()
}
fn state() -> DurableCutoverStateV1 {
    DurableCutoverStateV1 {
        version: 1,
        cutover_id: "native-reconciliation".into(),
        database_path: "/srv/hepta/runtime/native.sqlite".into(),
        mode: DurableCutoverModeV1::Production,
        phase: DurableCutoverPhaseV1::Canary,
        old_writer_id: "node".into(),
        new_writer_id: LOCAL_RECONCILIATION_WRITER_ID_V1.into(),
        writer_id: Some(LOCAL_RECONCILIATION_WRITER_ID_V1.into()),
        generation: 3,
        token: "native-reconciliation:3".into(),
        revision: 4,
        shadow_cases: 1,
        shadow_mismatches: 0,
        canary_scopes: vec![RECONCILIATION_WRITER_SCOPE_V1.into()],
        production_activation: true,
        activation_receipt_hash: None,
    }
}
fn hash(state: &DurableCutoverStateV1) -> Result<Sha256Digest> {
    native_reconciliation_durable_epoch_hash_v1(
        state,
        Path::new("/srv/hepta-cutover"),
        &digest('a'),
    )
}

#[test]
fn fixed_native_epoch_wire_digest_and_safe_integer_boundaries_are_stable() {
    // Fixed external signing contract vector, independent of a filesystem or
    // caller-supplied JSON report; the hash is still not permission.
    assert_eq!(
        hash(&state()).unwrap().as_str(),
        "sha256:b5f8fa47202037347eabc470d8fe5d59a1a23e36601ce74ac31f6804e4c9074f"
    );
    for field in ["generation", "revision", "shadow"] {
        for number in [0, MAX_SAFE_INTEGER, MAX_SAFE_INTEGER + 1, u64::MAX] {
            let mut value = state();
            match field {
                "generation" => {
                    value.generation = number;
                    value.token = format!("{}:{}", value.cutover_id, number);
                }
                "revision" => value.revision = number,
                "shadow" => value.shadow_cases = number,
                _ => unreachable!(),
            }
            assert_eq!(
                hash(&value).is_ok(),
                number == MAX_SAFE_INTEGER,
                "{field} {number}"
            );
        }
    }
}

#[test]
fn every_epoch_binding_changes_the_hash_but_authorization_receipt_is_excluded() {
    let initial = state();
    let expected = hash(&initial).unwrap();
    for field in [
        "cutover",
        "database",
        "old-writer",
        "generation",
        "revision",
        "shadow",
    ] {
        let mut value = initial.clone();
        match field {
            "cutover" => {
                value.cutover_id = "another-cutover".into();
                value.token = format!("{}:{}", value.cutover_id, value.generation);
            }
            "database" => value.database_path = "/srv/other-runtime/native.sqlite".into(),
            "old-writer" => value.old_writer_id = "node-other-instance".into(),
            "generation" => {
                value.generation += 1;
                value.token = format!("{}:{}", value.cutover_id, value.generation);
            }
            "revision" => value.revision += 1,
            "shadow" => value.shadow_cases += 1,
            _ => unreachable!(),
        }
        assert_ne!(hash(&value).unwrap(), expected, "{field}");
    }
    assert_ne!(
        native_reconciliation_durable_epoch_hash_v1(
            &initial,
            Path::new("/srv/other-cutover"),
            &digest('a')
        )
        .unwrap(),
        expected
    );
    assert_ne!(
        native_reconciliation_durable_epoch_hash_v1(
            &initial,
            Path::new("/srv/hepta-cutover"),
            &digest('b')
        )
        .unwrap(),
        expected
    );
    for receipt in [
        None,
        Some(digest('b').to_string()),
        Some("not-authority".into()),
    ] {
        let mut value = initial.clone();
        value.activation_receipt_hash = receipt;
        // The upper verified authorization comparison must reject wrong receipt.
        // Omitting it from this pure projection prevents the signing cycle.
        assert_eq!(hash(&value).unwrap(), expected);
    }
}

#[test]
fn incompatible_phase_writer_scope_and_shadow_claims_never_derive_native_epoch() {
    for phase in [
        DurableCutoverPhaseV1::Planned,
        DurableCutoverPhaseV1::Quiesced,
        DurableCutoverPhaseV1::BackedUp,
        DurableCutoverPhaseV1::ShadowVerified,
        DurableCutoverPhaseV1::Active,
        DurableCutoverPhaseV1::RolledBack,
    ] {
        let mut value = state();
        value.phase = phase;
        assert!(hash(&value).is_err());
    }
    for field in [
        "version",
        "local",
        "inactive",
        "wrong-new",
        "wrong-current",
        "none-current",
        "same-old",
        "bad-old",
        "empty-id",
        "long-id",
        "bad-token",
        "leading-zero-token",
        "mismatch",
    ] {
        let mut value = state();
        match field {
            "version" => value.version = 2,
            "local" => value.mode = DurableCutoverModeV1::LocalDrill,
            "inactive" => value.production_activation = false,
            "wrong-new" => value.new_writer_id = "rust-worker".into(),
            "wrong-current" => value.writer_id = Some("rust-worker".into()),
            "none-current" => value.writer_id = None,
            "same-old" => value.old_writer_id = value.new_writer_id.clone(),
            "bad-old" => value.old_writer_id = "node/multi".into(),
            "empty-id" => value.cutover_id.clear(),
            "long-id" => value.cutover_id = "a".repeat(129),
            "bad-token" => value.token = "unbound".into(),
            "leading-zero-token" => value.token = "native-reconciliation:03".into(),
            "mismatch" => value.shadow_mismatches = 1,
            _ => unreachable!(),
        }
        assert!(hash(&value).is_err(), "{field}");
    }
    for scopes in [
        vec![],
        vec!["store:another".into()],
        vec![
            RECONCILIATION_WRITER_SCOPE_V1.into(),
            RECONCILIATION_WRITER_SCOPE_V1.into(),
        ],
        vec![
            RECONCILIATION_WRITER_SCOPE_V1.into(),
            "store:another".into(),
        ],
    ] {
        let mut value = state();
        value.canary_scopes = scopes;
        assert!(hash(&value).is_err());
    }
}

#[test]
fn only_canonical_disjoint_external_enrollment_path_shapes_are_hashable() {
    for path in [
        "relative",
        "/srv/./cutover",
        "/srv/../cutover",
        "/srv//cutover",
        "/srv/cutover/",
        "/srv/\0cutover",
        "/srv/hepta/runtime",
        "/srv/hepta/runtime/epochs",
        "/srv/hepta",
        "/",
    ] {
        assert!(
            native_reconciliation_durable_epoch_hash_v1(&state(), Path::new(path), &digest('a'))
                .is_err(),
            "{path:?}"
        );
    }
    let non_utf8 = Path::new(std::ffi::OsStr::from_bytes(b"/srv/\xff"));
    assert!(native_reconciliation_durable_epoch_hash_v1(&state(), non_utf8, &digest('a')).is_err());
    for path in [
        "relative.sqlite",
        "/srv/./runtime/db",
        "/srv//runtime/db",
        "/srv/runtime/../db",
        "/srv/runtime/db/",
        "/",
    ] {
        let mut value = state();
        value.database_path = path.into();
        assert!(hash(&value).is_err(), "{path}");
    }
}

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-native-epoch-hash-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        for name in ["runtime", "cutover"] {
            let path = root.join(name);
            fs::create_dir(&path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn genuine_signed_external_canary_matches_signer_preview_without_a_signature_cycle() {
    let fixture = Fixture::new();
    let database = fixture.0.join("runtime/native.sqlite");
    let storage = fixture.0.join("cutover");
    Connection::open(&database).unwrap().execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO records VALUES(1,'original')").unwrap();
    fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).unwrap();
    let mut coordinator = DurableCutoverCoordinatorV1::create_with_storage_v2(
        &database,
        "native-reconciliation",
        "node",
        LOCAL_RECONCILIATION_WRITER_ID_V1,
        DurableCutoverModeV1::Production,
        DurableCutoverStorageV2::ExternalRoot {
            root: storage.clone(),
        },
    )
    .unwrap();
    coordinator.quiesce(0).unwrap();
    coordinator
        .backup_restore_drill(
            1,
            &fixture.0.join("backup.sqlite"),
            &fixture.0.join("restored.sqlite"),
        )
        .unwrap();
    coordinator
        .compare_shadow(2, "real-epoch-hash-fixture", b"same", b"same")
        .unwrap();
    let enrollment: Sha256Digest = coordinator
        .external_storage_enrollment_hash_v2()
        .unwrap()
        .parse()
        .unwrap();
    let preview = coordinator
        .with_production_shadow_observation_v2(|state, observer| {
            observer.assert_current().map_err(|e| e.to_string())?;
            super::super::signing_preview::prospective_canary(
                state,
                observer.external_storage_root_v2(),
                &enrollment,
            )
            .map_err(|e| e.code)
        })
        .unwrap();
    let expected =
        native_reconciliation_durable_epoch_hash_v1(&preview, &storage, &enrollment).unwrap();
    let subject = WriterCutoverSubjectV1 {
        repository: "TrillionniumFoundation/hepta-paper".into(),
        commit_sha: "1".repeat(40),
        tree_sha: "2".repeat(40),
        binary_hash: digest('3'),
        configuration_hash: digest('4'),
        host_identity_hash: digest('5'),
        service_identity_hash: digest('6'),
    };
    let shadow = coordinator
        .with_production_shadow_observation_v2(|state, _| Ok(state.clone()))
        .unwrap();
    drop(coordinator);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let policy = CampaignWriterPolicyV1::strict(nix::unistd::geteuid().as_raw());
    let preimage = inspect_writer_database_preimage_v1(&database, policy).unwrap();
    let mut authorization = WriterCutoverAuthorizationV1 {
        version: 1,
        cutover_id: preview.cutover_id.clone(),
        subject: subject.clone(),
        database_preimage_hash: writer_database_preimage_hash_v1(&preimage).unwrap(),
        initial_writer_lease_hash: expected.clone(),
        node_writer_disabled: true,
        issued_at_unix_ms: now - 1,
        expires_at_unix_ms: now + 60_000,
        nonce: "native-epoch-test-nonce".into(),
        signer_key_id: "native-epoch-test-key".into(),
        signature_base64: "AA".into(),
    };
    let key = SigningKey::from_bytes(&[71; 32]);
    authorization.signature_base64 = Base64UrlUnpadded::encode_string(
        &key.sign(&writer_cutover_signing_bytes_v1(&authorization).unwrap())
            .to_bytes(),
    );
    let trust =
        WriterCutoverTrustStoreV1::new([("native-epoch-test-key".into(), key.verifying_key())])
            .unwrap();
    let verified = verify_writer_cutover_authorization_v1(
        &authorization,
        &subject,
        now,
        WriterCutoverPolicyV1::default(),
        &trust,
    )
    .unwrap();
    let actual = DurableCutoverCoordinatorV1::start_production_canary_external_v2(
        ExternalProductionCanaryTransferRequestV2 {
            database_path: &database,
            expected_external_root: &storage,
            expected_enrollment_hash: enrollment.as_str(),
            expected_revision: shadow.revision,
            expected_shadow_state: &shadow,
            scopes: &preview.canary_scopes,
            writer_policy: policy,
        },
        &verified,
    )
    .unwrap();
    let mut coordinator = DurableCutoverCoordinatorV1::open(&database).unwrap();
    let mut actual_projection = actual.clone();
    actual_projection.activation_receipt_hash = None;
    assert_eq!(actual_projection, preview);
    let entered = std::cell::Cell::new(false);
    assert!(
        coordinator
            .with_production_shadow_observation_v2(|_, _| {
                entered.set(true);
                Ok(())
            })
            .is_err()
    );
    assert!(!entered.get());

    assert_eq!(
        actual.activation_receipt_hash.as_deref(),
        Some(verified.authorization_hash().as_str())
    );
    coordinator
        .with_writer_state_and_external_storage_v2(
            &actual.writer_fence().unwrap(),
            RECONCILIATION_WRITER_SCOPE_V1,
            |locked, observed| {
                observed.assert_current().map_err(|e| e.to_string())?;
                let held_hash = observed
                    .external_storage_enrollment_hash_v2()
                    .parse()
                    .unwrap();
                let actual_hash = native_reconciliation_durable_epoch_hash_v1(
                    locked,
                    observed.external_storage_root_v2(),
                    &held_hash,
                )
                .map_err(|e| e.to_string())?;
                assert_eq!(&actual_hash, verified.initial_writer_lease_hash());
                assert_eq!(actual_hash, expected);
                observed.assert_current().map_err(|e| e.to_string())
            },
        )
        .unwrap();
}
