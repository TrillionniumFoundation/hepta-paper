//! Only public synthetic trust documents and signed test receipts are persisted.
use hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis;
use hepta_paper_service::sqlite_mutation_coordinator::{
    Result,
    authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-native-schema-{}-{}",
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
fn oracle(requests: &[Value]) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/online-schema-transition-v1.mjs"))
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
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&value["profile"]).unwrap();
    value
}
fn make_fixture(root: &Temp, version: u64) -> Value {
    let out = oracle(&[json!({"operation":"fixture","root":root.0,"version":version})]);
    assert_eq!(out["results"][0]["ok"], true, "{out}");
    out["results"][0]["value"].clone()
}
#[derive(Clone)]
struct Raw {
    value: Value,
    calls: Arc<AtomicUsize>,
    tamper: Option<PathBuf>,
}
impl Raw {
    fn new(value: Value) -> Self {
        Self {
            value,
            calls: Arc::new(AtomicUsize::new(0)),
            tamper: None,
        }
    }
}
impl MutationAuthorityTransportV1 for Raw {
    fn invoke(&mut self, _: &Value) -> Result<Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(path) = self.tamper.take() {
            fs::write(path, b"{}").unwrap();
        }
        Ok(self.value.clone())
    }
}
fn load(fixture: &Value, raw: Raw) -> Result<PinnedMutationAuthorityV1<Raw>> {
    PinnedMutationAuthorityV1::load(
        Path::new(fixture["configurationPath"].as_str().unwrap()),
        fixture["configurationFileHash"].as_str().unwrap(),
        raw,
    )
}
fn native(fixture: &Value, case: &Value) -> Result<Value> {
    let mut client = load(fixture, Raw::new(case["receipt"].clone()))?;
    let now = canonical_instant_millis(case["now"].as_str().unwrap()).unwrap();
    let request = &case["request"];
    let result = match case["operation"].as_str().unwrap() {
        "reserve" => client.reserve_schema_transition(request, now)?,
        "finalize" => {
            let reservation = client.verify_historical_schema_transition_reservation(
                &case["reservation"],
                &case["reserveRequest"],
            )?;
            client.finalize_schema_transition(request, &reservation, now)?
        }
        "observe" => client.observe_schema_transition(request, now)?,
        _ => panic!("unknown operation"),
    };
    Ok(result.value().clone())
}
#[test]
fn schema_transition_v1_and_pristine_rebind_v2_contracts_match_real_node_signatures() {
    for version in [1, 2] {
        let root = Temp::new();
        let fixture = make_fixture(&root, version);
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 40);
        for case in cases {
            let actual = native(&fixture, case);
            let expected = &case["expected"];
            assert_eq!(
                actual.is_ok(),
                expected["ok"] == true && expected["accepted"] == true,
                "version {version}, {}: native {:?}, Node {expected}",
                case["label"],
                actual.as_ref().err().map(|e| &e.code)
            );
            if expected["ok"] == false {
                assert_eq!(
                    actual.err().unwrap().code,
                    expected["error"].as_str().unwrap(),
                    "version {version}, {}",
                    case["label"]
                );
            }
        }
    }
}
#[test]
fn schema_transition_process_modes_match_node_and_require_verified_same_authority_reservation() {
    for version in [1, 2] {
        let root = Temp::new();
        let fixture = make_fixture(&root, version);
        let cases = fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["label"].as_str().unwrap().ends_with("-valid"))
            .collect::<Vec<_>>();
        // The broker mirrors request array member order, as the source contract requires.
        let results=oracle(&cases.iter().map(|case|json!({"operation":"process","path":fixture["processConfigurationPath"],"case":case})).collect::<Vec<_>>());
        for (i, case) in cases.iter().enumerate() {
            let mut client = PinnedMutationAuthorityV1::load_process(
                Path::new(fixture["processConfigurationPath"].as_str().unwrap()),
                fixture["processConfigurationFileHash"].as_str().unwrap(),
            )
            .unwrap();
            let now = canonical_instant_millis(case["now"].as_str().unwrap()).unwrap();
            let actual = match case["operation"].as_str().unwrap() {
                "reserve" => client.reserve_schema_transition(&case["request"], now),
                "finalize" => {
                    let reservation = client
                        .verify_historical_schema_transition_reservation(
                            &case["reservation"],
                            &case["reserveRequest"],
                        )
                        .unwrap();
                    client.finalize_schema_transition(&case["request"], &reservation, now)
                }
                "observe" => client.observe_schema_transition(&case["request"], now),
                _ => panic!("unknown"),
            }
            .unwrap();
            assert_eq!(
                results["results"][i]["ok"], true,
                "version {version}, {}: {}",
                case["label"], results["results"][i]
            );
            assert_eq!(actual.value(), &results["results"][i]["value"]);
        }
        let another = Temp::new();
        let other = make_fixture(&another, version);
        let client = load(&fixture, Raw::new(Value::Null)).unwrap();
        let reservation = client
            .verify_historical_schema_transition_reservation(
                &fixture["base"]["reserve"]["receipt"],
                &fixture["base"]["reserve"]["request"],
            )
            .unwrap();
        let raw = Raw::new(other["base"]["finalize"]["receipt"].clone());
        let calls = raw.calls.clone();
        let mut other_client = load(&other, raw).unwrap();
        assert!(
            other_client
                .finalize_schema_transition(
                    &other["base"]["finalize"]["request"],
                    &reservation,
                    canonical_instant_millis(other["now"].as_str().unwrap()).unwrap()
                )
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn schema_transition_invalid_request_makes_no_rpc_and_transport_cannot_change_pinned_trust() {
    let root = Temp::new();
    let fixture = make_fixture(&root, 1);
    let raw = Raw::new(fixture["base"]["observe"]["receipt"].clone());
    let calls = raw.calls.clone();
    let mut client = load(&fixture, raw).unwrap();
    let mut request = fixture["base"]["observe"]["request"].clone();
    request["nonce"] = json!("bad nonce");
    let now = canonical_instant_millis(fixture["now"].as_str().unwrap()).unwrap();
    assert!(client.observe_schema_transition(&request, now).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let mut raw = Raw::new(fixture["base"]["observe"]["receipt"].clone());
    raw.tamper = Some(PathBuf::from(
        fixture["configurationPath"].as_str().unwrap(),
    ));
    let mut client = load(&fixture, raw).unwrap();
    assert!(
        client
            .observe_schema_transition(&fixture["base"]["observe"]["request"], now)
            .is_err()
    );
}
struct Server {
    child: std::process::Child,
    input: std::process::ChildStdin,
    output: std::io::BufReader<std::process::ChildStdout>,
}
impl Server {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = Command::new("node")
            .arg(root.join("rust/oracle/online-schema-transition-v1.mjs"))
            .arg("--serve")
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = std::io::BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
        }
    }
    fn ask(&mut self, value: &Value) -> Value {
        use std::io::BufRead;
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
        let mut output = String::new();
        self.output.read_line(&mut output).unwrap();
        serde_json::from_str(&output).unwrap()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct LiveTransport {
    server: Arc<std::sync::Mutex<Server>>,
    last_request: Arc<std::sync::Mutex<Option<Value>>>,
    bad_signature: bool,
    change_audit: Option<PathBuf>,
}
impl MutationAuthorityTransportV1 for LiveTransport {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        *self.last_request.lock().unwrap() = Some(request.clone());
        let reply = self.server.lock().unwrap().ask(
            &json!({"operation":"invoke","request":request,"badSignature":self.bad_signature}),
        );
        assert_eq!(reply["ok"], true, "{reply}");
        if let Some(path) = self.change_audit.take() {
            fs::OpenOptions::new()
                .append(true)
                .open(path)
                .unwrap()
                .write_all(b"\n")
                .unwrap();
        }
        Ok(reply["value"].clone())
    }
}
fn actual_runtime(root: &Temp) -> (Value, Arc<std::sync::Mutex<Server>>) {
    let mut server = Server::new();
    let out = server.ask(&json!({"operation":"runtime-fixture","root":root.0}));
    assert_eq!(out["ok"], true, "{out}");
    (
        out["value"].clone(),
        Arc::new(std::sync::Mutex::new(server)),
    )
}
#[test]
fn actual_ten_database_signed_schema_readiness_matches_node_and_retains_current_evidence() {
    use hepta_paper_service::{
        online_schema_transition::inspect_online_schema_transition_readiness_v1,
        state_database_inventory::observe_state_database_inventory_v1,
    };
    let root = Temp::new();
    let (fixture, server) = actual_runtime(&root);
    let runtime = Path::new(fixture["runtimeRoot"].as_str().unwrap());
    let inventory =
        observe_state_database_inventory_v1(runtime, &fixture["stateDatabaseManifest"]).unwrap();
    assert_eq!(inventory.value()["instances"].as_array().unwrap().len(), 10);
    let last = Arc::new(std::sync::Mutex::new(None));
    let mut authority = PinnedMutationAuthorityV1::load(
        Path::new(fixture["configurationPath"].as_str().unwrap()),
        fixture["configurationFileHash"].as_str().unwrap(),
        LiveTransport {
            server: server.clone(),
            last_request: last.clone(),
            bad_signature: false,
            change_audit: None,
        },
    )
    .unwrap();
    let now = canonical_instant_millis(fixture["now"].as_str().unwrap()).unwrap();
    let mut clock = || Ok(now);
    let ready = inspect_online_schema_transition_readiness_v1(
        runtime,
        &inventory,
        &fixture["writerManifest"],
        &mut authority,
        &mut clock,
    )
    .unwrap();
    let request = last.lock().unwrap().clone().unwrap();
    let expected = server
        .lock()
        .unwrap()
        .ask(&json!({"operation":"readiness","nonce":request["nonce"]}));
    assert_eq!(expected["ok"], true, "{expected}");
    assert_eq!(ready.value(), &expected["value"]);
    ready
        .assert_current(&inventory, &authority, &mut || Ok(now))
        .unwrap();
    let rewritten = server
        .lock()
        .unwrap()
        .ask(&json!({"operation":"resign-audit","variant":"numeric-spelling"}));
    assert_eq!(rewritten["ok"], true, "{rewritten}");
    assert!(
        ready
            .assert_current(&inventory, &authority, &mut || Ok(now))
            .is_err()
    );
    let ready = inspect_online_schema_transition_readiness_v1(
        runtime,
        &inventory,
        &fixture["writerManifest"],
        &mut authority,
        &mut clock,
    )
    .unwrap();
    let request = last.lock().unwrap().clone().unwrap();
    let numeric_expected = server
        .lock()
        .unwrap()
        .ask(&json!({"operation":"readiness","nonce":request["nonce"]}));
    assert_eq!(
        numeric_expected["ok"], true,
        "Node numeric spelling {numeric_expected}"
    );
    assert_eq!(ready.value(), &numeric_expected["value"]);
    assert!(
        ready
            .assert_current(&inventory, &authority, &mut || Ok(now + 60000))
            .is_err()
    );
    let audit = runtime.join("autonomous-research/online-schema-transition/FINAL.json");
    fs::OpenOptions::new()
        .append(true)
        .open(audit)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    assert!(
        ready
            .assert_current(&inventory, &authority, &mut || Ok(now))
            .is_err()
    );
}
#[test]
fn actual_schema_readiness_rejects_spliced_signatures_raw_member_drift_filesystem_and_late_rpc() {
    use hepta_paper_service::{
        online_schema_transition::inspect_online_schema_transition_readiness_v1,
        state_database_inventory::observe_state_database_inventory_v1,
    };
    use nix::{sys::stat::Mode, unistd::mkfifo};
    for variant in [
        "signature",
        "splice-observation",
        "reorder-instances",
        "symlink",
        "fifo",
        "hardlink",
        "unsafe-control",
        "audit-permission",
        "duplicate-json",
        "database-drift",
        "rpc-expiry",
        "rpc-bad-signature",
        "audit-during-rpc",
    ] {
        let root = Temp::new();
        let (fixture, server) = actual_runtime(&root);
        let runtime = Path::new(fixture["runtimeRoot"].as_str().unwrap());
        let inventory =
            observe_state_database_inventory_v1(runtime, &fixture["stateDatabaseManifest"])
                .unwrap();
        let audit = runtime.join("autonomous-research/online-schema-transition/FINAL.json");
        if ["signature", "splice-observation", "reorder-instances"].contains(&variant) {
            let out = server
                .lock()
                .unwrap()
                .ask(&json!({"operation":"resign-audit","variant":variant}));
            assert_eq!(out["ok"], true, "{out}");
            let node = server
                .lock()
                .unwrap()
                .ask(&json!({"operation":"readiness","nonce":"schema-transition:comparison"}));
            assert_eq!(
                node["ok"],
                variant == "splice-observation",
                "Node source comparison {variant}: {node}"
            );
        } else if variant == "symlink" {
            let renamed = audit.with_extension("original");
            fs::rename(&audit, &renamed).unwrap();
            std::os::unix::fs::symlink(renamed, &audit).unwrap();
        } else if variant == "fifo" {
            fs::remove_file(&audit).unwrap();
            mkfifo(&audit, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
        } else if variant == "hardlink" {
            fs::hard_link(&audit, root.0.join("audit-alias.json")).unwrap();
        } else if variant == "unsafe-control" {
            fs::set_permissions(audit.parent().unwrap(), fs::Permissions::from_mode(0o777))
                .unwrap();
        } else if variant == "audit-permission" {
            fs::set_permissions(&audit, fs::Permissions::from_mode(0o666)).unwrap();
        } else if variant == "duplicate-json" {
            let bytes = fs::read_to_string(&audit).unwrap();
            fs::write(&audit, format!("{{\"version\":1,{}", &bytes[1..])).unwrap();
        } else if variant == "database-drift" {
            let path = runtime.join(
                inventory.value()["instances"][0]["sourceRelativePath"]
                    .as_str()
                    .unwrap(),
            );
            fs::OpenOptions::new()
                .append(true)
                .open(path)
                .unwrap()
                .write_all(b"changed")
                .unwrap();
        }
        let last = Arc::new(std::sync::Mutex::new(None));
        let mut authority = PinnedMutationAuthorityV1::load(
            Path::new(fixture["configurationPath"].as_str().unwrap()),
            fixture["configurationFileHash"].as_str().unwrap(),
            LiveTransport {
                server: server.clone(),
                last_request: last.clone(),
                bad_signature: variant == "rpc-bad-signature",
                change_audit: (variant == "audit-during-rpc").then_some(audit),
            },
        )
        .unwrap();
        let now = canonical_instant_millis(fixture["now"].as_str().unwrap()).unwrap();
        let mut count = 0;
        let mut clock = || {
            count += 1;
            Ok(now
                + if variant == "rpc-expiry" && count >= 3 {
                    60000
                } else {
                    0
                })
        };
        let actual = inspect_online_schema_transition_readiness_v1(
            runtime,
            &inventory,
            &fixture["writerManifest"],
            &mut authority,
            &mut clock,
        );
        assert!(actual.is_err(), "{variant} must refuse");
        let code = actual.err().unwrap().code;
        match variant {
            "signature" | "splice-observation" | "reorder-instances" | "fifo" | "hardlink"
            | "unsafe-control" | "audit-permission" | "duplicate-json" => {
                assert_eq!(
                    code, "autonomous_research_online_schema_transition_audit_receipt_invalid",
                    "{variant}"
                )
            }
            "rpc-expiry" | "rpc-bad-signature" => assert_eq!(
                code, "autonomous_research_online_schema_transition_observation_invalid",
                "{variant}"
            ),
            "audit-during-rpc" => assert_eq!(
                code, "autonomous_research_online_schema_transition_audit_changed",
                "{variant}"
            ),
            "database-drift" => assert_eq!(
                code,
                "autonomous_research_state_database_changed_during_snapshot"
            ),
            "symlink" => assert_eq!(code, "autonomous_research_state_database_inventory_changed"),
            _ => panic!("unknown"),
        }
        assert_eq!(
            last.lock().unwrap().is_some(),
            variant.starts_with("rpc-") || variant == "audit-during-rpc",
            "{variant} RPC boundary"
        );
    }
}

#[test]
fn real_schema_readiness_checks_final_pinned_io_age_and_clock_without_extra_rpc() {
    use hepta_paper_service::{
        online_schema_transition::inspect_online_schema_transition_readiness_v1,
        state_database_inventory::observe_state_database_inventory_v1,
    };
    use sha2::{Digest, Sha256};
    let root = Temp::new();
    let (fixture, server) = actual_runtime(&root);
    let runtime = Path::new(fixture["runtimeRoot"].as_str().unwrap());
    let inventory =
        observe_state_database_inventory_v1(runtime, &fixture["stateDatabaseManifest"]).unwrap();
    // Pin a real stricter trust document: all historical and live receipts are
    // still produced and signed by the original authority in its own process.
    let path = Path::new(fixture["configurationPath"].as_str().unwrap());
    let mut configuration: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    configuration["maximumObservationAgeMs"] = json!(1000);
    let bytes = serde_json::to_vec(&configuration).unwrap();
    fs::write(path, &bytes).unwrap();
    let pin = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
    let last = Arc::new(std::sync::Mutex::new(None));
    let mut authority = PinnedMutationAuthorityV1::load(
        path,
        &pin,
        LiveTransport {
            server: server.clone(),
            last_request: last.clone(),
            bad_signature: false,
            change_audit: None,
        },
    )
    .unwrap();
    let now = canonical_instant_millis(fixture["now"].as_str().unwrap()).unwrap();
    let ready = inspect_online_schema_transition_readiness_v1(
        runtime,
        &inventory,
        &fixture["writerManifest"],
        &mut authority,
        &mut || Ok(now),
    )
    .unwrap();
    let expires = canonical_instant_millis(ready.value()["expiresAt"].as_str().unwrap()).unwrap();
    assert!(expires > now + 1001, "age rejection must precede expiry");
    ready
        .assert_current(&inventory, &authority, &mut || Ok(now + 1000))
        .unwrap();
    let prior_request = last.lock().unwrap().clone();
    for (values, code) in [
        (
            [now + 1000, now + 1001],
            "autonomous_research_online_schema_transition_observation_invalid",
        ),
        (
            [now + 1, now],
            "autonomous_research_online_schema_transition_readiness_clock_invalid",
        ),
        (
            [now - 1, now - 1],
            "autonomous_research_online_schema_transition_readiness_clock_invalid",
        ),
    ] {
        let mut samples = values.into_iter();
        let error = ready
            .assert_current(&inventory, &authority, &mut || {
                Ok(samples.next().unwrap_or(values[1]))
            })
            .expect_err("late or rolling-back proof must fail");
        assert_eq!(error.code, code);
        assert_eq!(
            *last.lock().unwrap(),
            prior_request,
            "retained checks invoke no transport"
        );
    }
    for (values, code) in [
        (
            [now, now, now + 1000, now + 1001],
            "autonomous_research_online_schema_transition_observation_invalid",
        ),
        (
            [now, now, now + 1, now],
            "autonomous_research_online_schema_transition_readiness_clock_invalid",
        ),
        (
            [now, now - 1, now - 1, now - 1],
            "autonomous_research_online_schema_transition_readiness_clock_invalid",
        ),
    ] {
        *last.lock().unwrap() = None;
        let mut samples = values.into_iter();
        let error = inspect_online_schema_transition_readiness_v1(
            runtime,
            &inventory,
            &fixture["writerManifest"],
            &mut authority,
            &mut || Ok(samples.next().unwrap_or(values[3])),
        )
        .err()
        .expect("final construction must reject stale or rolling-back evidence");
        assert_eq!(error.code, code);
        assert_eq!(
            last.lock().unwrap().is_some(),
            values[1] >= values[0],
            "rollback before RPC has zero external action"
        );
    }
}
