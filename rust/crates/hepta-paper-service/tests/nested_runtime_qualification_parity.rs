//! Real Node-builder fixtures and differential verifier checks. Ephemeral
//! signatures exercise the algorithm; they do not qualify a production host.
use hepta_paper_service::nested_runtime_qualification::verify_nested_runtime_platform_qualification_v1 as verify;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn oracle(input: Value) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/nested-runtime-qualification-v1.mjs"))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node oracle");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(input.to_string().as_bytes())
        .expect("request");
    let output = child.wait_with_output().expect("output");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("JSON oracle")
}
struct Fixture {
    root: PathBuf,
    request: Value,
    expected: Value,
}
impl Fixture {
    fn new(scenario: &str) -> Self {
        let value = oracle(json!({"operation":"fixture","scenario":scenario}));
        Self {
            root: PathBuf::from(value["root"].as_str().expect("root")),
            request: value["request"].clone(),
            expected: value["expected"].clone(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).expect("fixture cleanup");
    }
}
fn snapshot(root: &Path) -> BTreeMap<String, (Vec<u8>, u64, u32, i64, i64)> {
    fs::read_dir(root)
        .unwrap()
        .map(|e| {
            let p = e.unwrap().path();
            let m = fs::symlink_metadata(&p).unwrap();
            (
                p.file_name().unwrap().to_string_lossy().to_string(),
                (
                    fs::read(&p).unwrap(),
                    m.ino(),
                    m.mode(),
                    m.mtime(),
                    m.mtime_nsec(),
                ),
            )
        })
        .collect()
}
#[test]
fn complete_signed_current_pod_chain_matches_node_and_is_read_only() {
    let fixture = Fixture::new("valid");
    let before = snapshot(&fixture.root);
    let result = verify(&fixture.request).expect("verify");
    assert_eq!(result, fixture.expected);
    assert_eq!(result["ready"], true);
    assert_eq!(result["externalActionPerformed"], false);
    assert_eq!(snapshot(&fixture.root), before);
}

#[test]
fn declared_gpu_profile_and_device_proof_match_node() {
    let fixture = Fixture::new("gpu");
    let before = snapshot(&fixture.root);
    let result = verify(&fixture.request).expect("verify GPU evidence");
    assert_eq!(result["ready"], true);
    assert_eq!(result, fixture.expected);
    assert_eq!(snapshot(&fixture.root), before);
}
#[test]
fn time_pod_resource_plan_and_pinned_bytes_are_fail_closed_with_node_parity() {
    let fixture = Fixture::new("valid");
    let mut requests = Vec::new();
    for (field, value) in [
        ("podUid", json!("c94bd80d-f812-43f8-8988-d535a1417f2c")),
        ("planHash", json!(format!("sha256:{}", "9".repeat(64)))),
        ("profileId", json!("different-profile")),
        ("runtimeClassName", json!("different-runtime")),
        ("parentPodPids", json!(513)),
        ("parentPodMemoryBytes", json!(8589934593u64)),
        ("parentPodCpuMillis", json!(4001)),
        (
            "expectedConformanceBundleContentHash",
            json!(format!("sha256:{}", "0".repeat(64))),
        ),
        (
            "expectedAuthorityIndependenceBundleContentHash",
            Value::Null,
        ),
        ("qualificationKeyId", json!("wrong-qualified-key")),
        ("now", json!("2026-07-24T08:10:00.000Z")),
        ("now", json!("2026-07-24T06:59:59.999Z")),
    ] {
        let mut request = fixture.request.clone();
        request[field] = value;
        requests.push(request);
    }
    let expected = oracle(json!({"operation":"verify","requests":requests}));
    for (request, expected) in requests.iter().zip(expected.as_array().unwrap()) {
        assert_eq!(expected["ok"], true);
        let result = verify(request).expect("blocked report");
        assert_eq!(result["ready"], false, "{request}");
        assert_eq!(result, expected["value"], "{request}");
    }
}
#[test]
fn real_invalid_signatures_revocations_and_independence_fail_with_node_parity() {
    for scenario in [
        "signature",
        "revoked-key",
        "wrong-role",
        "same-organization",
        "shared-control-domain",
        "unknown-field",
        "signed-invalid-proof",
    ] {
        let f = Fixture::new(scenario);
        let before = snapshot(&f.root);
        let result = verify(&f.request).expect("blocked");
        assert_eq!(result["ready"], false, "{scenario}");
        assert_eq!(result, f.expected, "{scenario}");
        assert_eq!(snapshot(&f.root), before);
    }
}
#[test]
fn alias_hardlink_permissions_and_duplicate_keys_are_rejected_without_writes() {
    let f = Fixture::new("valid");
    let config = f.root.join("config.json");
    let link = f.root.join("config-link.json");
    symlink(&config, &link).unwrap();
    let mut request = f.request.clone();
    request["configPath"] = json!(link);
    assert_eq!(verify(&request).unwrap()["ready"], false);
    fs::remove_file(link).unwrap();
    let parent_alias = f.root.with_extension("parent-alias");
    symlink(&f.root, &parent_alias).unwrap();
    request["configPath"] = json!(parent_alias.join("config.json"));
    assert_eq!(verify(&request).unwrap()["ready"], false);
    fs::remove_file(parent_alias).unwrap();
    let hard = f.root.join("config-hard.json");
    fs::hard_link(&config, &hard).unwrap();
    assert_eq!(verify(&f.request).unwrap()["ready"], false);
    fs::remove_file(hard).unwrap();
    fs::set_permissions(&config, fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(verify(&f.request).unwrap()["ready"], false);
    fs::set_permissions(&config, fs::Permissions::from_mode(0o644)).unwrap();
    let original = fs::read(&config).unwrap();
    let mut duplicated = b"{\"version\":2,".to_vec();
    duplicated.extend_from_slice(&original[1..]);
    fs::write(&config, &duplicated).unwrap();
    request = f.request.clone();
    request["expectedConfigContentHash"] =
        json!(format!("sha256:{:x}", Sha256::digest(&duplicated)));
    let before = snapshot(&f.root);
    assert_eq!(verify(&request).unwrap()["ready"], false);
    assert_eq!(snapshot(&f.root), before);
}
#[test]
fn request_shape_clock_and_resource_bounds_are_closed() {
    let f = Fixture::new("valid");
    let mut request = f.request.clone();
    request["unexpected"] = true.into();
    assert!(verify(&request).is_err());
    request = f.request.clone();
    request["now"] = "2026-02-30T08:00:00.000Z".into();
    assert!(verify(&request).is_err());
    for n in [
        json!(0),
        json!(-1),
        json!(9007199254740992u64),
        json!(1.5),
        json!("1e999"),
        json!(true),
    ] {
        request = f.request.clone();
        request["parentPodPids"] = n;
        assert_eq!(verify(&request).unwrap()["ready"], false);
    }
    request = f.request.clone();
    request["parentPodPids"] = "512".into();
    assert_eq!(verify(&request).unwrap(), f.expected);
}

#[test]
fn real_cli_reports_success_blocked_and_input_errors_without_mutation() {
    let fixture = Fixture::new("valid");
    let request_path = fixture.root.join("request.json");
    let cli = |path: &Path| {
        Command::new(env!("CARGO_BIN_EXE_hepta-nested-runtime-qualification"))
            .arg("--request")
            .arg(path)
            .output()
            .expect("native verifier CLI")
    };
    fs::write(&request_path, serde_json::to_vec(&fixture.request).unwrap()).unwrap();
    fs::set_permissions(&request_path, fs::Permissions::from_mode(0o644)).unwrap();
    let before = snapshot(&fixture.root);
    let success = cli(&request_path);
    assert_eq!(success.status.code(), Some(0));
    assert!(success.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&success.stdout).unwrap(),
        fixture.expected
    );
    assert_eq!(snapshot(&fixture.root), before);

    let mut request = fixture.request.clone();
    request["parentPodPids"] = json!(513);
    fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();
    let before = snapshot(&fixture.root);
    let blocked = cli(&request_path);
    assert_eq!(blocked.status.code(), Some(2));
    assert_eq!(
        serde_json::from_slice::<Value>(&blocked.stdout).unwrap()["ready"],
        false
    );
    assert_eq!(snapshot(&fixture.root), before);

    let encoded = serde_json::to_vec(&fixture.request).unwrap();
    let mut duplicate = b"{\"podUid\":\"duplicate-key\",".to_vec();
    duplicate.extend_from_slice(&encoded[1..]);
    fs::write(&request_path, duplicate).unwrap();
    let before = snapshot(&fixture.root);
    let invalid = cli(&request_path);
    assert_eq!(invalid.status.code(), Some(1));
    assert!(invalid.stdout.is_empty());
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("evidence_json_invalid"));
    assert_eq!(snapshot(&fixture.root), before);
}

