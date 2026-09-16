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
        if self.mode == "numeric" {
            fn numeric(v: &mut Value) {
                match v {
                    Value::Number(n) => {
                        *v = json!(n.as_f64().unwrap());
                    }
                    Value::Object(o) => {
                        for v in o.values_mut() {
                            numeric(v);
                        }
                    }
                    Value::Array(a) => {
                        for v in a {
                            numeric(v);
                        }
                    }
                    _ => (),
                }
            }
            numeric(&mut value);
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

#[test]
fn verified_cache_write_requires_actual_inventory_signed_evidence_and_current_source() {
    use hepta_paper_service::{
        online_authority_evidence_cache::verified::record_verified_authority_evidence_cache_v1,
        state_database_inventory::observe_state_database_inventory_v1,
    };
    let mut f = Fixture::new();
    let state_manifest: Value = serde_json::from_slice(
        &fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../paper-core/config/autonomous-research-state-databases.v1.json"),
        )
        .unwrap(),
    )
    .unwrap();
    for definition in state_manifest["databases"].as_array().unwrap() {
        let path = f.root.join(definition["relativePath"].as_str().unwrap());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE fixture_records(id TEXT PRIMARY KEY,value TEXT); INSERT INTO fixture_records VALUES('one','before');").unwrap();
        for object in definition["requiredSchemaObjects"].as_array().unwrap() {
            let (kind, name) = object.as_str().unwrap().split_once(':').unwrap();
            let sql = match kind {
                "table" => format!("CREATE TABLE \"{name}\"(id TEXT PRIMARY KEY,value TEXT)"),
                "index" => format!("CREATE INDEX \"{name}\" ON fixture_records(value)"),
                "trigger" => format!(
                    "CREATE TRIGGER \"{name}\" BEFORE UPDATE ON fixture_records BEGIN SELECT 1; END"
                ),
                "view" => format!("CREATE VIEW \"{name}\" AS SELECT * FROM fixture_records"),
                _ => panic!("unknown fixture schema object"),
            };
            db.execute_batch(&sql).unwrap();
        }
        drop(db);
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let inventory = observe_state_database_inventory_v1(&f.root, &state_manifest).unwrap();
    f.inventory = inventory.value().clone();
    let mut configuration: Value =
        serde_json::from_slice(&fs::read(&f.configuration).unwrap()).unwrap();
    configuration["databaseScopeHash"] = f.inventory["databaseScopeHash"].clone();
    configuration["maximumObservationAgeMs"] = json!(1000);
    fs::write(&f.configuration, configuration.to_string()).unwrap();
    f.pin = bytehash(&fs::read(&f.configuration).unwrap());
    let source = verify_online_writer_static_coverage_v1(&f.root, &f.manifest).unwrap();
    let (mut authority, calls) = f.authority("success", Arc::new(AtomicI64::new(NOW)));
    let evidence = refresh_online_authority_evidence_v1(
        &f.inventory,
        &f.manifest,
        &mut authority,
        &source,
        &mut || Ok(NOW),
        3,
    )
    .unwrap();
    let writes_before = calls.lock().unwrap().len();
    let receipt = record_verified_authority_evidence_cache_v1(
        &f.root,
        &authority,
        &evidence,
        &inventory,
        &source,
        &mut || Ok(NOW),
    )
    .unwrap();
    receipt
        .assert_current(&authority, &evidence, &inventory, &source, &mut || {
            Ok(NOW + 1)
        })
        .unwrap();
    assert_eq!(
        calls.lock().unwrap().len(),
        writes_before,
        "cache never makes an authority RPC"
    );
    assert!(
        receipt
            .assert_current(&authority, &evidence, &inventory, &source, &mut || Ok(
                NOW + 60000
            ))
            .is_err()
    );
    let mut write_times = vec![NOW + 100, NOW + 100, NOW + 50, NOW + 50, NOW + 50].into_iter();
    assert!(
        record_verified_authority_evidence_cache_v1(
            &f.root,
            &authority,
            &evidence,
            &inventory,
            &source,
            &mut || Ok(write_times.next().unwrap())
        )
        .is_err()
    );
    let mut times = vec![NOW, NOW - 1].into_iter();
    assert!(
        receipt
            .assert_current(&authority, &evidence, &inventory, &source, &mut || Ok(
                times.next().unwrap()
            ))
            .is_err()
    );
    assert!(
        record_verified_authority_evidence_cache_v1(
            &f.root.join("wrong"),
            &authority,
            &evidence,
            &inventory,
            &source,
            &mut || Ok(NOW)
        )
        .is_err()
    );
    receipt
        .assert_current(&authority, &evidence, &inventory, &source, &mut || {
            Ok(NOW + 1000)
        })
        .unwrap();
    let mut ages = vec![NOW + 1000, NOW + 1001].into_iter();
    assert!(
        receipt
            .assert_current(&authority, &evidence, &inventory, &source, &mut || Ok(ages
                .next()
                .unwrap()))
            .is_err(),
        "still-unexpired signed evidence must reject observation age exceeded only after file/source checks"
    );
    let mut ages = vec![NOW, NOW, NOW, NOW, NOW + 1001].into_iter();
    assert!(
        record_verified_authority_evidence_cache_v1(
            &f.root,
            &authority,
            &evidence,
            &inventory,
            &source,
            &mut || Ok(ages.next().unwrap())
        )
        .is_err(),
        "final write sample must enforce observation age too"
    );
    let path = f
        .root
        .join("automation-cache/online-authority-evidence-v1/current.json");
    let saved = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"{}").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    assert!(
        receipt
            .assert_current(&authority, &evidence, &inventory, &source, &mut || Ok(NOW))
            .is_err()
    );
    fs::remove_file(&path).unwrap();
    fs::write(&path, saved).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    let database = f.root.join(
        state_manifest["databases"][0]["relativePath"]
            .as_str()
            .unwrap(),
    );
    let db = rusqlite::Connection::open(database).unwrap();
    db.execute("UPDATE fixture_records SET value='changed'", [])
        .unwrap();
    drop(db);
    assert!(
        receipt
            .assert_current(&authority, &evidence, &inventory, &source, &mut || Ok(NOW))
            .is_err()
    );
}

