//! Actual descriptors and ELF files, never manufactured deployment authority.
use super::*;
use crate::state_backup_authority::{
    PinnedStateBackupAuthorityV1, ProcessStateBackupAuthorityTransportV1,
    StateBackupAuthorityTransportV1,
};
use ed25519_dalek::{
    SigningKey,
    pkcs8::{EncodePublicKey, spki::der::pem::LineEnding},
};
use rusqlite::{Connection, ErrorCode};
use std::{os::unix::fs::PermissionsExt, sync::atomic::AtomicU64};

static NEXT: AtomicU64 = AtomicU64::new(0);
type Online = PinnedMutationAuthorityV1<ProcessMutationAuthorityTransportV1>;
type Backup = PinnedStateBackupAuthorityV1<ProcessStateBackupAuthorityTransportV1>;
struct Fixture {
    root: PathBuf,
    command: PathBuf,
    command_hash: Sha256Digest,
    online_process: PathBuf,
    online_pin: String,
    backup_process: PathBuf,
    backup_pin: String,
}
fn write(path: &Path, bytes: &[u8], mode: u32) -> String {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    hash_bytes(bytes)
}
fn document(root: &Path, name: &str, value: Value) -> (PathBuf, String) {
    let path = root.join(name);
    let hash = write(&path, &serde_json::to_vec(&value).unwrap(), 0o600);
    (path, hash)
}
impl Fixture {
    fn new(local: Option<&[u8]>) -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-native-authority-command-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let command = if let Some(bytes) = local {
            let path = root.join("command");
            write(&path, bytes, 0o700);
            path
        } else {
            // This is an actual installed root-owned ELF, not a reviewed
            // authority adapter and not a complete production deployment.
            PathBuf::from("/usr/bin/true")
        };
        let command_hash: Sha256Digest = hash_bytes(&fs::read(&command).unwrap()).parse().unwrap();
        let key = SigningKey::from_bytes(&[113; 32])
            .verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        let (online_key, online_key_hash) = document(
            &root,
            "online-key.json",
            json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityPublicKey","authorityId":"authority:native-command-fixture","keyId":"key:native-command-fixture","algorithm":"ed25519","publicKeyPem":key}),
        );
        let (online_configuration, online_configuration_hash) = document(
            &root,
            "online-configuration.json",
            json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityConfiguration","authorityId":"authority:native-command-fixture","keyId":"key:native-command-fixture","scopeId":"scope:native-command-fixture","databaseScopeHash":hash_bytes(b"database-scope"),"writerManifestHash":hash_bytes(b"writer-manifest"),"publicKeyPath":online_key,"publicKeySha256":online_key_hash,"maximumReservationLeaseMs":60000,"maximumObservationAgeMs":60000}),
        );
        let (online_process, online_pin) = document(
            &root,
            "online-process.json",
            json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityProcessConfiguration","authorityConfigurationPath":online_configuration,"authorityConfigurationSha256":online_configuration_hash,"commandPath":command,"commandSha256":command_hash.as_str(),"fixedArguments":[],"timeoutMs":1000}),
        );
        let (backup_key, backup_key_hash) = document(
            &root,
            "backup-key.json",
            json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityPublicKey","authorityId":"backup:native-command-fixture","keyId":"key:native-command-fixture","algorithm":"ed25519","publicKeyPem":key}),
        );
        let (backup_process, backup_pin) = document(
            &root,
            "backup-process.json",
            json!({"version":2,"kind":"AutonomousResearchStateBackupAuthorityProcessConfiguration","authorityId":"backup:native-command-fixture","keyId":"key:native-command-fixture","commandPath":command,"commandSha256":command_hash.as_str(),"publicKeyPath":backup_key,"publicKeySha256":backup_key_hash,"fixedArguments":[],"timeoutMs":1000,"maximumReservationLeaseMs":60000,"maximumHeadObservationAgeMs":60000,"onlineMutationAuthorityConfigurationPath":online_configuration,"onlineMutationAuthorityConfigurationSha256":online_configuration_hash}),
        );
        Self {
            root,
            command,
            command_hash,
            online_process,
            online_pin,
            backup_process,
            backup_pin,
        }
    }
    fn clients(&self) -> (Online, Backup) {
        (
            Online::load_process(&self.online_process, &self.online_pin).unwrap(),
            Backup::load_process(&self.backup_process, &self.backup_pin).unwrap(),
        )
    }
    fn replace_fixture_script(&mut self, bytes: &[u8]) {
        assert!(self.command.starts_with(&self.root));
        self.command_hash = write(&self.command, bytes, 0o700).parse().unwrap();
        for (path, pin) in [
            (&self.online_process, &mut self.online_pin),
            (&self.backup_process, &mut self.backup_pin),
        ] {
            let mut value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            value["commandSha256"] = json!(self.command_hash.as_str());
            *pin = write(path, &serde_json::to_vec(&value).unwrap(), 0o600);
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn assert_native(fixture: &Fixture, online: &Online, backup: &Backup) {
    online
        .assert_native_process_command_v1(&fixture.command, &fixture.command_hash)
        .unwrap();
    backup
        .assert_native_process_command_v1(&fixture.command, &fixture.command_hash)
        .unwrap();
}

#[test]
fn actual_installed_elf_binds_both_commands_and_rejects_wrong_expected_identity() {
    let fixture = Fixture::new(None);
    let (online, backup) = fixture.clients();
    assert_native(&fixture, &online, &backup);
    let wrong_hash: Sha256Digest = hash_bytes(b"different-command").parse().unwrap();
    for (path, hash) in [
        (Path::new("/usr/bin/false"), &fixture.command_hash),
        (fixture.command.as_path(), &wrong_hash),
    ] {
        assert!(online.assert_native_process_command_v1(path, hash).is_err());
        assert!(backup.assert_native_process_command_v1(path, hash).is_err());
    }
}

#[test]
fn shebang_is_rejected_without_rpc_and_generic_process_protocol_is_unchanged() {
    let mut fixture = Fixture::new(Some(
        b"#!/bin/sh\ncat >/dev/null\nprintf '{\"fixture\":\"script\"}\\n'\n",
    ));
    let invoked = fixture.root.join("invoked");
    fixture.replace_fixture_script(format!("#!/bin/sh\ncat >/dev/null\nprintf invoked >> '{}'\nprintf '{{\"fixture\":\"script\"}}\\n'\n", invoked.display()).as_bytes());
    let (online, backup) = fixture.clients();
    assert_eq!(
        online
            .assert_native_process_command_v1(&fixture.command, &fixture.command_hash)
            .unwrap_err()
            .code,
        "autonomous_research_online_mutation_authority_native_command_invalid"
    );
    assert_eq!(
        backup
            .assert_native_process_command_v1(&fixture.command, &fixture.command_hash)
            .unwrap_err()
            .code,
        "autonomous_research_state_backup_authority_native_command_invalid"
    );
    assert!(
        !invoked.exists(),
        "native command rejection must not spawn the configured script"
    );
    // Generic transports still accept scripts and only return untrusted JSON.
    let mut online =
        ProcessMutationAuthorityTransportV1::load(&fixture.online_process, &fixture.online_pin)
            .unwrap();
    let mut backup =
        ProcessStateBackupAuthorityTransportV1::load(&fixture.backup_process, &fixture.backup_pin)
            .unwrap();
    assert_eq!(
        online.invoke(&json!({})).unwrap(),
        json!({"fixture":"script"})
    );
    assert_eq!(
        backup.invoke(&json!({})).unwrap(),
        json!({"fixture":"script"})
    );
    assert_eq!(fs::read(invoked).unwrap(), b"invokedinvoked");
}

#[test]
fn retained_configuration_and_public_key_staleness_is_not_hidden_by_elf_identity() {
    for name in [
        "online-process.json",
        "online-configuration.json",
        "online-key.json",
        "backup-process.json",
        "backup-key.json",
    ] {
        for replacement in [false, true] {
            let fixture = Fixture::new(None);
            let (online, backup) = fixture.clients();
            assert_native(&fixture, &online, &backup);
            let path = fixture.root.join(name);
            if replacement {
                let changed = fixture.root.join("replacement");
                write(&changed, &fs::read(&path).unwrap(), 0o600);
                fs::rename(changed, &path).unwrap();
            } else {
                fs::remove_file(&path).unwrap();
            }
            if !name.starts_with("backup-") {
                assert!(
                    online
                        .assert_native_process_command_v1(&fixture.command, &fixture.command_hash)
                        .is_err()
                );
            }
            if name != "online-process.json" {
                assert!(
                    backup
                        .assert_native_process_command_v1(&fixture.command, &fixture.command_hash)
                        .is_err()
                );
            }
        }
    }
}

fn probe(path: &Path) {
    let result = Command::new("/proc/self/exe")
        .args(["--exact", "sqlite_mutation_coordinator::authority::process::native_command::tests::native_command_sqlite_lock_probe_child", "--nocapture"])
        .env("HEPTA_NATIVE_COMMAND_LOCK_PROBE", path).output().unwrap();
    assert!(
        result.status.success(),
        "{} {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("native command SQLite lock held"));
}
#[test]
fn native_command_sqlite_lock_probe_child() {
    let Some(path) = std::env::var_os("HEPTA_NATIVE_COMMAND_LOCK_PROBE") else {
        return;
    };
    let db = Connection::open(path).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    assert_eq!(
        db.execute_batch("BEGIN IMMEDIATE")
            .unwrap_err()
            .sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy)
    );
    println!("native command SQLite lock held");
}
fn lock_case(wal: bool, command_alias: bool) {
    let elf = fs::read("/usr/bin/true").unwrap();
    let fixture = Fixture::new(command_alias.then_some(elf.as_slice()));
    let path = fixture.root.join("target.sqlite");
    let setup = Connection::open(&path).unwrap();
    setup.execute_batch(if wal {"PRAGMA journal_mode=WAL; CREATE TABLE data(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO data VALUES(1,'before');"} else {"PRAGMA journal_mode=DELETE; CREATE TABLE data(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO data VALUES(1,'before');"}).unwrap();
    setup.close().unwrap();
    let (online, backup) = fixture.clients();
    if command_alias {
        // The actual user-owned ELF exercises only the local format/FD core.
        // It deliberately cannot satisfy root-owned production installation.
        online
            .transport
            .command
            .assert_held_elf_identity(
                &fixture.command,
                &fixture.command_hash,
                "local_elf_fixture_invalid",
            )
            .unwrap();
        assert!(
            online
                .assert_native_process_command_v1(&fixture.command, &fixture.command_hash)
                .is_err()
        );
        assert!(
            backup
                .assert_native_process_command_v1(&fixture.command, &fixture.command_hash)
                .is_err()
        );
    } else {
        assert_native(&fixture, &online, &backup);
    }
    // Every snapshot and raw descriptor precedes this actual owning handle.
    let db = Connection::open(&path).unwrap();
    db.execute_batch("BEGIN IMMEDIATE; UPDATE data SET value='staged' WHERE id=1")
        .unwrap();
    if !command_alias {
        assert_native(&fixture, &online, &backup);
    }
    probe(&path);
    let replaced = if command_alias {
        fixture.command.clone()
    } else {
        fixture.root.join("online-configuration.json")
    };
    fs::rename(&replaced, fixture.root.join("original-input")).unwrap();
    // WAL locks live on SHM; the DELETE case uses the main inode. Either alias
    // would expose a raw-open/close bug in the same process's retained checker.
    let locked_inode = if wal {
        path.with_extension("sqlite-shm")
    } else {
        path.clone()
    };
    fs::hard_link(&locked_inode, &replaced).unwrap();
    assert!(
        online
            .assert_native_process_command_v1(&fixture.command, &fixture.command_hash)
            .is_err()
    );
    assert!(
        backup
            .assert_native_process_command_v1(&fixture.command, &fixture.command_hash)
            .is_err()
    );
    probe(&path);
    db.execute_batch("ROLLBACK").unwrap();
    db.close().unwrap();
    drop(backup);
    drop(online);
}
#[test]
fn native_command_checks_keep_delete_and_wal_locks_when_configuration_aliases_target() {
    for wal in [false, true] {
        lock_case(wal, false);
    }
}
#[test]
fn command_path_hardlink_replacement_is_rejected_without_opening_live_database() {
    for wal in [false, true] {
        lock_case(wal, true);
    }
}