#[test]
fn node_numeric_coercions_and_integral_decimal_json_keep_the_same_identity() {
    let fixture = Fixture::new("valid");
    let mut requests = Vec::new();
    for (key, value) in [
        ("parentPodCpuMillis", json!("4e3")),
        ("parentPodCpuMillis", json!("0xFA0")),
        ("parentPodCpuMillis", json!(" +4000.0 ")),
        ("parentPodCpuMillis", json!([4000])),
        ("parentPodCpuMillis", json!("\u{FEFF}4000\u{FEFF}")),
        ("parentPodPids", json!("0o1000")),
        ("parentPodPids", json!("0b1000000000")),
        ("parentPodCpuMillis", json!(4000.0)),
        ("parentPodCpuMillis", json!("\u{0085}4000")),
    ] {
        let mut request = fixture.request.clone();
        request[key] = value;
        requests.push(request);
    }
    let expected = oracle(json!({"operation":"verify","requests":requests}));
    for (request, expected) in requests.iter().zip(expected.as_array().unwrap()) {
        assert_eq!(expected["ok"], true);
        assert_eq!(verify(request).unwrap(), expected["value"], "{request}");
    }
    let path = fixture.root.join("config.json");
    let mut bytes = String::from_utf8(fs::read(&path).unwrap())
        .unwrap()
        .replacen("\"version\":2,", "\"version\":2.0,", 1)
        .into_bytes();
    assert_ne!(bytes, fs::read(&path).unwrap());
    fs::write(&path, &bytes).unwrap();
    let mut request = fixture.request.clone();
    request["expectedConfigContentHash"] = json!(format!("sha256:{:x}", Sha256::digest(&bytes)));
    let bundle = fixture.root.join("conformance.json");
    bytes = String::from_utf8(fs::read(&bundle).unwrap())
        .unwrap()
        .replace("\"version\":1,", "\"version\":1.0,")
        .into_bytes();
    fs::write(&bundle, &bytes).unwrap();
    request["expectedConformanceBundleContentHash"] =
        json!(format!("sha256:{:x}", Sha256::digest(&bytes)));
    let expected = oracle(json!({"operation":"verify","requests":[request]}));
    assert_eq!(expected[0]["value"]["ready"], true);
    assert_eq!(verify(&request).unwrap(), expected[0]["value"]);
}
