//! Public read-only scope contract for canonical control-stream resolution.
use hepta_campaign_writer::{
    CampaignWriterError, CampaignWriterPolicyV1, CampaignWriterStoreV1, ControlSnapshotScopeV1,
};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
};

#[test]
fn local_state_cannot_be_resolved_as_an_activated_rust_writer() {
    let root = std::env::temp_dir().join(format!("hepta-control-scope-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir(&root).expect("private root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("private mode");
    let policy = CampaignWriterPolicyV1::strict(fs::metadata(&root).expect("metadata").uid());
    let path = root.join("writer.sqlite");
    drop(CampaignWriterStoreV1::create_local(&path, policy).expect("local writer"));
    assert!(matches!(
        CampaignWriterStoreV1::read_control_snapshot(
            &path,
            policy,
            "campaign",
            ControlSnapshotScopeV1::ActivatedRustWriter,
        ),
        Err(CampaignWriterError::ControlSnapshotScopeMismatch)
    ));
    fs::remove_dir_all(root).expect("cleanup");
}
