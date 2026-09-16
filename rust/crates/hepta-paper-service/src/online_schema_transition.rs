//! Actual audit-to-live-observation readiness with pinned signatures and inventory.
mod audit;
mod files;
pub mod target_schema;
use crate::{
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::{MutationClockV1, iso},
        contracts::schema_transition::schema_transition_receipt_hash_v1,
        error, hash,
        manifest::writer_manifest_hash_v1,
    },
    state_database_inventory::ObservedStateDatabaseInventoryV1,
};
use serde_json::{Value, json};
use std::path::Path;

/// Readiness can only be produced from an actual observed inventory, a held
/// audit file, three historical signatures and a fresh authority observation.
/// It is not an active runtime or a filesystem/current-head lease.
pub struct VerifiedSchemaTransitionReadinessV1 {
    value: Value,
    request: Value,
    observation: Value,
    inventory_hash: String,
    authority_configuration_hash: String,
    audit: files::AuditSnapshot,
}
impl VerifiedSchemaTransitionReadinessV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
    pub fn authority_configuration_hash(&self) -> &str {
        &self.authority_configuration_hash
    }
    pub fn assert_current<T: MutationAuthorityTransportV1>(
        &self,
        inventory: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        inventory.assert_current()?;
        self.audit.assert_current()?;
        if inventory.value()["inventoryHash"] != self.inventory_hash
            || authority.configuration_hash() != self.authority_configuration_hash
            || inventory.runtime_root() != self.audit.runtime_root()
        {
            return Err(error(
                "autonomous_research_online_schema_transition_readiness_subject_changed",
            ));
        }
        authority.verify_schema_transition_observation(
            &self.observation,
            &self.request,
            clock.now_millis()?,
        )?;
        Ok(())
    }
}
fn nonce() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| {
        error("autonomous_research_online_schema_transition_randomness_unavailable")
    })?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let value = hex::encode(bytes);
    Ok(format!(
        "schema-transition:{}-{}-{}-{}-{}",
        &value[..8],
        &value[8..12],
        &value[12..16],
        &value[16..20],
        &value[20..]
    ))
}
fn observe_request(receipt: &Value, inventory: &Value, requested_at: &str) -> Result<Value> {
    let plan = &receipt["reserveRequest"];
    let mut request = json!({"version":plan["version"],"kind":"AutonomousResearchOnlineSchemaTransitionObserveRequest","protocol":plan["protocol"],"scopeId":plan["scopeId"],"databaseScopeHash":plan["databaseScopeHash"],"writerManifestHash":plan["writerManifestHash"],"transitionId":plan["transitionId"],"transitionInventoryHash":plan["transitionInventoryHash"],"schemaBundleHash":plan["schemaBundleHash"],"finalizationReceiptHash":schema_transition_receipt_hash_v1(&receipt["finalization"] )?,"postInventoryHash":inventory["inventoryHash"],"postPristineRuntimeStateHash":receipt["postPristineRuntimeStateHash"],"nonce":nonce()?,"requestedAt":requested_at});
    if plan["version"] == 2 {
        request["transitionMode"] = plan["transitionMode"].clone();
        request["sourceWriterManifestHash"] = plan["sourceWriterManifestHash"].clone();
    }
    Ok(request)
}
pub fn inspect_online_schema_transition_readiness_v1<T: MutationAuthorityTransportV1>(
    runtime_root: &Path,
    inventory: &ObservedStateDatabaseInventoryV1,
    writer_manifest: &Value,
    authority: &mut PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
) -> Result<VerifiedSchemaTransitionReadinessV1> {
    inventory.assert_current()?;
    let inventory_value = inventory.value();
    if runtime_root != inventory.runtime_root()
        || inventory_value["databaseScopeHash"] != authority.trust()["databaseScopeHash"]
    {
        return Err(error(
            "autonomous_research_online_schema_transition_readiness_inventory_invalid",
        ));
    }
    let manifest_hash = writer_manifest_hash_v1(writer_manifest)?;
    // A historical rebind receipt can be verified by either source or target
    // trust. Current readiness is specifically bound to the target manifest.
    if authority.trust()["writerManifestHash"] != manifest_hash {
        return Err(error(
            "autonomous_research_online_schema_transition_readiness_authority_manifest_mismatch",
        ));
    }
    let audit = files::AuditSnapshot::load(runtime_root)?;
    let receipt = audit.value()?;
    audit::verify_audit(
        &receipt,
        audit.bytes(),
        inventory_value,
        &manifest_hash,
        authority,
    )?;
    let request = observe_request(&receipt, inventory_value, &iso(clock.now_millis()?)?)?;
    let observation = authority.observe_schema_transition(&request, clock.now_millis()?)?;
    inventory.assert_current()?;
    audit.assert_current()?;
    let observation = observation.value().clone();
    let mut value = json!({"version":receipt["version"],"kind":"AutonomousResearchOnlineSchemaTransitionReadyReceipt","status":"autonomous_research_online_schema_transition_ready","protocol":receipt["protocol"],"transitionId":receipt["transitionId"],"databaseScopeHash":receipt["databaseScopeHash"],"writerManifestHash":receipt["writerManifestHash"],"inventoryHash":inventory_value["inventoryHash"],"schemaTransitionReceiptHash":receipt["schemaTransitionReceiptHash"],"liveObservationReceiptHash":schema_transition_receipt_hash_v1(&observation)?,"observedAt":observation["observedAt"],"expiresAt":observation["expiresAt"],"externalAuthorityVerified":true,"blockers":[]});
    value["readinessReceiptHash"] = json!(hash(
        "AutonomousResearchOnlineSchemaTransitionReadyReceipt",
        &value
    )?);
    let inventory_hash = inventory_value["inventoryHash"]
        .as_str()
        .ok_or_else(|| {
            error("autonomous_research_online_schema_transition_readiness_inventory_invalid")
        })?
        .to_owned();
    // The inventory check can rehash/reinspect large snapshots. Read the clock
    // only after that work and after computing the output, not before it.
    authority.verify_schema_transition_observation(&observation, &request, clock.now_millis()?)?;
    Ok(VerifiedSchemaTransitionReadinessV1 {
        value,
        request,
        observation,
        inventory_hash,
        authority_configuration_hash: authority.configuration_hash().into(),
        audit,
    })
}
