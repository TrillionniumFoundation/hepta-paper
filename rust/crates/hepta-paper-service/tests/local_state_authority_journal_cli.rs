//! Actual binary/Node fixtures for the explicitly offline journal commands.
//! Export is inspected as a detached bundle; these tests do not publish over a
//! source, stop an authority, or manufacture migration/deployment permission.
use ed25519_dalek::{
    SigningKey, VerifyingKey,
    pkcs8::{DecodePublicKey, EncodePublicKey},
};
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fs,
    os::unix::{
        ffi::OsStringExt,
        fs::{PermissionsExt, symlink},
    },
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const BINARY: &str = env!("CARGO_BIN_EXE_hepta-paper-state-authority-journal");
const TABLES: [&str; 6] = [
    "authority_metadata",
    "authority_database_head",
    "authority_schema_transition",
    "authority_schema_rebind",
    "authority_mutation",
    "authority_backup_reservation",
];
static NEXT: AtomicU64 = AtomicU64::new(0);

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}
fn private_directory(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn private_file(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
struct Fixture {
    root: PathBuf,
    source: PathBuf,
    output: PathBuf,
    oracle: Value,
    daemon_hash: String,
    online_hash: String,
    public: VerifyingKey,
}
impl Fixture {
    fn node(scenario: &str) -> Self {
        let root = PathBuf::from(format!(
            "/tmp/hepta-journal-cli-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        private_directory(&root);
        let source = root.join("source");
        private_directory(&source);
        let output_parent = root.join("offline-artifacts");
        private_directory(&output_parent);
        let service = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let output = Command::new("node")
            .arg(service.join("src/local_state_authority/migration/offline_image/oracle.mjs"))
            .arg(service.ancestors().nth(3).unwrap())
            .arg(&source)
            .arg(scenario)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&oracle["profile"]).unwrap();
        let public =
            VerifyingKey::from_public_key_pem(oracle["publicKeyPem"].as_str().unwrap()).unwrap();
        let daemon_hash = digest(&fs::read(source.join("configuration.json")).unwrap());
        let mut fixture = Self {
            root,
            source,
            output: output_parent.join("bundle"),
            oracle,
            daemon_hash,
            online_hash: String::new(),
            public,
        };
        fixture.pin_public(public);
        // The actual Node signing key created the fixture, but neither command
        // needs to read a private key or generate a signature.
        fs::remove_file(fixture.source.join("fixture-key.pem")).unwrap();
        fixture
    }
    fn pin_public(&mut self, public: VerifyingKey) {
        let configuration = &self.oracle["configuration"];
        let document = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityPublicKey",
            "authorityId":configuration["authorityId"],"keyId":configuration["keyId"],
            "algorithm":"ed25519","publicKeyPem":public.to_public_key_pem(Default::default()).unwrap()});
        let public_path = self.source.join("public-key.json");
        let bytes = serde_json::to_vec(&document).unwrap();
        private_file(&public_path, &bytes);
        let mut online = configuration.as_object().unwrap().clone();
        for key in ["privateKeyPath", "stateDatabasePath", "socketPath"] {
            online.remove(key);
        }
        online.insert(
            "kind".into(),
            json!("AutonomousResearchOnlineMutationAuthorityConfiguration"),
        );
        online.insert("publicKeyPath".into(), json!(public_path));
        online.insert("publicKeySha256".into(), json!(digest(&bytes)));
        let bytes = serde_json::to_vec(&online).unwrap();
        private_file(&self.source.join("online.json"), &bytes);
        self.online_hash = digest(&bytes);
    }
    fn database(&self) -> PathBuf {
        PathBuf::from(
            self.oracle["configuration"]["stateDatabasePath"]
                .as_str()
                .unwrap(),
        )
    }
    fn arguments(&self, export: bool) -> Vec<String> {
        let mut arguments = vec![
            if export {
                "export-native-image"
            } else {
                "inspect"
            }
            .into(),
            "--daemon-configuration".into(),
            self.source.join("configuration.json").display().to_string(),
            "--daemon-configuration-sha256".into(),
            self.daemon_hash.clone(),
            "--online-configuration".into(),
            self.source.join("online.json").display().to_string(),
            "--online-configuration-sha256".into(),
            self.online_hash.clone(),
        ];
        if export {
            arguments.extend([
                "--output-directory".into(),
                self.output.display().to_string(),
            ]);
        }
        arguments
    }
    fn run(&self, export: bool) -> Output {
        Command::new(BINARY)
            .args(self.arguments(export))
            .output()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    serde_json::from_slice(&output.stdout).unwrap()
}
fn failure(output: Output) -> Value {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert!(error["code"].is_string());
    assert!(error.get("details").is_some());
    for field in [
        "retryable",
        "stateRecoverabilityFatal",
        "stateRecoverabilityDeferred",
    ] {
        assert!(error[field].is_boolean(), "{error}");
    }
    error
}
fn rows(db: &Connection) -> Vec<Vec<Vec<Value>>> {
    TABLES
        .iter()
        .map(|table| {
            let mut statement = db
                .prepare(&format!("SELECT rowid,* FROM main.{table} ORDER BY rowid"))
                .unwrap();
            let columns = statement.column_count();
            statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|index| {
                            Ok(match row.get_ref(index)? {
                                ValueRef::Null => Value::Null,
                                ValueRef::Integer(value) => json!(value),
                                ValueRef::Text(value) => json!(std::str::from_utf8(value).unwrap()),
                                _ => panic!("unexpected fixture SQL storage type"),
                            })
                        })
                        .collect::<rusqlite::Result<Vec<Value>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        })
        .collect()
}
fn snapshot(path: &Path) -> Vec<Vec<Vec<Value>>> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    db.execute_batch("BEGIN DEFERRED").unwrap();
    let result = rows(&db);
    db.execute_batch("ROLLBACK").unwrap();
    db.close().unwrap();
    result
}
fn catalog(db: &Connection) -> Vec<(String, String, String, Option<String>)> {
    db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

#[test]
fn help_parses_every_argument_before_source_io_and_binary_refuses_non_utf8() {
    let valid_hash = digest(b"nonexistent inputs");
    let output = Command::new(BINARY)
        .args([
            "inspect",
            "--help",
            "--daemon-configuration=/definitely-absent-hepta/config.json",
            &format!("--daemon-configuration-sha256={valid_hash}"),
            "--online-configuration=/definitely-absent-hepta/online.json",
            &format!("--online-configuration-sha256={valid_hash}"),
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .starts_with("Usage: hepta-paper-state-authority-journal ")
    );
    for arguments in [
        vec![],
        vec!["--help", "--unknown"],
        vec!["--help", "--help"],
        vec!["--help=true"],
        vec!["inspect", "--help", "--"],
        vec!["inspect", "extra", "--help"],
        vec!["inspect", "--daemon-configuration=", "--help"],
        vec!["--help", "--daemon-configuration", "relative/path"],
        vec!["--help", "--daemon-configuration", "/tmp/../secret"],
        vec!["--help", "--daemon-configuration", "/tmp//secret"],
        vec!["--help", "--online-configuration-sha256=invalid"],
        vec![
            "--help",
            "--daemon-configuration=/absent",
            "--daemon-configuration=/absent",
        ],
        vec![
            "--help",
            "--daemon-configuration",
            "--online-configuration=/absent",
        ],
        vec!["inspect", "--help", "--output-directory=/absent"],
        vec!["export-native-image"],
    ] {
        let error = failure(Command::new(BINARY).args(&arguments).output().unwrap());
        assert!(
            error["code"]
                .as_str()
                .unwrap()
                .starts_with("local_authority_journal_cli_"),
            "{arguments:?}: {error}"
        );
    }
    let error = failure(
        Command::new(BINARY)
            .arg("--help")
            .arg(OsString::from_vec(vec![0xff]))
            .output()
            .unwrap(),
    );
    assert_eq!(
        error["code"],
        "local_authority_journal_cli_argument_not_utf8"
    );
    assert_eq!(error["details"]["argumentIndex"], 1);
}

#[test]
fn actual_inspect_and_detached_export_preserve_all_native_schema_and_raw_history() {
    for scenario in ["uninitialized", "rebind2", "aborted-tail"] {
        let fixture = Fixture::node(scenario);
        let original_rows = snapshot(&fixture.database());
        let original_bytes = fs::read(fixture.database()).unwrap();
        let inspected = success(fixture.run(false));
        assert_eq!(
            inspected["kind"],
            "HeptaLocalStateAuthorityNamedJournalObservationV1"
        );
        assert_eq!(
            inspected["evidenceScope"],
            "named_source_snapshot_no_maintenance_authority"
        );
        assert_eq!(inspected["sourceConnectionClosed"], true);
        assert_eq!(inspected["sourceLogicalDataWritten"], false);
        assert_eq!(inspected["sourcePath"], json!(fixture.database()));
        assert!(!fixture.output.exists());
        // Exercise the documented --key=value spelling on the real export path.
        let arguments = fixture.arguments(true);
        let inline: Vec<String> = std::iter::once(arguments[0].clone())
            .chain(
                arguments[1..]
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| format!("{}={}", pair[0], pair[1])),
            )
            .collect();
        let exported = success(Command::new(BINARY).args(inline).output().unwrap());
        assert_eq!(
            exported["kind"],
            "HeptaLocalStateAuthorityOfflineNativeImagePublicationV1"
        );
        assert_eq!(
            exported["evidenceScope"],
            "offline_artifact_no_live_migration_authority"
        );
        assert_eq!(exported["publicationCommitted"], true);
        assert_eq!(exported["outputPath"], json!(fixture.output));
        let image_path = fixture.output.join("authority.sqlite");
        let report_path = fixture.output.join("report.json");
        assert_eq!(exported["imagePath"], json!(image_path));
        assert_eq!(exported["reportPath"], json!(report_path));
        let image_bytes = fs::read(&image_path).unwrap();
        let report_bytes = fs::read(&report_path).unwrap();
        assert_eq!(exported["imageSha256"], digest(&image_bytes));
        assert_eq!(exported["reportSha256"], digest(&report_bytes));
        assert_eq!(exported["imageByteLength"], image_bytes.len());
        assert_eq!(exported["reportByteLength"], report_bytes.len());
        let bundle: Value = serde_json::from_slice(&report_bytes).unwrap();
        assert_eq!(
            bundle["kind"],
            "HeptaLocalStateAuthorityOfflineNativeImageBundleV1"
        );
        assert_eq!(
            bundle["evidenceScope"],
            "offline_artifact_no_migration_or_publication_authority"
        );
        assert_eq!(bundle["sourceNamespaceObservation"], inspected);
        assert_eq!(
            bundle["image"]["evidenceScope"],
            "offline_native_image_no_publication_authority"
        );
        assert_eq!(
            bundle["image"]["sourceLogicalHash"],
            inspected["history"]["sourceLogicalHash"]
        );
        assert_eq!(
            bundle["image"]["nativeLogicalHash"],
            inspected["history"]["sourceLogicalHash"]
        );
        assert_eq!(bundle["image"]["imageSha256"], digest(&image_bytes));
        assert_eq!(&image_bytes[..16], b"SQLite format 3\0");
        assert_eq!(image_bytes[18..20], [1, 1]);
        let image =
            Connection::open_with_flags(&image_path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(
            image
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            image
                .query_row(
                    "SELECT key_hash FROM authority_native_identity WHERE singleton=1",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            digest(fixture.public.as_bytes())
        );
        assert_eq!(
            image
                .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(rows(&image), original_rows);
        let reference = Connection::open_in_memory().unwrap();
        reference
            .execute_batch(include_str!("../src/local_state_authority/schema.sql"))
            .unwrap();
        assert_eq!(catalog(&image), catalog(&reference));
        reference.close().unwrap();
        image.close().unwrap();
        assert_eq!(fs::read(fixture.database()).unwrap(), original_bytes);
        assert_eq!(snapshot(&fixture.database()), original_rows);
        assert!(!fixture.source.join("fixture-key.pem").exists());
    }
}

#[test]
fn repeated_export_refuses_existing_bundle_and_preserves_sentinel_and_error_details() {
    let fixture = Fixture::node("genesis");
    success(fixture.run(true));
    let sentinel = fixture.output.join("do-not-replace");
    private_file(&sentinel, b"existing user artifact\n");
    let image = fs::read(fixture.output.join("authority.sqlite")).unwrap();
    let report = fs::read(fixture.output.join("report.json")).unwrap();
    let original = fs::read(fixture.database()).unwrap();
    let error = failure(fixture.run(true));
    assert_eq!(error["details"]["publicationCommitted"], false);
    assert_eq!(error["details"]["outputPath"], json!(fixture.output));
    assert_eq!(fs::read(sentinel).unwrap(), b"existing user artifact\n");
    assert_eq!(
        fs::read(fixture.output.join("authority.sqlite")).unwrap(),
        image
    );
    assert_eq!(
        fs::read(fixture.output.join("report.json")).unwrap(),
        report
    );
    assert_eq!(fs::read(fixture.database()).unwrap(), original);
}

#[test]
fn wrong_pins_and_actual_wrong_public_key_never_produce_an_artifact() {
    let mut fixture = Fixture::node("genesis");
    let original = fs::read(fixture.database()).unwrap();
    for index in [4, 8] {
        let mut arguments = fixture.arguments(true);
        arguments[index] = digest(b"wrong pin");
        failure(Command::new(BINARY).args(arguments).output().unwrap());
        assert!(!fixture.output.exists());
        assert_eq!(fs::read(fixture.database()).unwrap(), original);
    }
    fixture.pin_public(SigningKey::from_bytes(&[91; 32]).verifying_key());
    failure(fixture.run(true));
    assert!(!fixture.output.exists());
    assert_eq!(fs::read(fixture.database()).unwrap(), original);
}

#[test]
fn pending_and_unqualified_backup_histories_are_refused_without_source_changes() {
    for scenario in [
        "pending-mutation",
        "pending-schema",
        "pending-rebind",
        "unactivated-rebind",
        "completed-backup",
    ] {
        let fixture = Fixture::node(scenario);
        let original_rows = snapshot(&fixture.database());
        let original = fs::read(fixture.database()).unwrap();
        failure(fixture.run(false));
        failure(fixture.run(true));
        assert!(!fixture.output.exists());
        assert_eq!(fs::read(fixture.database()).unwrap(), original);
        assert_eq!(snapshot(&fixture.database()), original_rows);
    }
}

#[test]
fn source_file_and_ancestor_symlinks_are_refused_without_following_for_export() {
    let fixture = Fixture::node("genesis");
    let original = fs::read(fixture.database()).unwrap();
    let retained = fixture.source.join("retained-source.sqlite");
    fs::rename(fixture.database(), &retained).unwrap();
    symlink(&retained, fixture.database()).unwrap();
    failure(fixture.run(true));
    assert!(!fixture.output.exists());
    assert_eq!(fs::read(&retained).unwrap(), original);
    fs::remove_file(fixture.database()).unwrap();
    fs::rename(&retained, fixture.database()).unwrap();
    let displaced = fixture.root.join("retained-source-root");
    fs::rename(&fixture.source, &displaced).unwrap();
    symlink(&displaced, &fixture.source).unwrap();
    failure(fixture.run(true));
    assert!(!fixture.output.exists());
    assert_eq!(
        fs::read(displaced.join("authority.sqlite")).unwrap(),
        original
    );
    // Restore the actual namespace only after the binary exited.
    fs::remove_file(&fixture.source).unwrap();
    fs::rename(displaced, &fixture.source).unwrap();
}
