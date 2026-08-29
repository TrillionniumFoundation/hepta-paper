use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_campaign_writer::{CampaignWriterStoreV1, IntegrationDispositionV1};

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
    let hash = format!("sha256:{}", "a".repeat(64));

    let mut first_store = CampaignWriterStoreV1::open(&database, uid).expect("store");
    let first = first_store
        .acquire_writer("writer-first", 10, 5)
        .expect("first writer");
    first_store
        .create_campaign(&first, 10, "campaign-1", 100)
        .expect("campaign");
    let claim = first_store
        .claim_node(&first, 10, "campaign-1", "node-1", "attempt-1", 0, 1, 50, 1)
        .expect("claim");
    first_store
        .prepare_result(
            &first,
            11,
            "campaign-1",
            "node-1",
            "attempt-1",
            claim.node_generation,
            &hash,
        )
        .expect("prepared result");
    drop(first_store);

    let mut recovered = CampaignWriterStoreV1::open(&database, uid).expect("recovered store");
    let second = recovered
        .acquire_writer("writer-second", 20, 100)
        .expect("replacement writer");
    assert!(second.generation > first.generation);
    assert_eq!(
        recovered
            .integrate_prepared_result(
                &second,
                20,
                "campaign-1",
                "node-1",
                "attempt-1",
                claim.node_generation,
                &hash,
                Some(40),
            )
            .expect("recovered integration"),
        IntegrationDispositionV1::Integrated
    );
    assert_eq!(
        recovered.campaign_budget("campaign-1").expect("budget"),
        (100, 0, 40)
    );
    recovered.validate_integrity().expect("integrity");
    fs::remove_dir_all(root).expect("cleanup");
}