fn actual_inspection_fixture() -> (
    Fixture,
    hepta_paper_service::state_database_inventory::ObservedStateDatabaseInventoryV1,
) {
    use hepta_paper_service::state_database_inventory::observe_state_database_inventory_v1;
    let mut f = Fixture::new();
    let state_manifest: Value = serde_json::from_slice(
        &fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../paper-core/config/autonomous-research-state-databases.v1.json"),
        )
        .unwrap(),
    )
    .unwrap();
    for definition in state_manifest["databases"].as_array().unwrap() {
        let path = f.root.join(definition["relativePath"].as_str().unwrap());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE fixture_records(id TEXT PRIMARY KEY,value TEXT); INSERT INTO fixture_records VALUES('one','before');").unwrap();
        for object in definition["requiredSchemaObjects"].as_array().unwrap() {
            let (kind, name) = object.as_str().unwrap().split_once(':').unwrap();
            let sql = match kind {
                "table" => format!("CREATE TABLE \"{name}\"(id TEXT PRIMARY KEY,value TEXT)"),
                "index" => format!("CREATE INDEX \"{name}\" ON fixture_records(value)"),
                "trigger" => format!(
                    "CREATE TRIGGER \"{name}\" BEFORE UPDATE ON fixture_records BEGIN SELECT 1; END"
                ),
                "view" => format!("CREATE VIEW \"{name}\" AS SELECT * FROM fixture_records"),
                _ => panic!("unknown fixture schema object"),
            };
            db.execute_batch(&sql).unwrap();
        }
        drop(db);
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let inventory = observe_state_database_inventory_v1(&f.root, &state_manifest).unwrap();
    f.inventory = inventory.value().clone();
    let mut configuration: Value =
        serde_json::from_slice(&fs::read(&f.configuration).unwrap()).unwrap();
    configuration["databaseScopeHash"] = f.inventory["databaseScopeHash"].clone();
    fs::write(&f.configuration, configuration.to_string()).unwrap();
    f.pin = bytehash(&fs::read(&f.configuration).unwrap());
    (f, inventory)
}

