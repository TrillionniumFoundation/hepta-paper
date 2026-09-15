//! Byte/archive tests deliberately do not manufacture semantic recovery proof.
use hepta_campaign_writer::{CampaignWriterPolicyV1, CampaignWriterStoreV1};
use hepta_codex_protocol::Sha256Digest;
use hepta_paper_service::{ObjectStoreV1, maintenance::{LocalMaintenanceSessionV1, verify_local_backup_v1}};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt, symlink},
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture { parent: PathBuf, state: PathBuf, object: Sha256Digest }
impl Fixture {
    fn new() -> Self {
        let parent = std::env::temp_dir().join(format!("hepta-backup-{}-{}",
            std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::DirBuilder::new().mode(0o700).create(&parent).expect("fresh parent");
        let parent = fs::canonicalize(parent).expect("canonical parent");
        let state = parent.join("state");
        let objects = ObjectStoreV1::open(&state).expect("object store");
        let object = objects.put(b"actual retained content").expect("put");
        let owner = fs::metadata(&state).expect("metadata").uid();
        let db = CampaignWriterStoreV1::create_local(
            state.join("campaign.sqlite"), CampaignWriterPolicyV1::strict(owner),
        ).expect("actual local SQLite database");
        drop(db);
        // Opaque definition bytes are intentional: byte verification must NEVER
        // upgrade this fixture into a semantically accepted workflow/recovery.
        private_write(&state.join("workflow.json"), b"{\"byteFixtureOnly\":true}");
        private_write(&state.join("workflow.lock"), b"");
        drop(objects);
        Self { parent, state, object }
    }
    fn object_path(&self) -> PathBuf {
        self.state.join("objects").join(self.object.as_str().trim_start_matches("sha256:"))
    }
    fn backup(&self) -> (PathBuf, Sha256Digest) {
        let bundle = self.parent.join("backup");
        let receipt = LocalMaintenanceSessionV1::acquire(&self.state).expect("lease")
            .backup(&bundle).expect("backup");
        assert!(receipt.bytes_verified);
        assert!(!receipt.semantic_recovery_verified);
        assert!(!receipt.production_activation);
        assert!(!receipt.node_retirement_verified);
        (bundle, receipt.manifest_hash)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.parent); }
}
fn private_write(path: &std::path::Path, bytes: &[u8]) {
    use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt};
    OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)
        .expect("new private file").write_all(bytes).expect("bytes");
}
fn hash(bytes: &[u8]) -> Sha256Digest {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes))).parse().expect("hash")
}

#[test]
fn actual_sqlite_and_cas_bytes_round_trip_without_recovery_promotion() {
    let f = Fixture::new();
    let (bundle, expected) = f.backup();
    let receipt = verify_local_backup_v1(&bundle, &expected).expect("verify");
    assert!(receipt.bytes_verified);
    assert!(!receipt.semantic_recovery_verified);
    assert_eq!(fs::read(f.state.join("campaign.sqlite")).expect("source"),
        fs::read(bundle.join("payload/campaign.sqlite")).expect("copy"));
    assert_eq!(fs::read(f.object_path()).expect("object"),
        fs::read(bundle.join("payload/objects").join(f.object.as_str().trim_start_matches("sha256:"))).expect("object copy"));
}

#[test]
fn service_handles_and_maintenance_are_mutually_exclusive() {
    let f = Fixture::new();
    let objects = ObjectStoreV1::open(&f.state).expect("open");
    let clone = objects.clone();
    assert!(LocalMaintenanceSessionV1::acquire(&f.state).is_err());
    drop(objects);
    assert!(LocalMaintenanceSessionV1::acquire(&f.state).is_err());
    drop(clone);
    let session = LocalMaintenanceSessionV1::acquire(&f.state).expect("lease");
    assert!(ObjectStoreV1::open(&f.state).is_err());
    assert!(LocalMaintenanceSessionV1::acquire(&f.state).is_err());
    drop(session);
    assert!(ObjectStoreV1::open(&f.state).is_ok());
}

#[test]
fn wrong_manifest_digest_is_rejected() {
    let f = Fixture::new();
    let (bundle, _) = f.backup();
    assert!(verify_local_backup_v1(&bundle, &hash(b"different")).is_err());
}

#[test]
fn corrupt_cas_is_rejected_without_repair() {
    let f = Fixture::new();
    fs::write(f.object_path(), b"changed").expect("corrupt");
    assert!(LocalMaintenanceSessionV1::acquire(&f.state).expect("lease").inspect().is_err());
    assert_eq!(fs::read(f.object_path()).expect("read"), b"changed");
}

