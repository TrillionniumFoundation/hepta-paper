//! Actual ten-file runtime and original full writer tree with signed synthetic
//! authority responses. No production key, process, or activation is involved.
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_paper_service::{
    online_runtime_activation::{
        active_refresh::refresh_online_authority_evidence_v1,
        finalized_inventory::inspect_online_finalized_inventory_v1,
    },
    online_writer_static::verify_online_writer_static_coverage_v1,
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::iso,
        contracts::online_mutation_signed_payload_v1,
    },
    state_database_inventory::observe_state_database_inventory_v1,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
const NOW: i64 = 1_789_560_000_000;
static NEXT: AtomicU64 = AtomicU64::new(0);
fn hash(kind: &str, v: &Value) -> String {
    hepta_legacy_compatibility::production_hash_record_v1(kind, v)
        .unwrap()
        .as_str()
        .into()
}
fn h(label: &str) -> String {
    hash("StateBackupCliNativeFixture", &json!({"label":label}))
}
fn pin(path: &Path) -> String {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(fs::read(path).unwrap()))
    )
}
fn oracle(name: &str, input: &Value) -> Value {
    let mut child = Command::new("node")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../oracle")
                .join(name),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"]).unwrap();
    result
}
struct Fixture {
    root: PathBuf,
    value: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-backup-cli-e2e-finalized-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let value = oracle(
            "state-safety-composition-v1.mjs",
            &json!({"mode":"fixture","root":root}),
        );
        assert_eq!(value["ok"], true, "{}", value["error"]);
        Self {
            root,
            value: value["value"].clone(),
        }
    }
    fn path(&self, key: &str) -> PathBuf {
        self.value[key].as_str().unwrap().into()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[derive(Default)]
struct State {
    calls: Vec<Value>,
    fault: String,
    fault_at: usize,
    mutation_path: Option<PathBuf>,
}
struct Broker {
    inventory: Value,
    state: Arc<Mutex<State>>,
}
impl MutationAuthorityTransportV1 for Broker {
    fn invoke(&mut self, q: &Value) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        let mut r = json!({"version":1,"authorityId":"authority:cli","keyId":"key:cli","requestHash":hash(q["kind"].as_str().unwrap(),q),"protocol":q["protocol"],"scopeId":q["scopeId"],"databaseScopeHash":q["databaseScopeHash"],"writerManifestHash":q["writerManifestHash"],"globalSequence":0,"globalHash":h("global:0"),"expiresAt":iso(NOW+60000).unwrap()});
        let heads=json!(self.inventory["instances"].as_array().unwrap().iter().map(|i|json!({"databaseRole":i["role"],"databaseInstanceId":i["instanceId"],"sequence":0,"hash":h(&format!("database:{}:0",i["instanceId"].as_str().unwrap())),"schemaHash":i["schemaHash"],"stateHash":h(&format!("state:{}:0",i["instanceId"].as_str().unwrap()))})).collect::<Vec<_>>());
        match q["kind"].as_str().unwrap() {
            "AutonomousResearchOnlineMutationCurrentHeadRequest" => {
                r["kind"] = json!("AutonomousResearchOnlineMutationCurrentHeadReceipt");
                r["status"] = json!("autonomous_research_online_mutation_current_head_observed");
                r["databaseHeads"] = heads;
                r["unresolvedReservationCount"] = json!(0);
                r["observedAt"] = json!(iso(NOW).unwrap());
            }
            "AutonomousResearchOnlineMutationActiveChallengeRequest" => {
                r["kind"] = json!("AutonomousResearchOnlineMutationActiveChallengeReceipt");
                r["status"] =
                    json!("autonomous_research_online_mutation_active_challenge_verified");
                r["databaseHeads"] = heads;
                r["challengeNonce"] = q["challengeNonce"].clone();
                r["challengedAt"] = json!(iso(NOW).unwrap());
            }
            "AutonomousResearchOnlineMutationScopeRequest" => {
                r["kind"] = json!("AutonomousResearchOnlineMutationScopeReceipt");
                r["status"] = json!("autonomous_research_online_mutation_scope_observed");
                r["observedAt"] = json!(iso(NOW).unwrap());
                for key in [
                    "staticInspectionReceiptHash",
                    "astGateReceiptHash",
                    "codeProvenanceHash",
                    "operationCount",
                    "operationIds",
                    "requiredDatabaseRoles",
                    "coveredDatabaseRoles",
                ] {
                    r[key] = q[key].clone();
                }
            }
            _ => panic!("unexpected authority RPC"),
        }
        if state.calls.len() == state.fault_at {
            if state.fault == "head" {
                r["globalHash"] = json!(h("other-global"));
                r["globalSequence"] = json!(1);
            }
            if state.fault == "other-database" {
                r["databaseHeads"][9]["hash"] = json!(h("other-database"));
            }
            if state.fault == "source" {
                fs::write(
                    state.mutation_path.as_ref().unwrap(),
                    "source added during authority RPC",
                )
                .unwrap();
            }
        }
        r["signature"] = json!(Base64::encode_string(
            &SigningKey::from_bytes(&[92; 32])
                .sign(online_mutation_signed_payload_v1(&r)?.as_bytes())
                .to_bytes()
        ));
        if state.calls.len() == state.fault_at && state.fault == "signature" {
            r["signature"] = json!("invalid");
        }
        state.calls.push(json!({"request":q,"receipt":r}));
        Ok(r)
    }
}
#[test]
fn actual_ten_database_heads_match_original_node_and_retain_current_proof_without_rpc_or_source_writes()
 {
    let f = Fixture::new();
    let inventory =
        observe_state_database_inventory_v1(&f.path("runtime"), &f.value["manifest"]).unwrap();
    let source =
        verify_online_writer_static_coverage_v1(&f.path("workspace"), &f.value["writerManifest"])
            .unwrap();
    let state = Arc::new(Mutex::new(State::default()));
    let mut authority = PinnedMutationAuthorityV1::load(
        &f.path("onlineConfiguration"),
        &pin(&f.path("onlineConfiguration")),
        Broker {
            inventory: inventory.value().clone(),
            state: state.clone(),
        },
    )
    .unwrap();
    let evidence = refresh_online_authority_evidence_v1(
        inventory.value(),
        &f.value["writerManifest"],
        &mut authority,
        &source,
        &mut || Ok(NOW),
        1,
    )
    .unwrap();
    let mut samples = 0;
    let proof = inspect_online_finalized_inventory_v1(
        &inventory,
        &f.value["writerManifest"],
        &mut authority,
        &source,
        &evidence,
        &mut || {
            samples += 1;
            Ok(NOW)
        },
    )
    .unwrap();
    eprintln!("ten native finalized inspections completed");
    assert_eq!(proof.database_inspections().len(), 10);
    assert_eq!(proof.value()["runtimeReady"], false);
    assert_eq!(state.lock().unwrap().calls.len(), 13);
    let records = state.lock().unwrap().calls[3..].to_vec();
    let key: Value =
        serde_json::from_slice(&fs::read(f.root.join("online-public.json")).unwrap()).unwrap();
    let compared = oracle(
        "online-finalized-inventory-v1.mjs",
        &json!({"root":f.root,"inventory":inventory.value(),"manifest":f.value["writerManifest"],"trust":authority.trust(),"publicKeyPem":key["publicKeyPem"],"now":iso(NOW).unwrap(),"records":records}),
    );
    for (native, node) in proof
        .database_inspections()
        .iter()
        .zip(compared["results"].as_array().unwrap())
    {
        assert_eq!(node["ok"], true, "{node}");
        assert_eq!(native.value(), &node["value"]);
    }
    eprintln!("all ten original Node receipts match");
    inventory.assert_current().unwrap();
    proof
        .assert_current(&inventory, &authority, &source, &evidence, &mut || Ok(NOW))
        .unwrap();
    assert_eq!(state.lock().unwrap().calls.len(), 13);
    let mut current = 0;
    let expired = inspect_online_finalized_inventory_v1(
        &inventory,
        &f.value["writerManifest"],
        &mut authority,
        &source,
        &evidence,
        &mut || {
            current += 1;
            Ok(if current == samples { NOW + 60000 } else { NOW })
        },
    );
    assert!(expired.is_err());
    assert_eq!(current, samples);
    eprintln!("final constructor clock expiry rejected");
    for (fault, offset) in [
        ("head", 9),
        ("signature", 5),
        ("other-database", 0),
        ("source", 3),
    ] {
        {
            let mut state = state.lock().unwrap();
            state.fault = fault.into();
            state.fault_at = state.calls.len() + offset;
            state.mutation_path = Some(
                f.path("workspace")
                    .join("paper-adapters/added-during-rpc.txt"),
            );
        }
        let error = inspect_online_finalized_inventory_v1(
            &inventory,
            &f.value["writerManifest"],
            &mut authority,
            &source,
            &evidence,
            &mut || Ok(NOW),
        )
        .err()
        .unwrap();
        assert!(
            error.code.contains(match fault {
                "signature" => "invalid",
                "source" => "source_changed",
                _ => "head_unstable",
            }),
            "{}",
            error.code
        );
        if fault == "source" {
            fs::remove_file(
                f.path("workspace")
                    .join("paper-adapters/added-during-rpc.txt"),
            )
            .unwrap();
        }
    }
    {
        state.lock().unwrap().fault.clear();
    }
    let mut count = 0;
    assert!(
        inspect_online_finalized_inventory_v1(
            &inventory,
            &f.value["writerManifest"],
            &mut authority,
            &source,
            &evidence,
            &mut || {
                count += 1;
                Ok(if count == 3 { NOW + 1 } else { NOW })
            }
        )
        .is_err()
    );
    inventory.assert_current().unwrap();
    fs::write(
        f.path("workspace")
            .join("paper-adapters/new-proof-input.txt"),
        "unscanned? no",
    )
    .unwrap();
    assert!(
        proof
            .assert_current(&inventory, &authority, &source, &evidence, &mut || Ok(NOW))
            .is_err()
    );
    fs::remove_file(
        f.path("workspace")
            .join("paper-adapters/new-proof-input.txt"),
    )
    .unwrap();
    eprintln!("signed head, clock, and source drift negatives completed");
    let physical_proof = inspect_online_finalized_inventory_v1(
        &inventory,
        &f.value["writerManifest"],
        &mut authority,
        &source,
        &evidence,
        &mut || Ok(NOW),
    )
    .unwrap();
    // Final time sampling must cover all pin/source/SQLite I/O.
    let mut checked = 0;
    assert!(
        proof
            .assert_current(&inventory, &authority, &source, &evidence, &mut || {
                checked += 1;
                Ok(if checked == 1 { NOW } else { NOW + 60000 })
            })
            .is_err()
    );
    let error = proof
        .assert_current(&inventory, &authority, &source, &evidence, &mut || Ok(NOW))
        .err()
        .unwrap();
    assert!(error.code.ends_with("clock_invalid"), "{}", error.code);
    let instance = &inventory.value()["instances"][9];
    let database = rusqlite::Connection::open(
        f.path("runtime")
            .join(instance["sourceRelativePath"].as_str().unwrap()),
    )
    .unwrap();
    database
        .execute("UPDATE records SET value='changed'", [])
        .unwrap();
    drop(database);
    assert!(
        physical_proof
            .assert_current(&inventory, &authority, &source, &evidence, &mut || Ok(NOW))
            .is_err()
    );
}
