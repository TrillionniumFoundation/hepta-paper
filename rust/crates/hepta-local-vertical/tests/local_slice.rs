use std::{
    collections::BTreeSet,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
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
use hepta_legacy_compatibility::hash_legacy_record_v1;
use hepta_readonly_control::inspect_read_only_store;
use hepta_workspace::{
    MutationManifestV1, MutationPolicyV1, PreparedWorkspaceResultV1, WorkspaceRootV1,
    materialize_attempt,
};
use serde_json::json;

static NEXT: AtomicU64 = AtomicU64::new(0);

fn cutover_subject() -> WriterCutoverSubjectV1 {
    WriterCutoverSubjectV1 {
        repository: "TrillionniumFoundation/hepta-paper".to_owned(),
        commit_sha: "1".repeat(40),
        tree_sha: "2".repeat(40),
        binary_hash: format!("sha256:{}", "3".repeat(64))
            .parse()
            .expect("binary hash"),
        configuration_hash: format!("sha256:{}", "4".repeat(64))
            .parse()
            .expect("configuration hash"),
        host_identity_hash: format!("sha256:{}", "5".repeat(64))
            .parse()
            .expect("host hash"),
        service_identity_hash: format!("sha256:{}", "6".repeat(64))
            .parse()
            .expect("service hash"),
    }
}

fn open_activated(
    database: &Path,
    policy: CampaignWriterPolicyV1,
    initial_lease: &WriterLeaseV1,
) -> CampaignWriterStoreV1 {
    let preimage = inspect_writer_database_preimage_v1(database, policy).expect("preimage");
    let signing_key = SigningKey::from_bytes(&[61_u8; 32]);
    let mut authorization = WriterCutoverAuthorizationV1 {
        version: 1,
        cutover_id: "local-slice-cutover".to_owned(),
        subject: cutover_subject(),
        database_preimage_hash: writer_database_preimage_hash_v1(&preimage).expect("preimage hash"),
        initial_writer_lease_hash: writer_lease_activation_hash_v1(initial_lease)
            .expect("writer lease hash"),
        node_writer_disabled: true,
        issued_at_unix_ms: 1,
        expires_at_unix_ms: 100_000,
        nonce: "local-slice-cutover-nonce".to_owned(),
        signer_key_id: "local-slice-cutover-key".to_owned(),
        signature_base64: "AA".to_owned(),
    };
    let message = writer_cutover_signing_bytes_v1(&authorization).expect("message");
    authorization.signature_base64 =
        Base64UrlUnpadded::encode_string(&signing_key.sign(&message).to_bytes());
    let trust = WriterCutoverTrustStoreV1::new([(
        "local-slice-cutover-key".to_owned(),
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
fn one_paper_fake_author_reviewer_path_recovers_without_duplicate_integration() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "hepta-local-slice-{}-{nonce}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let source = root.join("source");
    let attempts = root.join("attempts");
    let runtime = root.join("runtime");
    fs::create_dir(&root).expect("root");
    for selected in [&source, &attempts, &runtime] {
        fs::create_dir(selected).expect("directory");
    }
    for selected in [&root, &source, &attempts, &runtime] {
        fs::set_permissions(selected, fs::Permissions::from_mode(0o700)).expect("mode");
    }
    fs::create_dir(source.join("paper")).expect("paper directory");
    fs::set_permissions(source.join("paper"), fs::Permissions::from_mode(0o700))
        .expect("paper mode");
    fs::write(source.join("paper/main.tex"), b"draft-v1\n").expect("draft");

    let workspace_uid = fs::metadata(&source).expect("source metadata").uid();
    let source_root = WorkspaceRootV1::open(&source, workspace_uid).expect("source root");
    let before = source_root.inventory().expect("before inventory");
    let attempt =
        materialize_attempt(&source_root, &attempts, "attempt-1", workspace_uid).expect("attempt");
    fs::write(attempt.canonical_path.join("paper/main.tex"), b"draft-v2\n")
        .expect("author mutation");
    let attempt_root = attempt.open_root(workspace_uid).expect("attempt root");
    let after = attempt_root.inventory().expect("after inventory");
    let mutation = MutationManifestV1::between(&before, &after).expect("mutation");
    let policy = MutationPolicyV1 {
        version: 1,
        read_only: false,
        allowed_path_prefixes: vec!["paper".to_owned()],
        allowed_extensions: BTreeSet::from(["tex".to_owned()]),
        maximum_changed_entries: 2,
        maximum_changed_file_bytes: 4096,
    };
    let workspace_result =
        PreparedWorkspaceResultV1::new(&attempt, &attempt_root, &after, &mutation, &policy)
            .expect("workspace prepared result");
    let receipt = json!({
        "attemptId": &workspace_result.attempt_id,
        "beforeHash": &workspace_result.before_inventory_hash,
        "afterHash": &workspace_result.after_inventory_hash,
        "mutationHash": &workspace_result.mutation_manifest_hash,
    });
    let legacy_prepared_hash = hash_legacy_record_v1(&receipt).expect("prepared receipt hash");
    let prepared_hash = legacy_prepared_hash
        .as_str()
        .parse()
        .expect("typed prepared receipt hash");
    let integrated_hash = workspace_result.after_inventory_hash.clone();

    let database = runtime.join("campaign.sqlite");
    let uid = fs::metadata(&runtime).expect("runtime metadata").uid();
    let writer_policy = CampaignWriterPolicyV1::strict(uid);
    let lease_request = WriterLeaseV1 {
        generation: 1,
        token: "writer-1".to_owned(),
        expires_at_unix_ms: 1_000,
    };
    let mut writer = open_activated(&database, writer_policy, &lease_request);
    let lease = writer.acquire_writer(lease_request, 10).expect("lease");
    writer
        .create_campaign(&lease, "campaign-1", 1_000, 4, 0, 10)
        .expect("campaign");
    let claim = writer
        .claim_node(
            &lease,
            "campaign-1",
            "author-node",
            "attempt-1",
            0,
            "claim-1",
            1_000,
            100,
            1,
            0,
            11,
        )
        .expect("claim");
    let prepared = writer
        .store_prepared_result(&lease, &claim, &prepared_hash, false, 12)
        .expect("persist prepared result");
    assert_eq!(prepared.status, NodeStatusV1::Prepared);
    assert_eq!(prepared.prepared_result_hash.as_ref(), Some(&prepared_hash));
    writer.checkpoint().expect("prepared checkpoint");
    drop(writer);

    let replacement_request = WriterLeaseV1 {
        generation: 2,
        token: "writer-2".to_owned(),
        expires_at_unix_ms: 1_000,
    };
    let mut writer = open_activated(&database, writer_policy, &replacement_request);
    let replacement = writer
        .acquire_writer(replacement_request, 20)
        .expect("replacement lease");
    let integrated = writer
        .integrate_prepared_result(
            &replacement,
            &claim,
            &prepared_hash,
            &integrated_hash,
            75,
            21,
        )
        .expect("integrate");
    assert_eq!(integrated.status, NodeStatusV1::Integrated);
    assert_eq!(
        integrated.integrated_result_hash.as_ref(),
        Some(&integrated_hash)
    );
    let replay = writer
        .integrate_prepared_result(
            &replacement,
            &claim,
            &prepared_hash,
            &integrated_hash,
            75,
            22,
        )
        .expect("idempotent integration");
    assert_eq!(replay, integrated);
    let campaign = writer
        .load_campaign("campaign-1")
        .expect("campaign snapshot");
    assert_eq!(campaign.budget_remaining_microusd, 925);
    assert_eq!(campaign.cpu_remaining, 4);
    assert_eq!(campaign.gpu_remaining, 0);
    writer.validate_integrity().expect("writer integrity");
    writer.checkpoint().expect("integrated checkpoint");
    drop(writer);

    let reviewer_before = attempt_root.inventory().expect("reviewer before");
    let reviewer_after = attempt_root.inventory().expect("reviewer after");
    let reviewer_mutation =
        MutationManifestV1::between(&reviewer_before, &reviewer_after).expect("reviewer diff");
    MutationPolicyV1::reviewer_read_only()
        .validate_manifest(&reviewer_mutation)
        .expect("reviewer remained read-only");

    let snapshot = inspect_read_only_store(&database).expect("read-only campaign projection");
    assert_eq!(snapshot.schema_version, 1);
    assert!(snapshot.table_count >= 4);
    fs::remove_dir_all(root).expect("cleanup");
}
