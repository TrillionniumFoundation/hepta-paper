//! Concrete shared fence against the original real ten-database fixture.
//! Fixture brokers sign actual protocol messages with test-only private keys.
//! Fixture setup is retained from state_recoverability_parity, without its tests.
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
        controller::{
            RecoverabilityPolicyV1, SharedRecoverabilityEpochFenceV1,
            StateRecoverabilityControllerV1,
        },
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

type Fence = SharedRecoverabilityEpochFenceV1<BackupBroker, OnlineBroker>;
fn ready(fence: &Fence) {
    let result = fence.reconcile_with_validity(1000).unwrap();
    assert_eq!(
        result["status"], "autonomous_research_state_recoverability_ready",
        "{result}"
    );
}
fn assert_denied(
    fence: &Fence,
    token: &hepta_paper_service::state_recoverability::controller::VerifiedRecoverabilityActionV1,
    action: &str,
    suffix: &str,
) {
    let e = fence.assert_action_current(token, action).unwrap_err();
    assert!(e.code.ends_with(suffix), "{e:?}");
}
#[test]
fn action_tokens_bind_one_controller_generation_and_exact_action_without_rpc() {
    use mutation::RecoverabilityEpochFenceV1;
    let f = Fixture::new();
    let fence = Fence::new(f.controller());
    let head = json!({"globalSequence":0,"globalHash":h("global:0")});
    // A JSON finalized-head claim is not sufficient to establish recoverability.
    fence.mark_finalized(&head).unwrap();
    assert!(fence.observe_action("image-publication").is_err());
    ready(&fence);
    let token = fence.observe_action("image-publication").unwrap();
    let calls = f.state.borrow().calls.len();
    fence
        .clone()
        .assert_action_current(&token, "image-publication")
        .unwrap();
    assert_denied(&fence, &token, "provider-dispatch", "fence_action_mismatch");
    fence
        .assert_action_current(&token, "image-publication")
        .unwrap();
    assert_eq!(
        calls,
        f.state.borrow().calls.len(),
        "action checks must not invoke an authority"
    );

    let other = Fence::new(f.controller());
    ready(&other);
    assert_eq!(
        other.observe_action("image-publication").unwrap().value(),
        token.value()
    );
    assert_denied(&other, &token, "image-publication", "fence_origin_mismatch");
    // Coordinator feedback reaches the same controller through the trait clone.
    let mut feedback = fence.clone();
    feedback.mark_mutation_finalized(&head).unwrap();
    assert_denied(
        &fence,
        &token,
        "image-publication",
        "fence_generation_changed",
    );
    let token = fence.observe_action("image-publication").unwrap();
    feedback.mark_mutation_reconciliation_required(&json!({"reason":"local_commit_uncertain","databaseRole":"resident-instance","databaseInstanceId":"resident-instance","committed":"unknown"})).unwrap();
    assert_denied(
        &fence,
        &token,
        "image-publication",
        "fence_generation_changed",
    );
    assert!(fence.observe_action("image-publication").is_err());
    let reconciled = feedback.reconcile().unwrap();
    assert_eq!(
        reconciled["status"],
        "autonomous_research_state_recoverability_ready"
    );
    let token = fence.observe_action("image-publication").unwrap();
    ready(&fence);
    assert_denied(
        &fence,
        &token,
        "image-publication",
        "fence_generation_changed",
    );
    let token = fence.observe_action("image-publication").unwrap();
    fence
        .mark_finalized(&json!({"globalSequence":1,"globalHash":h("global:1")}))
        .unwrap();
    let mut diagnostic = fence.epoch_status().unwrap();
    diagnostic["status"] = "autonomous_research_state_recoverability_epoch_current".into();
    assert_eq!(
        diagnostic["status"],
        "autonomous_research_state_recoverability_epoch_current"
    );
    assert_denied(
        &fence,
        &token,
        "image-publication",
        "fence_generation_changed",
    );
    assert!(fence.observe_action("image-publication").is_err());
    let e = fence.observe_action("").unwrap_err();
    assert!(e.state_recoverability_fatal);
    assert!(e.code.ends_with("fence_action_invalid"));
}

