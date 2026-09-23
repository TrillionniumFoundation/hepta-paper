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
    let mut child = Command::new("node")
        .arg(repository.join("rust/oracle/state-recoverability-v1.mjs"))
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
    fn controller(&self) -> StateRecoverabilityControllerV1<BackupBroker, OnlineBroker> {
        self.controller_with_clock(Box::new(|| Ok(NOW)))
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
#[test]
fn native_ten_database_backup_and_fresh_snapshot_drill_match_node() {
    let f = Fixture::new();
    let expected = oracle(json!({"root":f.root,"mode":"backup"}));
    assert_eq!(
        expected["status"], "autonomous_research_state_backup_recorded",
        "{expected}"
    );
    let node_manifest: Value = serde_json::from_slice(
        &fs::read(
            Path::new(expected["bundlePath"].as_str().unwrap())
                .join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let node_files = node_manifest["content"]["databases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            fs::read(
                Path::new(expected["bundlePath"].as_str().unwrap())
                    .join(v["backupRelativePath"].as_str().unwrap()),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    fs::remove_dir_all(expected["bundlePath"].as_str().unwrap()).unwrap();
    let mut service = f.service();
    let backup = service.backup(&mut || Ok(NOW)).unwrap();
    let native_manifest: Value = serde_json::from_slice(
        &fs::read(
            Path::new(backup["bundlePath"].as_str().unwrap())
                .join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json"),
        )
        .unwrap(),
    )
    .unwrap();
    for (entry, previous) in native_manifest["content"]["databases"]
        .as_array()
        .unwrap()
        .iter()
        .zip(node_files)
    {
        let current = fs::read(
            Path::new(backup["bundlePath"].as_str().unwrap())
                .join(entry["backupRelativePath"].as_str().unwrap()),
        )
        .unwrap();
        assert_eq!(current.len(), previous.len());
        let differences = current
            .iter()
            .zip(&previous)
            .enumerate()
            .filter_map(|(i, (a, b))| if a == b { None } else { Some((i, *a, *b)) })
            .collect::<Vec<_>>();
        assert!(
            differences.iter().all(|(i, _, _)| (96..100).contains(i)),
            "SQLite byte differences {differences:?}"
        );
    }
    let mut comparable = node_manifest["content"].clone();
    for (node, native) in comparable["databases"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(native_manifest["content"]["databases"].as_array().unwrap())
    {
        node["backupSha256"] = native["backupSha256"].clone();
    }
    assert_eq!(native_manifest["content"], comparable);
    let mut projected = expected.clone();
    for key in ["bundlePath", "snapshotContentHash", "bundleManifestHash"] {
        projected[key] = backup[key].clone();
    }
    assert_eq!(backup, projected);
    let bundle = Path::new(backup["bundlePath"].as_str().unwrap());
    let native = service.restore_drill(bundle, &mut || Ok(NOW)).unwrap();
    let node = oracle(json!({"root":f.root,"mode":"drill","bundlePath":bundle}));
    assert_eq!(native, node);
    let native_sources = service.inspect_sources(NOW).unwrap();
    let node_sources = oracle(json!({"root":f.root,"mode":"sources"}));
    assert_eq!(native_sources, node_sources);
    let collision = service.backup(&mut || Ok(NOW)).unwrap_err();
    assert_eq!(
        collision.code,
        "autonomous_research_state_backup_bundle_already_exists"
    );
    assert!(bundle.join("RESTORE_DRILL_RECEIPT.json").exists());
}
#[test]
fn controller_really_reconciles_ten_databases_renews_and_enforces_dirty_and_sticky_fatal() {
    let f = Fixture::new();
    let mut c = f.controller();
    assert!(
        c.assert_for_action("before")
            .unwrap_err()
            .state_recoverability_deferred
    );
    let ready = c.reconcile_with_validity(1000).unwrap();
    assert_eq!(ready["mode"], "fresh-snapshot-renewed", "{ready}");
    assert_eq!(
        ready["status"],
        "autonomous_research_state_recoverability_ready"
    );
    assert_eq!(
        c.assert_for_action("commit").unwrap().value()["globalHash"],
        h("global:0")
    );
    assert_eq!(
        f.state
            .borrow()
            .calls
            .iter()
            .filter(|q| q["kind"] == "AutonomousResearchOnlineUnresolvedReservationListRequest")
            .count(),
        20
    );
    c.require_reconciliation(&json!({"reason":"local_commit_uncertain","databaseRole":"resident-instance","databaseInstanceId":"resident-instance","committed":"unknown"})).unwrap();
    assert!(c.assert_for_action("held").is_err());
    assert_eq!(c.reconcile_with_validity(0).unwrap()["mode"], "current");
    c.mark_finalized(&json!({"globalSequence":1,"globalHash":h("global:1")}))
        .unwrap();
    assert!(c.assert_for_action("dirty").is_err());
    let deferred = c.reconcile_with_validity(0).unwrap();
    assert_eq!(deferred["mode"], "concurrent-finalization");
    assert_eq!(
        deferred["status"],
        "autonomous_research_state_recoverability_deferred"
    );
    let fatal = c
        .mark_finalized(&json!({"globalSequence":1,"globalHash":h("conflicting-head")}))
        .unwrap_err();
    assert!(fatal.state_recoverability_fatal);
    assert!(
        c.reconcile_with_validity(0)
            .unwrap_err()
            .state_recoverability_fatal
    );
}
#[test]
fn real_invalid_signatures_and_fresh_authority_equivocation_never_yield_epoch() {
    for mode in ["bad-signature", "bad-scope"] {
        let f = Fixture::new();
        f.state.borrow_mut().mode = mode.into();
        let error = f.service().backup(&mut || Ok(NOW)).unwrap_err();
        assert!(error.code.contains("reservation"), "{mode}: {error}");
        assert!(!Path::new(f.data["backupRoot"].as_str().unwrap()).exists());
    }
    let f = Fixture::new();
    let mut c = f.controller();
    c.reconcile_with_validity(0).unwrap();
    f.state.borrow_mut().head = Some(json!({"sequence":0,"hash":h("equivocation")}));
    assert!(
        c.reconcile_with_validity(0)
            .unwrap_err()
            .state_recoverability_fatal
    );
    assert!(c.assert_for_action("blocked").is_err());
}

#[test]
fn real_changeset_replay_matches_node_and_rejects_signed_system_writes_and_conflicts() {
    let f = Fixture::new();
    let backup = oracle(json!({"root":f.root,"mode":"backup"}));
    let bundle = Path::new(backup["bundlePath"].as_str().unwrap());
    let mut service = f.service();
    for scenario in [
        "valid",
        "floating-sequences",
        "system-row",
        "conflict",
        "nested-signature",
    ] {
        let mut journal = oracle(
            json!({"root":f.root,"mode":"prepare-journal","bundlePath":bundle,"scenario":scenario}),
        );
        if scenario == "floating-sequences" {
            float_sequence_fields(&mut journal);
            for entry in journal["entries"].as_array_mut().unwrap() {
                for key in ["reservationReceipt", "finalizationReceipt"] {
                    let value = &mut entry[key];
                    let signature = SigningKey::from_bytes(&[88; 32]).sign(
                        mutation::contracts::online_mutation_signed_payload_v1(value)
                            .unwrap()
                            .as_bytes(),
                    );
                    value["signature"] = Base64::encode_string(&signature.to_bytes()).into();
                }
            }
        }
        {
            let mut state = f.state.borrow_mut();
            state.head = Some(json!({"sequence":1,"hash":journal["globalHash"]}));
            state.journal = Some(journal);
        }
        let before: Value = serde_json::from_slice(
            &fs::read(bundle.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json")).unwrap(),
        )
        .unwrap();
        let file = bundle.join(
            before["content"]["databases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["role"] == "native-store")
                .unwrap()["backupRelativePath"]
                .as_str()
                .unwrap(),
        );
        let original = fs::read(&file).unwrap();
        let result = service.restore_drill(bundle, &mut || Ok(NOW));
        if scenario == "valid" || scenario == "floating-sequences" {
            let native = result.unwrap();
            assert_eq!(native["journalReplayMutationCount"], 1);
            assert!(
                service.inspect_sources(NOW).is_ok(),
                "native published source must verify: {scenario}"
            );
            let node = oracle(json!({"root":f.root,"mode":"drill","bundlePath":bundle}));
            assert_eq!(
                normalize_integer_spellings(native),
                normalize_integer_spellings(node)
            );
        } else {
            let error = result.unwrap_err();
            assert!(
                error.code.contains(if scenario == "nested-signature" {
                    "journal_entry_invalid"
                } else {
                    "changeset"
                }),
                "{scenario}: {error}"
            );
            let node = oracle(json!({"root":f.root,"mode":"drill","bundlePath":bundle}));
            assert_eq!(
                node["status"], "autonomous_research_state_restore_drill_blocked",
                "{scenario}: {node}"
            );
        }
        assert_eq!(
            fs::read(file).unwrap(),
            original,
            "production/stored bundle changed: {scenario}"
        );
    }
}

#[test]
fn lost_finalization_reply_preserves_exact_transaction_and_real_restart_recovers_it() {
    let f = Fixture::new();
    f.state.borrow_mut().mode = "finalize-lost".into();
    let failed = f.service().backup(&mut || Ok(NOW)).unwrap_err();
    assert_eq!(
        failed.details["authorityFinalizationMayHaveSucceeded"],
        true
    );
    let staging = Path::new(failed.details["recoverableStagingPath"].as_str().unwrap());
    assert!(staging.join("PENDING_BACKUP.json").is_file());
    assert!(
        !staging
            .join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json")
            .exists()
    );
    let pending: Value =
        serde_json::from_slice(&fs::read(staging.join("PENDING_BACKUP.json")).unwrap()).unwrap();
    let file = staging.join(
        pending["content"]["databases"][0]["backupRelativePath"]
            .as_str()
            .unwrap(),
    );
    let original = fs::read(&file).unwrap();
    let mut damaged = original.clone();
    damaged.push(1);
    fs::write(&file, damaged).unwrap();
    let count = f.state.borrow().calls.len();
    f.state.borrow_mut().mode.clear();
    assert!(
        f.service()
            .recover_backup(staging, &mut || Ok(NOW))
            .unwrap_err()
            .code
            .contains("hash_mismatch")
    );
    assert_eq!(f.state.borrow().calls.len(), count);
    fs::write(&file, &original).unwrap();
    // A fresh service instance proves recovery does not depend on in-memory
    // successful responses, saved private keys, or a fabricated finalized flag.
    let recovered = f
        .service()
        .recover_backup(staging, &mut || Ok(NOW))
        .unwrap();
    assert!(!staging.exists());
    let target = Path::new(recovered["bundlePath"].as_str().unwrap());
    assert!(
        target
            .join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json")
            .is_file()
    );
    let finalizations = f
        .state
        .borrow()
        .calls
        .iter()
        .filter(|q| q["kind"] == "AutonomousResearchStateBackupAuthorityFinalizeRequest")
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(finalizations.len(), 2);
    assert_eq!(finalizations[0], finalizations[1]);
    assert_eq!(
        f.service().restore_drill(target, &mut || Ok(NOW)).unwrap()["status"],
        "autonomous_research_state_restore_drill_passed"
    );
}

fn run_controller_event(
    c: &mut StateRecoverabilityControllerV1<BackupBroker, OnlineBroker>,
    e: &Value,
) -> Value {
    let result = match e["op"].as_str().unwrap() {
        "status" => Ok(c.epoch_status()),
        "assert" => c
            .assert_for_action(e["action"].as_str().unwrap())
            .map(|v| v.value().clone()),
        "mark" => c.mark_finalized(&e["head"]),
        "require" => c.require_reconciliation(&e["requirement"]),
        _ => c.reconcile_with_validity(e["required"].as_i64().unwrap_or(0)),
    };
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(e) => {
            json!({"ok":false,"error":e.code,"fatal":e.state_recoverability_fatal,"deferred":e.state_recoverability_deferred,"retryable":e.retryable,"blockers":e.details.get("blockers").cloned().unwrap_or(json!([]))})
        }
    }
}
#[test]
fn controller_state_machine_receipts_and_failure_flags_match_original_node() {
    let f = Fixture::new();
    let b = oracle(json!({"root":f.root,"mode":"backup"}));
    oracle(json!({"root":f.root,"mode":"drill","bundlePath":b["bundlePath"]}));
    let events = json!([{"op":"status"},{"op":"assert","action":"before"},{"op":"reconcile","required":1000},{"op":"status"},{"op":"assert","action":"commit"},{"op":"mark","head":{"globalSequence":1,"globalHash":h("global:1")}},{"op":"status"},{"op":"assert","action":"dirty"},{"op":"reconcile"},{"op":"mark","head":{"globalSequence":1,"globalHash":h("other")}},{"op":"status"},{"op":"reconcile"}]);
    let before = f.service().inspect_sources(NOW);
    assert!(before.is_ok(), "before Node controller: {before:?}");
    let node = oracle(json!({"root":f.root,"mode":"controller","events":events}));
    let after = f.service().inspect_sources(NOW);
    assert!(after.is_ok(), "after Node controller: {after:?}");
    let mut c = f.controller();
    let native = events
        .as_array()
        .unwrap()
        .iter()
        .map(|e| run_controller_event(&mut c, e))
        .collect::<Vec<_>>();
    assert_eq!(json!(native), node);
    f.state.borrow_mut().mode = "timeout".into();
    let mut c = f.controller();
    let transient = run_controller_event(&mut c, &json!({"op":"reconcile"}));
    let node = oracle(
        json!({"root":f.root,"mode":"controller","scenario":"timeout","events":[{"op":"reconcile"}]}),
    );
    assert_eq!(transient, node[0]);
    assert!(
        c.assert_for_action("offline")
            .unwrap_err()
            .state_recoverability_deferred
    );
}

#[test]
fn final_clock_sample_rejects_expiry_during_file_checks_without_minting_epoch() {
    let f = Fixture::new();
    let b = oracle(json!({"root":f.root,"mode":"backup"}));
    oracle(json!({"root":f.root,"mode":"drill","bundlePath":b["bundlePath"]}));
    let calls = Rc::new(Cell::new(0usize));
    let cutoff = Rc::new(Cell::new(usize::MAX));
    let count = calls.clone();
    let boundary = cutoff.clone();
    let mut c = f.controller_with_clock(Box::new(move || {
        count.set(count.get() + 1);
        Ok(NOW
            + if count.get() >= boundary.get() {
                60000
            } else {
                0
            })
    }));
    c.reconcile_with_validity(0).unwrap();
    let reconcile_calls = calls.get();
    assert!(reconcile_calls >= 3);
    // First sample and resident's before-read sample remain valid. Only the
    // sample after source/key/SQLite checks reaches signed-head expiry.
    calls.set(0);
    cutoff.set(3);
    let denied = c.assert_for_action("expiring").unwrap_err();
    assert!(denied.state_recoverability_deferred && denied.retryable);
    assert_eq!(calls.get(), 3);
    assert_eq!(
        denied.code,
        "autonomous_research_state_recoverability_observation_validity_insufficient"
    );
    let calls = Rc::new(Cell::new(0));
    let count = calls.clone();
    let mut c = f.controller_with_clock(Box::new(move || {
        count.set(count.get() + 1);
        Ok(NOW
            + if count.get() >= reconcile_calls {
                60000
            } else {
                0
            })
    }));
    let error = c.reconcile_with_validity(0).unwrap_err();
    assert!(error.state_recoverability_fatal);
    assert!(c.assert_for_action("never-ready").is_err());
    assert_eq!(calls.get(), reconcile_calls);
}

fn float_sequence_fields(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if key == "sequence" || key.ends_with("Sequence") {
                    *value = json!(value.as_f64().unwrap());
                } else {
                    float_sequence_fields(value);
                }
            }
        }
        Value::Array(a) => {
            for v in a {
                float_sequence_fields(v);
            }
        }
        _ => {}
    }
}
fn normalize_integer_spellings(mut value: Value) -> Value {
    match &mut value {
        Value::Number(number) => {
            if let Some(n) = number
                .as_f64()
                .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
            {
                value = json!(n as i64);
            }
        }
        Value::Object(object) => {
            for v in object.values_mut() {
                *v = normalize_integer_spellings(v.take());
            }
        }
        Value::Array(a) => {
            for v in a {
                *v = normalize_integer_spellings(v.take());
            }
        }
        _ => {}
    }
    value
}
