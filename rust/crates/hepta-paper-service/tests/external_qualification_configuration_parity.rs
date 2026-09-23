//! Actual original Node configuration identities, compared on the same owned
//! files. Fixture credentials are nonsecret text; no configured command runs.
#[allow(dead_code)]
mod machine_intake_support;
use hepta_paper_service::external_qualification_configuration::{
    inspect_external_research_qualification_process_configuration_v1 as inspect,
    read_external_research_qualification_process_configuration_v3 as read,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    config: Value,
    environment: BTreeMap<String, String>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-qualification-configuration-parity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            root.join(".owned-qualification-configuration-fixture"),
            "owned nonsecret fixture\n",
        )
        .unwrap();
        let value = oracle(&json!({"action":"setup","root":root}), &root);
        assert_eq!(value["inspectionShapeReady"], true);
        Self {
            root,
            config: value["config"].clone(),
            environment: serde_json::from_value(value["environment"].clone()).unwrap(),
        }
    }
    fn path(&self) -> PathBuf {
        self.root.join("configuration.json")
    }
    fn write(&self, config: &Value) {
        fs::write(self.path(), serde_json::to_vec(config).unwrap()).unwrap();
    }
    fn expected(&self) -> Value {
        oracle(
            &json!({"action":"inspect","root":self.root,"configPath":self.path(),"environment":self.environment}),
            &self.root,
        )
    }
    fn compare(&self, label: &str) -> Value {
        let before = snapshot(&self.root);
        let expected = self.expected();
        let actual = inspect(Some(&self.path()), &self.environment, &self.root);
        assert_eq!(actual, expected["inspection"], "inspection: {label}");
        match read(Some(&self.path()), &self.environment, &self.root) {
            Ok(configuration) => {
                assert!(expected["error"].is_null(), "{label}: {expected}");
                assert_eq!(
                    configuration.identity(),
                    &expected["identity"],
                    "reader: {label}"
                );
                assert_eq!(
                    configuration.inspection(),
                    &actual,
                    "owned inspection: {label}"
                );
                configuration
                    .assert_current()
                    .expect("current owned observation");
            }
            Err(_) => assert!(
                !expected["inspection"]["ready"].as_bool().unwrap(),
                "{label}: {expected}"
            ),
        }
        assert!(!self.root.join("executed-marker").exists());
        assert_eq!(
            snapshot(&self.root),
            before,
            "no observed source mutation: {label}"
        );
        expected
    }
}
fn snapshot(root: &Path) -> Vec<Value> {
    fn visit(path: &Path, entries: &mut Vec<Value>) {
        let metadata = fs::symlink_metadata(path).unwrap();
        let content = if metadata.file_type().is_symlink() {
            json!(fs::read_link(path).unwrap())
        } else if metadata.is_file() {
            json!(hex::encode(Sha256::digest(fs::read(path).unwrap())))
        } else {
            Value::Null
        };
        entries.push(json!({"path":path,"dev":metadata.dev(),"ino":metadata.ino(),"mode":metadata.mode(),"uid":metadata.uid(),"gid":metadata.gid(),"nlink":metadata.nlink(),"size":metadata.size(),"mtime":metadata.mtime(),"mtimeNsec":metadata.mtime_nsec(),"ctime":metadata.ctime(),"ctimeNsec":metadata.ctime_nsec(),"content":content}));
        if metadata.is_dir() {
            let mut children = fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            children.sort();
            for child in children {
                visit(&child, entries);
            }
        }
    }
    let mut entries = Vec::new();
    visit(root, &mut entries);
    entries
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn oracle(input: &Value, root: &Path) -> Value {
    let mut command = Command::new("node");
    command
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../oracle/external-qualification-configuration-v3.mjs"),
        )
        .arg(serde_json::to_string(input).unwrap())
        .current_dir(root)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").expect("qualified Node"))
        .env("LANG", "en_US.UTF-8");
    let output = machine_intake_support::run(&mut command);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&output["profile"]).unwrap();
    output["value"].clone()
}