#[test]
fn action_revalidation_refuses_actual_source_inventory_resident_and_trust_changes() {
    for target in [
        "restore",
        "inventory",
        "resident",
        "command",
        "online-public",
        "backup-public",
    ] {
        let f = Fixture::new();
        let fence = Fence::new(f.controller());
        ready(&fence);
        let token = fence.observe_action("provider-dispatch").unwrap();
        let calls = f.state.borrow().calls.len();
        match target {
            "restore" => {
                let bundle = f.service().inspect_sources(NOW).unwrap();
                let receipt = Path::new(bundle["bundlePath"].as_str().unwrap())
                    .join("RESTORE_DRILL_RECEIPT.json");
                fs::OpenOptions::new()
                    .append(true)
                    .open(receipt)
                    .unwrap()
                    .write_all(b"\n")
                    .unwrap();
            }
            "inventory" => {
                let db = f.data["inventory"]["instances"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|v| v["role"] == "native-store")
                    .unwrap();
                let db = rusqlite::Connection::open(
                    Path::new(f.data["runtime"].as_str().unwrap())
                        .join(db["sourceRelativePath"].as_str().unwrap()),
                )
                .unwrap();
                db.execute("UPDATE records SET value='unsigned' WHERE id='subject'", [])
                    .unwrap();
            }
            "resident" => {
                let db = rusqlite::Connection::open(
                    Path::new(f.data["runtime"].as_str().unwrap())
                        .join("autonomous-research/supervisor/resident-instance.sqlite"),
                )
                .unwrap();
                db.execute(
                    "UPDATE autonomous_research_supervisor_instance SET owner_id='replacement'",
                    [],
                )
                .unwrap();
            }
            name => {
                let path = match name {
                    "command" => f.root.join("unused-raw-transport.py"),
                    "online-public" => f.root.join("online-public.json"),
                    "backup-public" => f.root.join("backup-public.json"),
                    _ => unreachable!(),
                };
                fs::OpenOptions::new()
                    .append(true)
                    .open(path)
                    .unwrap()
                    .write_all(b"\n")
                    .unwrap();
            }
        }
        let e = fence
            .assert_action_current(&token, "provider-dispatch")
            .unwrap_err();
        assert!(
            e.state_recoverability_deferred || e.state_recoverability_fatal,
            "{target}: {e:?}"
        );
        assert!(
            fence.observe_action("provider-dispatch").is_err(),
            "{target}"
        );
        assert_eq!(
            calls,
            f.state.borrow().calls.len(),
            "{target}: must not invoke an authority"
        );
    }
}

#[test]
fn final_clock_expiry_rollback_and_prior_clock_file_change_cannot_issue_an_action_proof() {
    for scenario in ["expiry", "rollback", "prior-clock-write"] {
        let f = Fixture::new();
        let armed = Rc::new(Cell::new(false));
        let samples = Rc::new(Cell::new(0));
        let active = armed.clone();
        let count = samples.clone();
        let native = f.data["inventory"]["instances"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["role"] == "native-store")
            .unwrap();
        let db = Path::new(f.data["runtime"].as_str().unwrap())
            .join(native["sourceRelativePath"].as_str().unwrap());
        let time = Box::new(move || {
            if !active.get() {
                return Ok(NOW);
            }
            let n = count.get() + 1;
            count.set(n);
            if scenario == "prior-clock-write" && n == 3 {
                let db = rusqlite::Connection::open(&db).unwrap();
                db.execute(
                    "UPDATE records SET value='changed-in-clock' WHERE id='subject'",
                    [],
                )
                .unwrap();
            }
            Ok(if n == 4 && scenario == "expiry" {
                NOW + 60_000
            } else if n == 4 && scenario == "rollback" {
                NOW - 1
            } else {
                NOW
            })
        });
        let fence = Fence::new(f.controller_with_clock(time));
        ready(&fence);
        let token = fence.observe_action("provider-dispatch").unwrap();
        armed.set(true);
        let e = fence
            .assert_action_current(&token, "provider-dispatch")
            .unwrap_err();
        assert!(
            e.state_recoverability_deferred || e.state_recoverability_fatal,
            "{scenario}: {e:?}"
        );
        if scenario != "prior-clock-write" {
            assert_eq!(samples.get(), 4, "{scenario}");
        }
        assert!(
            fence.observe_action("provider-dispatch").is_err(),
            "{scenario}"
        );
    }
}

#[test]
fn reentrant_clock_cannot_borrow_or_replace_the_concrete_controller() {
    let f = Fixture::new();
    let held: Rc<RefCell<Option<Fence>>> = Rc::new(RefCell::new(None));
    let attempted = Rc::new(Cell::new(0));
    let shared = held.clone();
    let observed = attempted.clone();
    let time = Box::new(move || {
        if let Some(fence) = shared.borrow().as_ref() {
            let e = fence.epoch_status().unwrap_err();
            assert!(e.code.ends_with("fence_busy"));
            let e = fence
                .mark_finalized(&json!({"globalSequence":99,"globalHash":h("injected")}))
                .unwrap_err();
            assert!(e.code.ends_with("fence_busy"));
            observed.set(observed.get() + 1);
        }
        Ok(NOW)
    });
    let fence = Fence::new(f.controller_with_clock(time));
    *held.borrow_mut() = Some(fence.clone());
    ready(&fence);
    let token = fence.observe_action("provider-dispatch").unwrap();
    assert_eq!(token.value()["globalSequence"], 0);
    fence
        .assert_action_current(&token, "provider-dispatch")
        .unwrap();
    assert!(attempted.get() >= 8);
    // Break the deliberate test-only clock/handle reference cycle.
    held.borrow_mut().take();
}
