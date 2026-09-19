//! Real temporary SQLite state and deterministic fixture-only Ed25519 keys.
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_paper_service::{
    sqlite_mutation_coordinator::{
        self as mutation,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock,
    },
    state_backup_authority::{
        PinnedStateBackupAuthorityV1, StateBackupAuthorityTransportV1,
        state_backup_authority_signature_payload_v1,
    },
    state_recoverability::{
        controller::{RecoverabilityPolicyV1, StateRecoverabilityControllerV1},
        resident::ResidentLeaseV1,
        service::{BackupRecoveryServiceOptionsV1, BackupRecoveryServiceV1},
    },
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
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
    hash("RecoverabilityNativeFixture", &json!({"label":label}))
}
fn fail(code: &str) -> mutation::SqliteMutationCoordinatorError {
    mutation::SqliteMutationCoordinatorError {
        code: code.into(),
        details: json!({}),
        state_recoverability_fatal: false,
        state_recoverability_deferred: false,
        retryable: false,
    }
}
fn oracle(input: Value) -> Value {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child =
        Command::new(std::env::var("HEPTA_TEST_NODE").unwrap_or_else(|_| "node".into()))
            .arg(
                std::env::var_os("HEPTA_MIXED_ORACLE")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        repository.join("rust/oracle/state-recoverability-mixed-v1.mjs")
                    }),
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
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&response["profile"]).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    response["value"].clone()
}
#[derive(Default)]
struct State {
    calls: Vec<Value>,
    mode: String,
    head: Option<Value>,
    journal: Option<Value>,
}
struct BackupBroker(Rc<RefCell<State>>);
impl StateBackupAuthorityTransportV1 for BackupBroker {
    fn invoke(&mut self, q: &Value) -> mutation::Result<Value> {
        let mut state = self.0.borrow_mut();
        state.calls.push(q.clone());
        if state.mode == "timeout" {
            return Err(fail("autonomous_research_state_backup_authority_timeout"));
        }
        let now = q["requestedAt"].as_str().unwrap();
        let expires=clock::iso(hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis(now).unwrap()+60000).unwrap();
        let mut v = json!({"version":1,"authorityId":"backup:authority","keyId":"backup:key","requestHash":hash(q["kind"].as_str().unwrap(),q)});
        match q["kind"].as_str().unwrap() {
            "AutonomousResearchStateBackupAuthorityReserveRequest" => {
                v["kind"] = "AutonomousResearchStateBackupAuthorityReservation".into();
                v["status"] = "autonomous_research_state_backup_authority_reserved".into();
                v["reservationId"] = "backup:reservation".into();
                for k in ["inventoryHash", "databaseScopeHash", "databaseInstanceIds"] {
                    v[k] = q[k].clone();
                }
                v["headSequence"] = 0.into();
                v["headHash"] = h("global:0").into();
                v["issuedAt"] = q["requestedAt"].clone();
                v["expiresAt"] = expires.into();
                v["mutationFenceProtocol"] =
                    "external-linearizable-reserve-apply-finalize-v1".into();
                v["allRegisteredMutationsFenced"] = true.into();
            }
            "AutonomousResearchStateBackupAuthorityFinalizeRequest" => {
                v["kind"] = "AutonomousResearchStateBackupAuthorityFinalization".into();
                v["status"] = "autonomous_research_state_backup_authority_finalized".into();
                for k in [
                    "reservationId",
                    "inventoryHash",
                    "databaseScopeHash",
                    "snapshotContentHash",
                ] {
                    v[k] = q[k].clone();
                }
                v["headSequence"] = 0.into();
                v["headHash"] = h("global:0").into();
                v["finalizedAt"] = q["requestedAt"].clone();
                v["allRegisteredMutationsFencedThroughFinalize"] = true.into();
            }
            "AutonomousResearchStateBackupAuthorityCurrentHeadRequest" => {
                v["kind"] = "AutonomousResearchStateBackupAuthorityCurrentHead".into();
                v["status"] = "autonomous_research_state_backup_authority_head_observed".into();
                for k in ["reservationId", "databaseScopeHash"] {
                    v[k] = q[k].clone();
                }
                v["headSequence"] = state
                    .head
                    .as_ref()
                    .map(|h| h["sequence"].clone())
                    .unwrap_or(json!(0));
                v["headHash"] = state
                    .head
                    .as_ref()
                    .map(|h| h["hash"].clone())
                    .unwrap_or(json!(h("global:0")));
                v["observedAt"] = q["requestedAt"].clone();
                v["expiresAt"] = expires.into();
                v["mutationFenceProtocol"] = "external-linearizable-restore-validation-v1".into();
                v["allRegisteredMutationsFenced"] = true.into();
            }
            "AutonomousResearchStateBackupAuthorityJournalRangeRequest" => {
                let journal = state
                    .journal
                    .as_ref()
                    .ok_or_else(|| fail("fixture_journal_unavailable"))?;
                v["kind"] = "AutonomousResearchStateBackupAuthorityJournalRange".into();
                v["status"] =
                    "autonomous_research_state_backup_authority_journal_range_complete".into();
                for key in [
                    "reservationId",
                    "databaseScopeHash",
                    "snapshotContentHash",
                    "onlineAuthorityId",
                    "onlineKeyId",
                    "scopeId",
                    "writerManifestHash",
                    "fromGlobalSequence",
                    "fromGlobalHash",
                    "toGlobalSequence",
                    "toGlobalHash",
                ] {
                    v[key] = q[key].clone();
                }
                v["entries"] = journal["entries"].clone();
                v["databaseHeads"] = journal["databaseHeads"].clone();
                v["observedAt"] = q["requestedAt"].clone();
                v["expiresAt"] = expires.into();
                v["mutationFenceProtocol"] =
                    "external-linearizable-finalized-mutation-journal-v1".into();
                v["completeFinalizedMutationJournal"] = true.into();
            }
            _ => return Err(fail("fixture_journal_unavailable")),
        }
        if state.mode == "bad-scope" {
            v["databaseScopeHash"] = h("wrong").into();
        }
        let key = SigningKey::from_bytes(&[77; 32]);
        let signature = key.sign(state_backup_authority_signature_payload_v1(&v)?.as_bytes());
        v["signature"] = Base64::encode_string(&signature.to_bytes()).into();
        if state.mode == "bad-signature" {
            v["signature"] = "invalid".into();
        }
        if state.mode == "finalize-lost"
            && q["kind"] == "AutonomousResearchStateBackupAuthorityFinalizeRequest"
        {
            return Err(fail("autonomous_research_state_backup_authority_timeout"));
        }
        Ok(v)
    }
}
struct OnlineBroker(Rc<RefCell<State>>);
impl MutationAuthorityTransportV1 for OnlineBroker {
    fn invoke(&mut self, q: &Value) -> mutation::Result<Value> {
        self.0.borrow_mut().calls.push(q.clone());
        if q["kind"] != "AutonomousResearchOnlineUnresolvedReservationListRequest" {
            return Err(fail("unexpected_online_operation"));
        }
        let mut v = q.clone();
        v["kind"] = "AutonomousResearchOnlineUnresolvedReservationListReceipt".into();
        v["status"] = "autonomous_research_online_unresolved_reservations_observed".into();
        v["authorityId"] = "authority:test".into();
        v["keyId"] = "key:test".into();
        v["requestHash"] = hash(q["kind"].as_str().unwrap(), q).into();
        v["unresolvedReservations"] = json!([]);
        v["unresolvedReservationCount"] = 0.into();
        v["unresolvedReservationSetHash"] =
            mutation::contracts::activation::unresolved_reservation_set_hash_v1(&json!([]))?.into();
        v["observedAt"] = q["requestedAt"].clone();
        let millis=hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis(q["requestedAt"].as_str().unwrap()).unwrap();
        v["expiresAt"] = clock::iso(millis + 60000)?.into();
        let signature = SigningKey::from_bytes(&[88; 32])
            .sign(mutation::contracts::online_mutation_signed_payload_v1(&v)?.as_bytes());
        v["signature"] = Base64::encode_string(&signature.to_bytes()).into();
        Ok(v)
    }
}
struct Fixture {
    root: PathBuf,
    data: Value,
    state: Rc<RefCell<State>>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-recoverability-e2e-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let data = oracle(json!({"root":root,"mode":"fixture"}));
        assert_eq!(clock::iso(NOW).unwrap(), data["now"]);
        Self {
            root,
            data,
            state: Rc::new(RefCell::new(State::default())),
        }
    }
    fn service(&self) -> BackupRecoveryServiceV1<BackupBroker, OnlineBroker> {
        let b = PinnedStateBackupAuthorityV1::load(
            Path::new(self.data["backupConfiguration"].as_str().unwrap()),
            self.data["backupConfigurationHash"].as_str().unwrap(),
            BackupBroker(self.state.clone()),
        )
        .unwrap();
        let o = PinnedMutationAuthorityV1::load(
            Path::new(self.data["onlineConfiguration"].as_str().unwrap()),
            self.data["onlineConfigurationHash"].as_str().unwrap(),
            OnlineBroker(self.state.clone()),
        )
        .unwrap();
        BackupRecoveryServiceV1::new(
            b,
            o,
            BackupRecoveryServiceOptionsV1 {
                runtime_root: PathBuf::from(self.data["runtime"].as_str().unwrap()),
                backup_root: PathBuf::from(self.data["backupRoot"].as_str().unwrap()),
                state_database_manifest: self.data["manifest"].clone(),
                writer_manifest: self.data["writerManifest"].clone(),
            },
        )
        .unwrap()
    }
    fn controller_with_clock(
        &self,
        time: Box<dyn clock::MutationClockV1>,
    ) -> StateRecoverabilityControllerV1<BackupBroker, OnlineBroker> {
        let lease = &self.data["lease"];
        let lease = ResidentLeaseV1::new(
            Path::new(self.data["runtime"].as_str().unwrap()),
            lease["ownerId"].as_str().unwrap(),
            lease["leaseToken"].as_str().unwrap(),
            lease["leaseGeneration"].as_i64().unwrap(),
        )
        .unwrap();
        StateRecoverabilityControllerV1::new(
            self.service(),
            lease,
            time,
            RecoverabilityPolicyV1::default(),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn backup_calls(state: &State) -> usize {
    state
        .calls
        .iter()
        .filter(|q| {
            matches!(
                q["kind"].as_str(),
                Some(
                    "AutonomousResearchStateBackupAuthorityReserveRequest"
                        | "AutonomousResearchStateBackupAuthorityFinalizeRequest"
                )
            )
        })
        .count()
}
fn apply_node(f: &Fixture, operation: &str, scenario: &str) -> Value {
    let result =
        oracle(json!({"root":f.root,"mode":"heartbeat","scenario":scenario,"operation":operation}));
    assert_eq!(result["marked"].as_array().unwrap().len(), 1);
    let sequence = result["journal"]["entries"].as_array().unwrap().len();
    let mut state = f.state.borrow_mut();
    state.head = Some(json!({"sequence":sequence,"hash":result["journal"]["globalHash"]}));
    state.journal = Some(result["journal"].clone());
    result
}
fn database_bytes(f: &Fixture) -> Vec<Vec<u8>> {
    f.data["inventory"]["instances"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            fs::read(
                Path::new(f.data["runtime"].as_str().unwrap())
                    .join(i["sourceRelativePath"].as_str().unwrap()),
            )
            .unwrap()
        })
        .collect()
}

fn compare_node_controller(include_heartbeat: bool) {
    let f = Fixture::new();
    let mut service = f.service();
    let backup = service.backup(&mut || Ok(NOW)).unwrap();
    let path = PathBuf::from(backup["bundlePath"].as_str().unwrap());
    service.restore_drill(&path, &mut || Ok(NOW)).unwrap();
    let previous = fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap();
    let original = fs::read(path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json")).unwrap();
    apply_node(&f, "business", "valid");
    let sequence = if include_heartbeat {
        apply_node(&f, "heartbeat", "valid");
        2
    } else {
        1
    };
    let mutated = json!({"journal":f.state.borrow().journal.clone().unwrap()});
    assert_eq!(
        mutated["journal"]["entries"].as_array().unwrap().len(),
        sequence
    );
    assert_eq!(
        mutated["journal"]["entries"][0]["reservationReceipt"]["databaseRole"],
        "native-store"
    );
    if include_heartbeat {
        assert_eq!(
            mutated["journal"]["entries"][1]["reservationReceipt"]["databasePreviousSequence"],
            0
        );
    }
    let live = database_bytes(&f);
    let count = backup_calls(&f.state.borrow());
    let node = oracle(
        json!({"root":f.root,"mode":"controller","now":clock::iso(NOW+sequence as i64*1000).unwrap(),"events":[{"op":"reconcile","required":1000}]}),
    );
    assert_eq!(node[0]["ok"], true, "{node}");
    let node_drill: Value =
        serde_json::from_slice(&fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap())
            .unwrap();
    fs::write(path.join("RESTORE_DRILL_RECEIPT.json"), previous).unwrap();
    let mut controller =
        f.controller_with_clock(Box::new(move || Ok(NOW + sequence as i64 * 1000)));
    let before = f.state.borrow().calls.len();
    let actual = controller.reconcile_with_validity(1000).unwrap();
    assert_eq!(actual, node[0]["value"]);
    assert_eq!(actual["headSequence"], sequence);
    assert!(controller.assert_for_action("mixed-signed-history").is_ok());
    assert_eq!(backup_calls(&f.state.borrow()), count);
    assert_eq!(f.state.borrow().calls.len() - before, 3);
    let actual_drill: Value =
        serde_json::from_slice(&fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap())
            .unwrap();
    assert_eq!(actual_drill, node_drill);
    assert_eq!(
        fs::read(path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json")).unwrap(),
        original
    );
    assert_eq!(database_bytes(&f), live);
}

#[test]
fn fixed_business_and_heartbeat_mixed_range_matches_entire_original_controller() {
    compare_node_controller(true);
}
#[test]
fn fixed_business_without_heartbeat_matches_entire_original_controller() {
    compare_node_controller(false);
}

struct NativeMixedBroker {
    state: Rc<RefCell<State>>,
    heads: Value,
    configuration: Value,
    reserve: Option<(Value, Value)>,
}
fn signed_online(mut value: Value) -> Value {
    let signature = SigningKey::from_bytes(&[88; 32]).sign(
        mutation::contracts::online_mutation_signed_payload_v1(&value)
            .unwrap()
            .as_bytes(),
    );
    value["signature"] = Base64::encode_string(&signature.to_bytes()).into();
    value
}
impl MutationAuthorityTransportV1 for NativeMixedBroker {
    fn invoke(&mut self, q: &Value) -> mutation::Result<Value> {
        self.state.borrow_mut().calls.push(q.clone());
        let kind = q["kind"].as_str().unwrap();
        let sequence = self
            .state
            .borrow()
            .journal
            .as_ref()
            .map(|v| v["entries"].as_array().unwrap().len())
            .unwrap_or(0);
        let now = clock::iso(NOW + (sequence as i64 + 1) * 1000)?;
        let expires = clock::iso(NOW + (sequence as i64 + 1) * 1000 + 60000)?;
        if kind == "AutonomousResearchOnlineMutationCurrentHeadRequest" {
            return Ok(signed_online(
                json!({"version":1,"kind":"AutonomousResearchOnlineMutationCurrentHeadReceipt","status":"autonomous_research_online_mutation_current_head_observed","authorityId":self.configuration["authorityId"],"keyId":self.configuration["keyId"],"requestHash":hash(kind,q),"protocol":mutation::ONLINE_MUTATION_PROTOCOL,"scopeId":self.configuration["scopeId"],"databaseScopeHash":self.configuration["databaseScopeHash"],"writerManifestHash":self.configuration["writerManifestHash"],"globalSequence":sequence,"globalHash":h(&format!("global:{sequence}")),"databaseHeads":self.heads,"unresolvedReservationCount":0,"observedAt":now,"expiresAt":expires}),
            ));
        }
        let mut v = q.clone();
        v["authorityId"] = self.configuration["authorityId"].clone();
        v["keyId"] = self.configuration["keyId"].clone();
        v["requestHash"] = hash(kind, q).into();
        match kind {
            "AutonomousResearchOnlineMutationReserveRequest" => {
                v.as_object_mut().unwrap().remove("requestedAt");
                v.as_object_mut().unwrap().remove("requestedLeaseMs");
                v["kind"] = "AutonomousResearchOnlineMutationReservationReceipt".into();
                v["status"] = "autonomous_research_online_mutation_reserved".into();
                v["reservationId"] = format!("mixed:{}", sequence + 1).into();
                v["globalSequence"] = (sequence + 1).into();
                v["globalHash"] = h(&format!("global:{}", sequence + 1)).into();
                v["databaseSequence"] =
                    (q["databasePreviousSequence"].as_i64().unwrap() + 1).into();
                v["databaseHash"] = h(&format!(
                    "database:{}:{}",
                    q["databaseInstanceId"].as_str().unwrap(),
                    q["databasePreviousSequence"].as_i64().unwrap() + 1
                ))
                .into();
                v["issuedAt"] = now.into();
                v["expiresAt"] = expires.into();
                let signed = signed_online(v);
                self.reserve = Some((q.clone(), signed.clone()));
                Ok(signed)
            }
            "AutonomousResearchOnlineMutationFinalizeRequest" => {
                v.as_object_mut().unwrap().remove("committedAt");
                v["kind"] = "AutonomousResearchOnlineMutationFinalizationReceipt".into();
                v["status"] = "autonomous_research_online_mutation_finalized".into();
                v["sideEffectPermitHash"] = h(&format!("mixed-permit:{}", sequence + 1)).into();
                v["finalizedAt"] = now.into();
                let signed = signed_online(v);
                let (request, reservation) = self.reserve.as_ref().unwrap();
                for head in self.heads.as_array_mut().unwrap() {
                    if head["databaseInstanceId"] == reservation["databaseInstanceId"] {
                        head["sequence"] = reservation["databaseSequence"].clone();
                        head["hash"] = reservation["databaseHash"].clone();
                        head["stateHash"] = reservation["postStateHash"].clone();
                    }
                }
                let mut state = self.state.borrow_mut();
                state.head = Some(json!({"sequence":sequence+1,"hash":reservation["globalHash"]}));
                let mut entries = state
                    .journal
                    .as_ref()
                    .map(|v| v["entries"].as_array().unwrap().clone())
                    .unwrap_or_default();
                entries.push(json!({"reserveRequest":request,"reservationReceipt":reservation,"finalizeRequest":q,"finalizationReceipt":signed}));
                state.journal = Some(
                    json!({"entries":entries,"databaseHeads":self.heads,"globalHash":reservation["globalHash"]}),
                );
                Ok(signed)
            }
            _ => Err(fail("unexpected_native_heartbeat_authority_operation")),
        }
    }
}
fn apply_native_mixed(f: &Fixture) {
    let mut heads=f.data["inventory"]["instances"].as_array().unwrap().iter().map(|i|json!({"databaseRole":i["role"],"databaseInstanceId":i["instanceId"],"sequence":0,"hash":h(&format!("database:{}:0",i["instanceId"].as_str().unwrap())),"schemaHash":i["schemaHash"],"stateHash":h(&format!("state:{}:0",i["instanceId"].as_str().unwrap()))})).collect::<Vec<_>>();
    heads.sort_by(|a, b| {
        a["databaseInstanceId"]
            .as_str()
            .cmp(&b["databaseInstanceId"].as_str())
    });
    let instances=json!(heads.iter().map(|h|json!({"databaseRole":h["databaseRole"],"databaseInstanceId":h["databaseInstanceId"],"schemaHash":h["schemaHash"]})).collect::<Vec<_>>());
    let config =
        serde_json::from_slice(&fs::read(f.data["onlineConfiguration"].as_str().unwrap()).unwrap())
            .unwrap();
    let authority = PinnedMutationAuthorityV1::load(
        Path::new(f.data["onlineConfiguration"].as_str().unwrap()),
        f.data["onlineConfigurationHash"].as_str().unwrap(),
        NativeMixedBroker {
            state: f.state.clone(),
            heads: json!(heads),
            configuration: config,
            reserve: None,
        },
    )
    .unwrap();
    let now = Rc::new(Cell::new(NOW + 1000));
    let time = now.clone();
    let mut coordinator = mutation::SqliteMutationCoordinatorV1::new(
        authority,
        mutation::SqliteMutationCoordinatorOptionsV1 {
            manifest: f.data["writerManifest"].clone(),
            operation_plans: f.data["plans"].clone(),
            database_instances: instances,
            requested_lease_ms: None,
            commit_safety_margin_ms: 1000,
        },
        Box::new(move || Ok(time.get())),
        None,
    )
    .unwrap();
    use rusqlite::types::Value as Sql;
    for role in ["native-store", "resident-instance"] {
        let instance = f.data["inventory"]["instances"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["role"] == role)
            .unwrap();
        let mut db = rusqlite::Connection::open(
            Path::new(f.data["runtime"].as_str().unwrap())
                .join(instance["sourceRelativePath"].as_str().unwrap()),
        )
        .unwrap();
        db.pragma_update(None, "foreign_keys", true).unwrap();
        let stamp = clock::iso(now.get()).unwrap();
        let (writer, operation, statement, parameters) = if role == "native-store" {
            (
                "writer:native-store:ledger-job-workflow:v1",
                "native-store.job-receipt-store.createJob.v1",
                "native-store.jobs.create.v1",
                vec![
                    Sql::Text("job:1".into()),
                    Sql::Text("dedup:1".into()),
                    Sql::Text("paper:mixed".into()),
                    Sql::Text("mixed-fixture".into()),
                    Sql::Integer(100),
                    Sql::Text("{}".into()),
                    Sql::Text(stamp.clone()),
                    Sql::Text(stamp),
                    Sql::Text("synthetic".into()),
                    Sql::Text("test".into()),
                ],
            )
        } else {
            let lease = &f.data["lease"];
            (
                "writer:resident-instance:supervisor-instance-repository:v1",
                "resident-instance.supervisor-instance-repository.heartbeatInstanceLease.v1",
                "resident-instance.heartbeat.apply.v1",
                vec![
                    Sql::Text(stamp.clone()),
                    Sql::Text(clock::iso(now.get() + lease["leaseMs"].as_i64().unwrap()).unwrap()),
                    Sql::Null,
                    Sql::Null,
                    Sql::Text(stamp.clone()),
                    Sql::Text("resident-autonomous-research-supervisor".into()),
                    Sql::Text(lease["ownerId"].as_str().unwrap().into()),
                    Sql::Text(lease["leaseToken"].as_str().unwrap().into()),
                    Sql::Integer(lease["leaseGeneration"].as_i64().unwrap()),
                    Sql::Text(stamp),
                ],
            )
        };
        let result=coordinator.execute_mutation(&mut db,&json!({"databaseRole":role,"databaseInstanceId":instance["instanceId"],"schemaContractId":instance["schemaContractId"],"writerId":writer,"operationId":operation,"authorizationReceiptHashes":[],"sideEffectReservationHashes":[]}),|tx|Ok(tx.run(statement,&parameters)?)).unwrap();
        assert_eq!(result["value"]["changes"], 1);
        now.set(NOW + 2000);
    }
    let journal = f.state.borrow().journal.clone().unwrap();
    fs::write(f.root.join("journal-fixture.json"), journal.to_string()).unwrap();
}

#[test]
fn native_fixed_coordinator_mixed_records_restore_without_new_backup() {
    let f = Fixture::new();
    let mut service = f.service();
    let backup = service.backup(&mut || Ok(NOW)).unwrap();
    let path = PathBuf::from(backup["bundlePath"].as_str().unwrap());
    service.restore_drill(&path, &mut || Ok(NOW)).unwrap();
    let old = fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap();
    apply_native_mixed(&f);
    let journal = f.state.borrow().journal.clone().unwrap();
    let node_fixture = Fixture::new();
    apply_node(&node_fixture, "business", "valid");
    apply_node(&node_fixture, "heartbeat", "valid");
    for index in 0..2 {
        let node = node_fixture.state.borrow().journal.clone().unwrap();
        for field in ["changesetBase64", "postStateHash", "codeProvenanceHash"] {
            assert_eq!(
                journal["entries"][index]["reservationReceipt"][field],
                node["entries"][index]["reservationReceipt"][field],
                "{index} {field}"
            );
        }
    }
    let node = oracle(
        json!({"root":f.root,"mode":"controller","now":clock::iso(NOW+2000).unwrap(),"events":[{"op":"reconcile","required":1000}]}),
    );
    assert_eq!(node[0]["ok"], true, "{node}");
    let node_drill: Value =
        serde_json::from_slice(&fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap())
            .unwrap();
    fs::write(path.join("RESTORE_DRILL_RECEIPT.json"), old).unwrap();
    let before = backup_calls(&f.state.borrow());
    let live = database_bytes(&f);
    let mut controller = f.controller_with_clock(Box::new(|| Ok(NOW + 2000)));
    assert_eq!(
        controller.reconcile_with_validity(1000).unwrap(),
        node[0]["value"]
    );
    let native_drill: Value =
        serde_json::from_slice(&fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap())
            .unwrap();
    assert_eq!(native_drill, node_drill);
    assert!(controller.assert_for_action("native-mixed").is_ok());
    assert_eq!(backup_calls(&f.state.borrow()), before);
    assert_eq!(database_bytes(&f), live);
}

#[test]
fn mixed_selected_candidate_rejects_signed_registry_bypasses_and_unsigned_rows_without_publication()
{
    let f = Fixture::new();
    let mut service = f.service();
    let backup = service.backup(&mut || Ok(NOW)).unwrap();
    let path = PathBuf::from(backup["bundlePath"].as_str().unwrap());
    service.restore_drill(&path, &mut || Ok(NOW)).unwrap();
    let old = fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap();
    apply_node(&f, "business", "valid");
    apply_node(&f, "heartbeat", "valid");
    let valid = f.state.borrow().journal.clone().unwrap();
    let original = database_bytes(&f);
    let count = backup_calls(&f.state.borrow());
    for scenario in [
        "unknown-operation",
        "cross-role-operation",
        "bad-provenance",
        "unregistered-effect",
        "system-effect",
        "bad-signature",
    ] {
        let mutant = oracle(json!({"root":f.root,"mode":"mutate-journal","scenario":scenario}));
        f.state.borrow_mut().journal = Some(mutant);
        let mut controller = f.controller_with_clock(Box::new(|| Ok(NOW + 2000)));
        let failure = controller.reconcile_with_validity(1000).unwrap_err();
        if [
            "unknown-operation",
            "cross-role-operation",
            "bad-provenance",
        ]
        .contains(&scenario)
        {
            assert!(
                failure
                    .code
                    .contains("registered_journal_operation_invalid"),
                "{scenario}: {failure}"
            );
        }
        if scenario == "unregistered-effect" {
            assert!(
                failure.code.contains("registered_journal_effect_forbidden"),
                "{failure}"
            );
        }
        assert_eq!(
            fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap(),
            old,
            "{scenario}"
        );
        assert_eq!(database_bytes(&f), original, "{scenario}");
        assert_eq!(backup_calls(&f.state.borrow()), count, "{scenario}");
        assert!(
            controller
                .assert_for_action("invalid-mixed-history")
                .is_err()
        );
    }
    f.state.borrow_mut().journal = Some(valid);
    let native = f.data["inventory"]["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["role"] == "native-store")
        .unwrap();
    let db = rusqlite::Connection::open(
        Path::new(f.data["runtime"].as_str().unwrap())
            .join(native["sourceRelativePath"].as_str().unwrap()),
    )
    .unwrap();
    db.execute("INSERT INTO records(id,value) VALUES(NULL,X'6162')", [])
        .unwrap();
    drop(db);
    let live = database_bytes(&f);
    let mut controller = f.controller_with_clock(Box::new(|| Ok(NOW + 2000)));
    let failure = controller.reconcile_with_validity(1000).unwrap_err();
    assert!(
        failure.code.contains("effective_state_mismatch"),
        "{failure}"
    );
    assert_eq!(
        fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap(),
        old
    );
    assert_eq!(database_bytes(&f), live);
    assert_eq!(backup_calls(&f.state.borrow()), count);
}
