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
                std::env::var_os("HEPTA_HEARTBEAT_ORACLE")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        repository.join("rust/oracle/state-recoverability-heartbeat-v1.mjs")
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
fn apply_real_heartbeat(f: &Fixture, scenario: &str, cycle: bool) -> Value {
    let result =
        oracle(json!({"root":f.root,"mode":"heartbeat","scenario":scenario,"cycle":cycle}));
    assert_eq!(result["marked"].as_array().unwrap().len(), 1);
    assert_eq!(result["journal"]["entries"].as_array().unwrap().len(), 1);
    let mut state = f.state.borrow_mut();
    state.head = Some(json!({"sequence":1,"hash":result["journal"]["globalHash"]}));
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
#[test]
fn real_signed_heartbeat_reuses_snapshot_and_matches_node_replay_without_new_backup() {
    for cycle in [false, true] {
        let f = Fixture::new();
        let now = Rc::new(Cell::new(NOW));
        let clock = now.clone();
        let mut controller = f.controller_with_clock(Box::new(move || Ok(clock.get())));
        let first = controller.reconcile_with_validity(0).unwrap();
        let path = PathBuf::from(first["bundlePath"].as_str().unwrap());
        let original = fs::read(path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json")).unwrap();
        let count = backup_calls(&f.state.borrow());
        assert_eq!(count, 2);
        let heartbeat = apply_real_heartbeat(&f, "valid", cycle);
        now.set(NOW + 1000);
        controller.mark_finalized(&heartbeat["marked"][0]).unwrap();
        assert!(
            controller
                .assert_for_action("before-refresh")
                .unwrap_err()
                .state_recoverability_deferred
        );
        let live = database_bytes(&f);
        let refreshed = controller
            .reconcile_existing_heartbeat_history_v1(&path, 1000)
            .unwrap();
        assert_eq!(
            refreshed["status"], "autonomous_research_state_recoverability_ready",
            "{refreshed}"
        );
        assert_eq!(refreshed["mode"], "journal-renewed");
        assert_eq!(refreshed["bundlePath"], first["bundlePath"]);
        assert_eq!(refreshed["headSequence"], 1);
        assert_eq!(
            controller
                .assert_for_action("after-refresh")
                .unwrap()
                .value()["globalHash"],
            heartbeat["journal"]["globalHash"]
        );
        assert_eq!(backup_calls(&f.state.borrow()), count);
        assert_eq!(
            fs::read(path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json")).unwrap(),
            original
        );
        assert_eq!(database_bytes(&f), live);
        if !cycle {
            // This fresh controller has no cached current-row proof.
            let mut restarted = f.controller_with_clock(Box::new(|| Ok(NOW + 1000)));
            assert_eq!(
                restarted.reconcile_with_validity(1000).unwrap()["status"],
                "autonomous_research_state_recoverability_ready"
            );
            assert!(
                restarted
                    .assert_for_action("fresh-verified-history")
                    .is_ok()
            );
        }
        let native: Value =
            serde_json::from_slice(&fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap())
                .unwrap();
        let node = oracle(
            json!({"root":f.root,"mode":"drill","bundlePath":path,"now":clock::iso(NOW+1000).unwrap()}),
        );
        assert_eq!(native, node);
    }
}
#[test]
fn signed_head_cannot_hide_unrecorded_rows_null_primary_keys_or_bad_nested_signature() {
    for scenario in ["unrecorded-row", "null-primary-key", "bad-signature"] {
        let f = Fixture::new();
        let now = Rc::new(Cell::new(NOW));
        let clock = now.clone();
        let mut controller = f.controller_with_clock(Box::new(move || Ok(clock.get())));
        let first = controller.reconcile_with_validity(0).unwrap();
        let path = PathBuf::from(first["bundlePath"].as_str().unwrap());
        let heartbeat = apply_real_heartbeat(&f, scenario, false);
        now.set(NOW + 1000);
        controller.mark_finalized(&heartbeat["marked"][0]).unwrap();
        let original = database_bytes(&f);
        let original_receipt = fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap();
        let count = backup_calls(&f.state.borrow());
        let error = controller
            .reconcile_existing_heartbeat_history_v1(&path, 0)
            .unwrap_err();
        assert!(
            error.code.contains(if scenario == "bad-signature" {
                "journal_entry_invalid"
            } else {
                "effective_state_mismatch"
            }),
            "{scenario}: {error}"
        );
        assert!(controller.assert_for_action("rejected").is_err());
        assert_eq!(database_bytes(&f), original);
        assert_eq!(
            fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap(),
            original_receipt
        );
        assert_eq!(backup_calls(&f.state.borrow()), count);
    }
}

struct NativeHeartbeatBroker {
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
impl MutationAuthorityTransportV1 for NativeHeartbeatBroker {
    fn invoke(&mut self, q: &Value) -> mutation::Result<Value> {
        self.state.borrow_mut().calls.push(q.clone());
        let kind = q["kind"].as_str().unwrap();
        let now = clock::iso(NOW + 1000)?;
        let expires = clock::iso(NOW + 61000)?;
        if kind == "AutonomousResearchOnlineMutationCurrentHeadRequest" {
            return Ok(signed_online(
                json!({"version":1,"kind":"AutonomousResearchOnlineMutationCurrentHeadReceipt","status":"autonomous_research_online_mutation_current_head_observed","authorityId":self.configuration["authorityId"],"keyId":self.configuration["keyId"],"requestHash":hash(kind,q),"protocol":mutation::ONLINE_MUTATION_PROTOCOL,"scopeId":self.configuration["scopeId"],"databaseScopeHash":self.configuration["databaseScopeHash"],"writerManifestHash":self.configuration["writerManifestHash"],"globalSequence":0,"globalHash":h("global:0"),"databaseHeads":self.heads,"unresolvedReservationCount":0,"observedAt":now,"expiresAt":expires}),
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
                v["reservationId"] = "heartbeat:1".into();
                v["globalSequence"] = 1.into();
                v["globalHash"] = h("global:1").into();
                v["databaseSequence"] = 1.into();
                v["databaseHash"] = h("database:resident-instance:1").into();
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
                v["sideEffectPermitHash"] = h("heartbeat-permit:1").into();
                v["finalizedAt"] = now.into();
                let signed = signed_online(v);
                let (request, reservation) = self.reserve.as_ref().unwrap();
                for head in self.heads.as_array_mut().unwrap() {
                    if head["databaseInstanceId"] == "resident-instance" {
                        head["sequence"] = 1.into();
                        head["hash"] = reservation["databaseHash"].clone();
                        head["stateHash"] = reservation["postStateHash"].clone();
                    }
                }
                let mut state = self.state.borrow_mut();
                state.head = Some(json!({"sequence":1,"hash":reservation["globalHash"]}));
                state.journal = Some(
                    json!({"entries":[{"reserveRequest":request,"reservationReceipt":reservation,"finalizeRequest":q,"finalizationReceipt":signed}],"databaseHeads":self.heads,"globalHash":reservation["globalHash"]}),
                );
                Ok(signed)
            }
            _ => Err(fail("unexpected_native_heartbeat_authority_operation")),
        }
    }
}
#[test]
fn actual_native_coordinator_heartbeat_generates_node_changeset_and_refreshes_epoch() {
    let f = Fixture::new();
    let now = Rc::new(Cell::new(NOW));
    let time = now.clone();
    let mut controller = f.controller_with_clock(Box::new(move || Ok(time.get())));
    let first = controller.reconcile_with_validity(0).unwrap();
    let bundle = PathBuf::from(first["bundlePath"].as_str().unwrap());
    let mut heads=f.data["inventory"]["instances"].as_array().unwrap().iter().map(|i|json!({"databaseRole":i["role"],"databaseInstanceId":i["instanceId"],"sequence":0,"hash":h(&format!("database:{}:0",i["instanceId"].as_str().unwrap())),"schemaHash":i["schemaHash"],"stateHash":h(&format!("state:{}:0",i["instanceId"].as_str().unwrap()))})).collect::<Vec<_>>();
    heads.sort_by(|a, b| {
        a["databaseInstanceId"]
            .as_str()
            .cmp(&b["databaseInstanceId"].as_str())
    });
    let instances=json!(heads.iter().map(|h|json!({"databaseRole":h["databaseRole"],"databaseInstanceId":h["databaseInstanceId"],"schemaHash":h["schemaHash"]})).collect::<Vec<_>>());
    let config: Value =
        serde_json::from_slice(&fs::read(f.data["onlineConfiguration"].as_str().unwrap()).unwrap())
            .unwrap();
    let authority = PinnedMutationAuthorityV1::load(
        Path::new(f.data["onlineConfiguration"].as_str().unwrap()),
        f.data["onlineConfigurationHash"].as_str().unwrap(),
        NativeHeartbeatBroker {
            state: f.state.clone(),
            heads: json!(heads),
            configuration: config,
            reserve: None,
        },
    )
    .unwrap();
    let mut coordinator = mutation::SqliteMutationCoordinatorV1::new(
        authority,
        mutation::SqliteMutationCoordinatorOptionsV1 {
            manifest: f.data["writerManifest"].clone(),
            operation_plans: f.data["plans"].clone(),
            database_instances: instances,
            requested_lease_ms: None,
            commit_safety_margin_ms: 1000,
        },
        Box::new(|| Ok(NOW + 1000)),
        None,
    )
    .unwrap();
    // This is the actual configured low-level coordinator, not fabricated active
    // runtime authority. The epoch below is independently proven by replay.
    assert_ne!(
        coordinator.inspect_status()["status"],
        "externally_fenced_sqlite_mutation_coordinator_active"
    );
    let instance = f.data["inventory"]["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["role"] == "resident-instance")
        .unwrap();
    let mut db = rusqlite::Connection::open(
        Path::new(f.data["runtime"].as_str().unwrap())
            .join(instance["sourceRelativePath"].as_str().unwrap()),
    )
    .unwrap();
    let lease = &f.data["lease"];
    let stamp = clock::iso(NOW + 1000).unwrap();
    let expiry = clock::iso(NOW + 1000 + lease["leaseMs"].as_i64().unwrap()).unwrap();
    use rusqlite::types::Value as Sql;
    let parameters = vec![
        Sql::Text(stamp.clone()),
        Sql::Text(expiry.clone()),
        Sql::Null,
        Sql::Null,
        Sql::Text(stamp.clone()),
        Sql::Text("resident-autonomous-research-supervisor".into()),
        Sql::Text(lease["ownerId"].as_str().unwrap().into()),
        Sql::Text(lease["leaseToken"].as_str().unwrap().into()),
        Sql::Integer(lease["leaseGeneration"].as_i64().unwrap()),
        Sql::Text(stamp),
    ];
    let mutation=coordinator.execute_mutation(&mut db,&json!({"databaseRole":"resident-instance","databaseInstanceId":"resident-instance","schemaContractId":"resident-instance-schema-v1","writerId":"writer:resident-instance:supervisor-instance-repository:v1","operationId":"resident-instance.supervisor-instance-repository.heartbeatInstanceLease.v1","authorizationReceiptHashes":[],"sideEffectReservationHashes":[]}),|tx|Ok(tx.run("resident-instance.heartbeat.apply.v1",&parameters)?)).unwrap();
    assert_eq!(mutation["value"]["changes"], 1, "{mutation}");
    drop(db);
    now.set(NOW + 1000);
    let journal = f.state.borrow().journal.clone().unwrap();
    controller
        .mark_finalized(&json!({"globalSequence":1,"globalHash":journal["globalHash"]}))
        .unwrap();
    let refreshed = controller
        .reconcile_existing_heartbeat_history_v1(&bundle, 1000)
        .unwrap();
    assert_eq!(refreshed["headSequence"], 1);
    assert!(controller.assert_for_action("native-heartbeat").is_ok());
    assert_eq!(backup_calls(&f.state.borrow()), 2);
    let node = Fixture::new();
    let heartbeat = apply_real_heartbeat(&node, "valid", false);
    assert_eq!(
        journal["entries"][0]["reservationReceipt"]["changesetBase64"],
        heartbeat["journal"]["entries"][0]["reservationReceipt"]["changesetBase64"]
    );
    assert_eq!(
        journal["entries"][0]["reservationReceipt"]["postStateHash"],
        heartbeat["journal"]["entries"][0]["reservationReceipt"]["postStateHash"]
    );
}

#[test]
fn a_new_controller_rejects_valid_historical_drill_over_unrecorded_live_rows() {
    let f = Fixture::new();
    let mut service = f.service();
    let backup = service.backup(&mut || Ok(NOW)).unwrap();
    let bundle = PathBuf::from(backup["bundlePath"].as_str().unwrap());
    let heartbeat = apply_real_heartbeat(&f, "unrecorded-row", false);
    // The historical snapshot and signed journal really are recoverable. This
    // valid historical receipt does not authenticate the additional live row.
    let historical = service
        .restore_drill(&bundle, &mut || Ok(NOW + 1000))
        .unwrap();
    assert_eq!(
        historical["status"],
        "autonomous_research_state_restore_drill_passed"
    );
    let mut controller = f.controller_with_clock(Box::new(|| Ok(NOW + 1000)));
    let result = controller.reconcile_with_validity(0);
    let error = result.unwrap_err();
    assert!(
        error.code.contains("effective_state_mismatch"),
        "wrong rejection: {error}; signed head {}",
        heartbeat["journal"]["globalHash"]
    );
    assert!(
        controller
            .assert_for_action("unsigned-business-row")
            .is_err()
    );
}

#[test]
fn changed_live_rows_during_completion_clock_do_not_replace_stored_drill() {
    let f = Fixture::new();
    let mut service = f.service();
    let backup = service.backup(&mut || Ok(NOW)).unwrap();
    let path = PathBuf::from(backup["bundlePath"].as_str().unwrap());
    service.restore_drill(&path, &mut || Ok(NOW)).unwrap();
    let original = fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap();
    apply_real_heartbeat(&f, "valid", false);
    let instance = f.data["inventory"]["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["role"] == "native-store")
        .unwrap();
    let live_path = Path::new(f.data["runtime"].as_str().unwrap())
        .join(instance["sourceRelativePath"].as_str().unwrap());
    let count = Rc::new(Cell::new(0));
    let ticks = count.clone();
    let injected = Rc::new(Cell::new(false));
    let changed = injected.clone();
    let mut controller = f.controller_with_clock(Box::new(move || {
        ticks.set(ticks.get() + 1);
        if ticks.get() == 9 {
            let db = rusqlite::Connection::open(&live_path)?;
            db.execute(
                "UPDATE records SET value='late-unrecorded' WHERE id='subject'",
                [],
            )?;
            changed.set(true);
        }
        Ok(NOW + 1000)
    }));
    let error = controller
        .reconcile_existing_heartbeat_history_v1(&path, 0)
        .unwrap_err();
    assert!(
        injected.get(),
        "injection point was not reached: {} ticks",
        count.get()
    );
    assert!(error.code.contains("changed"), "unexpected error: {error}");
    assert_eq!(
        fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap(),
        original
    );
    assert!(controller.assert_for_action("late-source-change").is_err());
}
