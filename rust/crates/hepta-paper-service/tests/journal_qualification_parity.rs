//! Ephemeral test authorities only; no external or production qualification is written.
use hepta_paper_service::journal_connector_coverage::{
    build_journal_connector_coverage_v2, journal_connector_coverage_cli_at_v2, journal_profiles_v2,
    qualification::{
        PortalTargetQualificationOptionsV1, apply_inspected_portal_target_qualifications_v1,
        canonical_instant_millis, inspect_portal_target_qualification_registry_v1,
    },
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-journal-qualification-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn write(path: &Path, text: &str) {
    fs::write(path, text).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn oracle(requests: &[Value]) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/journal-connector-coverage-v2.mjs"))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(requests).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"])
        .expect("pinned Node runtime, locale and record-hash source");
    result
}
fn fixtures() -> Vec<Value> {
    let result = oracle(&[json!({"operation":"qualification-fixtures"})]);
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    result["results"][0]["value"].as_array().unwrap().clone()
}
fn options(temp: &Temp, fixture: &Value, name: &str) -> Value {
    let registry = temp.0.join(format!("{name}-registry.json"));
    let trust = temp.0.join(format!("{name}-trust.json"));
    write(&registry, fixture["registryText"].as_str().unwrap());
    write(&trust, fixture["trustText"].as_str().unwrap());
    json!({"registryPath":registry,"trustStorePath":trust,"expectedRegistryHash":fixture["expectedRegistryHash"],"expectedTrustStoreHash":fixture["expectedTrustStoreHash"],"now":fixture["now"]})
}
fn native(request: &Value) -> Value {
    let opts = &request["options"];
    let result =
        inspect_portal_target_qualification_registry_v1(PortalTargetQualificationOptionsV1 {
            registry_path: Path::new(opts["registryPath"].as_str().unwrap_or("")),
            trust_store_path: opts["trustStorePath"].as_str().map(Path::new),
            expected_registry_hash: opts["expectedRegistryHash"].as_str(),
            expected_trust_store_hash: opts["expectedTrustStoreHash"].as_str(),
            now_unix_ms: canonical_instant_millis(opts["now"].as_str().unwrap()).unwrap(),
        });
    match result {
        Err(error) => json!({"ok":false,"error":error.to_string()}),
        Ok(inspection) => {
            let applied = if request["apply"] == true {
                let now = request["applyNow"]
                    .as_str()
                    .unwrap_or(opts["now"].as_str().unwrap());
                match apply_inspected_portal_target_qualifications_v1(
                    &build_journal_connector_coverage_v2(&journal_profiles_v2().unwrap()).unwrap(),
                    &inspection,
                    canonical_instant_millis(now).unwrap(),
                ) {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                }
            } else {
                Value::Null
            };
            json!({"ok":true,"value":inspection.report(),"applied":applied})
        }
    }
}
fn compare(requests: &[Value]) {
    let expected = oracle(requests);
    for (index, request) in requests.iter().enumerate() {
        let actual = native(request);
        assert!(
            actual == expected["results"][index],
            "case {index}: {}: {}",
            request["label"],
            first_difference(&actual, &expected["results"][index], "$")
        );
    }
}
fn first_difference(actual: &Value, expected: &Value, path: &str) -> String {
    match (actual, expected) {
        (Value::Object(left), Value::Object(right)) => {
            for key in left.keys().chain(right.keys()) {
                if left.get(key) != right.get(key) {
                    return first_difference(
                        left.get(key).unwrap_or(&Value::Null),
                        right.get(key).unwrap_or(&Value::Null),
                        &format!("{path}.{key}"),
                    );
                }
            }
        }
        (Value::Array(left), Value::Array(right)) if left.len() == right.len() => {
            for (index, (left, right)) in left.iter().zip(right).enumerate() {
                if left != right {
                    return first_difference(left, right, &format!("{path}[{index}]"));
                }
            }
        }
        _ => {}
    }
    let short = |value: &Value| value.to_string().chars().take(160).collect::<String>();
    format!("{path}: Rust={} Node={}", short(actual), short(expected))
}
#[test]
fn signed_qualification_full_inspection_and_applied_hashes_match_node() {
    let temp = Temp::new();
    let requests=fixtures().iter().enumerate().map(|(index,fixture)|json!({"operation":"qualification-inspect","label":fixture["label"],"options":options(&temp,fixture,&index.to_string()),"apply":true})).collect::<Vec<_>>();
    compare(&requests);
    for request in &requests[..5] {
        let result = native(request);
        assert_eq!(result["value"]["ready"], true, "{result}");
        assert_eq!(result["value"]["liveCommitAuthorizedTargetCount"], 0);
        assert_eq!(result["value"]["safety"]["networkActionPerformed"], false);
        assert!(
            result["applied"]["value"]["entries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|v| v["liveSubmissionReady"] == false && v["liveCommitAuthorized"] == false)
        );
    }
}
#[test]
fn pins_freshness_and_secure_file_boundaries_match_node() {
    let temp = Temp::new();
    let fixture = fixtures().remove(0);
    let original = options(&temp, &fixture, "base");
    let registry: Value = serde_json::from_str(fixture["registryText"].as_str().unwrap()).unwrap();
    let mut requests = Vec::new();
    for (field, values) in [
        (
            "expectedRegistryHash",
            vec![
                Value::Null,
                json!(""),
                json!("not-a-pin"),
                json!(format!("sha256:{}", "0".repeat(64))),
                json!(
                    fixture["expectedRegistryHash"]
                        .as_str()
                        .unwrap()
                        .to_uppercase()
                ),
            ],
        ),
        (
            "expectedTrustStoreHash",
            vec![
                Value::Null,
                json!(""),
                json!("not-a-pin"),
                json!(format!("sha256:{}", "0".repeat(64))),
                json!(
                    fixture["expectedTrustStoreHash"]
                        .as_str()
                        .unwrap()
                        .to_uppercase()
                ),
            ],
        ),
        (
            "now",
            vec![
                json!("2000-01-01T00:00:00.000Z"),
                json!("2100-01-01T00:00:00.000Z"),
                registry["issuedAt"].clone(),
                registry["expiresAt"].clone(),
            ],
        ),
    ] {
        for value in values {
            let mut opts = original.clone();
            opts[field] = value;
            requests.push(json!({"operation":"qualification-inspect","label":field,"options":opts,"apply":true}));
        }
    }
    let mut add_path = |label: &str, path: &Path| {
        let mut opts = original.clone();
        opts["registryPath"] = json!(path);
        requests.push(
            json!({"operation":"qualification-inspect","label":label,"options":opts,"apply":true}),
        );
    };
    add_path("missing", &temp.0.join("missing"));
    for (label, bytes, mode) in [
        (
            "world-writable",
            fixture["registryText"].as_str().unwrap(),
            0o666,
        ),
        ("array", "[]", 0o600),
        ("malformed", "{", 0o600),
        ("scalar", "null", 0o600),
        ("too-short", "1", 0o600),
    ] {
        let path = temp.0.join(label);
        write(&path, bytes);
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        add_path(label, &path);
    }
    let large = temp.0.join("too-large");
    write(&large, &" ".repeat(4 * 1024 * 1024 + 1));
    add_path("too-large", &large);
    let link = temp.0.join("symlink");
    symlink(original["registryPath"].as_str().unwrap(), &link).unwrap();
    add_path("symlink", &link);
    let directory = temp.0.join("directory");
    fs::create_dir(&directory).unwrap();
    add_path("directory", &directory);
    let parent_link = temp.0.join("parent-link");
    symlink(&temp.0, &parent_link).unwrap();
    add_path("parent-symlink", &parent_link.join("base-registry.json"));
    let hard_source = temp.0.join("hard-source");
    write(&hard_source, fixture["registryText"].as_str().unwrap());
    let hard_link = temp.0.join("hard-link");
    fs::hard_link(&hard_source, &hard_link).unwrap();
    add_path("hard-link", &hard_link);
    requests.push(json!({"operation":"qualification-inspect","label":"expires-after-inspection","options":original,"apply":true,"applyNow":"2100-01-01T00:00:00.000Z"}));
    compare(&requests);
}
#[test]
fn qualified_real_cli_flags_environment_counts_and_gates_match_node() {
    let temp = Temp::new();
    let fixtures = fixtures();
    for fixture in &fixtures[..2] {
        let opts = options(&temp, fixture, fixture["label"].as_str().unwrap());
        let now = canonical_instant_millis(fixture["now"].as_str().unwrap()).unwrap();
        for gate in [
            "--require-profile-resolved",
            "--require-sandbox-qualified",
            "--require-production-qualified",
            "--require-live-ready",
        ] {
            let argv = vec![
                "--venue".to_owned(),
                "tmlr".into(),
                gate.into(),
                "--qualification-registry".into(),
                opts["registryPath"].as_str().unwrap().into(),
                "--qualification-registry-hash".into(),
                opts["expectedRegistryHash"].as_str().unwrap().into(),
                "--qualification-trust-store".into(),
                opts["trustStorePath"].as_str().unwrap().into(),
                "--qualification-trust-store-hash".into(),
                opts["expectedTrustStoreHash"].as_str().unwrap().into(),
            ];
            let expected = oracle(&[json!({"operation":"cli","argv":argv})]);
            let result =
                journal_connector_coverage_cli_at_v2(&argv, &BTreeMap::new(), now).unwrap();
            assert_eq!(
                json!({"ok":true,"value":result.value,"exitCode":result.exit_code}),
                expected["results"][0]
            );
            let output = Command::new(env!("CARGO_BIN_EXE_hepta-journal-connector-coverage"))
                .args(&argv)
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(result.exit_code));
            assert!(output.stderr.is_empty());
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                result.value
            );
        }
        let environment = BTreeMap::from([
            (
                "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY".into(),
                opts["registryPath"].as_str().unwrap().into(),
            ),
            (
                "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH".into(),
                opts["expectedRegistryHash"].as_str().unwrap().into(),
            ),
            (
                "HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE".into(),
                opts["trustStorePath"].as_str().unwrap().into(),
            ),
            (
                "HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH".into(),
                opts["expectedTrustStoreHash"].as_str().unwrap().into(),
            ),
        ]);
        let result =
            journal_connector_coverage_cli_at_v2(&["--venue=tmlr".into()], &environment, now)
                .unwrap();
        assert_eq!(result.value["sandboxQualifiedCount"], 1);
        assert_eq!(result.value["liveSubmissionReadyCount"], 0);
    }
}
#[test]
fn canonical_clock_rejects_normalized_dates_and_preserves_iso_range() {
    for (date, expected) in [
        ("1970-01-01T00:00:00.000Z", Some(0)),
        ("1969-12-31T23:59:59.999Z", Some(-1)),
        ("2000-02-29T00:00:00.000Z", Some(951782400000)),
        ("2026-02-29T00:00:00.000Z", None),
        ("2026-01-01T24:00:00.000Z", None),
        ("2026-01-01T00:00:00Z", None),
        ("+010000-01-01T00:00:00.000Z", Some(253402300800000)),
        ("-000000-01-01T00:00:00.000Z", None),
    ] {
        assert_eq!(canonical_instant_millis(date), expected, "{date}");
    }
}
