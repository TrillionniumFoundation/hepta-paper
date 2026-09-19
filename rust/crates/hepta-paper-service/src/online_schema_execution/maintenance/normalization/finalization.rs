//! Bounded external-authority finalization and observation orchestration.
//!
//! This module only builds the exact signed request objects and consumes opaque
//! verified authority receipts. It never marks a runtime capability active,
//! mutates SQLite, or treats an external receipt as proof of local post-state.
use super::*;
use crate::pristine_runtime_state::{
    PristineDatabaseInspectionV1, PristineDatabaseOptionsV1, inspect_pristine_database_state_v1,
    pristine_runtime_state_hash_v1,
};
use crate::sqlite_mutation_coordinator::{
    authority::{
        MutationAuthorityTransportV1, PinnedMutationAuthorityV1, VerifiedMutationReceiptV1,
    },
    contracts::schema_transition::schema_transition_receipt_hash_v1,
    hash,
};
use crate::state_database_inventory::{
    ObservedStateDatabaseInventoryV1, observe_state_database_inventory_v1,
};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

fn sha(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 71
            && value.starts_with("sha256:")
            && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn text_field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| {
            crate::sqlite_mutation_coordinator::error(
                "autonomous_research_online_schema_transition_field_invalid",
            )
        })
}

/// Construct the same exact-key finalization request as the Node completion
/// protocol. The caller must have independently observed the post-inventory and
/// post-pristine hashes; this helper only binds those opaque hashes.
pub fn build_schema_transition_finalize_request_v1(
    plan: &Value,
    reservation: &VerifiedMutationReceiptV1,
    installations: &Value,
    post_inventory_hash: &str,
    post_pristine_runtime_state_hash: &str,
    completed_at: &str,
) -> Result<Value> {
    ensure(
        plan["version"] == 1 || plan["version"] == 2,
        "autonomous_research_online_schema_transition_version_invalid",
    )?;
    ensure(
        sha(&Value::String(post_inventory_hash.to_owned())),
        "autonomous_research_online_schema_transition_hash_invalid",
    )?;
    ensure(
        sha(&Value::String(post_pristine_runtime_state_hash.to_owned())),
        "autonomous_research_online_schema_transition_hash_invalid",
    )?;
    ensure(
        !completed_at.is_empty(),
        "autonomous_research_online_schema_transition_timestamp_invalid",
    )?;
    ensure(
        installations.is_array(),
        "autonomous_research_online_schema_transition_installations_invalid",
    )?;
    let request = json!({
        "version": plan["version"],
        "kind": "AutonomousResearchOnlineSchemaTransitionFinalizeRequest",
        "protocol": plan["protocol"],
        "scopeId": plan["scopeId"],
        "databaseScopeHash": plan["databaseScopeHash"],
        "writerManifestHash": plan["writerManifestHash"],
        "transitionId": plan["transitionId"],
        "transitionInventoryHash": plan["transitionInventoryHash"],
        "schemaBundleHash": plan["schemaBundleHash"],
        "reservationId": reservation.value()["reservationId"],
        "reservationReceiptHash": schema_transition_receipt_hash_v1(reservation.value())?,
        "postInventoryHash": post_inventory_hash,
        "postPristineRuntimeStateHash": post_pristine_runtime_state_hash,
        "installations": installations,
        "completedAt": completed_at,
    });
    Ok(request)
}

