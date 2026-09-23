use super::*;
use crate::local_state_authority::migration::LegacyAuthorityJournalVerifierV1;
use rusqlite::{Connection, OpenFlags};
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    process::Command,
};

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let mut random = [0u8; 12];
        getrandom::fill(&mut random).unwrap();
        let path = PathBuf::from(format!(
            "/tmp/hepta-offline-publication-{}",
            hex::encode(random)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn child(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn private(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn genuine_image(root: &Path) -> (OfflineNativeAuthorityImageV1, Value) {
    let service = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repository = service.ancestors().nth(3).unwrap();
    let output = Command::new("node")
        .arg(service.join("src/local_state_authority/migration/offline_image/oracle.mjs"))
        .arg(repository)
        .arg(root)
        .arg("aborted-tail")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&oracle["profile"]).unwrap();
    let configuration = &oracle["configuration"];
    let key = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityPublicKey",
        "authorityId":configuration["authorityId"],"keyId":configuration["keyId"],
        "algorithm":"ed25519","publicKeyPem":oracle["publicKeyPem"]});
    let bytes = serde_json::to_vec(&key).unwrap();
    let key_path = root.join("public-key.json");
    private(&key_path, &bytes);
    let mut online = configuration.as_object().unwrap().clone();
    for key in ["privateKeyPath", "stateDatabasePath", "socketPath"] {
        online.remove(key);
    }
    online.insert(
        "kind".into(),
        json!("AutonomousResearchOnlineMutationAuthorityConfiguration"),
    );
    online.insert("publicKeyPath".into(), json!(key_path));
    online.insert("publicKeySha256".into(), json!(hash_bytes(&bytes)));
    let online_bytes = serde_json::to_vec(&online).unwrap();
    let online_path = root.join("online.json");
    private(&online_path, &online_bytes);
    let daemon = root.join("configuration.json");
    let owner = LegacyAuthorityJournalVerifierV1::load(
        &daemon,
        &hash_bytes(&fs::read(&daemon).unwrap()),
        &online_path,
        &hash_bytes(&online_bytes),
    )
    .unwrap();
    let source = Path::new(configuration["stateDatabasePath"].as_str().unwrap());
    let db = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    db.pragma_update(None, "query_only", true).unwrap();
    db.execute_batch("BEGIN DEFERRED").unwrap();
    db.query_row("SELECT count(*) FROM main.sqlite_schema", [], |r| {
        r.get::<_, i64>(0)
    })
    .unwrap();
    let image = owner.build_offline_native_image(&db).unwrap();
    db.execute_batch("ROLLBACK").unwrap();
    db.close().unwrap();
    drop(owner);
    // This is a truthful named-path observation, deliberately not a stop or
    // source-provenance certificate. The real CLI supplies its stronger owner.
    let metadata = fs::symlink_metadata(source).unwrap();
    (
        image,
        json!({"evidenceScope":"named_namespace_observation_not_source_provenance",
        "sourcePath":source,"device":metadata.dev(),"inode":metadata.ino()}),
    )
}

fn genuine_archive(root: &Path) -> (OfflineLegacyAuthorityArchiveV1, Value) {
    let (_, observation) = genuine_image(root);
    let daemon = root.join("configuration.json");
    let online = root.join("online.json");
    let owner = LegacyAuthorityJournalVerifierV1::load(
        &daemon,
        &hash_bytes(&fs::read(&daemon).unwrap()),
        &online,
        &hash_bytes(&fs::read(&online).unwrap()),
    )
    .unwrap();
    let db = Connection::open_with_flags(
        root.join("authority.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    db.execute_batch("PRAGMA query_only=ON; BEGIN DEFERRED")
        .unwrap();
    db.query_row("SELECT count(*) FROM main.sqlite_schema", [], |r| {
        r.get::<_, i64>(0)
    })
    .unwrap();
    let archive = owner.build_offline_legacy_archive(&db).unwrap();
    db.execute_batch("ROLLBACK").unwrap();
    db.close().unwrap();
    drop(owner);
    (archive, observation)
}

#[test]
fn genuine_legacy_archive_has_distinct_closed_bundle_and_shared_publication_refusals() {
    let sandbox = Sandbox::new();
    let source = sandbox.child("source");
    let parent = sandbox.child("output");
    let (archive, observation) = genuine_archive(&source);
    let output = parent.join("bundle");
    let result = publish_legacy_archive(
        &output,
        &archive,
        &observation,
        std::slice::from_ref(&source),
    )
    .unwrap();
    assert_eq!(
        result["kind"],
        "HeptaLocalStateAuthorityOfflineLegacyArchivePublicationV1"
    );
    assert_eq!(result["publicationCommitted"], true);
    assert_eq!(result["archivePath"], json!(output.join(ARCHIVE)));
    assert_eq!(fs::read(output.join(ARCHIVE)).unwrap(), archive.bytes());
    assert!(!output.join(IMAGE).exists());
    assert_eq!(fs::read_dir(&output).unwrap().count(), 2);
    let report_bytes = fs::read(output.join(REPORT)).unwrap();
    assert_eq!(result["archiveSha256"], hash_bytes(archive.bytes()));
    assert_eq!(result["reportSha256"], hash_bytes(&report_bytes));
    let report: Value = serde_json::from_slice(&report_bytes).unwrap();
    assert_eq!(
        report["kind"],
        "HeptaLocalStateAuthorityOfflineLegacyArchiveBundleV1"
    );
    assert_eq!(report["archive"], *archive.report());
    assert_eq!(report["sourceNamespaceObservation"], observation);
    let db = Connection::open_with_flags(output.join(ARCHIVE), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='authority_native_identity'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    db.close().unwrap();
    for blocked in [&output, &source, &source.join("fresh"), &sandbox.0] {
        let failure = publish_legacy_archive(
            blocked,
            &archive,
            &observation,
            std::slice::from_ref(&source),
        )
        .unwrap_err();
        assert_eq!(failure.details["publicationCommitted"], false);
        assert_eq!(failure.details["inspectionRequired"], false);
    }
    assert_eq!(fs::read(output.join(ARCHIVE)).unwrap(), archive.bytes());
    assert_eq!(fs::read(output.join(REPORT)).unwrap(), report_bytes);
    assert_eq!(fs::read_dir(parent).unwrap().count(), 1);
}

#[test]
fn genuine_node_image_publishes_fresh_private_bundle_after_source_close() {
    let sandbox = Sandbox::new();
    let source = sandbox.child("source");
    let output_parent = sandbox.child("output");
    let (image, observation) = genuine_image(&source);
    let output = output_parent.join("bundle");
    let result = publish_image(&output, &image, &observation, &[source]).unwrap();
    assert_eq!(result["publicationCommitted"], true);
    assert_eq!(
        result["imageSha256"],
        hash_bytes(&fs::read(output.join(IMAGE)).unwrap())
    );
    let bytes = fs::read(output.join(REPORT)).unwrap();
    assert_eq!(result["reportSha256"], hash_bytes(&bytes));
    let report: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(report["image"], *image.report());
    assert_eq!(report["sourceNamespaceObservation"], observation);
    assert_eq!(fs::read(output.join(IMAGE)).unwrap(), image.bytes());
    assert_eq!(
        fs::symlink_metadata(&output).unwrap().mode() & 0o7777,
        0o700
    );
    for name in [IMAGE, REPORT] {
        let metadata = fs::symlink_metadata(output.join(name)).unwrap();
        assert_eq!(metadata.mode() & 0o7777, 0o600);
        assert_eq!(metadata.nlink(), 1);
    }
    let native =
        Connection::open_with_flags(output.join(IMAGE), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        native
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        native
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        native
            .query_row(
                "SELECT count(*) FROM authority_mutation WHERE status='aborted'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    native.close().unwrap();
    assert_eq!(fs::read_dir(output_parent).unwrap().count(), 1);
}

#[test]
fn protected_paths_and_all_existing_output_types_remain_untouched() {
    let sandbox = Sandbox::new();
    let source = sandbox.child("source");
    let output_parent = sandbox.child("output");
    let (image, observation) = genuine_image(&source);
    for path in [&source, &source.join("bundle"), &sandbox.0] {
        let failure =
            publish_image(path, &image, &observation, std::slice::from_ref(&source)).unwrap_err();
        assert_eq!(failure.code, PROTECTED);
        assert_eq!(failure.details["publicationCommitted"], false);
    }
    private(&output_parent.join("sentinel"), b"keep-me");
    fs::create_dir(output_parent.join("directory")).unwrap();
    private(&output_parent.join("directory/inside"), b"keep-inside");
    symlink(output_parent.join("sentinel"), output_parent.join("link")).unwrap();
    fs::hard_link(
        output_parent.join("sentinel"),
        output_parent.join("hardlink"),
    )
    .unwrap();
    for name in ["sentinel", "directory", "link", "hardlink"] {
        let failure = publish_image(
            &output_parent.join(name),
            &image,
            &observation,
            std::slice::from_ref(&source),
        )
        .unwrap_err();
        assert_eq!(failure.code, EXISTS);
        assert_eq!(failure.details["publicationCommitted"], false);
    }
    assert_eq!(
        fs::read(output_parent.join("sentinel")).unwrap(),
        b"keep-me"
    );
    assert_eq!(
        fs::read(output_parent.join("directory/inside")).unwrap(),
        b"keep-inside"
    );
    assert_eq!(fs::read_dir(&output_parent).unwrap().count(), 4);
    fs::set_permissions(&output_parent, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        publish_image(
            &output_parent.join("fresh"),
            &image,
            &observation,
            &[source]
        )
        .is_err()
    );
    assert!(!output_parent.join("fresh").exists());
}

#[test]
fn no_replace_remains_atomic_when_destination_appears_after_preflight() {
    let sandbox = Sandbox::new();
    let parent = Parent::open(&sandbox.0).unwrap();
    parent.absent(Path::new("bundle")).unwrap();
    let mut stage = Stage::create(&parent).unwrap();
    stage
        .write_new(IMAGE, b"test namespace primitive, not a qualified image")
        .unwrap();
    stage.write_new(REPORT, b"{}").unwrap();
    fs::create_dir(sandbox.0.join("bundle")).unwrap();
    private(&sandbox.0.join("bundle/sentinel"), b"retain");
    let staged_path = stage.path();
    let failure = stage
        .publish(Path::new("bundle"), &sandbox.0.join("bundle"))
        .unwrap_err();
    assert_eq!(failure.code, EXISTS);
    assert_eq!(failure.details["publicationCommitted"], false);
    drop(stage);
    assert!(!staged_path.exists());
    assert_eq!(
        fs::read(sandbox.0.join("bundle/sentinel")).unwrap(),
        b"retain"
    );
}

#[test]
fn namespace_drift_keeps_staging_and_never_follows_replacement_ancestor() {
    let sandbox = Sandbox::new();
    let path = sandbox.child("parent");
    let parent = Parent::open(&path).unwrap();
    let mut stage = Stage::create(&parent).unwrap();
    stage.write_new(IMAGE, b"namespace test").unwrap();
    let stage_name = stage.name.clone();
    let moved = sandbox.0.join("moved");
    fs::rename(&path, &moved).unwrap();
    symlink(&moved, &path).unwrap();
    assert!(stage.assert_current(&stage.path()).is_err());
    drop(stage);
    assert_eq!(
        fs::read(moved.join(stage_name).join(IMAGE)).unwrap(),
        b"namespace test"
    );
    assert!(fs::symlink_metadata(path).unwrap().is_symlink());
}

#[test]
fn replaced_or_hardlinked_staging_files_are_preserved_on_refusal() {
    for hardlink in [false, true] {
        let sandbox = Sandbox::new();
        let parent = Parent::open(&sandbox.0).unwrap();
        let mut stage = Stage::create(&parent).unwrap();
        stage.write_new(IMAGE, b"initial").unwrap();
        let path = stage.path();
        if hardlink {
            fs::hard_link(path.join(IMAGE), sandbox.0.join("alias")).unwrap();
        } else {
            fs::remove_file(path.join(IMAGE)).unwrap();
            private(&path.join(IMAGE), b"replacement");
        }
        assert!(
            stage
                .publish(Path::new("bundle"), &sandbox.0.join("bundle"))
                .is_err()
        );
        drop(stage);
        assert!(path.join(IMAGE).exists());
        assert!(!sandbox.0.join("bundle").exists());
    }
}

#[test]
fn postrename_failure_reports_committed_and_never_cleans_final_output() {
    let sandbox = Sandbox::new();
    let parent = Parent::open(&sandbox.0).unwrap();
    let mut stage = Stage::create(&parent).unwrap();
    stage.write_new(IMAGE, b"filesystem primitive").unwrap();
    stage.write_new(REPORT, b"{}").unwrap();
    let output = sandbox.0.join("bundle");
    // Exercise the real publication commit followed by actual namespace drift,
    // then the same terminal validation and error annotation as publish().
    stage.publish(Path::new("bundle"), &output).unwrap();
    fs::set_permissions(&output, fs::Permissions::from_mode(0o750)).unwrap();
    let failure = stage.finish_publication(&output).unwrap_err();
    assert_eq!(failure.details["publicationCommitted"], true);
    assert_eq!(failure.details["inspectionRequired"], true);
    drop(stage);
    assert_eq!(
        fs::read(output.join(IMAGE)).unwrap(),
        b"filesystem primitive"
    );
}

#[test]
fn unknown_stage_member_and_unsafe_ancestor_are_refused_without_deletion() {
    let sandbox = Sandbox::new();
    let parent = Parent::open(&sandbox.0).unwrap();
    let stage = Stage::create(&parent).unwrap();
    let path = stage.path();
    private(&path.join("unknown"), b"not ours");
    assert!(stage.assert_current(&path).is_err());
    drop(stage);
    assert_eq!(fs::read(path.join("unknown")).unwrap(), b"not ours");
    let ancestor = sandbox.child("ancestor");
    let leaf = ancestor.join("leaf");
    fs::create_dir(&leaf).unwrap();
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&ancestor, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(Parent::open(&leaf).is_err());
}
