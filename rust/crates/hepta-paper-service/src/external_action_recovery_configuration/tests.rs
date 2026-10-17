use super::*;
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};
use std::{
    fs::{self, DirBuilder, File, FileTimes, OpenOptions, Permissions},
    io::Write,
    os::unix::fs::{
        DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt, symlink,
    },
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};

const CHANGED: &str =
    "autonomous_research_supervisor_external_action_recovery_configuration_changed";
const JSON_UNSUPPORTED: &str =
    "autonomous_research_supervisor_external_action_recovery_json_profile_unsupported";
const FIFO_ENV: &str = "HEPTA_RECOVERY_CONFIGURATION_OWNED_FIFO_TEST";

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let parent = fs::canonicalize(std::env::temp_dir()).expect("actual temporary directory");
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).expect("owned fixture entropy");
        let root = parent.join(format!(
            "hepta-recovery-inspection-{}-{}",
            std::process::id(),
            hex::encode(nonce)
        ));
        Self::directory(&root);
        Self { root }
    }
    fn directory(path: &Path) {
        DirBuilder::new()
            .mode(0o700)
            .create(path)
            .expect("new owned directory");
        fs::set_permissions(path, Permissions::from_mode(0o700)).expect("exact private mode");
    }
    fn write(path: &Path, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .expect("new owned file");
        file.set_permissions(Permissions::from_mode(0o600))
            .expect("exact leaf mode");
        file.write_all(bytes).expect("owned file bytes");
    }
    fn config(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.root.join(name);
        Self::write(&path, bytes);
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn capture_error(path: &Path) -> String {
    match files::ObservedConfiguration::capture(path) {
        Ok(_) => panic!("unsafe owned fixture unexpectedly accepted"),
        Err(error) => error,
    }
}

#[test]
fn file_capture_enforces_actual_bounds_mode_links_and_type() {
    let fixture = Fixture::new();
    let minimum = fixture.config("minimum.json", b"{}");
    let held = files::ObservedConfiguration::capture(&minimum).expect("two-byte minimum");
    assert_eq!(held.bytes(), b"{}");
    held.assert_current().expect("unchanged actual file");
    drop(held);
    let maximum = fixture.config("maximum.json", &vec![b' '; 256 * 1024]);
    let held = files::ObservedConfiguration::capture(&maximum).expect("inclusive byte ceiling");
    assert_eq!(held.bytes().len(), 256 * 1024);
    drop(held);
    let excessive = fixture.config("excessive.json", &vec![b' '; 256 * 1024 + 1]);
    let tiny = fixture.config("tiny.json", b"0");
    for path in [&excessive, &tiny, &fixture.root] {
        assert_eq!(capture_error(path), INVALID);
    }
    for mode in [0o640, 0o604, 0o620] {
        fs::set_permissions(&minimum, Permissions::from_mode(mode)).expect("owned unsafe mode");
        assert_eq!(capture_error(&minimum), INVALID);
        assert_eq!(fs::read(&minimum).expect("unchanged bytes"), b"{}");
    }
    fs::set_permissions(&minimum, Permissions::from_mode(0o600)).expect("restore private mode");
    let alias = fixture.root.join("hardlink.json");
    fs::hard_link(&minimum, &alias).expect("owned hardlink");
    assert_eq!(capture_error(&minimum), INVALID);
    assert_eq!(capture_error(&alias), INVALID);
    fs::remove_file(alias).expect("remove owned alias");
    let link = fixture.root.join("symlink.json");
    symlink(&minimum, &link).expect("owned symlink");
    assert_eq!(capture_error(&link), INVALID);
    assert_eq!(fs::read(&minimum).expect("untouched symlink target"), b"{}");
}

#[test]
fn retained_file_refuses_same_inode_content_and_metadata_drift() {
    let fixture = Fixture::new();
    let path = fixture.config("config.json", br#"{"value":1}"#);
    let held = files::ObservedConfiguration::capture(&path).expect("retain actual file");
    let before = fs::metadata(&path).expect("original metadata");
    let mut writer = OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("owned original inode");
    writer
        .write_all(br#"{"value":2}"#)
        .expect("same-size overwrite");
    writer
        .set_times(FileTimes::new().set_modified(before.modified().expect("original mtime")))
        .expect("restore original mtime");
    drop(writer);
    let after = fs::metadata(&path).expect("modified metadata");
    assert_eq!(
        (before.dev(), before.ino(), before.len()),
        (after.dev(), after.ino(), after.len())
    );
    assert_eq!(
        before.modified().expect("original mtime"),
        after.modified().expect("restored mtime")
    );
    assert_eq!(held.assert_current(), Err(CHANGED.to_owned()));
    assert_eq!(held.bytes(), br#"{"value":1}"#);
    assert_eq!(
        fs::read(&path).expect("new bytes remain"),
        br#"{"value":2}"#
    );
    drop(held);

    let held = files::ObservedConfiguration::capture(&path).expect("new completed observation");
    fs::set_permissions(&path, Permissions::from_mode(0o700))
        .expect("different still-private mode");
    assert_eq!(held.assert_current(), Err(CHANGED.to_owned()));
    drop(held);
    let held = files::ObservedConfiguration::capture(&path).expect("capture permitted 0700 mode");
    File::open(&path)
        .expect("owned leaf")
        .set_times(FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(123)))
        .expect("metadata-only mtime change");
    assert_eq!(held.assert_current(), Err(CHANGED.to_owned()));
    assert_eq!(
        fs::read(&path).expect("content unchanged by metadata check"),
        br#"{"value":2}"#
    );
}

#[test]
fn retained_file_refuses_leaf_and_parent_replacements_without_touching_either() {
    let fixture = Fixture::new();
    let path = fixture.config("config.json", b"{}");
    let held = files::ObservedConfiguration::capture(&path).expect("original leaf");
    let retired = fixture.root.join("retired.json");
    fs::rename(&path, &retired).expect("retire owned original leaf");
    Fixture::write(&path, b"[]");
    assert_eq!(held.assert_current(), Err(CHANGED.to_owned()));
    assert_eq!(fs::read(&retired).expect("original remains"), b"{}");
    assert_eq!(fs::read(&path).expect("replacement remains"), b"[]");
    drop(held);

    let parent = fixture.root.join("parent");
    Fixture::directory(&parent);
    let nested = parent.join("config.json");
    Fixture::write(&nested, b"{}");
    let held = files::ObservedConfiguration::capture(&nested).expect("original parent");
    let retired_parent = fixture.root.join("retired-parent");
    fs::rename(&parent, &retired_parent).expect("retire original parent");
    Fixture::directory(&parent);
    Fixture::write(&nested, b"[]");
    assert_eq!(held.assert_current(), Err(CHANGED.to_owned()));
    assert_eq!(
        fs::read(retired_parent.join("config.json")).expect("old parent content"),
        b"{}"
    );
    assert_eq!(fs::read(&nested).expect("new parent content"), b"[]");
}

#[test]
fn parent_symlink_is_rejected_both_at_capture_and_after_retention() {
    let fixture = Fixture::new();
    let parent = fixture.root.join("parent");
    Fixture::directory(&parent);
    let path = parent.join("config.json");
    Fixture::write(&path, b"{}");
    let held = files::ObservedConfiguration::capture(&path).expect("actual ancestor chain");
    let retired = fixture.root.join("retired-parent");
    fs::rename(&parent, &retired).expect("move actual owned ancestor");
    symlink(&retired, &parent).expect("replace ancestor with owned symlink");
    assert_eq!(held.assert_current(), Err(CHANGED.to_owned()));
    assert_eq!(capture_error(&path), INVALID);
    assert_eq!(
        fs::read(retired.join("config.json")).expect("target not modified"),
        b"{}"
    );
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
fn actual_fifo_refuses_without_a_writer_under_owned_process_deadline() {
    let fixture = Fixture::new();
    let path = fixture.root.join("config.fifo");
    nix::unistd::mkfifo(&path, nix::sys::stat::Mode::from_bits_truncate(0o600))
        .expect("owned FIFO with no writer");
    fs::set_permissions(&path, Permissions::from_mode(0o600)).expect("exact FIFO mode");
    let child_test = format!(
        "{}::fifo_capture_child",
        module_path!()
            .split_once("::")
            .expect("library module prefix")
            .1
    );
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().expect("actual test executable"))
            .args(["--exact", &child_test, "--ignored"])
            .env(FIFO_ENV, &path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("owned bounded helper"),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.0.try_wait().expect("poll owned helper") {
            assert!(status.success(), "FIFO helper refused incorrectly");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "FIFO capture blocked with no writer"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        fs::symlink_metadata(&path)
            .expect("FIFO retained")
            .file_type()
            .is_fifo()
    );
    assert_eq!(
        fs::read(path.with_extension("completed")).expect("helper actually ran its test"),
        b"capture refused owned FIFO\n"
    );
}
#[test]
#[ignore = "owned child invoked by the bounded FIFO parent test"]
fn fifo_capture_child() {
    let path = PathBuf::from(std::env::var_os(FIFO_ENV).expect("owned helper path"));
    assert_eq!(capture_error(&path), INVALID);
    Fixture::write(
        &path.with_extension("completed"),
        b"capture refused owned FIFO\n",
    );
}

#[test]
fn value_hash_coercion_retains_original_json_values_and_case_rules() {
    let digest = format!("sha256:{}", "ab".repeat(32));
    for value in [json!(digest), json!([digest]), json!([[digest]])] {
        assert!(sha(&value));
        let source = serde_json::to_vec(&json!({"value":value})).expect("fixture JSON");
        let parsed = Document::parse(&source).expect("representable JSON");
        assert_eq!(
            parsed.value["value"], value,
            "shape check must not normalize array to string"
        );
    }
    for value in [
        Value::Null,
        json!(false),
        json!(0),
        json!([]),
        json!([null]),
        json!({"hash":digest}),
        json!(digest.to_uppercase()),
        json!([digest, digest]),
    ] {
        assert!(!sha(&value));
    }
    assert!(!truthy(&json!(0)));
    assert!(!truthy(&json!("")));
    assert!(truthy(&json!([])));
    assert!(truthy(&json!({})));
    assert!(safe_id(&json!(["recovery-key"])));
    assert!(!safe_id(&json!(["recovery", "key"])));
}

#[test]
fn action_comparison_preserves_original_order_despite_equal_object_values() {
    let source = br#"{"actionConfigurationIdentityHashes":{"golden-release-attestor":"a","production-readiness":"b","provider-canary":"c"},"capabilityReceipt":{"actionConfigurationIdentityHashes":{"provider-canary":"c","production-readiness":"b","golden-release-attestor":"a"}}}"#;
    let parsed = Document::parse(source).expect("ordered source JSON");
    assert_eq!(
        parsed.value["actionConfigurationIdentityHashes"],
        parsed.value["capabilityReceipt"]["actionConfigurationIdentityHashes"]
    );
    assert!(
        !parsed
            .action_order_matches()
            .expect("original JSON.stringify comparison")
    );
    let source = br#"{"actionConfigurationIdentityHashes":{"golden-release-attestor":1.0,"production-readiness":-0.0,"provider-canary":[1e3]},"capabilityReceipt":{"actionConfigurationIdentityHashes":{"golden-release-attestor":1,"production-readiness":0,"provider-canary":[1000]}}}"#;
    assert!(
        Document::parse(source)
            .expect("different numeric spellings")
            .action_order_matches()
            .expect("equivalent Node number serialization")
    );
}

#[test]
fn json_number_projection_and_explicit_utf8_profile_boundaries() {
    let parsed = Document::parse(br#"{"version":1.0,"zero":-0.0,"rounded":9007199254740993}"#)
        .expect("Node number semantics");
    assert_eq!(
        parsed.value,
        json!({"version":1,"zero":0,"rounded":9_007_199_254_740_992u64})
    );
    for bytes in [
        &b"{\"value\":\"\xff\"}"[..],
        &br#"{"value":"\ud800"}"#[..],
        &br#"{"value":1e999}"#[..],
    ] {
        assert!(matches!(Document::parse(bytes), Err(error) if error == JSON_UNSUPPORTED));
    }
    assert!(matches!(Document::parse(b"{"), Err(error) if error == INVALID));
}

struct CapabilityFixture {
    key: SigningKey,
    pem: String,
    receipt: Value,
    trusted: Value,
    process: Value,
    configuration: Value,
    trust: Value,
    now: i64,
}
impl CapabilityFixture {
    fn new() -> Self {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).expect("ephemeral synthetic signing key");
        let key = SigningKey::from_bytes(&seed);
        let pem = key
            .verifying_key()
            .to_public_key_pem(Default::default())
            .expect("public SPKI PEM");
        let process =
            json!(hash("OwnedRecoveryTestProcess", &json!({"test":1})).expect("real domain hash"));
        let configuration = json!(
            hash("OwnedRecoveryTestConfiguration", &json!({"test":1})).expect("real domain hash")
        );
        let trust =
            json!(hash("OwnedRecoveryTestTrust", &json!({"test":1})).expect("real domain hash"));
        let signer = json!({"algorithm":"Ed25519","keyId":"owned-recovery-key","keyVersion":1,
            "organization":"owned-test","role":"autonomous-research-external-action-recovery-authority","subjectId":"owned-subject"});
        let mut trusted = signer.clone();
        trusted["effectiveFrom"] = json!("2026-01-01T00:00:00.000Z");
        trusted["expiresAt"] = json!("2027-01-01T00:00:00.000Z");
        trusted["revokedAt"] = Value::Null;
        let mut action_hashes = serde_json::Map::new();
        for action in ACTIONS {
            action_hashes.insert(
                action.into(),
                json!(
                    hash("OwnedRecoveryTestAction", &json!({"action":action}))
                        .expect("action hash")
                ),
            );
        }
        let receipt = json!({"version":1,"kind":"AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceipt",
            "status":"autonomous_research_supervisor_external_action_recovery_qualified","actionKinds":ACTIONS,
            "authoritativeSignedLookupSupported":true,"definitiveNotFoundSupported":true,"idempotentResumeSupported":true,
            "stableKeyContractId":"autonomous-research-supervisor-external-action-stable-key-v1",
            "processIdentityHash":process,"recoveryProcessConfigurationIdentityHash":configuration,"recoveryTrustIdentityHash":trust,
            "actionConfigurationIdentityHashes":action_hashes,"issuedAt":"2026-09-22T00:00:00.000Z","expiresAt":"2026-09-22T01:00:00.000Z","signer":signer});
        let now = canonical(&json!("2026-09-22T00:30:00.000Z")).expect("canonical fixture time");
        let mut fixture = Self {
            key,
            pem,
            receipt,
            trusted,
            process,
            configuration,
            trust,
            now,
        };
        fixture.sign();
        fixture
    }
    fn sign(&mut self) {
        let object = self.receipt.as_object_mut().expect("receipt object");
        object.remove("signature");
        object.remove("autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash");
        let payload_hash = hash(
            "AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptPayload",
            &self.receipt,
        )
        .expect("production payload hash");
        self.receipt["signature"] = json!(Base64::encode_string(
            &self.key.sign(payload_hash.as_bytes()).to_bytes()
        ));
        let receipt_hash = hash(
            "AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceipt",
            &self.receipt,
        )
        .expect("production receipt hash");
        self.receipt["autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash"] =
            json!(receipt_hash);
    }
    fn verify(&self, public_key: Option<&str>, now: i64) -> super::Result<bool> {
        capability::verify(
            &self.receipt,
            &self.trusted,
            public_key,
            &self.process,
            &self.configuration,
            &self.trust,
            now,
        )
    }
    fn set_signature_transport(&mut self, signature: &str) {
        self.receipt["signature"] = json!(signature);
        self.receipt
            .as_object_mut()
            .expect("receipt object")
            .remove("autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash");
        let receipt_hash = hash(
            "AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceipt",
            &self.receipt,
        )
        .expect("actual own hash after signature transport change");
        self.receipt["autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash"] =
            json!(receipt_hash);
    }
}

#[test]
fn private_capability_verifies_real_signature_and_detects_payload_and_signature_tampering() {
    let mut fixture = CapabilityFixture::new();
    assert_eq!(
        fixture.receipt.as_object().expect("receipt object").len(),
        17
    );
    assert_eq!(
        fixture.trusted.as_object().expect("trusted object").len(),
        9
    );
    assert_eq!(fixture.verify(Some(&fixture.pem), fixture.now), Ok(true));
    let original = fixture.receipt.clone();
    fixture.receipt["actionConfigurationIdentityHashes"]["provider-canary"] =
        json!(format!("sha256:{}", "01".repeat(32)));
    assert_eq!(fixture.verify(Some(&fixture.pem), fixture.now), Ok(false));
    fixture.receipt = original.clone();
    fixture.receipt["signature"] = json!(Base64::encode_string(&[0u8; 64]));
    let mut with_signature = fixture.receipt.clone();
    with_signature
        .as_object_mut()
        .expect("receipt object")
        .remove("autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash");
    fixture.receipt["autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash"] = json!(
        hash(
            "AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceipt",
            &with_signature
        )
        .expect("genuine new receipt hash")
    );
    assert_eq!(
        fixture.verify(Some(&fixture.pem), fixture.now),
        Ok(false),
        "rehashed bad signature must still fail"
    );
    fixture.receipt = original;
    assert_eq!(fixture.verify(Some(&fixture.pem), fixture.now), Ok(true));
}

#[test]
fn private_capability_rejects_each_real_v3_trust_shape_conflict_and_non_pem_input() {
    let mut fixture = CapabilityFixture::new();
    let original = fixture.trusted.clone();
    for (field, value) in [
        ("role", json!("research_execution_release_attestor")),
        ("algorithm", json!("ed25519")),
        ("keyVersion", json!("1")),
        ("status", json!("active")),
    ] {
        fixture.trusted = original.clone();
        fixture.trusted[field] = value;
        assert_eq!(
            fixture.verify(Some(&fixture.pem), fixture.now),
            Ok(false),
            "actual conflict field {field}"
        );
    }
    fixture.trusted = original;
    assert_eq!(
        fixture.verify(None, fixture.now),
        Ok(false),
        "actual V3 KeyObject is not a string PEM"
    );
    assert_eq!(
        fixture.verify(Some(&fixture.pem), fixture.now),
        Ok(true),
        "control remains genuinely valid"
    );
}

#[test]
fn private_capability_preserves_node_utf16_low_byte_base64_transport() {
    let mut fixture = CapabilityFixture::new();
    let original = fixture.receipt["signature"]
        .as_str()
        .expect("actual ASCII signature")
        .to_owned();
    assert!(original.is_ascii());
    // Qualified Node 22.23.1 decodes QUJDRA== and U+0151/U+0100 variants
    // to the same 41424344 bytes. Here transport changes surround a REAL
    // signature; the receipt hash is recomputed, but the payload stays intact.
    let mapped = original
        .bytes()
        .map(|byte| char::from_u32(u32::from(byte) + 0x100).expect("valid mapped scalar"))
        .collect::<String>();
    fixture.set_signature_transport(&mapped);
    assert_eq!(fixture.verify(Some(&fixture.pem), fixture.now), Ok(true));
    fixture.set_signature_transport(&format!("\u{0100}{original}"));
    assert_eq!(fixture.verify(Some(&fixture.pem), fixture.now), Ok(true));

    // One valid scalar encodes as two surrogate code units whose low bytes
    // are the original first two base64 symbols. Iterating UTF-8 bytes or
    // scalar values would silently change those two meaningful symbols.
    let bytes = original.as_bytes();
    let mut paired =
        String::from_utf16(&[0xd800 | u16::from(bytes[0]), 0xdc00 | u16::from(bytes[1])])
            .expect("paired synthetic transport scalar");
    paired.push_str(original.get(2..).expect("remaining ASCII transport"));
    fixture.set_signature_transport(&paired);
    assert_eq!(fixture.verify(Some(&fixture.pem), fixture.now), Ok(true));
    fixture.set_signature_transport(&format!("\u{013d}{original}"));
    assert_eq!(
        fixture.verify(Some(&fixture.pem), fixture.now),
        Ok(false),
        "Node low-byte equals terminates decoding"
    );
    fixture.set_signature_transport(&original);
    assert_eq!(fixture.verify(Some(&fixture.pem), fixture.now), Ok(true));
}

#[test]
fn private_capability_applies_exact_time_boundaries_and_keeps_invalid_clock_precedence() {
    let mut fixture = CapabilityFixture::new();
    let issued = canonical(&fixture.receipt["issuedAt"]).expect("issued time");
    let expires = canonical(&fixture.receipt["expiresAt"]).expect("expiry time");
    assert_eq!(fixture.verify(Some(&fixture.pem), issued), Ok(true));
    assert_eq!(fixture.verify(Some(&fixture.pem), issued - 1), Ok(false));
    assert_eq!(fixture.verify(Some(&fixture.pem), expires - 1), Ok(true));
    assert_eq!(fixture.verify(Some(&fixture.pem), expires), Ok(false));
    fixture.trusted["effectiveFrom"] = fixture.receipt["issuedAt"].clone();
    assert_eq!(fixture.verify(Some(&fixture.pem), fixture.now), Ok(true));
    fixture.trusted["expiresAt"] = fixture.receipt["issuedAt"].clone();
    assert_eq!(fixture.verify(Some(&fixture.pem), fixture.now), Ok(false));
    assert_eq!(
        fixture.verify(Some(&fixture.pem), i64::MAX),
        Err("Invalid time value".to_owned())
    );
    fixture.receipt["version"] = json!(2);
    assert_eq!(
        fixture.verify(Some(&fixture.pem), i64::MAX),
        Ok(false),
        "earlier structure rejection short-circuits invalid Date"
    );
}