#[test]
fn actual_complete_inspection_identity_and_path_precedence_match() {
    let mut fixture = Fixture::new();
    let expected = fixture.compare("actual valid V3");
    assert_eq!(expected["inspection"]["ready"], true);
    fixture.environment.insert(
        "HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG".into(),
        fixture.path().to_str().unwrap().into(),
    );
    let from_environment = read(None, &fixture.environment, &fixture.root).unwrap();
    assert_eq!(from_environment.identity(), &expected["identity"]);
    let relative = read(
        Some(Path::new("./configuration.json")),
        &fixture.environment,
        &fixture.root,
    )
    .unwrap();
    assert_eq!(relative.identity(), &expected["identity"]);
    fixture.environment.insert(
        "HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG".into(),
        fixture.root.join("missing.json").to_str().unwrap().into(),
    );
    fixture.compare("explicit path overrides environment");
    fixture.environment.clear();
    let expected = oracle(
        &json!({"action":"inspect","root":fixture.root,"configPath":null,"environment":{}}),
        &fixture.root,
    );
    assert_eq!(
        inspect(None, &fixture.environment, &fixture.root),
        expected["inspection"]
    );
}

#[test]
fn actual_configuration_command_number_and_shape_matrix_matches() {
    let fixture = Fixture::new();
    let cases = [
        ("/version", json!(2)),
        ("/version", json!(3.0)),
        ("/version", json!("3")),
        ("/status", json!("retiring")),
        ("/extra", json!(true)),
        ("/maximumQualificationCostUsd", json!(0)),
        ("/maximumQualificationCostUsd", json!(1000)),
        ("/maximumQualificationCostUsd", json!(1000.01)),
        ("/maximumQualificationCostUsd", json!("1")),
        ("/maximumQualificationCostUsd", json!(-1)),
        ("/qualifier/timeoutMs", json!("1000")),
        ("/qualifier/timeoutMs", json!([1000])),
        ("/qualifier/timeoutMs", json!("0x3e8")),
        ("/qualifier/timeoutMs", json!(300000)),
        ("/qualifier/timeoutMs", json!(999)),
        ("/qualifier/timeoutMs", json!(300001)),
        ("/qualifier/timeoutMs", json!(1000.5)),
        ("/qualifier/timeoutMs", Value::Null),
        ("/qualifier/serviceId", json!(123)),
        ("/qualifier/serviceId", json!(["valid-service"])),
        ("/qualifier/serviceId", json!("ab")),
        ("/qualifier/principalId", json!("invalid space")),
        (
            "/qualifier/environmentAllowlist",
            json!(["FIXTURE_ALLOWED", "PATH", "PATH"]),
        ),
        ("/qualifier/environmentAllowlist", json!(["lowercase"])),
        ("/qualifier/environmentAllowlist", Value::Null),
        (
            "/qualifier/environmentAllowlist",
            json!([["FIXTURE_ALLOWED"], ["FIXTURE_ALLOWED"]]),
        ),
        ("/qualifier/args", json!([1])),
        ("/qualifier/args", json!(vec!["x"; 65])),
        ("/qualifier/args", json!(["😀".repeat(2049)])),
        ("/qualifier/protocol", json!("another-protocol")),
    ];
    for (pointer, value) in cases {
        let mut config = fixture.config.clone();
        if pointer == "/extra" {
            config["extra"] = value;
        } else {
            *config.pointer_mut(pointer).unwrap() = value;
        }
        fixture.write(&config);
        fixture.compare(pointer);
    }
    let mut config = fixture.config.clone();
    config["maximumQualificationCostUsd"] = json!(0);
    config["qualificationCostAuthority"] = json!("externally_operated_zero_cost");
    fixture.write(&config);
    assert_eq!(
        fixture.compare("zero cost authority")["inspection"]["ready"],
        true
    );
    config["maximumQualificationCostUsd"] = json!(0.1);
    fixture.write(&config);
    assert_eq!(
        fixture.compare("nonzero external zero cost")["inspection"]["ready"],
        false
    );
}