#[test]
fn wal_sidecar_is_not_silently_omitted() {
    let f = Fixture::new();
    private_write(&f.state.join("campaign.sqlite-wal"), b"");
    assert!(LocalMaintenanceSessionV1::acquire(&f.state).expect("lease").inspect().is_err());
}

#[test]
fn unknown_private_files_are_not_archived() {
    let f = Fixture::new();
    private_write(&f.state.join("credentials.json"), b"fixture secret must not be copied");
    let destination = f.parent.join("backup");
    assert!(LocalMaintenanceSessionV1::acquire(&f.state).expect("lease").backup(&destination).is_err());
    assert!(!destination.exists());
}

#[test]
fn symlink_file_is_rejected() {
    let f = Fixture::new();
    let target = f.parent.join("external");
    private_write(&target, b"not input");
    fs::remove_file(f.state.join("workflow.json")).expect("remove");
    symlink(target, f.state.join("workflow.json")).expect("link");
    assert!(LocalMaintenanceSessionV1::acquire(&f.state).expect("lease").inspect().is_err());
}

#[test]
fn hardlinked_file_is_rejected() {
    let f = Fixture::new();
    fs::hard_link(f.object_path(), f.parent.join("alias")).expect("hardlink");
    assert!(LocalMaintenanceSessionV1::acquire(&f.state).expect("lease").inspect().is_err());
}

#[test]
fn existing_destination_is_not_adopted_or_overwritten() {
    let f = Fixture::new();
    let destination = f.parent.join("existing");
    fs::DirBuilder::new().mode(0o700).create(&destination).expect("directory");
    private_write(&destination.join("preserve"), b"unchanged");
    assert!(LocalMaintenanceSessionV1::acquire(&f.state).expect("lease").backup(&destination).is_err());
    assert_eq!(fs::read(destination.join("preserve")).expect("preserved"), b"unchanged");
}

#[test]
fn destination_inside_source_is_rejected() {
    let f = Fixture::new();
    let destination = f.state.join("backup");
    assert!(LocalMaintenanceSessionV1::acquire(&f.state).expect("lease").backup(&destination).is_err());
    assert!(!destination.exists());
}

#[test]
fn changed_payload_is_rejected() {
    let f = Fixture::new();
    let (bundle, expected) = f.backup();
    fs::write(bundle.join("payload/workflow.json"), b"changed").expect("corrupt");
    assert!(verify_local_backup_v1(&bundle, &expected).is_err());
}

#[test]
fn extra_bundle_or_payload_file_is_rejected() {
    let f = Fixture::new();
    let (bundle, expected) = f.backup();
    private_write(&bundle.join("extra"), b"extra");
    assert!(verify_local_backup_v1(&bundle, &expected).is_err());
    fs::remove_file(bundle.join("extra")).expect("remove");
    private_write(&bundle.join("payload/unknown"), b"extra");
    assert!(verify_local_backup_v1(&bundle, &expected).is_err());
}

#[test]
fn partial_bundle_without_manifest_cannot_be_verified() {
    let f = Fixture::new();
    let (bundle, expected) = f.backup();
    fs::remove_file(bundle.join("manifest.json")).expect("remove manifest");
    assert!(verify_local_backup_v1(&bundle, &expected).is_err());
}

#[test]
fn self_asserted_semantic_or_production_authority_is_rejected_even_with_matching_hash() {
    let f = Fixture::new();
    let (bundle, _) = f.backup();
    let path = bundle.join("manifest.json");
    let original = fs::read(&path).expect("manifest");
    for field in ["semanticRecoveryVerified", "productionActivation", "nodeRetirementVerified"] {
        let mut value: serde_json::Value = serde_json::from_slice(&original).expect("json");
        value[field] = true.into();
        let edited = serde_json::to_vec(&value).expect("encode");
        fs::write(&path, &edited).expect("write");
        assert!(verify_local_backup_v1(&bundle, &hash(&edited)).is_err());
    }
}

#[test]
fn actual_cli_inspects_and_rejects_restore_or_gc_commands() {
    let f = Fixture::new();
    let binary = env!("CARGO_BIN_EXE_hepta-local-maintenance");
    let output = Command::new(binary).arg("inspect").arg(&f.state).output().expect("CLI");
    assert!(output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("JSON");
    assert_eq!(value["semanticRecoveryVerified"], false);
    for command in ["restore", "gc", "cutover"] {
        let output = Command::new(binary).arg(command).arg(&f.state).output().expect("CLI denial");
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}
