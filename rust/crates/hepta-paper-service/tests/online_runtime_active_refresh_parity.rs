use base64ct::{Base64, Encoding};
use ed25519_dalek::{
    Signer, SigningKey,
    pkcs8::{EncodePublicKey, spki::der::pem::LineEnding},
};
use hepta_paper_service::{
    online_runtime_activation::active_refresh::refresh_online_authority_evidence_v1,
    online_writer_static::verify_online_writer_static_coverage_v1,
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::iso,
        contracts::online_mutation_signed_payload_v1,
    },
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
        atomic::{AtomicI64, Ordering},
    },
};
const NOW: i64 = 1784365200000;
fn hash(kind: &str, value: &Value) -> String {
    hepta_legacy_compatibility::production_hash_record_v1(kind, value)
        .unwrap()
        .as_str()
        .into()
}
fn bytehash(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
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
    serde_json::from_slice(&output.stdout).unwrap()
}
struct Fixture {
    root: PathBuf,
    manifest: Value,
    inventory: Value,
    key: SigningKey,
    configuration: PathBuf,
    pin: String,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-native-active-refresh-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let data = oracle(
            "online-runtime-activation-v1.mjs",
            &json!({"mode":"fixture"}),
        );
        let manifest = data["manifest"].clone();
        let inventory = data["inventory"].clone();
        let config: Value =
            serde_json::from_str(include_str!("../src/online_writer_static/config.json")).unwrap();
        for relative in config["PROVENANCE_ONLY_SOURCES"].as_array().unwrap() {
            let path = root.join(relative.as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "// Synthetic test provenance only.\n").unwrap();
        }
        for operation in manifest["operations"].as_array().unwrap() {
            let path = root.join(operation["sourceFile"].as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path,format!("export function {}(db){{return db.executeMutation({{databaseRole:{},operationId:{},mutate:(tx)=>tx.run('statement:one')}});}}",operation["entrypoint"].as_str().unwrap(),operation["databaseRole"],operation["operationId"])).unwrap();
        }
        let key = SigningKey::from_bytes(&[42; 32]);
        let public = root.join("public.json");
        let document = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityPublicKey","authorityId":"authority:test","keyId":"key:test","algorithm":"ed25519","publicKeyPem":key.verifying_key().to_public_key_pem(LineEnding::LF).unwrap()});
        fs::write(&public, document.to_string()).unwrap();
        fs::set_permissions(&public, fs::Permissions::from_mode(0o600)).unwrap();
        let config = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityConfiguration","authorityId":"authority:test","keyId":"key:test","scopeId":"scope:test","databaseScopeHash":inventory["databaseScopeHash"],"writerManifestHash":hash("AutonomousResearchOnlineWriterCoverageManifest",&manifest),"publicKeyPath":public,"publicKeySha256":bytehash(&fs::read(&public).unwrap()),"maximumReservationLeaseMs":60000,"maximumObservationAgeMs":60000});
        let configuration = root.join("authority.json");
        fs::write(&configuration, config.to_string()).unwrap();
        fs::set_permissions(&configuration, fs::Permissions::from_mode(0o600)).unwrap();
        let pin = bytehash(&fs::read(&configuration).unwrap());
        Self {
            root,
            manifest,
            inventory,
            key,
            configuration,
            pin,
        }
    }
    fn authority(
        &self,
        mode: &str,
        time: Arc<AtomicI64>,
    ) -> (PinnedMutationAuthorityV1<Broker>, Arc<Mutex<Vec<Value>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let raw = Broker {
            key: self.key.clone(),
            inventory: self.inventory.clone(),
            calls: calls.clone(),
            mode: mode.into(),
            time,
        };
        (
            PinnedMutationAuthorityV1::load(&self.configuration, &self.pin, raw).unwrap(),
            calls,
        )
    }
    fn replay(&self, calls: &[Value], attempts: u8) -> Value {
        let script = self.root.join("broker.py");
        let encoded = json!(json!(calls).to_string()).to_string();
        fs::write(&script,format!("#!/usr/bin/python3\nimport json,sys\nrows=json.loads({encoded})\nrequest=json.load(sys.stdin)\nprint(json.dumps(next((row['receipt'] for row in rows if row['request']==request),None)))\n")).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let config = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityProcessConfiguration","authorityConfigurationPath":self.configuration,"authorityConfigurationSha256":self.pin,"commandPath":script,"commandSha256":bytehash(&fs::read(&script).unwrap()),"fixedArguments":[],"timeoutMs":1000});
        let process = self.root.join("process.json");
        fs::write(&process, config.to_string()).unwrap();
        fs::set_permissions(&process, fs::Permissions::from_mode(0o600)).unwrap();
        let mut nonces = Vec::new();
        for triple in calls.chunks(3) {
            for index in [0, 2, 1] {
                let request = &triple[index]["request"];
                let value = request["nonce"]
                    .as_str()
                    .or_else(|| request["challengeNonce"].as_str())
                    .unwrap();
                nonces.push(value.split_once(':').unwrap().1);
            }
        }
        oracle(
            "online-runtime-active-refresh-v1.mjs",
            &json!({"workspaceRoot":self.root,"runtimeRoot":self.root,"inventory":self.inventory,"manifest":self.manifest,"authorityProcessConfigurationPath":process,"now":iso(NOW).unwrap(),"maximumLinearizationAttempts":attempts,"nonces":nonces}),
        )
    }
}
struct Broker {
    key: SigningKey,
    inventory: Value,
    calls: Arc<Mutex<Vec<Value>>>,
    mode: String,
    time: Arc<AtomicI64>,
}
impl MutationAuthorityTransportV1 for Broker {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        let attempt = self.calls.lock().unwrap().len() / 3;
        let h = |label: &str| hash("NativeActiveRefreshHead", &json!({"label":label}));
        let mut value = json!({"version":1,"authorityId":"authority:test","keyId":"key:test","requestHash":hash(request["kind"].as_str().unwrap(),request),"protocol":request["protocol"],"scopeId":request["scopeId"],"databaseScopeHash":request["databaseScopeHash"],"writerManifestHash":request["writerManifestHash"],"globalSequence":17,"globalHash":h("global"),"expiresAt":iso(NOW+60000).unwrap()});
        let heads=json!(self.inventory["instances"].as_array().unwrap().iter().map(|i|json!({"databaseRole":i["role"],"databaseInstanceId":i["instanceId"],"sequence":0,"hash":h(i["instanceId"].as_str().unwrap()),"schemaHash":i["schemaHash"],"stateHash":h("state")})).collect::<Vec<_>>());
        match request["kind"].as_str().unwrap() {
            "AutonomousResearchOnlineMutationCurrentHeadRequest" => {
                value["kind"] = json!("AutonomousResearchOnlineMutationCurrentHeadReceipt");
                value["status"] =
                    json!("autonomous_research_online_mutation_current_head_observed");
                value["databaseHeads"] = heads;
                value["unresolvedReservationCount"] = json!(0);
                value["observedAt"] = json!(iso(NOW).unwrap());
            }
            "AutonomousResearchOnlineMutationActiveChallengeRequest" => {
                value["kind"] = json!("AutonomousResearchOnlineMutationActiveChallengeReceipt");
                value["status"] =
                    json!("autonomous_research_online_mutation_active_challenge_verified");
                value["databaseHeads"] = heads;
                value["challengeNonce"] = request["challengeNonce"].clone();
                value["challengedAt"] = json!(iso(NOW).unwrap());
                if self.mode == "expire-after-rpc" {
                    self.time.store(NOW + 60000, Ordering::SeqCst);
                }
            }
            _ => {
                value["kind"] = json!("AutonomousResearchOnlineMutationScopeReceipt");
                value["status"] = json!("autonomous_research_online_mutation_scope_observed");
                value["observedAt"] = json!(iso(NOW).unwrap());
                for key in [
                    "staticInspectionReceiptHash",
                    "astGateReceiptHash",
                    "codeProvenanceHash",
                    "operationCount",
                    "operationIds",
                    "requiredDatabaseRoles",
                    "coveredDatabaseRoles",
                ] {
                    value[key] = request[key].clone();
                }
                if self.mode == "unstable" || (self.mode == "retry" && attempt == 0) {
                    value["globalHash"] = json!(h("other"));
                }
            }
        }
        value["signature"] = json!(Base64::encode_string(
            &self
                .key
                .sign(online_mutation_signed_payload_v1(&value)?.as_bytes())
                .to_bytes()
        ));
        self.calls
            .lock()
            .unwrap()
            .push(json!({"request":request,"receipt":value}));
        Ok(value)
    }
}
#[test]
fn real_static_scan_and_signed_active_refresh_match_node_success_retry_and_instability() {
    for mode in ["success", "retry", "unstable"] {
        let f = Fixture::new();
        let evidence = verify_online_writer_static_coverage_v1(&f.root, &f.manifest).unwrap();
        let time = Arc::new(AtomicI64::new(NOW));
        let (mut authority, calls) = f.authority(mode, time.clone());
        let mut clock = move || Ok(time.load(Ordering::SeqCst));
        let result = refresh_online_authority_evidence_v1(
            &f.inventory,
            &f.manifest,
            &mut authority,
            &evidence,
            &mut clock,
            3,
        );
        let actual = match result {
            Ok(value) => {
                value
                    .assert_current(&authority, &f.inventory, &evidence, NOW)
                    .unwrap();
                assert_eq!(value.inventory_hash(), f.inventory["inventoryHash"]);
                assert_eq!(
                    value.authority_configuration_hash(),
                    authority.configuration_hash()
                );
                assert_eq!(
                    value.receipt_hash().unwrap(),
                    hash(
                        "AutonomousResearchOnlineMutationActiveRefreshReceipt",
                        value.value()
                    )
                );
                value.value().clone()
            }
            Err(e) => json!({"error":e.code}),
        };
        assert_eq!(actual, f.replay(&calls.lock().unwrap(), 3), "{mode}");
    }
}
#[test]
fn active_evidence_rejects_post_rpc_expiry_modified_source_and_wrong_subject() {
    let f = Fixture::new();
    let evidence = verify_online_writer_static_coverage_v1(&f.root, &f.manifest).unwrap();
    let time = Arc::new(AtomicI64::new(NOW));
    let (mut authority, calls) = f.authority("expire-after-rpc", time.clone());
    let mut clock = move || Ok(time.load(Ordering::SeqCst));
    assert_eq!(
        refresh_online_authority_evidence_v1(
            &f.inventory,
            &f.manifest,
            &mut authority,
            &evidence,
            &mut clock,
            3
        )
        .err()
        .unwrap()
        .code,
        "autonomous_research_online_mutation_current_head_receipt_invalid"
    );
    assert_eq!(calls.lock().unwrap().len(), 3);
    let (mut authority, calls) = f.authority("success", Arc::new(AtomicI64::new(NOW)));
    let proof = refresh_online_authority_evidence_v1(
        &f.inventory,
        &f.manifest,
        &mut authority,
        &evidence,
        &mut || Ok(NOW),
        3,
    )
    .unwrap();
    let mut inventory = f.inventory.clone();
    inventory["inventoryHash"] = json!(hash("wrong", &json!({})));
    assert!(
        proof
            .assert_current(&authority, &inventory, &evidence, NOW)
            .is_err()
    );
    assert!(
        proof
            .assert_current(&authority, &f.inventory, &evidence, NOW + 60000)
            .is_err()
    );
    fs::write(
        f.root.join("paper-adapters/automation/unregistered.mjs"),
        "export function mutation(db){db.exec('DELETE FROM x')}",
    )
    .unwrap();
    assert!(
        proof
            .assert_current(&authority, &f.inventory, &evidence, NOW)
            .is_err()
    );
    let before = calls.lock().unwrap().len();
    assert!(
        refresh_online_authority_evidence_v1(
            &f.inventory,
            &f.manifest,
            &mut authority,
            &evidence,
            &mut || Ok(NOW),
            3
        )
        .is_err()
    );
    assert_eq!(calls.lock().unwrap().len(), before);
}