#[test]
fn actual_signer_trust_order_schedule_and_independence_matrix_matches() {
    let fixture = Fixture::new();
    let cases = [
        ("/trustedSignerTrustSet/version", json!(1.0)),
        (
            "/trustedSignerTrustSet/keys/1/effectiveFrom",
            json!("0000-01-01T00:00:00.000Z"),
        ),
        (
            "/trustedSignerTrustSet/keys/1/expiresAt",
            json!("+010000-01-01T00:00:00.000Z"),
        ),
        (
            "/trustedSignerTrustSet/keys/1/expiresAt",
            json!("+275760-09-13T00:00:00.000Z"),
        ),
        ("/trustedSignerTrustSet/keys/0/keyVersion", json!(2)),
        (
            "/trustedSignerTrustSet/keys/0/keyId",
            json!("fixture-key_A"),
        ),
        ("/trustedSignerTrustSet/keys/0/status", json!("active")),
        (
            "/trustedSignerTrustSet/keys/0/revokedAt",
            json!("2026-08-01T00:00:00.000Z"),
        ),
        (
            "/trustedSignerTrustSet/keys/1/revokedAt",
            json!("2026-08-01T00:00:00.000Z"),
        ),
        ("/trustedSignerTrustSet/keys/1/algorithm", json!("Ed25519")),
        (
            "/trustedSignerTrustSet/keys/1/role",
            json!("unrelated_role"),
        ),
        (
            "/trustedSignerTrustSet/keys/1/effectiveFrom",
            json!("2026-01-01T00:00:00Z"),
        ),
        (
            "/trustedSignerTrustSet/keys/1/expiresAt",
            json!("2026-01-01T00:00:00.000Z"),
        ),
        ("/trustedSignerTrustSet/keys/1/organization", Value::Null),
        ("/verifierAttestor/status", json!("retiring")),
        ("/verifierAttestor/keyId", json!("fixture-key-a")),
        (
            "/verifierAttestor/subjectId",
            json!("fixture-release-subject"),
        ),
        (
            "/verifierAttestor/organization",
            json!("fixture  RELEASE office"),
        ),
        (
            "/verifierAttestor/organization",
            json!("Independent  Fixture Office"),
        ),
    ];
    for (pointer, value) in cases {
        let mut config = fixture.config.clone();
        *config.pointer_mut(pointer).unwrap() = value;
        fixture.write(&config);
        fixture.compare(pointer);
    }
    for pointer in [
        "/verifier/serviceId",
        "/verifier/principalId",
        "/verifier/executable",
        "/verifier/credentialRoot",
    ] {
        let mut config = fixture.config.clone();
        let replacement = config
            .pointer(&pointer.replace("/verifier/", "/qualifier/"))
            .unwrap()
            .clone();
        *config.pointer_mut(pointer).unwrap() = replacement;
        fixture.write(&config);
        assert_eq!(fixture.compare(pointer)["inspection"]["ready"], false);
    }
    for pointer in [
        "/verifierAttestor/publicKeyPath",
        "/trustedSignerTrustSet/keys/0/publicKeyPath",
    ] {
        let mut config = fixture.config.clone();
        *config.pointer_mut(pointer).unwrap() =
            config["trustedSignerTrustSet"]["keys"][1]["publicKeyPath"].clone();
        fixture.write(&config);
        assert_eq!(fixture.compare(pointer)["inspection"]["ready"], false);
    }
}

#[test]
fn actual_filtered_environment_and_content_changes_bind_identity() {
    let mut fixture = Fixture::new();
    let baseline = fixture.compare("baseline");
    fixture
        .environment
        .insert("FIXTURE_IGNORED".into(), "changed excluded value".into());
    assert_eq!(
        fixture.compare("excluded environment")["identity"],
        baseline["identity"]
    );
    fixture
        .environment
        .insert("FIXTURE_ALLOWED".into(), "changed included value".into());
    assert_ne!(
        fixture.compare("included environment")["identity"],
        baseline["identity"]
    );
    for path in [
        "qualifier-credentials/z.txt",
        "resource.txt",
        "qualifier.sh",
    ] {
        let old = read(Some(&fixture.path()), &fixture.environment, &fixture.root).unwrap();
        let target = fixture.root.join(path);
        let mut bytes = fs::read(&target).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        let inode = fs::metadata(&target).unwrap().ino();
        fs::write(&target, bytes).unwrap();
        assert_eq!(fs::metadata(&target).unwrap().ino(), inode);
        assert!(
            old.assert_current().is_err(),
            "same inode, same length changed {path}"
        );
        drop(old);
        assert_eq!(fixture.compare(path)["inspection"]["ready"], true);
    }
}

