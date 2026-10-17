//! Filesystem crash tests for ACK storage only. These dummy records are not
//! signed authority; ordinary CLI tests exercise the actual verifier/IPC path.
use super::*;
use std::{
    os::unix::{
        fs::{PermissionsExt, symlink},
        process::ExitStatusExt,
    },
    process::Command,
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let path = std::env::temp_dir().join(format!("hepta-ack-record-{}", hex::encode(nonce)));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path.canonicalize().unwrap())
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn digest() -> Sha256Digest {
    format!("sha256:{}", "a".repeat(64)).parse().unwrap()
}
fn acknowledgement() -> CommitBoundPreparedResultAcknowledgementV2 {
    CommitBoundPreparedResultAcknowledgementV2 {
        version: 2,
        authority_domain_id: "fixture-storage-only".into(),
        trust_store_generation: 1,
        operation_id: "operation".into(),
        request_hash: digest(),
        prepared_receipt_hash: digest(),
        campaign_id: "campaign".into(),
        node_id: "node".into(),
        attempt_id: "attempt".into(),
        campaign_revision: 1,
        lease_generation: 1,
        plan_hash: digest(),
        sequence: 1,
        result_hash: digest(),
        verifier_hash: digest(),
        verification_receipt_hash: digest(),
        committed_state_hash: digest(),
        actual_cost_microusd: 6,
        acknowledged_at_unix_ms: 100,
        signer_key_id: "storage-fixture".into(),
        signature_base64: "AA".into(),
    }
}
fn pending_files(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut rows = fs::read_dir(root.join(DIRECTORY))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|v| v == "pending"))
        .map(|path| {
            let bytes = fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    rows
}

#[test]
fn partial_publication_is_not_confirmation_and_retry_preserves_crash_bytes() {
    let root = Temp::new();
    let ack = acknowledgement();
    let hash = digest();
    select_intent(&root.0, &hash, &ack).unwrap();
    assert!(read_marker(&root.0, &hash).unwrap().is_none());
    let owner = Owner::open(&root.0, false).unwrap().unwrap();
    assert!(
        owner
            .publish(RecordKind::Confirmed, &hash, &ack, &mut |phase| {
                if phase == "partial" {
                    Err(ServiceError::Filesystem)
                } else {
                    Ok(())
                }
            })
            .is_err()
    );
    let retained = pending_files(&root.0);
    assert_eq!(retained.len(), 1);
    assert!(!retained[0].1.is_empty());
    assert!(read_marker(&root.0, &hash).unwrap().is_none());
    store_marker(&root.0, hash.clone(), &ack).unwrap();
    assert_eq!(pending_files(&root.0), retained);
    assert_eq!(
        read_marker(&root.0, &hash)
            .unwrap()
            .unwrap()
            .acknowledgement,
        ack
    );
}

#[test]
fn aliases_corruption_and_conflicting_intents_never_become_completion() {
    let root = Temp::new();
    let ack = acknowledgement();
    let hash = digest();
    symlink(root.0.join("missing"), root.0.join(DIRECTORY)).unwrap();
    assert!(read_marker(&root.0, &hash).is_err());
    assert!(select_intent(&root.0, &hash, &ack).is_err());
    fs::remove_file(root.0.join(DIRECTORY)).unwrap();
    let owner = Owner::open(&root.0, true).unwrap().unwrap();
    let confirmed = root
        .0
        .join(DIRECTORY)
        .join(RecordKind::Confirmed.filename(&hash));
    symlink(root.0.join("missing"), &confirmed).unwrap();
    assert!(read_marker(&root.0, &hash).is_err());
    fs::remove_file(&confirmed).unwrap();
    select_intent(&root.0, &hash, &ack).unwrap();
    let mut other = ack.clone();
    other.acknowledged_at_unix_ms += 1;
    assert!(select_intent(&root.0, &hash, &other).is_err());
    assert!(store_marker(&root.0, hash.clone(), &other).is_err());
    assert!(owner.read(RecordKind::Confirmed, &hash).unwrap().is_none());
    fs::write(&confirmed, b"partial legacy confirmation").unwrap();
    fs::set_permissions(&confirmed, fs::Permissions::from_mode(0o600)).unwrap();
    let before = fs::read(&confirmed).unwrap();
    assert!(read_marker(&root.0, &hash).is_err());
    assert!(store_marker(&root.0, hash.clone(), &ack).is_err());
    assert_eq!(fs::read(&confirmed).unwrap(), before);
}

#[test]
fn replaced_directory_or_temporary_inode_is_not_adopted_or_removed() {
    let root = Temp::new();
    let ack = acknowledgement();
    let hash = digest();
    let owner = Owner::open(&root.0, true).unwrap().unwrap();
    let held = root.0.join("held");
    let mut replaced = None;
    assert!(
        owner
            .publish(RecordKind::Intent, &hash, &ack, &mut |phase| {
                if phase == "synced" {
                    let path = pending_files(&root.0)[0].0.clone();
                    fs::rename(&path, &held).unwrap();
                    fs::write(&path, b"competitor").unwrap();
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
                    replaced = Some(path);
                }
                Ok(())
            })
            .is_err()
    );
    assert_eq!(fs::read(replaced.unwrap()).unwrap(), b"competitor");
    assert!(!fs::read(&held).unwrap().is_empty());
    assert!(owner.read(RecordKind::Intent, &hash).unwrap().is_none());
    fs::rename(root.0.join(DIRECTORY), root.0.join("old-directory")).unwrap();
    fs::create_dir(root.0.join(DIRECTORY)).unwrap();
    fs::set_permissions(root.0.join(DIRECTORY), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        owner
            .publish(RecordKind::Intent, &hash, &ack, &mut |_| Ok(()))
            .is_err()
    );
    assert_eq!(fs::read_dir(root.0.join(DIRECTORY)).unwrap().count(), 0);
}

#[test]
#[ignore = "owned SIGKILL helper invoked by the crash matrix"]
fn publication_crash_child() {
    let root = PathBuf::from(std::env::var_os("HEPTA_ACK_STORAGE_TEST_ROOT").unwrap());
    let selected = std::env::var("HEPTA_ACK_STORAGE_TEST_PHASE").unwrap();
    let kind = match std::env::var("HEPTA_ACK_STORAGE_TEST_KIND")
        .unwrap()
        .as_str()
    {
        "intent" => RecordKind::Intent,
        "confirmed" => RecordKind::Confirmed,
        _ => panic!("test kind"),
    };
    let owner = Owner::open(&root, true).unwrap().unwrap();
    owner
        .publish(kind, &digest(), &acknowledgement(), &mut |phase| {
            if phase == selected {
                nix::sys::signal::kill(nix::unistd::getpid(), nix::sys::signal::Signal::SIGKILL)
                    .unwrap();
            }
            Ok(())
        })
        .unwrap();
    panic!("test did not reach selected publication checkpoint");
}

#[test]
fn real_process_death_at_each_publication_boundary_preserves_exact_recovery() {
    for kind in ["intent", "confirmed"] {
        for phase in [
            "created",
            "partial",
            "synced",
            "published",
            "directory_synced",
        ] {
            let root = Temp::new();
            let hash = digest();
            let ack = acknowledgement();
            if kind == "confirmed" {
                select_intent(&root.0, &hash, &ack).unwrap();
            }
            let status = Command::new(std::env::current_exe().unwrap())
                .args([
                    "broker_prepared::ack_records::tests::publication_crash_child",
                    "--exact",
                    "--ignored",
                ])
                .env("HEPTA_ACK_STORAGE_TEST_ROOT", &root.0)
                .env("HEPTA_ACK_STORAGE_TEST_KIND", kind)
                .env("HEPTA_ACK_STORAGE_TEST_PHASE", phase)
                .status()
                .unwrap();
            assert_eq!(status.signal(), Some(9), "{kind}/{phase}");
            let retained = pending_files(&root.0);
            let confirmed =
                kind == "confirmed" && matches!(phase, "published" | "directory_synced");
            assert_eq!(read_marker(&root.0, &hash).unwrap().is_some(), confirmed);
            select_intent(&root.0, &hash, &ack).unwrap();
            store_marker(&root.0, hash.clone(), &ack).unwrap();
            assert_eq!(
                read_marker(&root.0, &hash)
                    .unwrap()
                    .unwrap()
                    .acknowledgement,
                ack
            );
            assert_eq!(
                pending_files(&root.0),
                retained,
                "crash remnants were changed"
            );
        }
    }
}
