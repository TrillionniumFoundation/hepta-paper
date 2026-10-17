//! Authenticated signed journal history, independent of the backup transport
//! envelope. This evidence does not prove replayed business state or readiness.
use super::{
    DATABASE_ROLES, Result,
    authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
    error, int, keys,
};
use crate::{
    online_finalized_head_inspection::VerifiedFinalizedHeadInspectionV1,
    online_schema_transition::history::checkpoint::VerifiedSchemaTransitionCheckpointV1,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// No public constructor or deserializer: entries originate in a verified
/// backup envelope or complete retained, authenticated local inspections.
pub(crate) struct VerifiedFinalizedMutationChainV1 {
    value: Value,
    authority_configuration_hash: String,
}
impl VerifiedFinalizedMutationChainV1 {
    pub(crate) fn value(&self) -> &Value {
        &self.value
    }
    pub(crate) fn authority_configuration_hash(&self) -> &str {
        &self.authority_configuration_hash
    }
}
fn invalid() -> super::SqliteMutationCoordinatorError {
    error("autonomous_research_state_backup_restore_journal_entry_invalid")
}
fn anchored_invalid() -> super::SqliteMutationCoordinatorError {
    error("autonomous_research_schema_checkpoint_finalized_history_binding_invalid")
}
fn number(value: &Value) -> Option<i64> {
    value
        .as_f64()
        .filter(|v| v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0)
        .map(|v| v as i64)
}
fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(_), Value::Number(_)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(k, a)| b.get(k).is_some_and(|b| equal(a, b)))
        }
        _ => a == b,
    }
}
/// Both callers have already authenticated the surrounding envelope. Backup
/// replay anchors the first per-database predecessor to its actual snapshot;
/// checkpoint history supplies every signed schema genesis here, including DBs
/// with no entries. Never seed a checkpoint predecessor from its first mutation.
fn verify_chain<T: MutationAuthorityTransportV1>(
    value: Value,
    mut heads: BTreeMap<String, Value>,
    anchored: bool,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<VerifiedFinalizedMutationChainV1> {
    authority.current()?;
    let mut sequence = number(&value["fromGlobalSequence"]).ok_or_else(invalid)?;
    let mut global_hash = value["fromGlobalHash"].clone();
    let entries = value["entries"].as_array().ok_or_else(invalid)?;
    if entries.len() > 4096 {
        return Err(invalid());
    }
    for entry in entries {
        if !keys(
            entry,
            &[
                "reserveRequest",
                "reservationReceipt",
                "finalizeRequest",
                "finalizationReceipt",
            ],
        ) {
            return Err(invalid());
        }
        let reservation = authority
            .verify_stored_reservation(&entry["reservationReceipt"], &entry["reserveRequest"])
            .map_err(|_| invalid())?;
        authority
            .verify_stored_finalization(
                &entry["finalizationReceipt"],
                &entry["finalizeRequest"],
                &reservation,
            )
            .map_err(|_| invalid())?;
        let r = reservation.value();
        let id = r["databaseInstanceId"].as_str().ok_or_else(invalid)?;
        if anchored && !heads.contains_key(id) {
            return Err(anchored_invalid());
        }
        let previous = heads.get(id).cloned().unwrap_or_else(|| json!({"sequence":r["databasePreviousSequence"],"hash":r["databasePreviousHash"],"stateHash":r["preStateHash"]}));
        if number(&r["globalPreviousSequence"]) != Some(sequence)
            || r["globalPreviousHash"] != global_hash
            || number(&r["globalSequence"]) != sequence.checked_add(1)
            || !equal(&r["databasePreviousSequence"], &previous["sequence"])
            || r["databasePreviousHash"] != previous["hash"]
            || r["preStateHash"] != previous["stateHash"]
            || number(&r["databaseSequence"])
                != number(&previous["sequence"]).and_then(|v| v.checked_add(1))
            || (anchored
                && (r["databaseRole"] != previous["databaseRole"]
                    || r["schemaHash"] != previous["schemaHash"]
                    || r["schemaContractId"] != previous["schemaContractId"]))
        {
            return Err(invalid());
        }
        let mut next = previous;
        next["sequence"] = r["databaseSequence"].clone();
        next["hash"] = r["databaseHash"].clone();
        next["stateHash"] = r["postStateHash"].clone();
        heads.insert(id.to_owned(), next);
        sequence = number(&r["globalSequence"]).ok_or_else(invalid)?;
        global_hash = r["globalHash"].clone();
    }
    for (id, head) in heads {
        let signed = value["databaseHeads"]
            .as_array()
            .and_then(|a| a.iter().find(|v| v["databaseInstanceId"] == id))
            .ok_or_else(|| {
                error("autonomous_research_state_backup_restore_journal_database_head_invalid")
            })?;
        if ["sequence", "hash", "stateHash"]
            .iter()
            .any(|k| !equal(&signed[k], &head[k]))
            || (anchored
                && ["databaseRole", "schemaHash"]
                    .iter()
                    .any(|k| signed[k] != head[k]))
        {
            return Err(error(
                "autonomous_research_state_backup_restore_journal_database_head_invalid",
            ));
        }
    }
    if number(&value["toGlobalSequence"]) != Some(sequence) || value["toGlobalHash"] != global_hash
    {
        return Err(error(
            "autonomous_research_state_backup_restore_journal_continuity_invalid",
        ));
    }
    authority.current()?;
    Ok(VerifiedFinalizedMutationChainV1 {
        value,
        authority_configuration_hash: authority.configuration_hash().to_owned(),
    })
}
/// Only the verified backup-envelope consumer calls this internal adapter. Its
/// existing signed request, nonempty range and binding checks remain unchanged.
pub(crate) fn verify_backup_chain_v1<T: MutationAuthorityTransportV1>(
    receipt: &crate::state_backup_authority::VerifiedBackupAuthorityReceiptV1,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<VerifiedFinalizedMutationChainV1> {
    let r = receipt.value();
    verify_chain(
        json!({"entries":r["entries"],"databaseHeads":r["databaseHeads"],"fromGlobalSequence":r["fromGlobalSequence"],"fromGlobalHash":r["fromGlobalHash"],"toGlobalSequence":r["toGlobalSequence"],"toGlobalHash":r["toGlobalHash"]}),
        BTreeMap::new(),
        false,
        authority,
    )
}
/// Merge the complete retained journals from all ten real inspections, anchored
/// to the unchanged signed schema FINAL and every original signed DB genesis.
/// The caller separately revalidates freshness, source identities and replayed
/// current business state; this function creates no activation capability.
pub(crate) fn authenticate_schema_checkpoint_chain_v1<T: MutationAuthorityTransportV1>(
    checkpoint: &VerifiedSchemaTransitionCheckpointV1,
    inspections: &[VerifiedFinalizedHeadInspectionV1],
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<VerifiedFinalizedMutationChainV1> {
    authority.current()?;
    let audit = checkpoint.schema_audit()?;
    let reservation = authority.verify_historical_schema_transition_reservation(
        &audit["reservation"],
        &audit["reserveRequest"],
    )?;
    let finalization = authority.verify_historical_schema_transition_finalization(
        &audit["finalization"],
        &audit["finalizeRequest"],
        &reservation,
    )?;
    let finalized = finalization.value();
    let inventory = checkpoint.historical_inventory();
    if finalized["postInventoryHash"] != inventory["inventoryHash"]
        || inventory["databaseScopeHash"] != authority.trust()["databaseScopeHash"]
        || inspections.len() != DATABASE_ROLES.len()
    {
        return Err(anchored_invalid());
    }
    let instances = inventory["instances"]
        .as_array()
        .ok_or_else(anchored_invalid)?;
    let genesis = reservation.value()["databaseGenesis"]
        .as_array()
        .ok_or_else(anchored_invalid)?;
    if instances.len() != DATABASE_ROLES.len() || genesis.len() != DATABASE_ROLES.len() {
        return Err(anchored_invalid());
    }
    let current = inspections
        .first()
        .ok_or_else(anchored_invalid)?
        .current_head();
    let current_heads = current["databaseHeads"]
        .as_array()
        .ok_or_else(anchored_invalid)?;
    if current_heads.len() != DATABASE_ROLES.len() {
        return Err(anchored_invalid());
    }
    let mut heads = BTreeMap::new();
    let mut roles = BTreeSet::new();
    let mut entries = Vec::new();
    let mut seen = BTreeSet::new();
    for inspection in inspections {
        let local = inspection.value();
        let id = local["databaseInstanceId"]
            .as_str()
            .ok_or_else(anchored_invalid)?;
        let instance = instances
            .iter()
            .find(|i| i["instanceId"] == id)
            .ok_or_else(anchored_invalid)?;
        let original = genesis
            .iter()
            .find(|g| g["databaseInstanceId"] == id)
            .ok_or_else(anchored_invalid)?;
        let role = instance["role"].as_str().ok_or_else(anchored_invalid)?;
        let signed = current_heads
            .iter()
            .filter(|h| h["databaseInstanceId"] == id)
            .collect::<Vec<_>>();
        if inspection.authority_configuration_hash() != authority.configuration_hash()
            || !seen.insert(id)
            || !roles.insert(role)
            || !DATABASE_ROLES.contains(&role)
            || [
                "globalSequence",
                "globalHash",
                "databaseHeads",
                "scopeId",
                "databaseScopeHash",
                "writerManifestHash",
            ]
            .iter()
            .any(|k| !equal(&inspection.current_head()[k], &current[k]))
            || !equal(inspection.authenticated_genesis(), original)
            || original["databaseRole"] != instance["role"]
            || original["schemaContractId"] != instance["schemaContractId"]
            || original["schemaHash"] != instance["schemaHash"]
            || !equal(&original["globalSequence"], &finalized["globalSequence"])
            || original["globalHash"] != finalized["globalHash"]
            || number(&original["databaseSequence"]) != Some(0)
            || number(&original["globalSequence"]) != Some(0)
            || local["schemaHash"] != instance["schemaHash"]
            || local["schemaContractId"] != instance["schemaContractId"]
            || local["databaseRole"] != instance["role"]
            || signed.len() != 1
        {
            return Err(anchored_invalid());
        }
        heads.insert(id.to_owned(), json!({"databaseRole":role,"schemaContractId":instance["schemaContractId"],"schemaHash":instance["schemaHash"],"sequence":original["databaseSequence"],"hash":original["databaseHash"],"stateHash":original["stateHash"]}));
        entries.extend_from_slice(inspection.authenticated_entries());
        if entries.len() > 4096 {
            return Err(invalid());
        }
    }
    // Individual databases are ordered by DB sequence; global order must be
    // reconstructed across the complete namespace, never inferred from one DB.
    entries.sort_by_key(|entry| {
        number(&entry["reservationReceipt"]["globalSequence"]).unwrap_or(i64::MIN)
    });
    let value = json!({"entries":entries,"databaseHeads":current["databaseHeads"],"fromGlobalSequence":finalized["globalSequence"],"fromGlobalHash":finalized["globalHash"],"toGlobalSequence":current["globalSequence"],"toGlobalHash":current["globalHash"]});
    // Safe integer access also rejects negative or malformed chain endpoints.
    if int(&value, "toGlobalSequence")? < int(&value, "fromGlobalSequence")? {
        return Err(anchored_invalid());
    }
    verify_chain(value, heads, true, authority)
}

#[cfg(test)]
mod tests;