#[test]
fn actual_argument_interpreter_and_credential_file_refusals_match() {
    let fixture = Fixture::new();
    let resource = fixture.root.join("resource.txt");
    fs::rename(&resource, fixture.root.join("argument-target.txt")).unwrap();
    symlink("argument-target.txt", &resource).unwrap();
    assert_eq!(
        fixture.compare("Node follows argument symlink")["inspection"]["ready"],
        true
    );
    // The original interpreter reader observes /usr/bin/env and its resolved
    // PATH target; neither is launched by this test.
    fs::write(
        fixture.root.join("qualifier.sh"),
        "#!/usr/bin/env sh\n# changed qualifier\nexit 91\n",
    )
    .unwrap();
    assert_eq!(fixture.compare("env shebang")["inspection"]["ready"], true);
    fs::write(
        fixture.root.join("qualifier.sh"),
        "owned non-shebang executable bytes\n",
    )
    .unwrap();
    assert_eq!(fixture.compare("no shebang")["inspection"]["ready"], true);
    let q = fixture.root.join("qualifier-credentials/z.txt");
    fs::write(
        &q,
        fs::read(fixture.root.join("verifier-credentials/z.txt")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        fixture.compare("shared credential material")["inspection"]["ready"],
        false
    );
    fs::write(&q, "independent qualifier fixture").unwrap();
    fs::set_permissions(&q, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        fixture.compare("credential public mode")["inspection"]["ready"],
        false
    );
    fs::set_permissions(&q, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&q, fixture.root.join("credential-hardlink.txt")).unwrap();
    assert_eq!(
        fixture.compare("credential hard link")["inspection"]["ready"],
        false
    );
}

#[test]
fn actual_config_and_public_key_failures_match_without_executing_commands() {
    let fixture = Fixture::new();
    fs::write(fixture.path(), b"{invalid").unwrap();
    assert_eq!(
        fixture.compare("invalid JSON")["inspection"]["ready"],
        false
    );
    fixture.write(&fixture.config);
    fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(
        fixture.compare("writable configuration")["inspection"]["ready"],
        false
    );
    fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o600)).unwrap();
    for content in [
        "not a public key",
        "-----BEGIN PRIVATE KEY-----\nsynthetic non-key marker\n-----END PRIVATE KEY-----\n",
    ] {
        fs::write(fixture.root.join("release-public.pem"), content).unwrap();
        assert_eq!(
            fixture.compare("invalid or private PEM marker")["inspection"]["ready"],
            false
        );
    }
}

#[test]
fn retained_actual_files_detect_replacement_and_native_rejects_fifo() {
    let fixture = Fixture::new();
    let old = read(Some(&fixture.path()), &fixture.environment, &fixture.root).unwrap();
    let bytes = fs::read(fixture.path()).unwrap();
    fs::rename(
        fixture.path(),
        fixture.root.join("previous-configuration.json"),
    )
    .unwrap();
    fs::write(fixture.path(), bytes).unwrap();
    fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o600)).unwrap();
    assert!(old.assert_current().is_err());
    drop(old);
    fixture.compare("new valid replacement");
    let fifo = fixture.root.join("fifo.json");
    nix::unistd::mkfifo(
        &fifo,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    assert_eq!(
        inspect(Some(&fifo), &fixture.environment, &fixture.root)["ready"],
        false
    );
    assert!(!fixture.root.join("executed-marker").exists());
}

