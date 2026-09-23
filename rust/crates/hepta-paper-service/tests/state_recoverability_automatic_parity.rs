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
#[test]
fn automatic_reconciliation_reuses_old_snapshot_for_running_and_fresh_controller() {
    for warm in [true, false] {
        let f = Fixture::new();
        let now = Rc::new(Cell::new(NOW));
        let time = now.clone();
        let mut controller = f.controller_with_clock(Box::new(move || Ok(time.get())));
        let first = if warm {
            controller.reconcile_with_validity(0).unwrap()
        } else {
            let mut service = f.service();
            let backup = service.backup(&mut || Ok(NOW)).unwrap();
            service
                .restore_drill(
                    Path::new(backup["bundlePath"].as_str().unwrap()),
                    &mut || Ok(NOW),
                )
                .unwrap();
            backup
        };
        let path = PathBuf::from(first["bundlePath"].as_str().unwrap());
        let original = fs::read(path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json")).unwrap();
        let count = backup_calls(&f.state.borrow());
        let heartbeat = apply_real_heartbeat(&f, "valid", warm);
        now.set(NOW + 1000);
        if warm {
            controller.mark_finalized(&heartbeat["marked"][0]).unwrap();
        }
        let live = database_bytes(&f);
        // Run the original complete controller from the same old receipt.
        // Its fixture writes only this temporary historical drill. Restore the
        // old bytes so native normal selection independently proves the path.
        let previous_drill = fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap();
        let node_controller = oracle(
            json!({"root":f.root,"mode":"controller","now":clock::iso(NOW+1000).unwrap(),"events":[{"op":"reconcile","required":1000}]}),
        );
        assert_eq!(node_controller[0]["ok"], true, "{node_controller}");
        let node_drill: Value =
            serde_json::from_slice(&fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap())
                .unwrap();
        fs::write(path.join("RESTORE_DRILL_RECEIPT.json"), previous_drill).unwrap();
        let invalid = path.parent().unwrap().join("newest-invalid-candidate");
        fs::create_dir(&invalid).unwrap();
        fs::set_permissions(&invalid, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(invalid.join("foreign"), b"preserve invalid candidate").unwrap();
        let before = f.state.borrow().calls.len();
        let refreshed = controller.reconcile_with_validity(1000).unwrap();
        assert_eq!(
            refreshed["status"],
            "autonomous_research_state_recoverability_ready"
        );
        assert_eq!(refreshed, node_controller[0]["value"]);
        assert_eq!(refreshed["mode"], "journal-renewed");
        assert_eq!(refreshed["bundlePath"], first["bundlePath"]);
        assert_eq!(refreshed["headSequence"], 1);
        assert!(controller.assert_for_action("automatic-refresh").is_ok());
        assert_eq!(backup_calls(&f.state.borrow()), count);
        assert_eq!(
            f.state.borrow().calls[before..]
                .iter()
                .map(|q| q["kind"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            vec![
                "AutonomousResearchStateBackupAuthorityCurrentHeadRequest",
                "AutonomousResearchStateBackupAuthorityJournalRangeRequest",
                "AutonomousResearchStateBackupAuthorityCurrentHeadRequest",
            ],
            "candidate selection must not add authority calls"
        );
        assert_eq!(
            fs::read(path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json")).unwrap(),
            original
        );
        assert_eq!(
            fs::read(invalid.join("foreign")).unwrap(),
            b"preserve invalid candidate"
        );
        assert_eq!(database_bytes(&f), live);
        let native: Value =
            serde_json::from_slice(&fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap())
                .unwrap();
        assert_eq!(native, node_drill);
        // The next heartbeat uses the ordinary already-selected historical
        // source branch, which must also compare live rows before publishing.
        let old_receipt = fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap();
        let second = apply_real_heartbeat(&f, if warm { "valid" } else { "unrecorded-row" }, false);
        now.set(NOW + 2000);
        controller.mark_finalized(&second["marked"][0]).unwrap();
        let before = f.state.borrow().calls.len();
        if warm {
            let next = controller.reconcile_with_validity(1000).unwrap();
            assert_eq!(next["mode"], "journal-renewed");
            assert_eq!(next["headSequence"], 2);
            assert!(
                controller
                    .assert_for_action("second-automatic-refresh")
                    .is_ok()
            );
            assert_eq!(f.state.borrow().calls.len() - before, 4);
        } else {
            let error = controller.reconcile_with_validity(1000).unwrap_err();
            assert!(error.code.contains("effective_state_mismatch"), "{error}");
            assert_eq!(
                fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap(),
                old_receipt
            );
            assert!(
                controller
                    .assert_for_action("unrecorded-after-second-heartbeat")
                    .is_err()
            );
        }
        assert_eq!(backup_calls(&f.state.borrow()), count);
    }
}
#[test]
fn automatic_candidate_never_renews_or_publishes_over_unrecorded_rows_or_bad_signature() {
    for scenario in [
        "unrecorded-row",
        "null-primary-key",
        "blob-type",
        "bad-signature",
    ] {
        let f = Fixture::new();
        let now = Rc::new(Cell::new(NOW));
        let clock = now.clone();
        let mut controller = f.controller_with_clock(Box::new(move || Ok(clock.get())));
        let mut service = f.service();
        let first = service.backup(&mut || Ok(NOW)).unwrap();
        let path = PathBuf::from(first["bundlePath"].as_str().unwrap());
        service.restore_drill(&path, &mut || Ok(NOW)).unwrap();
        let heartbeat = apply_real_heartbeat(&f, scenario, false);
        if scenario == "blob-type" {
            let instance = f.data["inventory"]["instances"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["role"] == "native-store")
                .unwrap();
            let db = rusqlite::Connection::open(
                Path::new(f.data["runtime"].as_str().unwrap())
                    .join(instance["sourceRelativePath"].as_str().unwrap()),
            )
            .unwrap();
            db.execute(
                "UPDATE records SET value = CAST(value AS BLOB) WHERE id='subject'",
                [],
            )
            .unwrap();
        }
        now.set(NOW + 1000);
        controller.mark_finalized(&heartbeat["marked"][0]).unwrap();
        let original = database_bytes(&f);
        let original_receipt = fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap();
        let count = backup_calls(&f.state.borrow());
        let error = controller.reconcile_with_validity(0).unwrap_err();
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
#[test]
fn automatic_completion_clock_change_cannot_replace_stored_drill() {
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
    let error = controller.reconcile_with_validity(0).unwrap_err();
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

#[test]
fn finalized_current_snapshot_without_drill_keeps_existing_fresh_renewal_path() {
    let f = Fixture::new();
    let mut service = f.service();
    let older = service.backup(&mut || Ok(NOW)).unwrap();
    let old_manifest: Value = serde_json::from_slice(
        &fs::read(
            Path::new(older["bundlePath"].as_str().unwrap())
                .join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let instance = f.data["inventory"]["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["role"] == "native-store")
        .unwrap();
    let db = rusqlite::Connection::open(
        Path::new(f.data["runtime"].as_str().unwrap())
            .join(instance["sourceRelativePath"].as_str().unwrap()),
    )
    .unwrap();
    db.execute_batch("VACUUM").unwrap();
    drop(db);
    let original = service.backup(&mut || Ok(NOW + 500)).unwrap();
    let old = PathBuf::from(original["bundlePath"].as_str().unwrap());
    let manifest = fs::read(old.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json")).unwrap();
    assert!(!old.join("RESTORE_DRILL_RECEIPT.json").exists());
    let current_manifest: Value = serde_json::from_slice(&manifest).unwrap();
    assert_ne!(
        old_manifest["content"]["inventoryHash"],
        current_manifest["content"]["inventoryHash"]
    );
    assert_eq!(backup_calls(&f.state.borrow()), 4);
    let mut controller = f.controller_with_clock(Box::new(|| Ok(NOW + 1000)));
    let result = controller.reconcile_with_validity(0).unwrap();
    assert_eq!(
        result["status"],
        "autonomous_research_state_recoverability_ready"
    );
    assert_eq!(result["mode"], "fresh-snapshot-renewed");
    assert_eq!(result["headSequence"], 0);
    assert_ne!(result["bundlePath"], original["bundlePath"]);
    assert_eq!(backup_calls(&f.state.borrow()), 6);
    assert_eq!(
        fs::read(old.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json")).unwrap(),
        manifest
    );
    assert!(!old.join("RESTORE_DRILL_RECEIPT.json").exists());
    assert!(
        controller
            .assert_for_action("fresh-backup-without-drill")
            .is_ok()
    );
}
