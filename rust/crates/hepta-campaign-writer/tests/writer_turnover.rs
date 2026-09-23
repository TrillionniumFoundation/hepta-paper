use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_campaign_writer::{
    CampaignWriterPolicyV1, CampaignWriterStoreV1, NodeStatusV1, WriterCutoverAuthorizationV1,
    WriterCutoverPolicyV1, WriterCutoverSubjectV1, WriterCutoverTrustStoreV1, WriterLeaseV1,
    inspect_writer_database_preimage_v1, verify_writer_cutover_authorization_v1,
    writer_cutover_signing_bytes_v1, writer_database_preimage_hash_v1,
    writer_lease_activation_hash_v1,
};
use hepta_codex_protocol::Sha256Digest;

static NEXT: AtomicU64 = AtomicU64::new(0);

fn digest(marker: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64))).expect("digest")
}

fn cutover_subject() -> WriterCutoverSubjectV1 {
    WriterCutoverSubjectV1 {
        repository: "TrillionniumFoundation/hepta-paper".to_owned(),
        commit_sha: "1".repeat(40),
        tree_sha: "2".repeat(40),
        binary_hash: digest('3'),
        configuration_hash: digest('4'),
        host_identity_hash: digest('5'),
        service_identity_hash: digest('6'),
    }
}

fn open_activated(
    database: &Path,
    policy: CampaignWriterPolicyV1,
    initial_lease: &WriterLeaseV1,
) -> CampaignWriterStoreV1 {
    let preimage = inspect_writer_database_preimage_v1(database, policy).expect("preimage");
    let signing_key = SigningKey::from_bytes(&[51_u8; 32]);
    let mut authorization = WriterCutoverAuthorizationV1 {
        version: 1,
        cutover_id: "turnover-cutover".to_owned(),
        subject: cutover_subject(),
        database_preimage_hash: writer_database_preimage_hash_v1(&preimage).expect("preimage hash"),
        initial_writer_lease_hash: writer_lease_activation_hash_v1(initial_lease)
            .expect("writer lease hash"),
        node_writer_disabled: true,
        issued_at_unix_ms: 1,
        expires_at_unix_ms: 100_000,
        nonce: "turnover-cutover-nonce".to_owned(),
        signer_key_id: "turnover-cutover-key".to_owned(),
        signature_base64: "AA".to_owned(),
    };
    let message = writer_cutover_signing_bytes_v1(&authorization).expect("message");
    authorization.signature_base64 =
        Base64UrlUnpadded::encode_string(&signing_key.sign(&message).to_bytes());
    let trust = WriterCutoverTrustStoreV1::new([(
        "turnover-cutover-key".to_owned(),
        signing_key.verifying_key(),
    )])
    .expect("trust");
    let verified = verify_writer_cutover_authorization_v1(
        &authorization,
        &cutover_subject(),
        10,
        WriterCutoverPolicyV1::default(),
        &trust,
    )
    .expect("verified");
    CampaignWriterStoreV1::open_for_cutover(database, policy, &verified, 10)
        .expect("activated store")
}

#[test]
fn a_new_writer_generation_integrates_an_exact_durable_prepared_result() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "hepta-writer-turnover-{}-{nonce}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).expect("root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
    let uid = fs::metadata(&root).expect("metadata").uid();
    let database = root.join("campaign.sqlite");
    let policy = CampaignWriterPolicyV1::strict(uid);
    let prepared_hash =
        Sha256Digest::from_str(&format!("sha256:{}", "a".repeat(64))).expect("prepared hash");
    let integrated_hash =
        Sha256Digest::from_str(&format!("sha256:{}", "b".repeat(64))).expect("integrated hash");

    let first_request = WriterLeaseV1 {
        generation: 1,
        token: "writer-first".to_owned(),
        expires_at_unix_ms: 1_000,
    };
    let mut first_store = open_activated(&database, policy, &first_request);
    let first = first_store
        .acquire_writer(first_request, 10)
        .expect("first writer");
    first_store
        .create_campaign(&first, "campaign-1", 100, 10, 0, 10)
        .expect("campaign");
    let claim = first_store
        .claim_node(
            &first,
            "campaign-1",
            "node-1",
            "attempt-1",
            0,
            "claim-1",
            1_000,
            50,
            1,
            0,
            11,
        )
        .expect("claim");
    let prepared = first_store
        .store_prepared_result(&first, &claim, &prepared_hash, false, 12)
        .expect("prepared result");
    assert_eq!(prepared.status, NodeStatusV1::Prepared);
    first_store.checkpoint().expect("prepared checkpoint");
    drop(first_store);

    let second_request = WriterLeaseV1 {
        generation: 2,
        token: "writer-second".to_owned(),
        expires_at_unix_ms: 1_000,
    };
    let mut recovered = open_activated(&database, policy, &second_request);
    let second = recovered
        .acquire_writer(second_request, 20)
        .expect("replacement writer");
    assert!(second.generation > first.generation);
    let integrated = recovered
        .integrate_prepared_result(&second, &claim, &prepared_hash, &integrated_hash, 40, 21)
        .expect("recovered integration");
    assert_eq!(integrated.status, NodeStatusV1::Integrated);
    assert_eq!(
        integrated.integrated_result_hash.as_ref(),
        Some(&integrated_hash)
    );
    let replay = recovered
        .integrate_prepared_result(&second, &claim, &prepared_hash, &integrated_hash, 40, 22)
        .expect("idempotent recovered integration");
    assert_eq!(replay, integrated);
    let campaign = recovered.load_campaign("campaign-1").expect("budget");
    assert_eq!(campaign.budget_remaining_microusd, 60);
    assert_eq!(campaign.cpu_remaining, 10);
    assert_eq!(campaign.gpu_remaining, 0);
    recovered.validate_integrity().expect("integrity");
    recovered.checkpoint().expect("integrated checkpoint");
    drop(recovered);
    fs::remove_dir_all(root).expect("cleanup");
}
