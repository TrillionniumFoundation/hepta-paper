use super::*;
use crate::sqlite_mutation_coordinator::hash_bytes;
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    options: Options,
}
impl Fixture {
    fn node() -> Self {
        let root = PathBuf::from(format!(
            "/tmp/hepta-journal-source-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let service = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo = service.ancestors().nth(3).unwrap();
        let output = Command::new("node")
            .arg(service.join("src/local_state_authority/migration/schema_history/oracle.mjs"))
            .arg(repo)
            .arg(&root)
            .arg("genesis")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&oracle["profile"]).unwrap();
        let config = &oracle["configuration"];
        let public = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityPublicKey",
            "authorityId":config["authorityId"],"keyId":config["keyId"],"algorithm":"ed25519","publicKeyPem":oracle["publicKeyPem"]});
        let bytes = serde_json::to_vec(&public).unwrap();
        let public_path = root.join("public.json");
        fs::write(&public_path, &bytes).unwrap();
        fs::set_permissions(&public_path, fs::Permissions::from_mode(0o600)).unwrap();
        let mut online = config.as_object().unwrap().clone();
        for key in ["privateKeyPath", "stateDatabasePath", "socketPath"] {
            online.remove(key);
        }
        online.insert(
            "kind".into(),
            json!("AutonomousResearchOnlineMutationAuthorityConfiguration"),
        );
        online.insert("publicKeyPath".into(), json!(public_path));
        online.insert("publicKeySha256".into(), json!(hash_bytes(&bytes)));
        let bytes = serde_json::to_vec(&online).unwrap();
        let online_path = root.join("online.json");
        fs::write(&online_path, &bytes).unwrap();
        fs::set_permissions(&online_path, fs::Permissions::from_mode(0o600)).unwrap();
        let options = Options {
            daemon_configuration: root.join("configuration.json"),
            daemon_hash: hash_bytes(&fs::read(root.join("configuration.json")).unwrap()),
            online_configuration: online_path,
            online_hash: hash_bytes(&bytes),
            output_directory: None,
        };
        Self { root, options }
    }
    fn database(&self) -> PathBuf {
        self.root.join("authority.sqlite")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn assert_no_open_source_handles(root: &Path) {
    let family = [
        "authority.sqlite",
        "authority.sqlite-wal",
        "authority.sqlite-shm",
        "authority.sqlite-journal",
    ]
    .into_iter()
    .filter_map(|name| fs::symlink_metadata(root.join(name)).ok())
    .map(|value| (value.dev(), value.ino()))
    .collect::<Vec<_>>();
    for entry in fs::read_dir("/proc/self/fd").unwrap() {
        // stat follows the kernel's descriptor reference without opening it.
        // The only descriptor created by this enumeration is the proc directory.
        if let Ok(value) = fs::metadata(entry.unwrap().path()) {
            assert!(
                !family.contains(&(value.dev(), value.ino())),
                "source descriptor survived the owning read stage"
            );
        }
    }
}

#[test]
fn owning_read_closes_every_source_handle_before_returning_an_offline_artifact() {
    for mode in [
        Mode::Inspect,
        Mode::ExportNativeImage,
        Mode::ExportLegacyArchive,
    ] {
        let fixture = Fixture::node();
        let before = fs::read(fixture.database()).unwrap();
        let output = read_source(&fixture.options, mode).unwrap();
        assert!(matches!(
            (mode, &output.artifact),
            (Mode::Inspect, None)
                | (
                    Mode::ExportNativeImage,
                    Some(SourceArtifact::NativeImage(_))
                )
                | (
                    Mode::ExportLegacyArchive,
                    Some(SourceArtifact::LegacyArchive(_))
                )
        ));
        assert_eq!(output.report["sourceConnectionClosed"], true);
        assert_eq!(
            output.report["evidenceScope"],
            "named_source_snapshot_no_maintenance_authority"
        );
        assert_eq!(output.report["history"]["head"]["globalSequence"], 0);
        assert!(output.protected_paths.contains(&fixture.root));
        assert_no_open_source_handles(&fixture.root);
        assert_eq!(before, fs::read(fixture.database()).unwrap());
    }
}

#[test]
fn source_and_sidecar_aliases_are_refused_and_failure_closes_sqlite() {
    let fixture = Fixture::node();
    let extra = fixture.root.join("alias.sqlite");
    fs::hard_link(fixture.database(), &extra).unwrap();
    for mode in [Mode::ExportNativeImage, Mode::ExportLegacyArchive] {
        assert!(read_source(&fixture.options, mode).is_err());
    }
    fs::remove_file(extra).unwrap();
    let wal = fixture.root.join("authority.sqlite-wal");
    symlink(fixture.root.join("configuration.json"), &wal).unwrap();
    for mode in [Mode::ExportNativeImage, Mode::ExportLegacyArchive] {
        assert!(read_source(&fixture.options, mode).is_err());
    }
    fs::remove_file(wal).unwrap();
    let writer = Connection::open(fixture.database()).unwrap();
    writer
        .execute("UPDATE authority_metadata SET global_sequence=9", [])
        .unwrap();
    writer.close().unwrap();
    for mode in [Mode::ExportNativeImage, Mode::ExportLegacyArchive] {
        assert!(read_source(&fixture.options, mode).is_err());
    }
    assert_no_open_source_handles(&fixture.root);
    let writer = Connection::open(fixture.database()).unwrap();
    writer.execute_batch("BEGIN EXCLUSIVE; ROLLBACK").unwrap();
    writer.close().unwrap();
}

#[test]
fn canonical_names_and_complete_ancestor_identity_are_required() {
    let fixture = Fixture::node();
    let parent = fixture.root.parent().unwrap();
    let alias = parent.join(format!(
        "{}.alias",
        fixture.root.file_name().unwrap().to_str().unwrap()
    ));
    symlink(&fixture.root, &alias).unwrap();
    let options = Options {
        daemon_configuration: alias.join("configuration.json"),
        daemon_hash: fixture.options.daemon_hash.clone(),
        online_configuration: fixture.options.online_configuration.clone(),
        online_hash: fixture.options.online_hash.clone(),
        output_directory: None,
    };
    assert!(read_source(&options, Mode::Inspect).is_err());
    fs::remove_file(alias).unwrap();
    assert!(!canonical_name(Path::new("/tmp/../source")));
    assert!(!canonical_name(Path::new("/tmp//source")));
    assert!(!canonical_name(Path::new("/tmp/./source")));
    assert!(!canonical_name(Path::new("/tmp/source/")));
}