#[test]
fn native_passive_and_active_inspection_verify_real_signed_evidence_and_match_node() {
    use hepta_paper_service::online_authority_evidence_cache::{
        record_passive_authority_evidence_cache_v1,
        verified::record_verified_authority_evidence_cache_v1,
    };
    use hepta_paper_service::online_authority_inspection::{
        OnlineAuthorityInspectionInputV1, inspect_active_online_authority_v1,
        inspect_passive_online_authority_v1,
    };
    let (f, inventory) = actual_inspection_fixture();
    let source = verify_online_writer_static_coverage_v1(&f.root, &f.manifest).unwrap();
    let (mut authority, calls) = f.authority("success", Arc::new(AtomicI64::new(NOW)));
    let active = refresh_online_authority_evidence_v1(
        &f.inventory,
        &f.manifest,
        &mut authority,
        &source,
        &mut || Ok(NOW),
        3,
    )
    .unwrap();
    record_verified_authority_evidence_cache_v1(
        &f.root,
        &authority,
        &active,
        &inventory,
        &source,
        &mut || Ok(NOW),
    )
    .unwrap();
    let statuses = [
        Value::Null,
        json!({"implemented":true,"status":"externally_fenced_sqlite_mutation_coordinator_configured","coveredDatabaseRoles":f.manifest["coverage"]["coveredDatabaseRoles"],"blockers":["autonomous_research_online_mutation_runtime_activation_required"]}),
        json!({"implemented":true,"status":"externally_fenced_sqlite_mutation_coordinator_ready","coveredDatabaseRoles":f.manifest["coverage"]["coveredDatabaseRoles"],"blockers":[]}),
    ];
    let no_rpc = calls.lock().unwrap().len();
    for status in &statuses {
        let passive = inspect_passive_online_authority_v1(
            &authority,
            &inventory,
            &source,
            &f.manifest,
            status,
            &mut || Ok(NOW),
        )
        .unwrap();
        let inspected = inspect_active_online_authority_v1(
            OnlineAuthorityInspectionInputV1 {
                authority: &authority,
                inventory: &inventory,
                source: &source,
                manifest: &f.manifest,
                coordinator: status,
            },
            &active,
            &mut || Ok(NOW),
        )
        .unwrap();
        for (mode, native) in [("active", inspected.value()), ("passive", passive.value())] {
            let node = oracle(
                "online-authority-inspection-v1.mjs",
                &json!({"mode":mode,"workspaceRoot":f.root,"runtimeRoot":f.root,"inventory":f.inventory,"authorityConfigurationPath":f.configuration,"now":iso(NOW).unwrap(),"coordinatorStatus":status,"manifest":f.manifest,"activeRefreshReceipt":active.value()}),
            );
            assert_eq!(*native, node, "{mode} {status}");
        }
        passive
            .assert_current(&authority, &inventory, &source, &mut || Ok(NOW + 1))
            .unwrap();
        assert!(
            passive
                .assert_current(&authority, &inventory, &source, &mut || Ok(NOW + 60000))
                .is_err()
        );
        let mut times = vec![NOW, NOW - 1].into_iter();
        assert!(
            passive
                .assert_current(&authority, &inventory, &source, &mut || Ok(times
                    .next()
                    .unwrap()))
                .is_err()
        );
    }
    assert_eq!(
        calls.lock().unwrap().len(),
        no_rpc,
        "all passive/inspection checks use no external RPC"
    );
    let mut late = vec![NOW, NOW, NOW, NOW + 60000].into_iter();
    assert!(
        inspect_passive_online_authority_v1(
            &authority,
            &inventory,
            &source,
            &f.manifest,
            &Value::Null,
            &mut || Ok(late.next().unwrap())
        )
        .is_err(),
        "expiry sampled after source and file validation must reject"
    );
    let proof = inspect_passive_online_authority_v1(
        &authority,
        &inventory,
        &source,
        &f.manifest,
        &Value::Null,
        &mut || Ok(NOW),
    )
    .unwrap();
    let cache = f
        .root
        .join("automation-cache/online-authority-evidence-v1/current.json");
    fs::remove_file(&cache).unwrap();
    let mut fake = active.value().clone();
    fake["authorityEvidence"]["currentHead"]["receipt"]["signature"] =
        json!(Base64::encode_string(&[0u8; 64]));
    record_passive_authority_evidence_cache_v1(
        &f.root,
        &fake,
        f.inventory["databaseScopeHash"].as_str().unwrap(),
        authority.trust()["writerManifestHash"].as_str().unwrap(),
        &iso(NOW + 60000).unwrap(),
    )
    .unwrap();
    assert!(
        inspect_passive_online_authority_v1(
            &authority,
            &inventory,
            &source,
            &f.manifest,
            &Value::Null,
            &mut || Ok(NOW)
        )
        .is_err(),
        "valid cache hash never replaces actual authority signature verification"
    );
    assert!(
        proof
            .assert_current(&authority, &inventory, &source, &mut || Ok(NOW))
            .is_err()
    );
    fs::remove_file(&cache).unwrap();
    let mut split = active.value().clone();
    let challenge = &mut split["authorityEvidence"]["activeChallenge"]["receipt"];
    challenge["databaseHeads"][0]["hash"] = json!(hash("signed-equivocation", &json!({})));
    let signature = f.key.sign(
        online_mutation_signed_payload_v1(challenge)
            .unwrap()
            .as_bytes(),
    );
    challenge["signature"] = json!(Base64::encode_string(&signature.to_bytes()));
    split["activeChallengeReceiptHash"]=json!(hepta_paper_service::sqlite_mutation_coordinator::contracts::online_mutation_receipt_hash_v1(&split["authorityEvidence"]["activeChallenge"]["receipt"]).unwrap());
    record_passive_authority_evidence_cache_v1(
        &f.root,
        &split,
        f.inventory["databaseScopeHash"].as_str().unwrap(),
        authority.trust()["writerManifestHash"].as_str().unwrap(),
        &iso(NOW + 60000).unwrap(),
    )
    .unwrap();
    let denied = inspect_passive_online_authority_v1(
        &authority,
        &inventory,
        &source,
        &f.manifest,
        &statuses[2],
        &mut || Ok(NOW),
    )
    .err()
    .unwrap();
    assert_eq!(
        denied.code,
        "autonomous_research_online_mutation_passive_evidence_binding_invalid"
    );
    let node = oracle(
        "online-authority-inspection-v1.mjs",
        &json!({"mode":"passive","workspaceRoot":f.root,"runtimeRoot":f.root,"inventory":f.inventory,"authorityConfigurationPath":f.configuration,"now":iso(NOW).unwrap(),"coordinatorStatus":statuses[2],"manifest":f.manifest}),
    );
    assert_eq!(
        node["status"], "autonomous_research_online_anti_rollback_ready",
        "incumbent only compares global head; native additionally rejects genuinely signed contradictory per-database heads"
    );
    assert_eq!(calls.lock().unwrap().len(), no_rpc);
}

