//! Concrete shared fence against the original real ten-database fixture.
//! Fixture brokers sign actual protocol messages with test-only private keys.
//! Fixture setup is retained from state_recoverability_parity, without its tests.
#[path = "activation_binding/native_transaction/tests.rs"]
mod native_transaction_tests;
use crate::{
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
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signer, SigningKey};
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
        let expires = clock::iso(
            crate::journal_connector_coverage::qualification::canonical_instant_millis(now)
                .unwrap()
                + 60000,
        )
        .unwrap();
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
        let millis = crate::journal_connector_coverage::qualification::canonical_instant_millis(
            q["requestedAt"].as_str().unwrap(),
        )
        .unwrap();
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
            "hepta-recoverability-e2e-binding-{}-{}",
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

use super::VerifiedRecoverabilityActivationBindingV1;
use crate::state_database_inventory::{
    ObservedStateDatabaseInventoryV1, observe_state_database_inventory_v1,
};
fn inventory(f: &Fixture) -> ObservedStateDatabaseInventoryV1 {
    observe_state_database_inventory_v1(
        Path::new(f.data["runtime"].as_str().unwrap()),
        &f.data["manifest"],
    )
    .unwrap()
}
fn authority(f: &Fixture) -> PinnedMutationAuthorityV1<OnlineBroker> {
    PinnedMutationAuthorityV1::load(
        Path::new(f.data["onlineConfiguration"].as_str().unwrap()),
        f.data["onlineConfigurationHash"].as_str().unwrap(),
        OnlineBroker(f.state.clone()),
    )
    .unwrap()
}
fn binding(
    f: &Fixture,
    fence: &Fence,
    inventory: &ObservedStateDatabaseInventoryV1,
) -> VerifiedRecoverabilityActivationBindingV1 {
    fence
        .observe_activation_binding_with_pins(inventory, &authority(f), || Ok(()))
        .unwrap()
}
#[test]
fn binding_uses_actual_sources_and_one_controller_generation_without_rpc() {
    let fixture = Fixture::new();
    let fence = Fence::new(fixture.controller());
    let inventory = inventory(&fixture);
    assert!(
        fence
            .observe_activation_binding_with_pins(&inventory, &authority(&fixture), || Ok(()))
            .is_err()
    );
    ready(&fence);
    let calls = fixture.state.borrow().calls.len();
    let proof = binding(&fixture, &fence, &inventory);
    assert_eq!(proof.value()["runtimeRoot"], fixture.data["runtime"]);
    assert_eq!(
        proof.value()["inventoryHash"],
        inventory.value()["inventoryHash"]
    );
    assert_eq!(proof.value()["globalSequence"], 0);
    assert_eq!(proof.value()["globalHash"], h("global:0"));
    assert_eq!(
        proof.value()["restoreDrillReceiptHash"],
        proof.restore_source_inspection()["restoreDrillReceiptHash"]
    );
    fence
        .clone()
        .assert_activation_binding_with_pins(&proof, &inventory, &authority(&fixture), || Ok(()))
        .unwrap();
    fence.assert_activation_binding_time(&proof, NOW).unwrap();
    assert_eq!(fixture.state.borrow().calls.len(), calls);
    let other = Fence::new(fixture.controller());
    ready(&other);
    let rejected = other
        .assert_activation_binding_with_pins(&proof, &inventory, &authority(&fixture), || Ok(()))
        .unwrap_err();
    assert!(rejected.code.ends_with("fence_origin_mismatch"));
    assert!(
        other
            .assert_activation_binding_time(&proof, NOW)
            .unwrap_err()
            .code
            .ends_with("fence_origin_mismatch")
    );
    // Even renewing the exact same signed head revokes the prior generation.
    ready(&fence);
    assert!(
        fence
            .assert_activation_binding_time(&proof, NOW)
            .unwrap_err()
            .code
            .ends_with("fence_generation_changed")
    );
    let proof = binding(&fixture, &fence, &inventory);
    fence
        .mark_finalized(&json!({"globalSequence":0,"globalHash":h("global:0")}))
        .unwrap();
    let rejected = fence
        .assert_activation_binding_with_pins(&proof, &inventory, &authority(&fixture), || Ok(()))
        .unwrap_err();
    assert!(rejected.code.ends_with("fence_generation_changed"));
    assert!(
        fence
            .assert_activation_binding_time(&proof, NOW)
            .unwrap_err()
            .code
            .ends_with("fence_generation_changed")
    );
}

