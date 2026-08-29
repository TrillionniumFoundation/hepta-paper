use std::{
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

static NEXT: AtomicU64 = AtomicU64::new(0);

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
    let prepared_hash = Sha256Digest::from_str(&format!("sha256:{}", "a".repeat(64)))
        .expect("prepared hash");
    let integrated_hash = Sha256Digest::from_str(&format!("sha256:{}", "b".repeat(64)))
        .expect("integrated hash");

    let mut first_store = CampaignWriterStoreV1::open(&database, policy).expect("store");
    let first = first_store
        .acquire_writer(
            WriterLeaseV1 {
                generation: 1,
                token: "writer-first".to_owned(),
                expires_at_unix_ms: 1_000,
            },
            10,
        )
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

    let mut recovered = CampaignWriterStoreV1::open(&database, policy).expect("recovered store");
    let second = recovered
        .acquire_writer(
            WriterLeaseV1 {
                generation: 2,
                token: "writer-second".to_owned(),
                expires_at_unix_ms: 1_000,
            },
            20,
        )
        .expect("replacement writer");
    assert!(second.generation > first.generation);
    let integrated = recovered
        .integrate_prepared_result(
            &second,
            &claim,
            &prepared_hash,
            &integrated_hash,
            40,
            21,
        )
        .expect("recovered integration");
    assert_eq!(integrated.status, NodeStatusV1::Integrated);
    assert_eq!(
        integrated.integrated_result_hash.as_ref(),
        Some(&integrated_hash)
    );
    let replay = recovered
        .integrate_prepared_result(
            &second,
            &claim,
            &prepared_hash,
            &integrated_hash,
            40,
            22,
        )
        .expect("idempotent recovered integration");
    assert_eq!(replay, integrated);
    let campaign = recovered.load_campaign("campaign-1").expect("budget");
    assert_eq!(campaign.budget_remaining_microusd, 60);
    assert_eq!(campaign.cpu_remaining, 10);
    assert_eq!(campaign.gpu_remaining, 0);
    recovered.validate_integrity().expect("integrity");
    recovered.checkpoint().expect("integrated checkpoint");
    fs::remove_dir_all(root).expect("cleanup");
}
