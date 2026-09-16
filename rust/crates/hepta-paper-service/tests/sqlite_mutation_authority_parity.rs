//! Only public synthetic trust documents and signed test receipts are persisted.
use hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis;
use hepta_paper_service::sqlite_mutation_coordinator::{
    Result,
    authority::{
        MutationAuthorityTransportV1, PinnedMutationAuthorityV1,
        ProcessMutationAuthorityTransportV1,
    },
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-sqlite-authority-rust-{}-{}",
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
        .arg(root.join("rust/oracle/sqlite-mutation-authority-v1.mjs"))
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
fn fixture(root: &Temp, size: usize) -> Value {
    let out = oracle(&[json!({"operation":"fixture","root":root.0,"size":size})]);
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
fn native(fixture: &Value, case: &Value) -> Result<Option<Value>> {
    let mut client = load(fixture, Raw::new(case["receipt"].clone()))?;
    let request = &case["request"];
    let now = canonical_instant_millis(case["now"].as_str().unwrap()).unwrap();
    let receipt = match case["operation"].as_str().unwrap() {
        "head" => client.observe_current_head(request, Some(&case["expectedInstances"]), now)?,
        "reserve" => client.reserve_mutation(request, now)?,
        "finalize" | "abort" => {
            let reservation =
                client.verify_stored_reservation(&case["reservation"], &case["reserveRequest"])?;
            if case["operation"] == "finalize" {
                client.finalize_mutation(request, &reservation, now)?
            } else {
                client.abort_mutation(request, &reservation, now)?
            }
        }
        _ => {
            return client
                .resolve_mutation_attempt(request, &case["reserveRequest"], now)
                .map(|r| r.map(|r| r.value().clone()));
        }
    };
    Ok(Some(receipt.value().clone()))
}
#[test]
fn opaque_receipts_match_node_real_signatures_domains_bindings_and_leases() {
    let root = Temp::new();
    let fixture = fixture(&root, 8);
    let cases = fixture["cases"].as_array().unwrap();
    let requests=cases.iter().map(|case|json!({"operation":"verify","configurationPath":fixture["configurationPath"],"case":case})).collect::<Vec<_>>();
    let expected = oracle(&requests);
    for (index, case) in cases.iter().enumerate() {
        let actual = native(&fixture, case);
        let accepted = actual.is_ok();
        let node = &expected["results"][index];
        assert_eq!(
            accepted,
            node["ok"] == true && node["accepted"] == true,
            "{} native error {:?}, Node {node}",
            case["label"],
            actual.err().map(|e| e.to_string())
        );
    }
}
#[test]
fn process_transport_matches_node_for_every_coordinator_action() {
    let root = Temp::new();
    let fixture = fixture(&root, 8);
    let cases = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["label"].as_str().unwrap().ends_with("-valid"))
        .collect::<Vec<_>>();
    let expected=oracle(&cases.iter().map(|case|json!({"operation":"process","processConfigurationPath":fixture["processConfigurationPath"],"case":case})).collect::<Vec<_>>());
    for (index, case) in cases.into_iter().enumerate() {
        let mut client = PinnedMutationAuthorityV1::load_process(
            Path::new(fixture["processConfigurationPath"].as_str().unwrap()),
            fixture["processConfigurationFileHash"].as_str().unwrap(),
        )
        .unwrap();
        let now = canonical_instant_millis(case["now"].as_str().unwrap()).unwrap();
        let request = &case["request"];
        let actual = match case["operation"].as_str().unwrap() {
            "head" => Some(
                client
                    .observe_current_head(request, Some(&case["expectedInstances"]), now)
                    .unwrap()
                    .value()
                    .clone(),
            ),
            "reserve" => Some(
                client
                    .reserve_mutation(request, now)
                    .unwrap()
                    .value()
                    .clone(),
            ),
            "finalize" | "abort" => {
                let reservation = client
                    .verify_stored_reservation(&case["reservation"], &case["reserveRequest"])
                    .unwrap();
                let result = if case["operation"] == "finalize" {
                    client.finalize_mutation(request, &reservation, now)
                } else {
                    client.abort_mutation(request, &reservation, now)
                };
                Some(result.unwrap().value().clone())
            }
            _ => client
                .resolve_mutation_attempt(request, &case["reserveRequest"], now)
                .unwrap()
                .map(|r| r.value().clone()),
        };
        assert_eq!(expected["results"][index]["ok"], true, "{expected}");
        assert_eq!(json!(actual), expected["results"][index]["value"]);
    }
}
#[test]
fn snapshots_wrong_keys_and_unvalidated_transports_cannot_forge_receipts() {
    let root = Temp::new();
    let fixture = fixture(&root, 8);
    let raw = Raw::new(json!({"verified":true,"ready":true}));
    let calls = raw.calls.clone();
    let mut client = load(&fixture, raw).unwrap();
    let case = &fixture["cases"][0];
    let now = canonical_instant_millis(case["now"].as_str().unwrap()).unwrap();
    assert!(
        client
            .observe_current_head(&case["request"], Some(&case["expectedInstances"]), now)
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let mut invalid = case["request"].clone();
    invalid["scopeId"] = json!("scope:wrong");
    assert!(
        client
            .observe_current_head(&invalid, Some(&case["expectedInstances"]), now)
            .is_err()
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "invalid scoped request must not reach transport"
    );
    let source = PinnedMutationAuthorityV1::load_process(
        Path::new(fixture["processConfigurationPath"].as_str().unwrap()),
        fixture["processConfigurationFileHash"].as_str().unwrap(),
    )
    .unwrap();
    let reserve = &fixture["base"]["reserve"];
    let verified = source
        .verify_stored_reservation(&reserve["receipt"], &reserve["request"])
        .unwrap();
    let second_root = Temp::new();
    let second = fixture_fn(&second_root);
    let raw = Raw::new(second["base"]["finalize"]["receipt"].clone());
    let calls = raw.calls.clone();
    let mut other = load(&second, raw).unwrap();
    assert!(
        other
            .finalize_mutation(&fixture["base"]["finalize"]["request"], &verified, now)
            .is_err()
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "cross-verifier opaque reservation must not reach transport"
    );
    let mut raw = Raw::new(case["receipt"].clone());
    raw.tamper = Some(PathBuf::from(
        fixture["configurationPath"].as_str().unwrap(),
    ));
    let mut client = load(&fixture, raw).unwrap();
    let failure = client
        .observe_current_head(&case["request"], Some(&case["expectedInstances"]), now)
        .err()
        .unwrap();
    assert_eq!(
        failure.code,
        "autonomous_research_online_mutation_authority_process_identity_changed"
    );
}
fn fixture_fn(root: &Temp) -> Value {
    fixture(root, 8)
}
fn hash_file(path: &Path) -> String {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(fs::read(path).unwrap()))
    )
}
#[test]
fn pinned_public_inputs_reject_aliases_duplicates_permissions_and_identity_changes() {
    for mode in [
        "wrong-config-pin",
        "duplicate-config",
        "public-symlink",
        "public-hardlink",
        "public-writable",
        "private-material",
        "invalid-public-pem",
        "duplicate-public",
        "wrong-key-identity",
        "wrong-public-pin",
        "command-changed",
    ] {
        let root = Temp::new();
        let fixture = fixture(&root, 8);
        let config = PathBuf::from(fixture["configurationPath"].as_str().unwrap());
        let public = PathBuf::from(fixture["publicKeyPath"].as_str().unwrap());
        let mut pin = fixture["configurationFileHash"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut document: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        match mode {
            "wrong-config-pin" => pin = format!("sha256:{}", "0".repeat(64)),
            "duplicate-config" => {
                let text = fs::read_to_string(&config).unwrap();
                fs::write(&config, text.replacen('{', "{\"version\":1,", 1)).unwrap();
                pin = hash_file(&config);
            }
            "public-symlink" => {
                let moved = public.with_extension("held");
                fs::rename(&public, &moved).unwrap();
                symlink(moved, &public).unwrap();
            }
            "public-hardlink" => fs::hard_link(&public, public.with_extension("alias")).unwrap(),
            "public-writable" => {
                fs::set_permissions(&public, fs::Permissions::from_mode(0o620)).unwrap()
            }
            "private-material" | "invalid-public-pem" | "duplicate-public"
            | "wrong-key-identity" => {
                let mut value: Value = serde_json::from_slice(&fs::read(&public).unwrap()).unwrap();
                match mode {
                    "private-material" => {
                        value["privateKeyPem"] = json!("synthetic forbidden marker")
                    }
                    "invalid-public-pem" => {
                        value["publicKeyPem"] = json!(
                            value["publicKeyPem"]
                                .as_str()
                                .unwrap()
                                .replacen("MCow", "MC!ow", 1)
                        )
                    }
                    "wrong-key-identity" => value["keyId"] = json!("key:other"),
                    _ => {}
                }
                let mut bytes = value.to_string();
                if mode == "duplicate-public" {
                    bytes = bytes.replacen('{', "{\"version\":1,", 1);
                }
                fs::write(&public, bytes).unwrap();
                document["publicKeySha256"] = json!(hash_file(&public));
                fs::write(&config, document.to_string()).unwrap();
                pin = hash_file(&config);
            }
            "wrong-public-pin" => {
                document["publicKeySha256"] = json!(format!("sha256:{}", "0".repeat(64)));
                fs::write(&config, document.to_string()).unwrap();
                pin = hash_file(&config);
            }
            _ => {
                let process = Path::new(fixture["processConfigurationPath"].as_str().unwrap());
                let mut client = PinnedMutationAuthorityV1::load_process(
                    process,
                    fixture["processConfigurationFileHash"].as_str().unwrap(),
                )
                .unwrap();
                fs::write(
                    fixture["commandPath"].as_str().unwrap(),
                    "#!/bin/sh\nexit 0\n",
                )
                .unwrap();
                let case = &fixture["cases"][0];
                assert!(
                    client
                        .observe_current_head(
                            &case["request"],
                            Some(&case["expectedInstances"]),
                            canonical_instant_millis(case["now"].as_str().unwrap()).unwrap()
                        )
                        .is_err()
                );
                continue;
            }
        }
        assert!(
            PinnedMutationAuthorityV1::load(&config, &pin, Raw::new(Value::Null)).is_err(),
            "{mode}"
        );
    }
}
#[test]
fn process_invalid_json_timeout_and_escaped_pipe_holder_are_bounded() {
    for mode in [
        "invalid-json",
        "duplicate-json",
        "nonzero",
        "timeout",
        "escaped-pipe",
    ] {
        let root = Temp::new();
        let fixture = fixture(&root, 8);
        let command = Path::new(fixture["commandPath"].as_str().unwrap());
        let body = match mode {
            "invalid-json" => "print('not json')",
            "duplicate-json" => "print('{\"version\":1,\"version\":2}')",
            "nonzero" => "sys.exit(9)",
            "timeout" => "time.sleep(30)",
            _ => {
                "pid=os.fork()\nif pid==0:\n os.setsid()\n time.sleep(2)\n os._exit(0)\nprint('{}')"
            }
        };
        fs::write(
            command,
            format!("#!/usr/bin/python3\nimport sys,time,os\n{body}\n"),
        )
        .unwrap();
        let path = Path::new(fixture["processConfigurationPath"].as_str().unwrap());
        let mut document: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        document["commandSha256"] = json!(hash_file(command));
        fs::write(path, document.to_string()).unwrap();
        let mut transport =
            ProcessMutationAuthorityTransportV1::load(path, &hash_file(path)).unwrap();
        let start = Instant::now();
        let result = transport.invoke(&json!({}));
        assert!(result.is_err(), "{mode}");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "{mode} blocked its transport"
        );
    }
}