#[test]
fn terminal_binding_time_uses_real_exclusive_deadlines_and_never_regresses() {
    let fixture = Fixture::new();
    let fence = Fence::new(fixture.controller());
    ready(&fence);
    let inventory = inventory(&fixture);
    let authority = authority(&fixture);
    let proof = binding(&fixture, &fence, &inventory);
    fence
        .assert_activation_binding_with_pins(&proof, &inventory, &authority, || Ok(()))
        .unwrap();
    let timestamp = |value: &Value| crate::sqlite_mutation_coordinator::timestamp(value).unwrap();
    let cutoff = {
        let state = fence.state.borrow();
        let evidence = state.controller.evidence.as_ref().unwrap();
        let receipt = &evidence.observation.value()["authorityCurrentHeadReceipt"];
        let maximum_age = state.controller.service.backup.trust()["maximumHeadObservationAgeMs"]
            .as_i64()
            .unwrap();
        [
            timestamp(&receipt["expiresAt"]),
            timestamp(&receipt["observedAt"]) + maximum_age + 1,
            timestamp(&evidence.resident.value()["leaseExpiresAt"]),
            timestamp(&proof.restore_source_inspection()["restoreDrillPerformedAt"]) + 86_400_001,
        ]
        .into_iter()
        .min()
        .unwrap()
    };
    assert!(cutoff > NOW);
    let calls = fixture.state.borrow().calls.len();
    fence
        .assert_activation_binding_time(&proof, cutoff - 1)
        .unwrap();
    assert!(
        fence
            .assert_activation_binding_time(&proof, cutoff)
            .is_err()
    );
    assert!(
        fence
            .assert_activation_binding_time(&proof, cutoff + 1)
            .is_err()
    );
    let regressed = fence
        .assert_activation_binding_time(&proof, cutoff - 1)
        .unwrap_err();
    assert!(regressed.code.ends_with("clock_invalid"));
    assert!(regressed.state_recoverability_fatal);
    assert_eq!(fixture.state.borrow().calls.len(), calls);
}
#[test]
fn binding_rejects_cross_runtime_inventory_and_authority_even_for_the_same_signed_head() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    let fence = Fence::new(fixture.controller());
    ready(&fence);
    let own = inventory(&fixture);
    for (selected, authority) in [
        (&inventory(&other), authority(&fixture)),
        (&own, authority(&other)),
    ] {
        let rejected = fence
            .observe_activation_binding_with_pins(selected, &authority, || Ok(()))
            .err()
            .expect("different scope must be rejected");
        assert!(
            rejected
                .code
                .ends_with("activation_binding_subject_mismatch"),
            "{}",
            rejected.code
        );
    }
    // A rejected unrelated subject does not turn that subject into a permit.
    binding(&fixture, &fence, &own);
}
#[test]
fn binding_rechecks_real_files_resident_and_expiry_after_pin_io() {
    for attack in ["database", "resident", "restore", "authority", "expiry"] {
        let fixture = Fixture::new();
        let time = Rc::new(Cell::new(NOW));
        let observed_time = Rc::clone(&time);
        let fence =
            Fence::new(fixture.controller_with_clock(Box::new(move || Ok(observed_time.get()))));
        ready(&fence);
        let inventory = inventory(&fixture);
        let authority = authority(&fixture);
        let proof = fence
            .observe_activation_binding_with_pins(&inventory, &authority, || Ok(()))
            .unwrap();
        match attack {
            "database" => {
                let path =
                    Path::new(fixture.data["runtime"].as_str().unwrap()).join("hepta-paper.sqlite");
                let db = rusqlite::Connection::open(path).unwrap();
                db.execute_batch(
                    "CREATE TABLE binding_unregistered_write(id INTEGER PRIMARY KEY);",
                )
                .unwrap();
            }
            "resident" => {
                let path = Path::new(fixture.data["runtime"].as_str().unwrap())
                    .join("autonomous-research/supervisor/resident-instance.sqlite");
                let db = rusqlite::Connection::open(path).unwrap();
                db.execute_batch("UPDATE autonomous_research_supervisor_instance SET lease_generation=lease_generation+1;").unwrap();
            }
            "restore" => {
                let path = Path::new(
                    proof.restore_source_inspection()["bundlePath"]
                        .as_str()
                        .unwrap(),
                )
                .join("RESTORE_DRILL_RECEIPT.json");
                let mut bytes = fs::read(&path).unwrap();
                bytes.push(b' ');
                fs::write(path, bytes).unwrap();
            }
            "authority" => {
                let path = Path::new(fixture.data["onlineConfiguration"].as_str().unwrap());
                let mut bytes = fs::read(path).unwrap();
                bytes.push(b' ');
                fs::write(path, bytes).unwrap();
            }
            "expiry" => (),
            _ => unreachable!(),
        }
        let rejected =
            fence.assert_activation_binding_with_pins(&proof, &inventory, &authority, || {
                if attack == "expiry" {
                    time.set(NOW + 60_001);
                }
                Ok(())
            });
        assert!(rejected.is_err(), "{attack}");
    }
}
fn bytes_hash(bytes: &[u8]) -> String {
    crate::sqlite_mutation_coordinator::hash_bytes(bytes)
}
fn process_fence(
    fixture: &Fixture,
    online_process: &Path,
    online_pin: &str,
) -> SharedRecoverabilityEpochFenceV1<
    crate::state_backup_authority::ProcessStateBackupAuthorityTransportV1,
    crate::sqlite_mutation_coordinator::authority::ProcessMutationAuthorityTransportV1,