#[test]
fn state_safety_projection_matches_node_canonical_inventory_restore_and_all_receipt_fields() {
    use hepta_paper_service::online_authority_inspection::{
        OnlineAuthorityInspectionInputV1, inspect_active_online_authority_v1,
    };
    use hepta_paper_service::state_safety::evaluate_state_safety_readiness_v1;
    let (f, inventory) = actual_inspection_fixture();
    let source = verify_online_writer_static_coverage_v1(&f.root, &f.manifest).unwrap();
    let (mut authority, _calls) = f.authority("success", Arc::new(AtomicI64::new(NOW)));
    let active = refresh_online_authority_evidence_v1(
        &f.inventory,
        &f.manifest,
        &mut authority,
        &source,
        &mut || Ok(NOW),
        3,
    )
    .unwrap();
    let status = json!({"implemented":true,"status":"externally_fenced_sqlite_mutation_coordinator_ready","coveredDatabaseRoles":f.manifest["coverage"]["coveredDatabaseRoles"],"blockers":[]});
    let inspected = inspect_active_online_authority_v1(
        OnlineAuthorityInspectionInputV1 {
            authority: &authority,
            inventory: &inventory,
            source: &source,
            manifest: &f.manifest,
            coordinator: &status,
        },
        &active,
        &mut || Ok(NOW),
    )
    .unwrap();
    // Projection fixture only: these source metadata claims deliberately do not
    // construct VerifiedStoredRestoreSourceV1 or any activation capability.
    let instances = f.inventory["instances"].as_array().unwrap();
    let restore = json!({"version":1,"kind":"AutonomousResearchStateBackupSourcesInspection","status":"autonomous_research_state_backup_sources_ready","bundlePath":"/fixture/metadata-only","manifestId":f.inventory["manifestId"],"manifestHash":f.inventory["manifestHash"],"bundleManifestHash":hash("fixture-bundle",&json!({})),"snapshotContentHash":hash("fixture-content",&json!({})),"snapshotCreatedAt":iso(NOW).unwrap(),"inventoryHash":f.inventory["inventoryHash"],"databaseScopeHash":f.inventory["databaseScopeHash"],"databaseInstanceIds":instances.iter().map(|i|i["instanceId"].clone()).collect::<Vec<_>>(),"restoreDrillReceiptHash":hash("fixture-drill",&json!({})),"restoreDrillPerformedAt":iso(NOW).unwrap(),"authorityId":"backup:fixture","keyId":"key:fixture","headSequence":0,"headHash":hash("head",&json!({})),"sources":instances.iter().map(|i|json!({"role":format!("autonomous_state_database:{}",i["instanceId"].as_str().unwrap())})).collect::<Vec<_>>(),"skippedCandidates":[],"blockers":[]});
    let base = json!({"inventory":f.inventory,"latestRestoreDrill":restore,"onlineAntiRollback":inspected.value(),"now":NOW});
    assert_eq!(
        evaluate_state_safety_readiness_v1(
            &base["inventory"],
            &base["latestRestoreDrill"],
            Some(&base["onlineAntiRollback"]),
            NOW
        )
        .unwrap()["ready"],
        true
    );
    let mut cases = vec![base.clone(), json!({"now":NOW})];
    fn scalar_paths(value: &Value, prefix: &str, paths: &mut Vec<String>) {
        if let Some(o) = value.as_object() {
            for (k, v) in o {
                let p = format!("{prefix}/{k}");
                if v.is_object() {
                    scalar_paths(v, &p, paths);
                } else if !v.is_array() {
                    paths.push(p);
                }
            }
        }
    }
    let mut paths = Vec::new();
    for root in ["inventory", "latestRestoreDrill", "onlineAntiRollback"] {
        scalar_paths(&base[root], &format!("/{root}"), &mut paths);
    }
    for path in paths {
        for replacement in [Value::Null, json!(false), json!("invalid"), json!(1.0)] {
            // The native protocol has canonical UTC string timestamps. Numeric
            // Date.parse coercion is an explicit compatibility boundary below.
            if path.ends_with("At") && replacement.is_number() {
                continue;
            }
            let mut changed = base.clone();
            *changed.pointer_mut(&path).unwrap() = replacement;
            cases.push(changed);
        }
    }
    for delta in [-1, 60_000, 86_400_000, 86_400_001] {
        let mut value = base.clone();
        value["now"] = json!(NOW + delta);
        cases.push(value);
    }
    for root in ["inventory", "latestRestoreDrill", "onlineAntiRollback"] {
        for b in [
            json!([]),
            json!(["fixture_blocked"]),
            json!(["autonomous_research_online_anti_rollback_coordinator_not_implemented"]),
            json!([""]),
        ] {
            let mut value = base.clone();
            value[root]["blockers"] = b;
            cases.push(value);
        }
    }
    let mut noncanonical = base.clone();
    noncanonical["latestRestoreDrill"]["restoreDrillPerformedAt"] = json!(1.0);
    let native_date = evaluate_state_safety_readiness_v1(
        &noncanonical["inventory"],
        &noncanonical["latestRestoreDrill"],
        Some(&noncanonical["onlineAntiRollback"]),
        NOW,
    )
    .unwrap();
    let node_date = oracle("state-safety-v1.mjs", &noncanonical);
    assert_eq!(native_date["ready"], false);
    assert!(native_date["latestRestoreDrill"]["restoreDrillPerformedAt"].is_null());
    assert!(
        node_date["latestRestoreDrill"]["restoreDrillPerformedAt"].is_string(),
        "the original coerces numeric dates; this explicit difference remains documented"
    );
    let node = oracle("state-safety-v1.mjs", &json!(cases));
    for (index, input) in cases.iter().enumerate() {
        let native = evaluate_state_safety_readiness_v1(
            &input["inventory"],
            &input["latestRestoreDrill"],
            input.get("onlineAntiRollback"),
            input["now"].as_i64().unwrap(),
        )
        .unwrap_or_else(|e| json!({"error":e.code}));
        if native != node[index] {
            fs::write(
                "/tmp/hepta-safety-mismatch.json",
                json!({"input":input,"native":native,"node":node[index]}).to_string(),
            )
            .unwrap();
            panic!("state safety mismatch case {index}; details /tmp/hepta-safety-mismatch.json");
        }
    }
}

