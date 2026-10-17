//! Local adapter proof only: no runtime activation object is constructed.
use super::*;
use crate::sqlite_mutation_coordinator::{
    self as coordinator, DATABASE_ROLES, ONLINE_MUTATION_PROTOCOL,
    SqliteMutationCoordinatorOptionsV1, authority::PinnedMutationAuthorityV1, contracts::*,
    storage::exact_schema_hash_v1,
};
use base64ct::{Base64, Encoding};
use ed25519_dalek::{
    Signer, SigningKey,
    pkcs8::{EncodePublicKey, spki::der::pem::LineEnding},
};
use serde_json::json;
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

const NOW: &str = "2026-07-16T08:00:45.000Z";
fn h(label: &str) -> String {
    hash("RuntimeImageOnlineNativeFixture", &json!({"label":label})).unwrap()
}
fn oracle(script: &str, input: Value) -> Value {
    let mut child =
        Command::new(std::env::var("HEPTA_TEST_NODE").unwrap_or_else(|_| "node".into()))
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../rust/oracle")
                    .join(script),
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
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
fn write_private(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
struct Fixture {
    root: PathBuf,
    receipt_path: PathBuf,
    image: Value,
    inputs: Value,
    keys: Vec<String>,
    coordinator: SqliteMutationCoordinatorV1<Transport>,
    state: Arc<Mutex<State>>,
}
impl Fixture {
    fn new(scenario: &str) -> Self {
        let image = oracle(
            "runtime-image-reproducibility-v2.mjs",
            json!({"operation":"fixture","scenario":"valid"}),
        );
        let root = PathBuf::from(image["root"].as_str().unwrap());
        let receipt_path = root.join("online-receipt.json");
        let fixture = oracle(
            "runtime-image-online-publication-v1.mjs",
            json!({"operation":"fixture"}),
        );
        assert_eq!(
            runtime_image_publication_mutation_plans_v1(),
            fixture["plans"]
        );
        assert_eq!(
            runtime_image_publication_writer_plan_hash_v1().unwrap(),
            fixture["writerHash"]
        );
        let db =
            Connection::open(format!("{}.publication.sqlite", receipt_path.display())).unwrap();
        write_private(
            Path::new(&format!("{}.publication.sqlite", receipt_path.display())),
            &[],
        );
        disk::schema(&db).unwrap();
        for statement in fixture["schema"].as_array().unwrap() {
            db.execute_batch(statement.as_str().unwrap()).unwrap();
        }
        let schema = exact_schema_hash_v1(&db).unwrap();
        db.execute("INSERT INTO autonomous_research_online_mutation_authority_metadata(singleton,schema_version,protocol,database_role,database_instance_id,schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,genesis_global_sequence,genesis_global_hash,genesis_database_sequence,genesis_database_hash,genesis_state_hash,provisioned_at) VALUES(1,1,?,?,?,?,?,?,?,0,?,0,?,?,?)",rusqlite::params![ONLINE_MUTATION_PROTOCOL,PUBLICATION_DATABASE_ROLE,PUBLICATION_DATABASE_ROLE,PUBLICATION_SCHEMA_CONTRACT_ID,schema,h("scope"),fixture["manifestHash"].as_str().unwrap(),h("genesis-global"),h("genesis-database"),h("genesis-state"),NOW]).unwrap();
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).unwrap();
        let key = SigningKey::from_bytes(&seed);
        let key_path = root.join("online-authority-public.json");
        let document = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityPublicKey","authorityId":"authority:image-test","keyId":"key:image-test","algorithm":"ed25519","publicKeyPem":key.verifying_key().to_public_key_pem(LineEnding::LF).unwrap()});
        let public_bytes = serde_json::to_vec(&document).unwrap();
        write_private(&key_path, &public_bytes);
        let configuration = root.join("online-authority.json");
        let config = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityConfiguration","authorityId":"authority:image-test","keyId":"key:image-test","scopeId":"scope:image-test","databaseScopeHash":h("scope"),"writerManifestHash":fixture["manifestHash"],"publicKeyPath":key_path,"publicKeySha256":digest(&public_bytes),"maximumReservationLeaseMs":60000,"maximumObservationAgeMs":60000});
        let config_bytes = serde_json::to_vec(&config).unwrap();
        write_private(&configuration, &config_bytes);
        let state = Arc::new(Mutex::new(State {
            scenario: scenario.into(),
            calls: Vec::new(),
            reserved: None,
            sequence: 0,
            global_hash: h("genesis-global"),
            database_hash: h("genesis-database"),
            state_hash: h("genesis-state"),
            schema,
            manifest_hash: fixture["manifestHash"].as_str().unwrap().into(),
            root: root.clone(),
        }));
        let transport = Transport {
            key,
            state: state.clone(),
        };
        let instances=transport.heads().as_array().unwrap().iter().map(|head|json!({"databaseRole":head["databaseRole"],"databaseInstanceId":head["databaseInstanceId"],"schemaHash":head["schemaHash"]})).collect::<Vec<_>>();
        let authority =
            PinnedMutationAuthorityV1::load(&configuration, &digest(&config_bytes), transport)
                .unwrap();
        let now = instant(&NOW.into()).unwrap();
        let coordinator = SqliteMutationCoordinatorV1::new(
            authority,
            SqliteMutationCoordinatorOptionsV1 {
                manifest: fixture["manifest"].clone(),
                operation_plans: fixture["plans"].clone(),
                database_instances: json!(instances),
                requested_lease_ms: None,
                commit_safety_margin_ms: 1000,
            },
            Box::new(move || Ok(now)),
            None,
        )
        .unwrap();
        drop(db);
        let keys = array(&image["publicKeys"])
            .iter()
            .map(|v| s(v).into())
            .collect();
        let inputs = image["inputs"].clone();
        Self {
            root,
            receipt_path,
            image,
            inputs,
            keys,
            coordinator,
            state,
        }
    }
    fn context(&self) -> ReceiptVerificationContext<'_> {
        ReceiptVerificationContext {
            now: NOW,
            current_code_provenance_hash: s(&self.image["request"]["codeProvenanceHash"]),
            current_release_identity_hash: s(&self.image["request"]["releaseIdentityHash"]),
            current_inputs: &self.inputs,
            configuration: &self.image["configuration"],
            profile_policies: &self.image["profilePolicies"],
            active_plugin_scope: &self.image["scope"],
            public_keys: &self.keys,
        }
    }
    fn publish(&mut self) -> OnlineResult<Value> {
        let context = ReceiptVerificationContext {
            now: NOW,
            current_code_provenance_hash: s(&self.image["request"]["codeProvenanceHash"]),
            current_release_identity_hash: s(&self.image["request"]["releaseIdentityHash"]),
            current_inputs: &self.inputs,
            configuration: &self.image["configuration"],
            profile_policies: &self.image["profilePolicies"],
            active_plugin_scope: &self.image["scope"],
            public_keys: &self.keys,
        };
        publish_with_coordinator(
            &self.receipt_path,
            &self.image["receipt"],
            &context,
            &mut self.coordinator,
            PUBLICATION_DATABASE_ROLE,
            PUBLICATION_SCHEMA_CONTRACT_ID,
        )
    }
    fn recover(&mut self) -> OnlineResult<Value> {
        let context = ReceiptVerificationContext {
            now: NOW,
            current_code_provenance_hash: s(&self.image["request"]["codeProvenanceHash"]),
            current_release_identity_hash: s(&self.image["request"]["releaseIdentityHash"]),
            current_inputs: &self.inputs,
            configuration: &self.image["configuration"],
            profile_policies: &self.image["profilePolicies"],
            active_plugin_scope: &self.image["scope"],
            public_keys: &self.keys,
        };
        recover_with_coordinator(
            &self.receipt_path,
            &context,
            &mut self.coordinator,
            PUBLICATION_DATABASE_ROLE,
        )
    }
    fn db(&self) -> Connection {
        Connection::open(format!(
            "{}.publication.sqlite",
            self.receipt_path.display()
        ))
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
struct State {
    scenario: String,
    calls: Vec<Value>,
    reserved: Option<Value>,
    sequence: i64,
    global_hash: String,
    database_hash: String,
    state_hash: String,
    schema: String,
    manifest_hash: String,
    root: PathBuf,
}
struct Transport {
    key: SigningKey,
    state: Arc<Mutex<State>>,
}
impl Transport {
    fn sign(&self, mut value: Value) -> Value {
        let signature = self.key.sign(
            online_mutation_signed_payload_v1(&value)
                .unwrap()
                .as_bytes(),
        );
        value["signature"] = Base64::encode_string(&signature.to_bytes()).into();
        value
    }
    fn heads(&self) -> Value {
        let state = self.state.lock().unwrap();
        let mut roles = DATABASE_ROLES.to_vec();
        roles.sort();
        json!(roles.into_iter().map(|role|{let local=role==PUBLICATION_DATABASE_ROLE;json!({"databaseRole":role,"databaseInstanceId":role,"sequence":if local{state.sequence}else{0},"hash":if local{state.database_hash.clone()}else{h(&format!("head:{role}"))},"schemaHash":if local{state.schema.clone()}else{h(&format!("schema:{role}"))},"stateHash":if local{state.state_hash.clone()}else{h(&format!("state:{role}"))}})}).collect::<Vec<_>>())
    }
}
impl MutationAuthorityTransportV1 for Transport {
    fn invoke(&mut self, request: &Value) -> coordinator::Result<Value> {
        let kind = s(&request["kind"]);
        self.state.lock().unwrap().calls.push(request.clone());
        if kind == "AutonomousResearchOnlineMutationCurrentHeadRequest" {
            let heads = self.heads();
            let state = self.state.lock().unwrap();
            return Ok(self.sign(json!({"version":1,"kind":"AutonomousResearchOnlineMutationCurrentHeadReceipt","status":"autonomous_research_online_mutation_current_head_observed","authorityId":"authority:image-test","keyId":"key:image-test","requestHash":hash(kind,request).unwrap(),"protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":"scope:image-test","databaseScopeHash":h("scope"),"writerManifestHash":state.manifest_hash,"globalSequence":state.sequence,"globalHash":state.global_hash,"databaseHeads":heads,"unresolvedReservationCount":0,"observedAt":NOW,"expiresAt":"2026-07-16T08:01:45.000Z"})));
        }
        let mut state = self.state.lock().unwrap();
        let mut receipt = request.clone();
        receipt["authorityId"] = "authority:image-test".into();
        receipt["keyId"] = "key:image-test".into();
        receipt["requestHash"] = hash(kind, request).unwrap().into();
        if kind == "AutonomousResearchOnlineMutationReserveRequest" {
            receipt.as_object_mut().unwrap().remove("requestedAt");
            receipt.as_object_mut().unwrap().remove("requestedLeaseMs");
            receipt["kind"] = "AutonomousResearchOnlineMutationReservationReceipt".into();
            receipt["status"] = "autonomous_research_online_mutation_reserved".into();
            let next = state.sequence + 1;
            receipt["reservationId"] = format!("reservation:image-{next}").into();
            receipt["globalSequence"] = next.into();
            receipt["databaseSequence"] = next.into();
            receipt["globalHash"] = h(&format!("global:{next}")).into();
            receipt["databaseHash"] = h(&format!("database:{next}")).into();
            receipt["issuedAt"] = NOW.into();
            receipt["expiresAt"] = "2026-07-16T08:01:45.000Z".into();
            let receipt = self.sign(receipt);
            state.reserved = Some(receipt.clone());
            return Ok(receipt);
        }
        if kind == "AutonomousResearchOnlineMutationFinalizeRequest" {
            if state.scenario == "finalization-pending" {
                return Err(mutation_error("synthetic_finalization_pending"));
            }
            receipt.as_object_mut().unwrap().remove("committedAt");
            receipt["kind"] = "AutonomousResearchOnlineMutationFinalizationReceipt".into();
            receipt["status"] = "autonomous_research_online_mutation_finalized".into();
            receipt["sideEffectPermitHash"] =
                h(&format!("permit:{}", s(&request["reservationId"]))).into();
            receipt["finalizedAt"] = NOW.into();
            if state.scenario == "wrong-permit" {
                receipt["sideEffectReservationHashes"] = json!([h("wrong-mirror")]);
            }
            if state.scenario == "mirror-failure" {
                fs::set_permissions(&state.root, fs::Permissions::from_mode(0o770)).unwrap();
            }
            let mut signed = self.sign(receipt);
            if state.scenario == "invalid-signature" {
                signed["signature"] = Base64::encode_string(&[0u8; 64]).into();
            }
            state.sequence = request["globalSequence"].as_i64().unwrap();
            state.global_hash = s(&request["globalHash"]).into();
            state.database_hash = s(&request["databaseHash"]).into();
            state.state_hash = s(&request["postStateHash"]).into();
            return Ok(signed);
        }
        if kind == "AutonomousResearchOnlineMutationAbortRequest" {
            receipt["kind"] = "AutonomousResearchOnlineMutationAbortReceipt".into();
            receipt["status"] = "autonomous_research_online_mutation_aborted".into();
            receipt["abortedAt"] = NOW.into();
            return Ok(self.sign(receipt));
        }
        Err(mutation_error("unexpected_test_transport_operation"))
    }
}

#[test]
fn actual_fenced_publication_has_verified_bound_permit_and_readonly_status() {
    let mut f = Fixture::new("valid");
    assert_eq!(
        f.coordinator.inspect_status()["status"],
        "externally_fenced_sqlite_mutation_coordinator_partial"
    );
    let result = f.publish().unwrap();
    assert_eq!(result["publicationGeneration"], 1);
    assert!(sha(&result["mirrorSideEffectPermitHash"]));
    assert_eq!(result["crossResourceAtomicPublicationClaimed"], false);
    let mut payload = result.clone();
    payload
        .as_object_mut()
        .unwrap()
        .remove("runtimeImageReproducibilityReceiptPublicationHash");
    assert_eq!(
        result["runtimeImageReproducibilityReceiptPublicationHash"],
        oracle(
            "runtime-image-online-publication-v1.mjs",
            json!({"operation":"publicationHash","value":payload})
        )
    );
    let db = f.db();
    let proof = f
        .coordinator
        .verify_latest_finalized_mutation(&db, PUBLICATION_DATABASE_ROLE)
        .unwrap();
    assert_eq!(
        proof.value()["sideEffectPermitHash"],
        result["mirrorSideEffectPermitHash"]
    );
    let calls = f.state.lock().unwrap().calls.clone();
    let reserve = calls
        .iter()
        .find(|v| v["kind"] == "AutonomousResearchOnlineMutationReserveRequest")
        .unwrap();
    assert_eq!(
        reserve["sideEffectReservationHashes"][0],
        oracle(
            "runtime-image-online-publication-v1.mjs",
            json!({"operation":"mirrorHash","value":{"version":1,"databaseInstanceId":PUBLICATION_DATABASE_ROLE,"receiptPath":f.receipt_path,"receiptHash":result["receiptHash"],"receiptContentHash":result["receiptContentHash"]}})
        )
    );
    let before = fs::read(format!("{}.publication.sqlite", f.receipt_path.display())).unwrap();
    assert_eq!(
        read_with_coordinator(
            &f.receipt_path,
            &f.context(),
            &f.coordinator,
            PUBLICATION_DATABASE_ROLE
        )
        .unwrap()
        .unwrap()["inspection"]["ready"],
        true
    );
    assert_eq!(
        before,
        fs::read(format!("{}.publication.sqlite", f.receipt_path.display())).unwrap()
    );
    assert_eq!(f.state.lock().unwrap().calls.len(), 3);
}

#[test]
fn latest_pending_publication_cannot_borrow_an_older_valid_permit() {
    let mut f = Fixture::new("valid");
    f.publish().unwrap();
    let prior = fs::read(&f.receipt_path).unwrap();
    f.state.lock().unwrap().scenario = "finalization-pending".into();
    assert_eq!(
        f.publish().unwrap_err().code,
        "externally_fenced_sqlite_mutation_committed_finalization_pending"
    );
    assert_eq!(fs::read(&f.receipt_path).unwrap(), prior);
    let before = fs::read(format!("{}.publication.sqlite", f.receipt_path.display())).unwrap();
    let error = read_with_coordinator(
        &f.receipt_path,
        &f.context(),
        &f.coordinator,
        PUBLICATION_DATABASE_ROLE,
    )
    .unwrap_err();
    assert_eq!(
        error.code,
        "externally_fenced_sqlite_mutation_finalized_receipt_required"
    );
    assert_eq!(
        before,
        fs::read(format!("{}.publication.sqlite", f.receipt_path.display())).unwrap()
    );
    f.state.lock().unwrap().scenario = "valid".into();
    let recovered = f.recover().unwrap();
    assert_eq!(
        recovered["recoveredReservationIds"],
        json!(["reservation:image-2"])
    );
    assert_eq!(recovered["mirror"]["publicationGeneration"], 2);
    assert_eq!(recovered["mirror"]["sideEffectPermitHash"], Value::Null);
    assert_eq!(
        read_with_coordinator(
            &f.receipt_path,
            &f.context(),
            &f.coordinator,
            PUBLICATION_DATABASE_ROLE
        )
        .unwrap()
        .unwrap()["inspection"]["ready"],
        true
    );
}

#[test]
fn missing_or_invalid_finalization_never_writes_mirror_and_recovery_does_not_repeat_dml() {
    for scenario in ["finalization-pending", "wrong-permit", "invalid-signature"] {
        let mut f = Fixture::new(scenario);
        let failure = f.publish().unwrap_err();
        assert_eq!(
            failure.code,
            "externally_fenced_sqlite_mutation_committed_finalization_pending"
        );
        assert_eq!(failure.details["details"]["committed"], true);
        assert!(!f.receipt_path.exists());
        let db = f.db();
        assert_eq!(
            db.query_row(
                "SELECT publication_generation FROM runtime_image_reproducibility_receipt",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        drop(db);
        f.state.lock().unwrap().scenario = "valid".into();
        let recovered = f.recover().unwrap();
        assert_eq!(
            recovered["recoveredReservationIds"],
            json!(["reservation:image-1"])
        );
        assert!(sha(&recovered["mirror"]["sideEffectPermitHash"]));
        assert_eq!(
            f.db()
                .query_row(
                    "SELECT publication_generation FROM runtime_image_reproducibility_receipt",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            f.state
                .lock()
                .unwrap()
                .calls
                .iter()
                .filter(|v| v["kind"] == "AutonomousResearchOnlineMutationReserveRequest")
                .count(),
            1
        );
    }
}

#[test]
fn post_finalize_mirror_failure_and_tampered_signed_generation_fail_closed() {
    let mut f = Fixture::new("mirror-failure");
    let failure = f.publish().unwrap_err();
    assert_eq!(
        failure.code,
        "runtime_reproducibility_receipt_committed_mirror_pending"
    );
    assert_eq!(failure.details["committed"], true);
    assert!(!f.receipt_path.exists());
    fs::set_permissions(&f.root, fs::Permissions::from_mode(0o700)).unwrap();
    f.state.lock().unwrap().scenario = "valid".into();
    let recovered = f.recover().unwrap();
    assert_eq!(recovered["recoveredReservationIds"], json!([]));
    assert_eq!(recovered["mirror"]["publicationGeneration"], 1);
    fs::remove_file(&f.receipt_path).unwrap();
    f.db()
        .execute(
            "UPDATE runtime_image_reproducibility_receipt SET publication_generation=42",
            [],
        )
        .unwrap();
    let failure = f.recover().unwrap_err();
    assert_eq!(
        failure.code,
        "runtime_reproducibility_receipt_generation_not_signed"
    );
    assert!(!f.receipt_path.exists());
}

#[test]
fn finalized_journal_signature_and_duplicate_json_cannot_authorize_repair() {
    for duplicate in [false, true] {
        let mut f = Fixture::new("valid");
        f.publish().unwrap();
        fs::remove_file(&f.receipt_path).unwrap();
        let db = f.db();
        let trigger:String=db.query_row("SELECT sql FROM sqlite_schema WHERE name='autonomous_research_online_mutation_finalization_no_update'",[],|r|r.get(0)).unwrap();
        db.execute_batch("DROP TRIGGER autonomous_research_online_mutation_finalization_no_update")
            .unwrap();
        let raw:String=db.query_row("SELECT finalization_receipt_json FROM autonomous_research_online_mutation_finalization_receipt",[],|r|r.get(0)).unwrap();
        let mut receipt: Value = serde_json::from_str(&raw).unwrap();
        receipt["signature"] = Base64::encode_string(&[0u8; 64]).into();
        let text = if duplicate {
            format!("{{\"version\":1,{}", &raw[1..])
        } else {
            receipt.to_string()
        };
        let hash = if duplicate {
            online_mutation_receipt_hash_v1(&serde_json::from_str::<Value>(&raw).unwrap()).unwrap()
        } else {
            online_mutation_receipt_hash_v1(&receipt).unwrap()
        };
        db.execute("UPDATE autonomous_research_online_mutation_finalization_receipt SET finalization_receipt_json=?,finalization_receipt_hash=?",rusqlite::params![text,hash]).unwrap();
        db.execute_batch(&trigger).unwrap();
        drop(db);
        let failure = f.recover().unwrap_err();
        assert!(!f.receipt_path.exists());
        assert!(
            failure.code.contains(if duplicate {
                "finalized_journal_invalid"
            } else {
                "finalization_receipt_invalid"
            }),
            "{}",
            failure.code
        );
    }
}