#[test]
fn actual_configuration_size_boundary_and_credential_namespace_drift() {
    let fixture = Fixture::new();
    let mut encoded = serde_json::to_vec(&fixture.config).unwrap();
    encoded.resize(256 * 1024, b' ');
    fs::write(fixture.path(), &encoded).unwrap();
    assert_eq!(
        fixture.compare("exact maximum config bytes")["inspection"]["ready"],
        true
    );
    encoded.push(b' ');
    fs::write(fixture.path(), &encoded).unwrap();
    assert_eq!(
        fixture.compare("over maximum config bytes")["inspection"]["ready"],
        false
    );
    fixture.write(&fixture.config);
    let old = read(Some(&fixture.path()), &fixture.environment, &fixture.root).unwrap();
    let added = fixture.root.join("qualifier-credentials/new-file.txt");
    fs::write(&added, "added nonsecret fixture bytes").unwrap();
    fs::set_permissions(&added, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(
        old.assert_current().is_err(),
        "added credential namespace entry"
    );
    drop(old);
    fixture.compare("new credential inventory");
    let old = read(Some(&fixture.path()), &fixture.environment, &fixture.root).unwrap();
    fs::rename(
        fixture.root.join("qualifier-credentials/nested"),
        fixture.root.join("qualifier-credentials/renamed"),
    )
    .unwrap();
    assert!(
        old.assert_current().is_err(),
        "renamed credential directory"
    );
    drop(old);
    fixture.compare("renamed credential inventory");
}

#[test]
fn actual_utf16_credential_names_pem_bytes_and_absent_argument_observations() {
    let fixture = Fixture::new();
    for (name, content) in [
        ("\u{10000}.txt", "supplementary filename fixture"),
        ("\u{e000}.txt", "bmp filename fixture"),
    ] {
        let path = fixture.root.join("qualifier-credentials").join(name);
        fs::write(&path, content).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fixture.compare("UTF16 directory listing order");
    let old = read(Some(&fixture.path()), &fixture.environment, &fixture.root).unwrap();
    let pem = fixture.root.join("release-public.pem");
    let mut text = fs::read_to_string(&pem).unwrap();
    text.push('\n');
    fs::write(&pem, text).unwrap();
    assert!(
        old.assert_current().is_err(),
        "same public SPKI, changed real PEM bytes"
    );
    drop(old);
    fixture.compare("same key with changed PEM bytes");
    let old = read(Some(&fixture.path()), &fixture.environment, &fixture.root).unwrap();
    // The literal command flag was originally absent as a filesystem resource.
    // Creating that path changes what the original reader includes in identity.
    fs::write(fixture.root.join("--mode"), "new owned argument resource").unwrap();
    assert!(
        old.assert_current().is_err(),
        "formerly missing argument now exists"
    );
    drop(old);
    fixture.compare("new existing argument resource");
}

#[test]
fn retained_env_interpreter_detects_new_earlier_path_candidate() {
    let mut fixture = Fixture::new();
    let search = fixture.root.join("first-path-directory");
    fs::create_dir(&search).unwrap();
    fs::write(
        fixture.root.join("qualifier.sh"),
        "#!/usr/bin/env sh\n# qualifier fixture only\nexit 91\n",
    )
    .unwrap();
    fixture
        .environment
        .insert("PATH".into(), format!("{}:/usr/bin:/bin", search.display()));
    let baseline = fixture.compare("initial env interpreter selection");
    let old = read(Some(&fixture.path()), &fixture.environment, &fixture.root).unwrap();
    let program = search.join("sh");
    fs::write(&program, "owned never executed interpreter candidate").unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    let changed = fixture.expected();
    assert_ne!(
        changed["identity"]["qualifier"]["interpreterIdentityHash"],
        baseline["identity"]["qualifier"]["interpreterIdentityHash"]
    );
    assert!(
        old.assert_current().is_err(),
        "new earlier PATH executable changes current selection"
    );
    drop(old);
    fixture.compare("new actual env interpreter selection");
    fs::set_permissions(&program, fs::Permissions::from_mode(0o600)).unwrap();
    let old = read(Some(&fixture.path()), &fixture.environment, &fixture.root).unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        old.assert_current().is_err(),
        "earlier nonexecutable file becomes executable"
    );
    assert!(!fixture.root.join("executed-marker").exists());
}
