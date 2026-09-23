use hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis;
use hepta_paper_service::sqlite_mutation_coordinator::Result;
use hepta_paper_service::state_backup_authority::{
    PinnedStateBackupAuthorityV1,
    restore_source::{
        StoredRestoreSourceOptionsV1, VerifiedStoredRestoreSourceV1,
        verify_stored_restore_source_v1,
    },
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    data: Value,
}
impl Fixture {
    fn new(scenario: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-sqlite-authority-rust-backup-source-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = Command::new("node")
            .arg(repository.join("rust/oracle/state-backup-restore-source-v1.mjs"))
            .current_dir(repository)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                json!({"root":root,"scenario":scenario})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["ok"], true, "{result}");
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"]).unwrap();
        Self {
            root,
            data: result["value"].clone(),
        }
    }
    fn now(&self) -> i64 {
        canonical_instant_millis(self.data["now"].as_str().unwrap()).unwrap()
    }
    fn load(&self, inventory: &Value, now: i64) -> Result<VerifiedStoredRestoreSourceV1> {
        let authority = PinnedStateBackupAuthorityV1::load_process(
            Path::new(self.data["configurationPath"].as_str().unwrap()),
            self.data["configurationFileHash"].as_str().unwrap(),
        )?;
        verify_stored_restore_source_v1(
            &authority,
            StoredRestoreSourceOptionsV1 {
                bundle_path: Path::new(self.data["bundlePath"].as_str().unwrap()),
                bundle_file_hash: self.data["bundleFileHash"].as_str().unwrap(),
                restore_receipt_file_hash: self.data["restoreReceiptFileHash"].as_str().unwrap(),
                state_database_manifest: &self.data["manifest"],
                current_inventory: inventory,
                now,
            },
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn walk(p: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
        for e in fs::read_dir(p).unwrap() {
            let p = e.unwrap().path();
            let metadata = fs::symlink_metadata(&p).unwrap();
            if metadata.is_dir() {
                walk(&p, out)
            } else if metadata.is_file() {
                out.push((p.clone(), fs::read(p).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out);
    out.sort();
    out
}
#[test]
fn actual_ten_database_snapshot_and_signed_journal_sources_match_node_read_only() {
    for scenario in ["snapshot", "journal", "float-bytes"] {
        let f = Fixture::new(scenario);
        assert_eq!(
            f.data["node"]["status"], "autonomous_research_state_backup_sources_ready",
            "{}",
            f.data["node"]
        );
        let before = snapshot(&f.root);
        let source = f.load(&f.data["inventory"], f.now()).unwrap();
        assert_eq!(source.inspection(), &f.data["node"]);
        source
            .assert_current(&f.data["inventory"], f.now())
            .unwrap();
        assert_eq!(snapshot(&f.root), before);
    }
}
#[test]
fn real_signed_splice_cannot_claim_another_snapshot_and_raw_member_order_is_preserved() {
    for (scenario, node_ready, code) in [
        (
            "splice",
            true,
            "autonomous_research_state_backup_restore_journal_binding_invalid",
        ),
        (
            "ordered-heads",
            false,
            "autonomous_research_state_backup_restore_journal_binding_invalid",
        ),
        (
            "journal-bad-signature",
            false,
            "autonomous_research_state_backup_restore_journal_entry_invalid",
        ),
    ] {
        let f = Fixture::new(scenario);
        assert_eq!(
            f.data["node"]["status"] == "autonomous_research_state_backup_sources_ready",
            node_ready,
            "{scenario}: {}",
            f.data["node"]
        );
        let failure = f.load(&f.data["inventory"], f.now()).err().unwrap();
        assert_eq!(failure.code, code, "{scenario}");
    }
}
#[test]
fn actual_sqlite_content_and_required_objects_cannot_be_replaced_with_signed_claims() {
    for (scenario, node_ready) in [
        ("sqlite-garbage-signed", true),
        ("missing-required-signed", true),
        ("corrupt-file", false),
    ] {
        let f = Fixture::new(scenario);
        assert_eq!(
            f.data["node"]["status"] == "autonomous_research_state_backup_sources_ready",
            node_ready,
            "{scenario}: {}",
            f.data["node"]
        );
        assert!(f.load(&f.data["inventory"], f.now()).is_err(), "{scenario}");
    }
}
#[test]
fn source_currentness_rechecks_exact_inventory_age_files_and_directory_set() {
    for mode in [
        "content",
        "permissions",
        "symlink",
        "hardlink",
        "extra-entry",
        "expired",
        "inventory",
    ] {
        let f = Fixture::new("snapshot");
        let source = f.load(&f.data["inventory"], f.now()).unwrap();
        let path = Path::new(f.data["firstDatabasePath"].as_str().unwrap());
        let mut inventory = f.data["inventory"].clone();
        let mut now = f.now();
        match mode {
            "content" => fs::write(path, b"changed source bytes").unwrap(),
            "permissions" => fs::set_permissions(path, fs::Permissions::from_mode(0o620)).unwrap(),
            "symlink" => {
                let held = f.root.join("held.sqlite");
                fs::rename(path, &held).unwrap();
                symlink(held, path).unwrap();
            }
            "hardlink" => fs::hard_link(path, f.root.join("alias.sqlite")).unwrap(),
            "extra-entry" => {
                fs::write(path.parent().unwrap().join("unexpected.sqlite"), b"extra").unwrap()
            }
            "expired" => now += 86_400_001,
            _ => inventory["inventoryHash"] = json!("sha256:untrusted"),
        }
        assert!(source.assert_current(&inventory, now).is_err(), "{mode}");
    }
}
#[test]
fn forged_ready_inventory_and_stale_restore_are_rejected_before_ready_type_creation() {
    let f = Fixture::new("snapshot");
    assert!(f.load(&f.data["inventory"], f.now() + 86_400_001).is_err());
    let mut inventory = f.data["inventory"].clone();
    inventory["instances"][0]["schemaHash"] = json!("sha256:forged");
    assert!(f.load(&inventory, f.now()).is_err());
}

#[test]
fn declared_aggregate_size_is_rejected_before_any_database_open() {
    let fixture = Fixture::new("declared-size-signed");
    let error = fixture
        .load(&fixture.data["inventory"], fixture.now())
        .err()
        .unwrap();
    assert_eq!(
        error.code,
        "autonomous_research_state_backup_source_resource_limit"
    );
}
