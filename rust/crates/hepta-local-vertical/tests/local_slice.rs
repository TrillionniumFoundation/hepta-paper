use std::{
    collections::BTreeSet,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_campaign_writer::{
    CampaignWriterPolicyV1, CampaignWriterStoreV1, NodeStatusV1, WriterLeaseV1,
};
use hepta_codex_protocol::Sha256Digest;
use hepta_legacy_compatibility::hash_legacy_record_v1;
use hepta_readonly_control::inspect_read_only_store;
use hepta_workspace_authority::{
    MutationPolicyV1, WorkspaceRootV1, compare_inventories_v1, materialize_attempt_v1,
    prepare_workspace_result_v1,
};
use serde_json::json;

static NEXT: AtomicU64 = AtomicU64::new(0);

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

    let source_root = WorkspaceRootV1::open(&source, None).expect("source root");
    let before = source_root.inventory().expect("before inventory");
    let attempt = materialize_attempt_v1(&source_root, &attempts, "attempt-1").expect("attempt");
    fs::write(attempt.join("paper/main.tex"), b"draft-v2\n").expect("author mutation");
    let attempt_root = WorkspaceRootV1::open(&attempt, None).expect("attempt root");
    let after = attempt_root.inventory().expect("after inventory");
    let mutation = compare_inventories_v1(&before, &after).expect("mutation");
    let policy = MutationPolicyV1 {
        allowed_prefixes: vec!["paper".to_owned()],
        allowed_extensions: BTreeSet::from(["tex".to_owned()]),
        maximum_changed_paths: 2,
        maximum_changed_bytes: 4096,
        allow_deletion: false,
        read_only: false,
    };
    let workspace_result =
        prepare_workspace_result_v1("attempt-1", &before, &after, &mutation, &policy)
            .expect("workspace prepared result");
    let receipt = json!({
        "attemptId": &workspace_result.attempt_id,
        "beforeHash": &workspace_result.before_hash,
        "afterHash": &workspace_result.after_hash,
        "mutationHash": &workspace_result.mutation_hash,
    });
    let legacy_prepared_hash = hash_legacy_record_v1(&receipt).expect("prepared receipt hash");
    let prepared_hash =
        Sha256Digest::from_str(legacy_prepared_hash.as_str()).expect("typed prepared receipt hash");
    let integrated_hash = Sha256Digest::from_str(&workspace_result.after_hash)
        .expect("typed integrated workspace hash");

    let database = runtime.join("campaign.sqlite");
    let uid = fs::metadata(&runtime).expect("runtime metadata").uid();
    let writer_policy = CampaignWriterPolicyV1::strict(uid);
    let mut writer =
        CampaignWriterStoreV1::open(&database, writer_policy.clone()).expect("writer");
    let lease = writer
        .acquire_writer(
            WriterLeaseV1 {
                generation: 1,
                token: "writer-1".to_owned(),
                expires_at_unix_ms: 1_000,
            },
            10,
        )
        .expect("lease");
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

    let mut writer = CampaignWriterStoreV1::open(&database, writer_policy).expect("reopen writer");
    let replacement = writer
        .acquire_writer(
            WriterLeaseV1 {
                generation: 2,
                token: "writer-2".to_owned(),
                expires_at_unix_ms: 1_000,
            },
            20,
        )
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
        compare_inventories_v1(&reviewer_before, &reviewer_after).expect("reviewer diff");
    let reviewer_policy = MutationPolicyV1 {
        allowed_prefixes: vec!["paper".to_owned()],
        allowed_extensions: BTreeSet::new(),
        maximum_changed_paths: 0,
        maximum_changed_bytes: 0,
        allow_deletion: false,
        read_only: true,
    };
    hepta_workspace_authority::validate_mutation_v1(&reviewer_mutation, &reviewer_policy)
        .expect("reviewer remained read-only");

    let snapshot = inspect_read_only_store(&database).expect("read-only campaign projection");
    assert_eq!(snapshot.schema_version, 1);
    assert!(snapshot.table_count >= 4);
    fs::remove_dir_all(root).expect("cleanup");
}