/// Construct the exact observation request. `nonce` is persisted by the caller
/// before invoking an external service so a crash cannot silently change it.
pub fn build_schema_transition_observe_request_v1(
    plan: &Value,
    finalization: &VerifiedMutationReceiptV1,
    post_inventory_hash: &str,
    post_pristine_runtime_state_hash: &str,
    nonce: &str,
    requested_at: &str,
) -> Result<Value> {
    ensure(
        plan["version"] == 1 || plan["version"] == 2,
        "autonomous_research_online_schema_transition_version_invalid",
    )?;
    for value in [post_inventory_hash, post_pristine_runtime_state_hash] {
        ensure(
            sha(&Value::String(value.to_owned())),
            "autonomous_research_online_schema_transition_hash_invalid",
        )?;
    }
    ensure(
        !nonce.is_empty() && !requested_at.is_empty(),
        "autonomous_research_online_schema_transition_observation_invalid",
    )?;
    let mut request = json!({
        "version": plan["version"],
        "kind": "AutonomousResearchOnlineSchemaTransitionObserveRequest",
        "protocol": plan["protocol"],
        "scopeId": plan["scopeId"],
        "databaseScopeHash": plan["databaseScopeHash"],
        "writerManifestHash": plan["writerManifestHash"],
        "transitionId": plan["transitionId"],
        "transitionInventoryHash": plan["transitionInventoryHash"],
        "schemaBundleHash": plan["schemaBundleHash"],
        "finalizationReceiptHash": schema_transition_receipt_hash_v1(finalization.value())?,
        "postInventoryHash": post_inventory_hash,
        "postPristineRuntimeStateHash": post_pristine_runtime_state_hash,
        "nonce": nonce,
        "requestedAt": requested_at,
    });
    if plan["version"] == 2 {
        request["transitionMode"] = plan["transitionMode"].clone();
        request["sourceWriterManifestHash"] = plan["sourceWriterManifestHash"].clone();
    }
    Ok(request)
}

pub struct SchemaTransitionFinalizationResult {
    pub finalize_request: Value,
    pub finalization: VerifiedMutationReceiptV1,
}

pub struct SchemaTransitionFinalizeOptions<'a> {
    pub plan: &'a Value,
    pub reservation: &'a VerifiedMutationReceiptV1,
    pub installations: &'a Value,
    pub post_inventory_hash: &'a str,
    pub post_pristine_runtime_state_hash: &'a str,
    pub completed_at: &'a str,
}

pub struct SchemaTransitionObservationResult {
    pub observe_request: Value,
    pub observation: VerifiedMutationReceiptV1,
}

/// Local post-state bound to real held file observations and exact plan/records.
/// Reports can be read, but caller JSON cannot construct or rewrite this object.
/// The result has no external authority or activation semantics.
///
/// ```compile_fail
/// use hepta_paper_service::online_schema_execution::maintenance::normalization::finalization::SchemaTransitionPostStateV1;
/// let state: SchemaTransitionPostStateV1 = serde_json::from_str("{}").unwrap();
/// ```
pub struct SchemaTransitionPostStateV1 {
    observed: ObservedStateDatabaseInventoryV1,
    plan: Value,
    installations: Value,
    pristine_runtime_state_hash: String,
    inspections: Vec<PristineDatabaseInspectionV1>,
}
impl SchemaTransitionPostStateV1 {
    pub fn inventory(&self) -> &Value {
        self.observed.value()
    }
    pub fn pristine_runtime_state_hash(&self) -> &str {
        &self.pristine_runtime_state_hash
    }
    pub fn inspections(&self) -> &[PristineDatabaseInspectionV1] {
        &self.inspections
    }
    /// Revalidate the retained live files before consuming their hashes. This
    /// is an observation boundary, not a lock against subsequent mutations.
    pub fn assert_current(&self, plan: &Value, installations: Option<&Value>) -> Result<()> {
        ensure(
            *plan == self.plan && installations.is_none_or(|value| *value == self.installations),
            "autonomous_research_online_schema_transition_post_state_subject_changed",
        )?;
        self.observed.assert_current()
    }
}

