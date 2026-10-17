//! Actual filesystem lifetime tests. Source-only inspection intentionally cannot
//! satisfy the separate installed-principal check on an ordinary single-UID host.
use super::*;
use std::{
    os::unix::fs::symlink,
    sync::atomic::AtomicU64,
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    parent: PathBuf,
    path: PathBuf,
    bytes: Vec<u8>,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-retained-config-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let parent = root.join("installed");
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o750)).unwrap();
        let path = parent.join("canary.json");
        let mut configuration = super::super::tests::configuration();
        let uid = Uid::effective().as_raw();
        let gid = Gid::effective().as_raw();
        configuration.configuration_authority_uid = uid;
        configuration.configuration_reader_gid = gid;
        configuration.broker_uid = uid.checked_add(1).unwrap_or_else(|| uid - 1);
        configuration.broker_gid = gid;
        configuration.operation_authority_uid = uid;
        configuration.trust_bundle_authority_uid = uid;
        configuration.gate_authority_uid = uid;
        configuration.listener.parent_owner_uid = configuration.broker_uid;
        configuration.listener.parent_group_gid = gid;
        configuration.purpose = crate::ProductCodexOperationPurposeV1::OneShotReadOnlyCanary;
        let bytes = serde_json::to_vec(&configuration).unwrap();
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap();
        Self {
            root,
            parent,
            path,
            bytes,
        }
    }
    fn observed_source(&self) -> LoadedProductCodexBrokerConfigurationV1 {
        let loaded = load_configuration_source(&self.path).unwrap();
        loaded.assert_source_current().unwrap();
        loaded
    }
    fn rewrite(&self, bytes: &[u8]) {
        fs::set_permissions(&self.path, fs::Permissions::from_mode(0o640)).unwrap();
        fs::write(&self.path, bytes).unwrap();
        fs::set_permissions(&self.path, fs::Permissions::from_mode(0o440)).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn original_source_allows_sibling_churn_and_concurrent_independent_reads() {
    let fixture = Fixture::new();
    let loaded = fixture.observed_source();
    fs::write(
        fixture.parent.join("unrelated-installation-log"),
        b"sibling",
    )
    .unwrap();
    loaded.assert_source_current().unwrap();
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let loaded = loaded.clone();
            scope.spawn(move || {
                for _ in 0..8 {
                    loaded.assert_source_current().unwrap();
                }
            });
        }
    });
}

#[test]
fn rewrite_and_restore_cannot_revive_any_original_clone() {
    let fixture = Fixture::new();
    let loaded = fixture.observed_source();
    let clone = loaded.clone();
    let inode = loaded.identity.inode;
    let mut changed = fixture.bytes.clone();
    changed.push(b' ');
    fixture.rewrite(&changed);
    assert_eq!(fs::metadata(&fixture.path).unwrap().ino(), inode);
    assert!(loaded.assert_source_current().is_err());
    fixture.rewrite(&fixture.bytes);
    assert!(clone.assert_source_current().is_err());
    assert!(loaded.assert_source_current().is_err());
    // A new source observation is distinct. It does not restore the old owner.
    load_configuration_source(&fixture.path)
        .unwrap()
        .assert_source_current()
        .unwrap();
    assert!(clone.assert_source_current().is_err());
}

#[test]
fn missing_replaced_symlinked_and_hardlinked_sources_revoke() {
    for variant in ["missing", "replacement", "symlink", "hardlink"] {
        let fixture = Fixture::new();
        let loaded = fixture.observed_source();
        let saved = fixture.root.join("saved.json");
        if variant == "hardlink" {
            fs::hard_link(&fixture.path, &saved).unwrap();
        } else {
            fs::rename(&fixture.path, &saved).unwrap();
            if variant == "replacement" {
                fs::write(&fixture.path, &fixture.bytes).unwrap();
                fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o440)).unwrap();
            } else if variant == "symlink" {
                symlink(&saved, &fixture.path).unwrap();
            }
        }
        assert!(loaded.assert_source_current().is_err(), "{variant}");
        if variant == "hardlink" {
            fs::remove_file(&saved).unwrap();
        } else {
            if fs::symlink_metadata(&fixture.path).is_ok() {
                fs::remove_file(&fixture.path).unwrap();
            }
            fs::rename(&saved, &fixture.path).unwrap();
        }
        assert!(
            loaded.assert_source_current().is_err(),
            "restored {variant}"
        );
    }
}

#[test]
fn parent_replacement_with_the_same_configuration_inode_is_not_adopted() {
    let fixture = Fixture::new();
    let loaded = fixture.observed_source();
    let saved = fixture.root.join("old-installation");
    fs::rename(&fixture.parent, &saved).unwrap();
    fs::create_dir(&fixture.parent).unwrap();
    fs::set_permissions(&fixture.parent, fs::Permissions::from_mode(0o750)).unwrap();
    fs::rename(saved.join("canary.json"), &fixture.path).unwrap();
    let current = load_configuration_source(&fixture.path).unwrap();
    assert_eq!(current.identity.inode, loaded.identity.inode);
    assert_ne!(current.identity.parent, loaded.identity.parent);
    assert!(loaded.assert_source_current().is_err());
}

#[test]
fn changed_file_or_parent_mode_permanently_revokes_source() {
    for parent in [false, true] {
        let fixture = Fixture::new();
        let loaded = fixture.observed_source();
        let (path, original, changed) = if parent {
            (&fixture.parent, 0o750, 0o755)
        } else {
            (&fixture.path, 0o440, 0o640)
        };
        fs::set_permissions(path, fs::Permissions::from_mode(changed)).unwrap();
        assert!(loaded.assert_source_current().is_err());
        fs::set_permissions(path, fs::Permissions::from_mode(original)).unwrap();
        assert!(loaded.assert_source_current().is_err());
    }
}

#[test]
fn actual_broker_principal_is_required_and_failed_check_revokes_all_clones() {
    let fixture = Fixture::new();
    let loaded = fixture.observed_source();
    let clone = loaded.clone();
    assert!(matches!(
        load_product_codex_broker_configuration(&fixture.path),
        Err(ProductCodexBrokerDaemonError::BrokerPrincipal)
    ));
    assert!(matches!(
        loaded.assert_current(),
        Err(ProductCodexBrokerDaemonError::BrokerPrincipal)
    ));
    assert!(clone.assert_source_current().is_err());
    assert!(loaded.clone().into_current_configuration().is_err());
}

#[test]
fn rewrite_and_restore_before_first_recheck_is_detected_by_file_identity() {
    let fixture = Fixture::new();
    let loaded = fixture.observed_source();
    let mut changed = fixture.bytes.clone();
    changed.push(b' ');
    fixture.rewrite(&changed);
    fixture.rewrite(&fixture.bytes);
    let fresh = load_configuration_source(&fixture.path).unwrap();
    assert_eq!(fresh.identity.inode, loaded.identity.inode);
    assert_eq!(fresh.identity.content_hash, loaded.identity.content_hash);
    assert_eq!(fresh.configuration, loaded.configuration);
    assert_ne!(fresh.identity, loaded.identity);
    assert!(loaded.assert_source_current().is_err());
    assert!(loaded.clone().assert_source_current().is_err());
}
