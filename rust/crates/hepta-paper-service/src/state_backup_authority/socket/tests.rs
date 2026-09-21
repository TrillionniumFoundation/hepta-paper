use super::*;
use crate::sqlite_mutation_coordinator::hash_bytes;
use ed25519_dalek::{SigningKey, pkcs8::EncodePublicKey};
use rusqlite::Connection;
use std::{
    ffi::OsString,
    fs,
    io::{Read, Write},
    os::unix::{ffi::OsStringExt, fs::PermissionsExt, net::UnixListener},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::Duration,
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    configuration: Value,
}
fn write(path: &Path, value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap();
    fs::write(path, &bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    hash_bytes(&bytes)
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-backup-socket-unit-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let public = SigningKey::from_bytes(&[61; 32])
            .verifying_key()
            .to_public_key_pem(Default::default())
            .unwrap();
        let online_public = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityPublicKey","authorityId":"authority:backup-socket","keyId":"key:backup-socket","algorithm":"ed25519","publicKeyPem":public});
        let online_public_hash = write(&root.join("online-public.json"), &online_public);
        let mut backup_public = online_public.clone();
        backup_public["kind"] = json!("AutonomousResearchStateBackupAuthorityPublicKey");
        let backup_public_hash = write(&root.join("backup-public.json"), &backup_public);
        let online = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityConfiguration","authorityId":online_public["authorityId"],"keyId":online_public["keyId"],"scopeId":"scope:backup-socket","databaseScopeHash":hash_bytes(b"scope"),"writerManifestHash":hash_bytes(b"writers"),"publicKeyPath":root.join("online-public.json"),"publicKeySha256":online_public_hash,"maximumReservationLeaseMs":60000,"maximumObservationAgeMs":30000});
        let online_hash = write(&root.join("online.json"), &online);
        let configuration = json!({"version":1,"kind":CONFIGURATION_KIND,"authorityId":online["authorityId"],"keyId":online["keyId"],"socketPath":root.join("authority.sock"),"timeoutMs":1000,"maximumMessageBytes":65536,"publicKeyPath":root.join("backup-public.json"),"publicKeySha256":backup_public_hash,"maximumReservationLeaseMs":60000,"maximumHeadObservationAgeMs":30000,"onlineMutationAuthorityConfigurationPath":root.join("online.json"),"onlineMutationAuthorityConfigurationSha256":online_hash});
        write(&root.join("socket.json"), &configuration);
        Self {
            root,
            configuration,
        }
    }
    fn load(&self) -> PinnedStateBackupAuthorityV1<LocalStateAuthoritySocketTransportV1> {
        PinnedStateBackupAuthorityV1::load_socket_v1(
            &self.root.join("socket.json"),
            &hash_bytes(&serde_json::to_vec(&self.configuration).unwrap()),
        )
        .unwrap()
    }
    fn listener(&self) -> UnixListener {
        UnixListener::bind(self.root.join("authority.sock")).unwrap()
    }
    fn request(&self) -> Value {
        json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityReserveRequest","inventoryHash":hash_bytes(b"inventory"),"databaseScopeHash":hash_bytes(b"scope"),"databaseInstanceIds":["instance:fixture"],"requestedAt":"2026-09-22T00:00:00.000Z","maximumLeaseMs":10000})
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn assert_only_empty_probe(listener: &UnixListener) {
    let (mut stream, _) = listener.accept().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    assert!(bytes.is_empty());
    listener.set_nonblocking(true).unwrap();
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn socket_configuration_has_closed_numeric_and_path_bounds_before_connect() {
    let fixture = Fixture::new();
    for (field, value) in [
        ("version", json!(2)),
        ("timeoutMs", json!(999)),
        ("timeoutMs", json!(120001)),
        ("maximumMessageBytes", json!(1023)),
        ("maximumMessageBytes", json!(268435457)),
        ("maximumMessageBytes", json!(2048.5)),
        ("maximumReservationLeaseMs", json!(900001)),
        ("maximumHeadObservationAgeMs", json!(999)),
        ("socketPath", json!("/")),
        ("socketPath", json!("/tmp//test.sock")),
        ("socketPath", json!("/tmp/./test.sock")),
        ("socketPath", json!("/tmp/../test.sock")),
        ("socketPath", json!("/tmp/test.sock/")),
        ("socketPath", json!("/tmp/a\u{0}b")),
        ("publicKeyPath", json!("relative")),
    ] {
        let mut configuration = fixture.configuration.clone();
        configuration[field] = value;
        let pin = write(&fixture.root.join("invalid.json"), &configuration);
        let result =
            PinnedStateBackupAuthorityV1::load_socket_v1(&fixture.root.join("invalid.json"), &pin);
        assert!(
            matches!(result, Err(e) if e.code == CONFIGURATION_INVALID),
            "field={field}"
        );
    }
    let invalid_path = PathBuf::from(OsString::from_vec(vec![b'/', b't', b'm', b'p', b'/', 0xff]));
    assert!(
        matches!(PinnedStateBackupAuthorityV1::load_socket_v1(&invalid_path, &hash_bytes(b"no file")), Err(e) if e.code == CONFIGURATION_INVALID)
    );
}

#[test]
fn every_retained_public_pin_is_checked_without_an_rpc() {
    for name in [
        "socket.json",
        "backup-public.json",
        "online.json",
        "online-public.json",
    ] {
        let fixture = Fixture::new();
        let listener = fixture.listener();
        let mut authority = fixture.load();
        authority.current().unwrap();
        fs::write(fixture.root.join(name), b"changed").unwrap();
        let failure = authority
            .reserve_snapshot(&fixture.request(), 1)
            .err()
            .unwrap();
        assert_eq!(
            failure.code,
            "autonomous_research_state_backup_authority_socket_inputs_changed"
        );
        assert_eq!(failure.details["requestBytesSent"], 0);
        assert_eq!(failure.details["authorityOutcome"], "not_invoked");
        assert_only_empty_probe(&listener);
    }
}

#[test]
fn pin_drift_after_a_response_preserves_unknown_outcome() {
    let fixture = Fixture::new();
    let listener = fixture.listener();
    let path = fixture.root.join("online-public.json");
    let server = thread::spawn(move || {
        let (mut probe, _) = listener.accept().unwrap();
        let mut bytes = Vec::new();
        probe.read_to_end(&mut bytes).unwrap();
        assert!(bytes.is_empty());
        let (mut stream, _) = listener.accept().unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        assert!(!bytes.is_empty());
        fs::write(path, b"changed after request").unwrap();
        stream.write_all(b"{\"ok\":true,\"receipt\":{}}\n").unwrap();
    });
    let mut authority = fixture.load();
    let failure = authority
        .reserve_snapshot(&fixture.request(), 1)
        .err()
        .unwrap();
    assert_eq!(
        failure.code,
        "autonomous_research_state_backup_authority_socket_inputs_changed"
    );
    assert_eq!(failure.details["authorityOutcome"], "unknown");
    assert_eq!(failure.details["requestDelivery"], "sent");
    assert_eq!(failure.details["inspectionRequired"], true);
    assert!(failure.details.get("requestBytesSent").is_none());
    assert!(failure.details.get("committed").is_none());
    assert!(!failure.retryable);
    server.join().unwrap();
}

#[test]
fn sqlite_lock_probe() {
    let Ok(path) = std::env::var("HEPTA_BACKUP_SOCKET_UNIT_LOCK_PATH") else {
        return;
    };
    let expected = std::env::var("HEPTA_BACKUP_SOCKET_UNIT_LOCK_EXPECTED").unwrap();
    let db = Connection::open(path).unwrap();
    db.busy_timeout(Duration::from_millis(30)).unwrap();
    match db.execute_batch("BEGIN IMMEDIATE") {
        Ok(()) => {
            assert_eq!(expected, "available");
            db.execute_batch("ROLLBACK").unwrap();
        }
        Err(error) => {
            assert_eq!(expected, "blocked");
            assert!(
                matches!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
                ),
                "{error}"
            );
        }
    }
    db.close().unwrap();
}
fn probe(path: &Path, expected: &str) {
    let output = Command::new("/proc/self/exe")
        .args([
            "--exact",
            "state_backup_authority::socket::tests::sqlite_lock_probe",
            "--nocapture",
        ])
        .env("HEPTA_BACKUP_SOCKET_UNIT_LOCK_PATH", path)
        .env("HEPTA_BACKUP_SOCKET_UNIT_LOCK_EXPECTED", expected)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn retained_pin_alias_rejection_preserves_real_delete_and_wal_writer_locks() {
    for mode in ["DELETE", "WAL"] {
        let aliases: &[&str] = if mode == "WAL" {
            &["main", "shm"]
        } else {
            &["main"]
        };
        for alias in aliases {
            for name in [
                "socket.json",
                "backup-public.json",
                "online.json",
                "online-public.json",
            ] {
                let fixture = Fixture::new();
                let database = fixture.root.join("target.sqlite");
                let seed = Connection::open(&database).unwrap();
                seed.execute_batch(&format!("PRAGMA journal_mode={mode}; CREATE TABLE value(v INTEGER); INSERT INTO value VALUES(1)")).unwrap();
                seed.close().unwrap();
                let listener = fixture.listener();
                // All regular descriptors precede the actual owning connection.
                let mut authority = fixture.load();
                let db = Connection::open(&database).unwrap();
                db.execute_batch("BEGIN IMMEDIATE; UPDATE value SET v=2")
                    .unwrap();
                probe(&database, "blocked");
                let source = if *alias == "shm" {
                    PathBuf::from(format!("{}-shm", database.display()))
                } else {
                    database.clone()
                };
                fs::rename(
                    fixture.root.join(name),
                    fixture.root.join(format!("original-{name}")),
                )
                .unwrap();
                fs::hard_link(&source, fixture.root.join(name)).unwrap();
                assert!(authority.current().is_err());
                let failure = authority
                    .reserve_snapshot(&fixture.request(), 1)
                    .err()
                    .unwrap();
                assert_eq!(failure.details["requestBytesSent"], 0);
                probe(&database, "blocked");
                assert_only_empty_probe(&listener);
                db.execute_batch("ROLLBACK").unwrap();
                probe(&database, "available");
                db.close().unwrap();
                // Never drop original raw evidence until SQLite has closed.
                drop(authority);
            }
        }
    }
}