pub fn observe_schema_transition_post_state_v1(
    runtime_root: &Path,
    state_database_manifest: &Value,
    plan: &Value,
    installations: &Value,
    machine_genesis: Option<&crate::pristine_runtime_state::PinnedMachineGenesisDocumentsV1>,
) -> Result<SchemaTransitionPostStateV1> {
    ensure(
        plan["version"] == 1 || plan["version"] == 2,
        "autonomous_research_online_schema_transition_version_invalid",
    )?;
    let inventory = observe_state_database_inventory_v1(runtime_root, state_database_manifest)?;
    ensure(
        inventory.value()["status"] == "autonomous_research_state_database_inventory_ready"
            && inventory.value()["databaseScopeHash"] == plan["databaseScopeHash"]
            && inventory.value()["manifestHash"] == plan["stateDatabaseManifestHash"],
        "autonomous_research_online_schema_transition_post_inventory_invalid",
    )?;
    let instances = plan["instances"].as_array().ok_or_else(|| {
        error("autonomous_research_online_schema_transition_installation_invalid")
    })?;
    let records = installations.as_array().ok_or_else(|| {
        error("autonomous_research_online_schema_transition_installations_invalid")
    })?;
    let actual = inventory.value()["instances"].as_array().ok_or_else(|| {
        error("autonomous_research_online_schema_transition_post_inventory_invalid")
    })?;
    ensure(
        instances.len() == crate::sqlite_mutation_coordinator::DATABASE_ROLES.len()
            && instances.len() == records.len()
            && instances.len() == actual.len(),
        "autonomous_research_online_schema_transition_installations_invalid",
    )?;
    let mut seen = std::collections::BTreeSet::new();
    let mut inspections = Vec::with_capacity(instances.len());
    for (instance, record) in instances.iter().zip(records) {
        let id = text_field(instance, "databaseInstanceId")?;
        let observed = inventory.current_database_instance(id)?;
        ensure(
            seen.insert(id)
                && observed["role"] == instance["databaseRole"]
                && observed["schemaContractId"] == instance["schemaContractId"]
                && observed["sourceRelativePath"] == instance["sourceRelativePath"]
                && observed["schemaHash"] == instance["expectedPostSchemaHash"]
                && record["databaseInstanceId"] == instance["databaseInstanceId"]
                && record["databaseRole"] == instance["databaseRole"]
                && record["schemaContractId"] == instance["schemaContractId"]
                && record["preSchemaHash"] == instance["preSchemaHash"]
                && record["prePristineStateHash"] == instance["prePristineStateHash"]
                && record["postSchemaHash"] == instance["expectedPostSchemaHash"],
            "autonomous_research_pristine_schema_rebind_installation_missing",
        )?;
        // Initial installation still binds every actual schema and record. Only
        // the aggregate pristine hash is not applicable to protocol v1.
        if plan["version"] == 1 {
            continue;
        }
        let inspection = inventory.with_database_snapshot(id, |path| {
            let mut database = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )?;
            database.busy_timeout(std::time::Duration::ZERO)?;
            inspect_pristine_database_state_v1(
                &mut database,
                PristineDatabaseOptionsV1 {
                    database_role: text_field(instance, "databaseRole")?,
                    database_instance_id: id,
                    schema_contract_id: text_field(instance, "schemaContractId")?,
                    schema_hash: text_field(instance, "expectedPostSchemaHash")?,
                    state_database_manifest_hash: text_field(plan, "stateDatabaseManifestHash")?,
                    phase: "post-rebind",
                    machine_genesis,
                },
            )
        })?;
        ensure(
            record["postPristineStateHash"] == inspection.value()["pristineStateHash"],
            "autonomous_research_pristine_schema_rebind_post_state_changed",
        )?;
        inspections.push(inspection);
    }
    let pristine_runtime_state_hash = if plan["version"] == 1 {
        hash(
            "AutonomousResearchInitialSchemaTransitionPristineStateNotApplicable",
            &json!({ "transitionId": plan["transitionId"] }),
        )?
    } else {
        pristine_runtime_state_hash_v1(&inspections)?
    };
    inventory.assert_current()?;
    Ok(SchemaTransitionPostStateV1 {
        observed: inventory,
        plan: plan.clone(),
        installations: installations.clone(),
        pristine_runtime_state_hash,
        inspections,
    })
}

pub struct SchemaTransitionObserveOptions<'a> {
    pub plan: &'a Value,
    pub finalization: &'a VerifiedMutationReceiptV1,
    pub post_inventory_hash: &'a str,
    pub post_pristine_runtime_state_hash: &'a str,
    pub nonce: &'a str,
    pub requested_at: &'a str,
}

pub struct SchemaTransitionFinalizePostStateOptions<'a> {
    pub plan: &'a Value,
    pub reservation: &'a VerifiedMutationReceiptV1,
    pub installations: &'a Value,
    pub post_state: &'a SchemaTransitionPostStateV1,
    pub completed_at: &'a str,
}

pub struct SchemaTransitionObservePostStateOptions<'a> {
    pub plan: &'a Value,
    pub finalization: &'a VerifiedMutationReceiptV1,
    pub post_state: &'a SchemaTransitionPostStateV1,
    pub nonce: &'a str,
    pub requested_at: &'a str,
}