#[test]
fn persisted_receipts_verify_at_recorded_time_without_renewing_the_live_lease() {
    let root = Temp::new();
    let fixture = fixture(&root, 8);
    let reserve = &fixture["base"]["reserve"];
    let finalize = &fixture["base"]["finalize"];
    let mut client = load(&fixture, Raw::new(reserve["receipt"].clone())).unwrap();
    let later = canonical_instant_millis("2026-09-17T12:00:00.000Z").unwrap();
    assert!(client.reserve_mutation(&reserve["request"], later).is_err());
    let reservation = client
        .verify_stored_reservation(&reserve["receipt"], &reserve["request"])
        .unwrap();
    let finalization = client
        .verify_stored_finalization(&finalize["receipt"], &finalize["request"], &reservation)
        .unwrap();
    assert_eq!(finalization.value(), &finalize["receipt"]);
    let mut corrupted = finalize["receipt"].clone();
    corrupted["signature"] = json!("invalid");
    assert!(
        client
            .verify_stored_finalization(&corrupted, &finalize["request"], &reservation)
            .is_err()
    );
    let mut changed_request = reserve["request"].clone();
    changed_request["mutationAttemptId"] = json!("attempt:other");
    assert!(
        client
            .verify_stored_reservation(&reserve["receipt"], &changed_request)
            .is_err()
    );
}
#[test]
fn process_transport_handles_real_signed_multi_megabyte_changesets_and_clean_environment() {
    let root = Temp::new();
    let fixture = fixture(&root, 3 * 1024 * 1024);
    let reserve = &fixture["base"]["reserve"];
    let case = json!({"operation":"reserve","request":reserve["request"],"receipt":reserve["receipt"],"now":fixture["now"]});
    let expected = oracle(&[
        json!({"operation":"process","processConfigurationPath":fixture["processConfigurationPath"],"case":case}),
    ]);
    assert_eq!(expected["results"][0]["ok"], true);
    let path = Path::new(fixture["processConfigurationPath"].as_str().unwrap());
    let mut client = PinnedMutationAuthorityV1::load_process(
        path,
        fixture["processConfigurationFileHash"].as_str().unwrap(),
    )
    .unwrap();
    let now = canonical_instant_millis(fixture["now"].as_str().unwrap()).unwrap();
    let receipt = client.reserve_mutation(&reserve["request"], now).unwrap();
    assert_eq!(receipt.value(), &expected["results"][0]["value"]);
    let command = Path::new(fixture["commandPath"].as_str().unwrap());
    fs::write(command, "#!/usr/bin/python3\nimport os,json,sys\njson.load(sys.stdin)\nprint(json.dumps(dict(os.environ)))\n").unwrap();
    let mut config: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    config["commandSha256"] = json!(hash_file(command));
    fs::write(path, config.to_string()).unwrap();
    let mut transport = ProcessMutationAuthorityTransportV1::load(path, &hash_file(path)).unwrap();
    assert_eq!(
        transport.invoke(&json!({})).unwrap(),
        json!({"PATH":"/usr/bin:/bin","LANG":"C","LC_ALL":"C"})
    );
}