#[test]
fn real_signed_numeric_active_receipts_preserve_original_node_number_semantics() {
    let f = Fixture::new();
    let source = verify_online_writer_static_coverage_v1(&f.root, &f.manifest).unwrap();
    let (mut authority, calls) = f.authority("numeric", Arc::new(AtomicI64::new(NOW)));
    let proof = refresh_online_authority_evidence_v1(
        &f.inventory,
        &f.manifest,
        &mut authority,
        &source,
        &mut || Ok(NOW),
        3,
    )
    .unwrap();
    assert_eq!(*proof.value(), f.replay(&calls.lock().unwrap(), 3));
    proof
        .assert_current(&authority, &f.inventory, &source, NOW)
        .unwrap();
}

#[test]
fn observation_age_crossed_only_after_inspection_io_rejects_still_unexpired_signatures() {
    use hepta_paper_service::online_authority_evidence_cache::verified::record_verified_authority_evidence_cache_v1;
    use hepta_paper_service::online_authority_inspection::{
        OnlineAuthorityInspectionInputV1, inspect_active_online_authority_v1,
        inspect_passive_online_authority_v1,
    };
    let (mut f, inventory) = actual_inspection_fixture();
    let mut config: Value = serde_json::from_slice(&fs::read(&f.configuration).unwrap()).unwrap();
    config["maximumObservationAgeMs"] = json!(1000);
    fs::write(&f.configuration, config.to_string()).unwrap();
    f.pin = bytehash(&fs::read(&f.configuration).unwrap());
    let source = verify_online_writer_static_coverage_v1(&f.root, &f.manifest).unwrap();
    let (mut authority, calls) = f.authority("success", Arc::new(AtomicI64::new(NOW)));
    let active = refresh_online_authority_evidence_v1(
        &f.inventory,
        &f.manifest,
        &mut authority,
        &source,
        &mut || Ok(NOW),
        3,
    )
    .unwrap();
    record_verified_authority_evidence_cache_v1(
        &f.root,
        &authority,
        &active,
        &inventory,
        &source,
        &mut || Ok(NOW),
    )
    .unwrap();
    let before = calls.lock().unwrap().len();
    let proof = inspect_passive_online_authority_v1(
        &authority,
        &inventory,
        &source,
        &f.manifest,
        &Value::Null,
        &mut || Ok(NOW + 1000),
    )
    .unwrap();
    let mut times = vec![NOW + 1000, NOW + 1001].into_iter();
    assert!(
        proof
            .assert_current(&authority, &inventory, &source, &mut || Ok(times
                .next()
                .unwrap()))
            .is_err()
    );
    let mut times = vec![NOW, NOW, NOW, NOW + 1001].into_iter();
    assert!(
        inspect_passive_online_authority_v1(
            &authority,
            &inventory,
            &source,
            &f.manifest,
            &Value::Null,
            &mut || Ok(times.next().unwrap())
        )
        .is_err()
    );
    let mut times = vec![NOW, NOW, NOW, NOW + 1001].into_iter();
    assert!(
        inspect_active_online_authority_v1(
            OnlineAuthorityInspectionInputV1 {
                authority: &authority,
                inventory: &inventory,
                source: &source,
                manifest: &f.manifest,
                coordinator: &Value::Null
            },
            &active,
            &mut || Ok(times.next().unwrap())
        )
        .is_err()
    );
    assert_eq!(calls.lock().unwrap().len(), before);
}