/// Invoke external finalization after the caller has completed all local
/// post-state checks. The returned receipt remains a verifier-bound opaque
/// value; this function does not publish progress or activate a capability.
pub fn finalize_schema_transition_v1<T: MutationAuthorityTransportV1>(
    authority: &mut PinnedMutationAuthorityV1<T>,
    options: SchemaTransitionFinalizeOptions<'_>,
    now: i64,
) -> Result<SchemaTransitionFinalizationResult> {
    let request = build_schema_transition_finalize_request_v1(
        options.plan,
        options.reservation,
        options.installations,
        options.post_inventory_hash,
        options.post_pristine_runtime_state_hash,
        options.completed_at,
    )?;
    let finalization = authority.finalize_schema_transition(&request, options.reservation, now)?;
    Ok(SchemaTransitionFinalizationResult {
        finalize_request: request,
        finalization,
    })
}

/// Bind finalization directly to a freshly observed post-state object, so a
/// caller cannot accidentally pair a receipt with an unrelated hash string.
pub fn finalize_schema_transition_with_post_state_v1<T: MutationAuthorityTransportV1>(
    authority: &mut PinnedMutationAuthorityV1<T>,
    options: SchemaTransitionFinalizePostStateOptions<'_>,
    now: i64,
) -> Result<SchemaTransitionFinalizationResult> {
    options
        .post_state
        .assert_current(options.plan, Some(options.installations))?;
    let result = finalize_schema_transition_v1(
        authority,
        SchemaTransitionFinalizeOptions {
            plan: options.plan,
            reservation: options.reservation,
            installations: options.installations,
            post_inventory_hash: text_field(options.post_state.inventory(), "inventoryHash")?,
            post_pristine_runtime_state_hash: &options.post_state.pristine_runtime_state_hash,
            completed_at: options.completed_at,
        },
        now,
    )?;
    options
        .post_state
        .assert_current(options.plan, Some(options.installations))?;
    Ok(result)
}

/// Invoke observation only for a version whose external protocol permits the
/// observation phase. Version 2 intentionally remains a restart-required
/// boundary after finalization and cannot be reported ready here.
pub fn observe_schema_transition_v1<T: MutationAuthorityTransportV1>(
    authority: &mut PinnedMutationAuthorityV1<T>,
    options: SchemaTransitionObserveOptions<'_>,
    now: i64,
) -> Result<SchemaTransitionObservationResult> {
    ensure(
        options.plan["version"] == 1,
        "autonomous_research_pristine_schema_rebind_target_configuration_restart_required",
    )?;
    let request = build_schema_transition_observe_request_v1(
        options.plan,
        options.finalization,
        options.post_inventory_hash,
        options.post_pristine_runtime_state_hash,
        options.nonce,
        options.requested_at,
    )?;
    let observation = authority.observe_schema_transition(&request, now)?;
    Ok(SchemaTransitionObservationResult {
        observe_request: request,
        observation,
    })
}

