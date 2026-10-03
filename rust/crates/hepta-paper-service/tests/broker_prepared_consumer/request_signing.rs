//! Ordinary service-entry request issuance. The protocol peer remains a fixture;
//! the request signer, private-key file, atomic publication and recovery rules are
//! the real service implementation.
use super::*;
use std::{io::ErrorKind, os::unix::fs::MetadataExt, process::Command};

fn configuration_file(fixture: &Fixture) -> std::path::PathBuf {
    let path = fixture.root.join("issued-service.json");
    fs::write(&path, serde_json::to_vec(&fixture.config).unwrap()).unwrap();
    path
}

fn remove_key(fixture: &Fixture) {
    let path = fixture.request_signer_key_path.as_ref().unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::remove_file(path).unwrap();
}

#[test]
fn ordinary_cli_issues_signed_request_commits_and_replays_without_key_or_ipc() {
    let fixture = Fixture::new_issued_execution();
    assert!(!fixture.request_path.exists());
    let config = configuration_file(&fixture);
    let peer = fixture.serve_issued_execution(fixture.listener(), OUTPUT, false);
    let first = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    let issued = peer.join().unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert_eq!(fixture.published_request(), issued);
    let metadata = fs::symlink_metadata(&fixture.request_path).unwrap();
    assert_eq!(metadata.mode() & 0o7777, 0o400);
    assert_eq!(metadata.uid(), nix::unistd::geteuid().as_raw());
    let first: serde_json::Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(first["commitReceipts"][0]["newlyCommitted"], true);

    fs::remove_file(&fixture.socket_path).unwrap();
    remove_key(&fixture);
    let replay = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    assert!(
        replay.status.success(),
        "{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    let replay: serde_json::Value = serde_json::from_slice(&replay.stdout).unwrap();
    assert_eq!(replay["commitReceipts"][0]["newlyCommitted"], false);
    assert_eq!(
        first["commitReceipts"][0]["resultHash"],
        replay["commitReceipts"][0]["resultHash"]
    );
}

#[test]
fn lost_execution_response_reuses_issued_request_and_queries_without_signing_key() {
    let mut fixture = Fixture::new_issued_execution();
    let config = configuration_file(&fixture);
    let peer = fixture.serve_issued_execution(fixture.listener(), OUTPUT, true);
    let first = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    let issued = peer.join().unwrap();
    assert!(!first.status.success());
    assert_eq!(fixture.published_request(), issued);
    assert_eq!(
        fs::read_dir(fixture.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        1
    );

    fs::remove_file(&fixture.socket_path).unwrap();
    remove_key(&fixture);
    fixture.request = issued;
    let recovery = fixture.serve(fixture.listener(), OUTPUT, false, false);
    let second = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    recovery.join().unwrap();
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    let second: serde_json::Value = serde_json::from_slice(&second.stdout).unwrap();
    assert_eq!(second["commitReceipts"][0]["newlyCommitted"], true);
}

#[test]
fn unsafe_private_key_is_rejected_before_request_publication_or_broker_ipc() {
    let fixture = Fixture::new_issued_execution();
    let key = fixture.request_signer_key_path.as_ref().unwrap();
    fs::set_permissions(key, fs::Permissions::from_mode(0o644)).unwrap();
    let config = configuration_file(&fixture);
    let listener = fixture.listener();
    listener.set_nonblocking(true).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(listener.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
    assert!(!fixture.request_path.exists());
    assert_eq!(
        fs::read_dir(fixture.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn recovery_never_remints_a_missing_request_after_execution_intent() {
    let fixture = Fixture::new_issued_execution();
    let config = configuration_file(&fixture);
    let peer = fixture.serve_issued_execution(fixture.listener(), OUTPUT, true);
    let first = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    peer.join().unwrap();
    assert!(!first.status.success());
    fs::remove_file(&fixture.socket_path).unwrap();
    fs::set_permissions(&fixture.request_path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::remove_file(&fixture.request_path).unwrap();

    let listener = fixture.listener();
    listener.set_nonblocking(true).unwrap();
    let recovery = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    assert!(!recovery.status.success());
    assert_eq!(listener.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
    assert!(!fixture.request_path.exists());
    assert_eq!(
        fs::read_dir(fixture.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn mismatched_private_key_is_rejected_before_request_or_broker_effect() {
    use ed25519_dalek::{
        SigningKey,
        pkcs8::{EncodePrivateKey, spki::der::pem::LineEnding},
    };

    let fixture = Fixture::new_issued_execution();
    let key = fixture.request_signer_key_path.as_ref().unwrap();
    let replacement = SigningKey::from_bytes(&[72; 32]);
    fs::write(
        key,
        replacement.to_pkcs8_pem(LineEnding::LF).unwrap().as_bytes(),
    )
    .unwrap();
    fs::set_permissions(key, fs::Permissions::from_mode(0o600)).unwrap();
    let config = configuration_file(&fixture);
    let listener = fixture.listener();
    listener.set_nonblocking(true).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(listener.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
    assert!(!fixture.request_path.exists());
    assert_eq!(
        fs::read_dir(fixture.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn aliased_pending_request_is_rejected_without_unlinking_or_broker_effect() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new_issued_execution();
    let target = fixture.root.join("attacker-owned-target");
    fs::write(&target, b"not a request").unwrap();
    let filename = fixture.request_path.file_name().unwrap().to_string_lossy();
    let pending = fixture
        .request_path
        .parent()
        .unwrap()
        .join(format!(".{filename}.pending"));
    symlink(&target, &pending).unwrap();
    let config = configuration_file(&fixture);
    let listener = fixture.listener();
    listener.set_nonblocking(true).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(listener.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
    assert!(
        fs::symlink_metadata(&pending)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read(target).unwrap(), b"not a request");
    assert!(!fixture.request_path.exists());
    assert_eq!(
        fs::read_dir(fixture.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn configured_signer_rejects_a_prepublished_request_from_another_key_before_ipc() {
    use base64ct::{Base64UrlUnpadded, Encoding};
    use ed25519_dalek::{Signer, SigningKey};
    use hepta_codex_broker::capability_signing_bytes;

    let fixture = Fixture::new_issued_execution();
    let mut request = fixture.request.clone();
    request.request_capability.signer_key_id = "other-request-key".into();
    request.request_capability.signature_base64 = "A".repeat(86);
    let other = SigningKey::from_bytes(&[78; 32]);
    request.request_capability.signature_base64 = Base64UrlUnpadded::encode_string(
        &other
            .sign(&capability_signing_bytes(&request).unwrap())
            .to_bytes(),
    );
    request.validate().unwrap();
    fixture.publish(&request);

    let config = configuration_file(&fixture);
    let listener = fixture.listener();
    listener.set_nonblocking(true).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("run")
        .arg(&config)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(listener.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
    assert_eq!(fixture.published_request(), request);
    assert_eq!(
        fs::read_dir(fixture.config.state_directory.join("attempts"))
            .unwrap()
            .count(),
        0
    );
}
