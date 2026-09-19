//! Authentication for automatic recovery of the original complete fixed writer
//! registry. Signatures attest capture; this does not invent a runtime callback
//! trace or allow arbitrary plans supplied by the caller.
use super::*;
use crate::{
    online_mutation_composition::BuiltinOnlineMutationPlansV1,
    sqlite_changeset::inspect_sqlite_changeset_effects_v1,
    sqlite_mutation_plan::assert_sqlite_mutation_database_surface_v1,
    state_backup_authority::VerifiedFinalizedJournalEvidenceV1,
};
use base64ct::{Base64, Encoding};

pub(super) struct RegisteredJournalPlansV1 {
    registry: BuiltinOnlineMutationPlansV1,
}
fn rejected() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_state_registered_journal_operation_invalid")
}
impl RegisteredJournalPlansV1 {
    pub(super) fn authenticate(
        manifest: &Value,
        inventory: &ObservedStateDatabaseInventoryV1,
        range: &VerifiedFinalizedJournalEvidenceV1,
    ) -> Result<Option<Self>> {
        let registry = BuiltinOnlineMutationPlansV1::load()?;
        let manifest_hash =
            crate::sqlite_mutation_coordinator::manifest::writer_manifest_hash_v1(manifest)?;
        if registry.checked_plans().manifest_hash() != manifest_hash {
            // The older bounded heartbeat fixture/contract remains supported;
            // a custom manifest cannot opt itself into general replay here.
            return Ok(None);
        }
        let result = Self { registry };
        let entries = range.value()["entries"].as_array().ok_or_else(rejected)?;
        ensure(
            !entries.is_empty() && entries.len() <= 4096,
            "autonomous_research_state_registered_journal_operation_invalid",
        )?;
        let instances = inventory.value()["instances"]
            .as_array()
            .ok_or_else(rejected)?;
        for entry in entries {
            let receipt = &entry["reservationReceipt"];
            let operation_id = text(receipt, "operationId")?;
            let original = result.registry.writer_manifest();
            let operation = original["operations"]
                .as_array()
                .and_then(|values| values.iter().find(|v| v["operationId"] == operation_id))
                .ok_or_else(rejected)?;
            let writer = original["writers"]
                .as_array()
                .and_then(|values| {
                    values.iter().find(|v| {
                        v["writerId"] == receipt["writerId"]
                            && v["operationIds"]
                                .as_array()
                                .is_some_and(|ids| ids.contains(&receipt["operationId"]))
                    })
                })
                .ok_or_else(rejected)?;
            let instance = instances
                .iter()
                .find(|i| i["instanceId"] == receipt["databaseInstanceId"])
                .ok_or_else(rejected)?;
            ensure(
                receipt["writerManifestHash"] == manifest_hash
                    && operation["coordinatorIntegrated"] == true
                    && operation["databaseRole"] == receipt["databaseRole"]
                    && instance["role"] == receipt["databaseRole"]
                    && instance["schemaHash"] == receipt["schemaHash"]
                    && instance["schemaContractId"] == receipt["schemaContractId"]
                    && writer["implementationHash"] == receipt["codeProvenanceHash"],
                "autonomous_research_state_registered_journal_operation_invalid",
            )?;
            let plan = result
                .registry
                .checked_plans()
                .get(operation_id)
                .ok_or_else(rejected)?;
            let allowed = plan
                .allowed_replay_effects()
                .map_err(|_| rejected())?
                .into_iter()
                .map(|e| (e.table, e.operation))
                .collect::<BTreeSet<_>>();
            let bytes =
                Base64::decode_vec(text(receipt, "changesetBase64")?).map_err(|_| rejected())?;
            let effects = inspect_sqlite_changeset_effects_v1(&bytes).map_err(|_| rejected())?;
            ensure(
                !effects.is_empty()
                    && effects.iter().all(|effect| {
                        !crate::sqlite_mutation_plan::SYSTEM_TABLES
                            .iter()
                            .any(|s| s.eq_ignore_ascii_case(&effect.table))
                            && allowed.contains(&(effect.table.clone(), effect.operation.clone()))
                    }),
                "autonomous_research_state_registered_journal_effect_forbidden",
            )?;
        }
        Ok(Some(result))
    }
    pub(super) fn assert_database_surface(
        &self,
        database: &Connection,
        instance: &Value,
        range: &VerifiedFinalizedJournalEvidenceV1,
    ) -> Result<()> {
        let entries = range.value()["entries"].as_array().ok_or_else(rejected)?;
        let mut checked = BTreeSet::new();
        for entry in entries
            .iter()
            .filter(|e| e["reservationReceipt"]["databaseInstanceId"] == instance["instanceId"])
        {
            let id = text(&entry["reservationReceipt"], "operationId")?;
            if checked.insert(id) {
                let plan = self.registry.checked_plans().get(id).ok_or_else(rejected)?;
                assert_sqlite_mutation_database_surface_v1(database, plan)
                    .map_err(|e| error(e.to_string()))?;
            }
        }
        Ok(())
    }
}
