//! Independent ephemeral keys and isolated local registries; never real authority.
use hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis;
use hepta_paper_service::portal_target_qualification::{
    PortalTargetQualificationOperatorOptionsV1 as Options,
    execute_portal_target_qualification_import_v1, inspect_portal_target_qualification_v1,
    plan_portal_target_qualification_import_v1, portal_target_qualification_cli_at_v1,
    preflight_portal_target_qualification_v1,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Barrier,
        atomic::{AtomicU64, Ordering},
    },
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "hepta-portal-operator-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        Self(p)
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
        .arg(root.join("rust/oracle/portal-target-qualification-v1.mjs"))
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
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&value["profile"])
        .expect("Node 22.23.1, locale and actual source hash");
    value
}
fn fixtures() -> Vec<Value> {
    let result = oracle(&[json!({"operation":"fixtures"})]);
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    result["results"][0]["value"].as_array().unwrap().clone()
}
fn setup(root: &Path, fixture: &Value) -> Value {
    let path = root.join(fixture["label"].as_str().unwrap());
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    write(
        &path.join("candidate.json"),
        fixture["candidateText"].as_str().unwrap(),
    );
    write(
        &path.join("trust.json"),
        fixture["trustText"].as_str().unwrap(),
    );
    if let Some(current) = fixture["currentText"].as_str() {
        write(&path.join("registry.json"), current);
    }
    json!({"registryPath":path.join("registry.json"),"candidatePath":path.join("candidate.json"),"trustStorePath":path.join("trust.json"),"expectedRegistryHash":fixture["registryHash"],"expectedCandidateFileHash":fixture["candidateHash"],"expectedTrustStoreHash":fixture["trustHash"],"now":fixture["now"],"targetVenueIds":if fixture["label"]=="two"{json!(["iclr","neurips"])}else{json!(["tmlr"])}})
}
fn options(value: &Value) -> Options {
    Options {
        registry_path: value["registryPath"].as_str().map(PathBuf::from),
        candidate_path: value["candidatePath"].as_str().map(PathBuf::from),
        trust_store_path: value["trustStorePath"].as_str().map(PathBuf::from),
        expected_registry_hash: value["expectedRegistryHash"].as_str().map(str::to_owned),
        expected_candidate_file_hash: value["expectedCandidateFileHash"]
            .as_str()
            .map(str::to_owned),
        expected_trust_store_hash: value["expectedTrustStoreHash"].as_str().map(str::to_owned),
        expected_plan_hash: value["expectedPlanHash"].as_str().map(str::to_owned),
        now_unix_ms: canonical_instant_millis(value["now"].as_str().unwrap()).unwrap(),
        target_venue_ids: value["targetVenueIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        requested_qualification_level: value["requestedQualificationLevel"]
            .as_str()
            .map(str::to_owned),
        expected_target_bindings: value["expectedTargetBindings"]
            .as_object()
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default(),
    }
}
fn native(request: &Value) -> Value {
    let opts = options(&request["options"]);
    let result = match request["operation"].as_str().unwrap() {
        "status" => inspect_portal_target_qualification_v1(&opts),
        "preflight" => preflight_portal_target_qualification_v1(&opts),
        "import-plan" => plan_portal_target_qualification_import_v1(&opts),
        "import-execute" => execute_portal_target_qualification_import_v1(&opts),
        _ => panic!("unknown test operation"),
    };
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error.to_string()}),
    }
}
fn difference(a: &Value, b: &Value, path: &str) -> String {
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()) {
                if a.get(key) != b.get(key) {
                    return difference(
                        a.get(key).unwrap_or(&Value::Null),
                        b.get(key).unwrap_or(&Value::Null),
                        &format!("{path}.{key}"),
                    );
                }
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (index, (a, b)) in a.iter().zip(b).enumerate() {
                if a != b {
                    return difference(a, b, &format!("{path}[{index}]"));
                }
            }
        }
        _ => {}
    }
    format!("{path}: Rust={a}, Node={b}")
}
fn compare(requests: &[Value]) {
    let expected = oracle(requests);
    for (index, request) in requests.iter().enumerate() {
        let actual = native(request);
        assert_eq!(
            actual,
            expected["results"][index],
            "{} {}",
            request["label"],
            difference(&actual, &expected["results"][index], "$")
        );
    }
}
#[test]
fn four_mode_readonly_contracts_match_signed_node_corpus() {
    let temp = Temp::new();
    let mut requests = Vec::new();
    for fixture in fixtures() {
        let opts = setup(&temp.0, &fixture);
        for operation in ["status", "preflight", "import-plan"] {
            requests.push(json!({"label":fixture["label"],"operation":operation,"options":opts}));
        }
    }
    compare(&requests);
    for request in &requests {
        let parent = Path::new(request["options"]["candidatePath"].as_str().unwrap())
            .parent()
            .unwrap();
        assert!(!parent.join("registry.json.lock").exists());
        assert!(
            fs::read_dir(parent).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp"))
        );
    }
}
#[test]
fn preflight_pins_bindings_missing_inputs_and_expiration_match_node() {
    let temp = Temp::new();
    let fixture = fixtures().remove(0);
    let opts = setup(&temp.0, &fixture);
    let mut requests = Vec::new();
    let candidate: Value =
        serde_json::from_str(fixture["candidateText"].as_str().unwrap()).unwrap();
    for mode in [
        "no-target",
        "three-targets",
        "duplicate-target",
        "unknown-target",
        "bad-level",
        "missing-candidate",
        "missing-trust",
        "missing-candidate-pin",
        "bad-candidate-pin",
        "wrong-candidate-pin",
        "wrong-trust-pin",
        "binding-match",
        "binding-drift",
        "binding-invalid",
        "expired",
        "future",
        "active-ready",
        "active-no-pin",
    ] {
        let mut o = opts.clone();
        match mode {
            "no-target" => o["targetVenueIds"] = json!([]),
            "three-targets" => o["targetVenueIds"] = json!(["tmlr", "iclr", "neurips"]),
            "duplicate-target" => o["targetVenueIds"] = json!(["tmlr", "tmlr"]),
            "unknown-target" => o["targetVenueIds"] = json!(["unknown"]),
            "bad-level" => o["requestedQualificationLevel"] = json!("bad"),
            "missing-candidate" => o["candidatePath"] = json!(temp.0.join("missing")),
            "missing-trust" => o["trustStorePath"] = Value::Null,
            "missing-candidate-pin" => o["expectedCandidateFileHash"] = Value::Null,
            "bad-candidate-pin" => o["expectedCandidateFileHash"] = json!("bad"),
            "wrong-candidate-pin" => {
                o["expectedCandidateFileHash"] = json!(format!("sha256:{}", "0".repeat(64)))
            }
            "wrong-trust-pin" => {
                o["expectedTrustStoreHash"] = json!(format!("sha256:{}", "0".repeat(64)))
            }
            "binding-match" => {
                o["expectedTargetBindings"] = json!({"tmlr":{"portalTargetSubjectHash":candidate["entries"][0]["portalTargetSubjectHash"],"submissionRouteHash":candidate["entries"][0]["submissionRouteHash"],"schemaFingerprintHash":candidate["entries"][0]["schemaFingerprintHash"]}})
            }
            "binding-drift" => {
                o["expectedTargetBindings"] = json!({"tmlr":{"portalTargetSubjectHash":format!("sha256:{}","0".repeat(64)),"submissionRouteHash":format!("sha256:{}","0".repeat(64)),"schemaFingerprintHash":format!("sha256:{}","0".repeat(64))}})
            }
            "binding-invalid" => {
                o["expectedTargetBindings"] = json!({"tmlr":{"submissionRouteHash":"bad"}})
            }
            "expired" => o["now"] = json!("2030-01-01T00:00:00.000Z"),
            "future" => o["now"] = json!("2020-01-01T00:00:00.000Z"),
            "active-ready" | "active-no-pin" => {
                o["candidatePath"] = Value::Null;
                o["registryPath"] = opts["candidatePath"].clone();
                o["expectedRegistryHash"] = if mode == "active-ready" {
                    fixture["candidateRegistryHash"].clone()
                } else {
                    Value::Null
                };
            }
            _ => unreachable!(),
        }
        requests.push(json!({"label":mode,"operation":"preflight","options":o}));
    }
    compare(&requests);
}
#[test]
fn initial_and_successor_atomic_import_match_node_bytes_and_receipts() {
    let temp = Temp::new();
    for fixture in fixtures().into_iter().filter(|f| {
        [
            "initial",
            "sandbox",
            "two",
            "empty",
            "successor-unchanged",
            "successor-replaced",
            "expired-current",
        ]
        .contains(&f["label"].as_str().unwrap())
    }) {
        let mut opts = setup(&temp.0, &fixture);
        let planned = plan_portal_target_qualification_import_v1(&options(&opts)).unwrap();
        opts["expectedPlanHash"] = planned["planHash"].clone();
        let request = json!({"operation":"import-execute","options":opts});
        let expected = oracle(std::slice::from_ref(&request));
        assert_eq!(expected["results"][0]["ok"], true, "{expected}");
        let path = Path::new(opts["registryPath"].as_str().unwrap());
        let expected_bytes = fs::read(path).unwrap();
        if let Some(prior) = fixture["currentText"].as_str() {
            write(path, prior);
        } else {
            fs::remove_file(path).unwrap();
        }
        let actual = native(&request);
        assert_eq!(
            actual,
            expected["results"][0],
            "{}: {}",
            fixture["label"],
            difference(&actual, &expected["results"][0], "$")
        );
        assert_eq!(fs::read(path).unwrap(), expected_bytes);
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let parent = path.parent().unwrap();
        assert_eq!(fs::read_dir(parent).unwrap().count(), 3);
        assert!(!parent.join("registry.json.lock").exists());
        let saved = fs::read(path).unwrap();
        assert!(execute_portal_target_qualification_import_v1(&options(&opts)).is_err());
        assert_eq!(fs::read(path).unwrap(), saved);
    }
}
#[test]
fn failed_and_concurrent_imports_never_clobber_registry_or_other_files() {
    let temp = Temp::new();
    let fixture = fixtures().remove(0);
    let opts = setup(&temp.0, &fixture);
    let mut options = options(&opts);
    let plan = plan_portal_target_qualification_import_v1(&options).unwrap();
    options.expected_plan_hash = Some(format!("sha256:{}", "0".repeat(64)));
    assert!(execute_portal_target_qualification_import_v1(&options).is_err());
    let registry = options.registry_path.as_ref().unwrap();
    assert!(!registry.exists());
    options.expected_plan_hash = plan["planHash"].as_str().map(str::to_owned);
    let lock = registry.with_file_name("registry.json.lock");
    write(&lock, "foreign-lock");
    assert!(execute_portal_target_qualification_import_v1(&options).is_err());
    assert_eq!(fs::read_to_string(&lock).unwrap(), "foreign-lock");
    fs::remove_file(&lock).unwrap();
    let candidate = options.candidate_path.as_ref().unwrap();
    let saved = fs::read(candidate).unwrap();
    write(candidate, "{}");
    assert!(execute_portal_target_qualification_import_v1(&options).is_err());
    assert!(!registry.exists());
    write(candidate, std::str::from_utf8(&saved).unwrap());
    let outside = temp.0.join("outside");
    write(&outside, "do-not-modify");
    symlink(&outside, registry).unwrap();
    assert!(execute_portal_target_qualification_import_v1(&options).is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "do-not-modify");
    fs::remove_file(registry).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let mut threads = Vec::new();
    for _ in 0..2 {
        let barrier = barrier.clone();
        let options = options.clone();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            execute_portal_target_qualification_import_v1(&options)
        }));
    }
    barrier.wait();
    let results = threads
        .into_iter()
        .map(|t| t.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|r| r.is_err()).count(), 1);
    let mut check = options.clone();
    check.expected_registry_hash = fixture["candidateRegistryHash"].as_str().map(str::to_owned);
    assert_eq!(
        inspect_portal_target_qualification_v1(&check).unwrap()["ready"],
        true
    );
    assert!(!lock.exists());
}
#[test]
fn strict_cli_flags_environment_bindings_and_exit_gates_match_node() {
    let temp = Temp::new();
    let fixture = fixtures().remove(0);
    let opts = setup(&temp.0, &fixture);
    let now = canonical_instant_millis(fixture["now"].as_str().unwrap()).unwrap();
    let environment = BTreeMap::from([
        (
            "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY".into(),
            opts["candidatePath"].as_str().unwrap().into(),
        ),
        (
            "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH".into(),
            fixture["candidateRegistryHash"].as_str().unwrap().into(),
        ),
        (
            "HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE".into(),
            opts["trustStorePath"].as_str().unwrap().into(),
        ),
        (
            "HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH".into(),
            fixture["trustHash"].as_str().unwrap().into(),
        ),
    ]);
    let mut cases = vec![
        vec!["--help"],
        vec![],
        vec!["--require-ready"],
        vec![
            "--action",
            "preflight",
            "--target",
            "tmlr",
            "--require-ready",
        ],
        vec![
            "--action",
            "preflight",
            "--target",
            "tmlr",
            "--target",
            "iclr",
            "--require-ready",
        ],
        vec!["--action", "wrong"],
        vec!["--"],
        vec!["positional"],
        vec!["--unknown"],
        vec!["--help=1"],
        vec!["--help", "--help"],
        vec!["--target"],
        vec!["--target="],
        vec!["--action", "status", "--action", "status"],
        vec![
            "--action",
            "preflight",
            "--target",
            "tmlr",
            "--expected-route-hash",
            "bad",
        ],
        vec![
            "--action",
            "preflight",
            "--target",
            "tmlr",
            "--expected-route-hash",
            "iclr=value",
        ],
        vec![
            "--action",
            "preflight",
            "--target",
            "tmlr",
            "--expected-route-hash",
            "tmlr=bad",
            "--expected-route-hash",
            "tmlr=other",
        ],
        vec!["--action", "import-execute"],
        vec!["--action", "import-execute", "--execute"],
    ]
    .into_iter()
    .map(|v| v.into_iter().map(str::to_owned).collect::<Vec<_>>())
    .collect::<Vec<_>>();
    let candidate: Value =
        serde_json::from_str(fixture["candidateText"].as_str().unwrap()).unwrap();
    cases.push(vec![
        "--action".into(),
        "preflight".into(),
        "--target".into(),
        "tmlr".into(),
        "--expected-subject-hash".into(),
        format!(
            "tmlr={}",
            candidate["entries"][0]["portalTargetSubjectHash"]
                .as_str()
                .unwrap()
        ),
        "--expected-route-hash".into(),
        format!(
            "tmlr={}",
            candidate["entries"][0]["submissionRouteHash"]
                .as_str()
                .unwrap()
        ),
        "--expected-schema-hash".into(),
        format!(
            "tmlr={}",
            candidate["entries"][0]["schemaFingerprintHash"]
                .as_str()
                .unwrap()
        ),
    ]);
    let requests=cases.iter().map(|argv|json!({"operation":"cli","argv":argv,"environment":environment,"now":fixture["now"]})).collect::<Vec<_>>();
    let expected = oracle(&requests);
    for (index, argv) in cases.iter().enumerate() {
        let result = portal_target_qualification_cli_at_v1(argv, &environment, now);
        let actual = match result {
            Ok(output) => json!({"ok":true,"value":output.report,"exitCode":output.exit_code}),
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        assert_eq!(
            actual,
            expected["results"][index],
            "case {argv:?}: {}",
            difference(&actual, &expected["results"][index], "$")
        );
    }
    let binary = env!("CARGO_BIN_EXE_hepta-portal-target-qualification");
    let invoke = |args: &[&str]| {
        let mut command = Command::new(binary);
        for (name, _) in std::env::vars()
            .filter(|(name, _)| name.starts_with("HEPTA_PORTAL_TARGET_QUALIFICATION_"))
        {
            command.env_remove(name);
        }
        command.envs(&environment).args(args).output().unwrap()
    };
    let output = invoke(&["--require-ready"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ready"], true);
    assert_eq!(report, expected["results"][2]["value"]);
    assert!(output.stderr.is_empty());
    let output = invoke(&[
        "--action",
        "preflight",
        "--target",
        "iclr",
        "--require-ready",
    ]);
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["ready"],
        false
    );
    assert!(output.stderr.is_empty());
    let output = invoke(&["--action", "import-execute"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap().trim(),
        "portal_target_qualification_import_execute_confirmation_required"
    );
}
#[test]
fn unsafe_local_inputs_and_readonly_preflight_cannot_become_ready() {
    let temp = Temp::new();
    for mode in [
        "candidate-symlink",
        "trust-symlink",
        "candidate-hardlink",
        "trust-writable",
        "parent-alias",
    ] {
        let mut fixture = fixtures().remove(0);
        fixture["label"] = json!(mode);
        let opts = setup(&temp.0, &fixture);
        let mut options = options(&opts);
        let candidate = options.candidate_path.as_ref().unwrap().clone();
        let trust = options.trust_store_path.as_ref().unwrap().clone();
        match mode {
            "candidate-symlink" | "trust-symlink" => {
                let file = if mode == "candidate-symlink" {
                    &candidate
                } else {
                    &trust
                };
                let original = file.with_extension("original");
                fs::rename(file, &original).unwrap();
                symlink(&original, file).unwrap();
            }
            "candidate-hardlink" => {
                fs::hard_link(&candidate, candidate.with_extension("hardlink")).unwrap();
            }
            "trust-writable" => {
                fs::set_permissions(&trust, fs::Permissions::from_mode(0o620)).unwrap()
            }
            "parent-alias" => {
                let alias = temp.0.join("alias");
                symlink(candidate.parent().unwrap(), &alias).unwrap();
                options.candidate_path = Some(alias.join("candidate.json"));
            }
            _ => unreachable!(),
        }
        assert!(
            plan_portal_target_qualification_import_v1(&options).is_err(),
            "{mode}"
        );
        assert_eq!(
            preflight_portal_target_qualification_v1(&options).unwrap()["ready"],
            false,
            "{mode}"
        );
        assert!(!options.registry_path.unwrap().exists());
    }
}

#[test]
fn preflight_authority_diagnostics_match_actual_node_verifiers() {
    use sha2::{Digest, Sha256};
    let temp = Temp::new();
    let cases =
        oracle(&[json!({"operation":"authority-fixtures","now":"2026-09-16T12:00:00.000Z"})]);
    let mut requests = Vec::new();
    for fixture in cases["results"][0]["value"].as_array().unwrap() {
        let path = temp.0.join(fixture["label"].as_str().unwrap());
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let candidate = fixture["registryText"].as_str().unwrap();
        write(&path.join("candidate.json"), candidate);
        write(
            &path.join("trust.json"),
            fixture["trustText"].as_str().unwrap(),
        );
        let options = json!({"registryPath":path.join("absent.json"),"candidatePath":path.join("candidate.json"),"trustStorePath":path.join("trust.json"),"expectedCandidateFileHash":format!("sha256:{}",hex::encode(Sha256::digest(candidate.as_bytes()))),"expectedTrustStoreHash":fixture["expectedTrustStoreHash"],"now":fixture["now"],"targetVenueIds":["tmlr"]});
        requests.push(json!({"label":fixture["label"],"operation":"preflight","options":options}));
    }
    compare(&requests);
}