pub fn observe_schema_transition_with_post_state_v1<T: MutationAuthorityTransportV1>(
    authority: &mut PinnedMutationAuthorityV1<T>,
    options: SchemaTransitionObservePostStateOptions<'_>,
    now: i64,
) -> Result<SchemaTransitionObservationResult> {
    options.post_state.assert_current(options.plan, None)?;
    let result = observe_schema_transition_v1(
        authority,
        SchemaTransitionObserveOptions {
            plan: options.plan,
            finalization: options.finalization,
            post_inventory_hash: text_field(options.post_state.inventory(), "inventoryHash")?,
            post_pristine_runtime_state_hash: &options.post_state.pristine_runtime_state_hash,
            nonce: options.nonce,
            requested_at: options.requested_at,
        },
        now,
    )?;
    options.post_state.assert_current(options.plan, None)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlite_mutation_coordinator::authority::verified_for_test;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn plan(version: i64) -> Value {
        let mut plan = json!({
            "version": version,
            "protocol": if version == 1 { "external-authority-quiesced-offline-schema-transition-v1" } else { "external-authority-pristine-finalized-schema-rebind-v2" },
            "scopeId": "scope",
            "databaseScopeHash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            "writerManifestHash": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            "transitionId": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
            "transitionInventoryHash": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
            "schemaBundleHash": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        });
        if version == 2 {
            plan["transitionMode"] = json!("pristine");
            plan["sourceWriterManifestHash"] = plan["writerManifestHash"].clone();
        }
        plan
    }

    #[test]
    fn request_shapes_match_node_completion_protocol_and_bind_receipt() {
        let reservation = verified_for_test(json!({
            "kind": "AutonomousResearchOnlineSchemaTransitionReservationReceipt",
            "reservationId": "reservation",
            "version": 1,
        }));
        let value = "sha256:6666666666666666666666666666666666666666666666666666666666666666";
        let finalize = build_schema_transition_finalize_request_v1(
            &plan(1),
            &reservation,
            &json!([]),
            value,
            value,
            "2026-09-16T12:00:00.000Z",
        )
        .unwrap();
        assert_eq!(
            finalize["kind"],
            "AutonomousResearchOnlineSchemaTransitionFinalizeRequest"
        );
        assert_eq!(finalize.as_object().unwrap().len(), 15);
        assert_eq!(finalize["postInventoryHash"], value);
        let observe = build_schema_transition_observe_request_v1(
            &plan(1),
            &reservation,
            value,
            value,
            "schema-transition:test",
            "2026-09-16T12:00:00.000Z",
        )
        .unwrap();
        assert_eq!(
            observe["kind"],
            "AutonomousResearchOnlineSchemaTransitionObserveRequest"
        );
        assert_eq!(observe.as_object().unwrap().len(), 14);
        assert_eq!(
            observe["finalizationReceiptHash"].as_str().unwrap().len(),
            71
        );
    }

    #[test]
    fn rejects_unbound_hashes_and_keeps_v2_at_restart_boundary() {
        let reservation = verified_for_test(json!({
            "kind": "AutonomousResearchOnlineSchemaTransitionReservationReceipt",
            "reservationId": "reservation",
            "version": 1,
        }));
        let bad = build_schema_transition_finalize_request_v1(
            &plan(1),
            &reservation,
            &json!([]),
            "bad",
            "bad",
            "now",
        );
        assert!(bad.is_err());
        let bad = build_schema_transition_observe_request_v1(
            &plan(2),
            &reservation,
            "sha256:6666666666666666666666666666666666666666666666666666666666666666",
            "sha256:6666666666666666666666666666666666666666666666666666666666666666",
            "nonce",
            "now",
        );
        assert!(bad.is_ok());
    }

    #[test]
    fn request_bytes_match_node_completion_builder() {
        let reservation = json!({
            "kind": "AutonomousResearchOnlineSchemaTransitionReservationReceipt",
            "reservationId": "reservation",
            "version": 1,
        });
        let plan = plan(1);
        let value = "sha256:6666666666666666666666666666666666666666666666666666666666666666";
        let input = json!({
            "plan": plan,
            "reservation": reservation,
            "finalization": {
                "kind": "AutonomousResearchOnlineSchemaTransitionFinalizationReceipt",
                "finalizedAt": "2026-09-16T12:00:00.000Z",
            },
            "inventory": {"inventoryHash": value},
            "installations": [],
            "postInventoryHash": value,
            "postPristineRuntimeStateHash": value,
            "completedAt": "2026-09-16T12:00:00.000Z",
            "nonce": "schema-transition:test",
            "requestedAt": "2026-09-16T12:00:00.000Z",
        });
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../oracle/schema-finalization-v1.mjs");
        let mut child = Command::new("node")
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        writeln!(child.stdin.as_mut().unwrap(), "{input}").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(expected["ok"], true, "{expected}");
        let verified_reservation = verified_for_test(input["reservation"].clone());
        let finalize = build_schema_transition_finalize_request_v1(
            &input["plan"],
            &verified_reservation,
            &input["installations"],
            value,
            value,
            "2026-09-16T12:00:00.000Z",
        )
        .unwrap();
        let observe_finalization = verified_for_test(input["finalization"].clone());
        let observe = build_schema_transition_observe_request_v1(
            &input["plan"],
            &observe_finalization,
            value,
            value,
            "schema-transition:test",
            "2026-09-16T12:00:00.000Z",
        )
        .unwrap();
        assert_eq!(finalize, expected["finalize"]);
        assert_eq!(observe, expected["observe"]);
    }
}