> {
    let backup = PinnedStateBackupAuthorityV1::load_process(
        Path::new(fixture.data["backupConfiguration"].as_str().unwrap()),
        fixture.data["backupConfigurationHash"].as_str().unwrap(),
    )
    .unwrap();
    let online = PinnedMutationAuthorityV1::load_process(online_process, online_pin).unwrap();
    let runtime = PathBuf::from(fixture.data["runtime"].as_str().unwrap());
    let service = BackupRecoveryServiceV1::new(
        backup,
        online,
        BackupRecoveryServiceOptionsV1 {
            runtime_root: runtime.clone(),
            backup_root: PathBuf::from(fixture.data["backupRoot"].as_str().unwrap()),
            state_database_manifest: fixture.data["manifest"].clone(),
            writer_manifest: fixture.data["writerManifest"].clone(),
        },
    )
    .unwrap();
    let lease = &fixture.data["lease"];
    let resident = ResidentLeaseV1::new(
        &runtime,
        lease["ownerId"].as_str().unwrap(),
        lease["leaseToken"].as_str().unwrap(),
        lease["leaseGeneration"].as_i64().unwrap(),
    )
    .unwrap();
    SharedRecoverabilityEpochFenceV1::new(
        StateRecoverabilityControllerV1::new(
            service,
            resident,
            Box::new(|| Ok(NOW)),
            RecoverabilityPolicyV1::default(),
        )
        .unwrap(),
    )
}
#[test]
fn concrete_process_pin_checks_reject_replaced_inputs_without_invoking_commands() {
    use crate::sqlite_mutation_coordinator::authority::ProcessMutationAuthorityTransportV1;
    for attack in ["process", "authority", "key", "command"] {
        let fixture = Fixture::new();
        let authority_path = Path::new(fixture.data["onlineConfiguration"].as_str().unwrap());
        let authority_document: Value =
            serde_json::from_slice(&fs::read(authority_path).unwrap()).unwrap();
        let command = fixture.root.join("online-process");
        fs::copy("/bin/true", &command).unwrap();
        fs::set_permissions(&command, fs::Permissions::from_mode(0o700)).unwrap();
        let process = fixture.root.join("online-process.json");
        let document = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityProcessConfiguration","authorityConfigurationPath":authority_path,"authorityConfigurationSha256":fixture.data["onlineConfigurationHash"],"commandPath":command,"commandSha256":bytes_hash(&fs::read(&command).unwrap()),"fixedArguments":[],"timeoutMs":1000});
        let bytes = serde_json::to_vec(&document).unwrap();
        fs::write(&process, &bytes).unwrap();
        fs::set_permissions(&process, fs::Permissions::from_mode(0o600)).unwrap();
        let client =
            PinnedMutationAuthorityV1::<ProcessMutationAuthorityTransportV1>::load_process(
                &process,
                &bytes_hash(&bytes),
            )
            .unwrap();
        client.assert_process_current_v1().unwrap();
        let fence = process_fence(&fixture, &process, &bytes_hash(&bytes));
        fence.assert_process_subject_current(&client).unwrap();
        assert!(
            fence
                .observe_activation_binding_v1(&inventory(&fixture), &client)
                .is_err()
        );
        // The same verifier does not make different command invocation
        // contracts the same retained process subject.
        let alternate = fixture.root.join("alternate-process.json");
        let mut alternate_document = document.clone();
        alternate_document["timeoutMs"] = json!(2000);
        let alternate_bytes = serde_json::to_vec(&alternate_document).unwrap();
        fs::write(&alternate, &alternate_bytes).unwrap();
        fs::set_permissions(&alternate, fs::Permissions::from_mode(0o600)).unwrap();
        let alternate_client =
            PinnedMutationAuthorityV1::load_process(&alternate, &bytes_hash(&alternate_bytes))
                .unwrap();
        let rejected = fence
            .assert_process_subject_current(&alternate_client)
            .unwrap_err();
        assert!(
            rejected
                .code
                .ends_with("activation_binding_process_subject_mismatch")
        );
        let changed = match attack {
            "process" => process,
            "authority" => authority_path.to_owned(),
            "key" => PathBuf::from(authority_document["publicKeyPath"].as_str().unwrap()),
            _ => command,
        };
        let bytes = fs::read(&changed).unwrap();
        // Byte-identical inode replacement must still revoke a retained pin.
        let replacement = fixture.root.join("replacement");
        fs::write(&replacement, bytes).unwrap();
        fs::set_permissions(&replacement, fs::metadata(&changed).unwrap().permissions()).unwrap();
        fs::rename(replacement, changed).unwrap();
        assert!(
            client.assert_process_current_v1().is_err(),
            "online {attack}"
        );
        assert!(
            fence.assert_process_inputs_current_v1().is_err(),
            "fence {attack}"
        );
        assert!(fixture.state.borrow().calls.is_empty());
    }
    for attack in ["process", "authority", "key", "command"] {
        let fixture = Fixture::new();
        let configuration = Path::new(fixture.data["backupConfiguration"].as_str().unwrap());
        let document: Value = serde_json::from_slice(&fs::read(configuration).unwrap()).unwrap();
        let client = PinnedStateBackupAuthorityV1::load_process(
            configuration,
            fixture.data["backupConfigurationHash"].as_str().unwrap(),
        )
        .unwrap();
        client.assert_process_current_v1().unwrap();
        let changed = match attack {
            "process" => configuration.to_owned(),
            "authority" => PathBuf::from(
                document["onlineMutationAuthorityConfigurationPath"]
                    .as_str()
                    .unwrap(),
            ),
            "key" => PathBuf::from(document["publicKeyPath"].as_str().unwrap()),
            _ => PathBuf::from(document["commandPath"].as_str().unwrap()),
        };
        let bytes = fs::read(&changed).unwrap();
        let replacement = fixture.root.join("replacement");
        fs::write(&replacement, bytes).unwrap();
        fs::set_permissions(&replacement, fs::metadata(&changed).unwrap().permissions()).unwrap();
        fs::rename(replacement, changed).unwrap();
        assert!(
            client.assert_process_current_v1().is_err(),
            "backup {attack}"
        );
        assert!(fixture.state.borrow().calls.is_empty());
    }
}
