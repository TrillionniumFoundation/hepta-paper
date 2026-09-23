//! Durable historical FINAL.json publication, bound to real post-installation
//! files and one pinned verifier. This does not activate a runtime, issue a live
//! readiness proof, send an authority RPC, or finish the finalization RPC journal.
use super::*;
use crate::{
    online_schema_execution::plan::installation_support::{
        validate_installation_inventory, validate_installation_journal,
    },
    online_schema_transition::audit::verify_audit,
    sqlite_mutation_coordinator::{hash_bytes, manifest::writer_manifest_hash_v1},
    state_database_inventory::{
        ObservedStateDatabaseInventoryV1, schema_source::maintenance_lock::SchemaMaintenanceLock,
    },
    state_recoverability::schema_finalization_repository::SchemaFinalizationRepository,
};
use std::path::PathBuf;
const MAX_BYTES: usize = 16 * 1024 * 1024;
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_online_schema_transition_final_receipt_invalid")
}
/// These are untrusted protocol records. Signature verification, fixed-plan
/// reconstruction and real post-inventory validation happen inside `prepare`.
pub struct SchemaTransitionAuditInputV1<'a> {
    pub plan: &'a Value,
    /// Retained independently from the progress/audit document being recovered.
    pub expected_plan_hash: &'a str,
    pub state_database_manifest: &'a Value,
    pub writer_manifest: &'a Value,
    pub reserve_request: &'a Value,
    pub reservation: &'a Value,
    pub finalize_request: &'a Value,
    pub finalization: &'a Value,
    pub observe_request: &'a Value,
    pub observation: &'a Value,
    pub installations: &'a Value,
}
/// An immutable historical audit bound to the original real runtime inventory.
/// No public constructor, Deserialize, mutable projection, activation or write
/// handle exists. Every publication rechecks the files and the pinned verifier.
///
/// ```compile_fail
/// use hepta_paper_service::online_schema_execution::maintenance::normalization::finalization::publication::PreparedSchemaTransitionAuditV1;
/// let proof: PreparedSchemaTransitionAuditV1 = serde_json::from_str("{}").unwrap();
/// ```
pub struct PreparedSchemaTransitionAuditV1 {
    receipt: Value,
    bytes: Vec<u8>,
    plan: Value,
    runtime_root: PathBuf,
    inventory_hash: String,
    authority_hash: String,
    writer_manifest_hash: String,
}
impl PreparedSchemaTransitionAuditV1 {
    pub fn value(&self) -> &Value {
        &self.receipt
    }
    fn assert_current<T: MutationAuthorityTransportV1>(
        &self,
        inventory: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
    ) -> Result<()> {
        ensure(
            inventory.runtime_root() == self.runtime_root
                && inventory.value()["inventoryHash"] == self.inventory_hash
                && authority.configuration_hash() == self.authority_hash,
            "autonomous_research_online_schema_transition_final_receipt_subject_changed",
        )?;
        inventory.assert_current()?;
        verify_audit(
            &self.receipt,
            &self.bytes,
            inventory.value(),
            &self.writer_manifest_hash,
            authority,
        )?;
        Ok(())
    }
}
/// Prepare v1's exact Node audit from actual ten-database post-state and all three
/// real historical signatures. Historical receipt publication may finish after
/// receipt expiry; fresh runtime readiness remains a separate signed challenge.
/// V2 needs an owned target-configuration restart proof, which is unavailable in
/// this API. No caller boolean or signed source-config receipt can bypass it.
pub fn prepare_schema_transition_audit_v1<T: MutationAuthorityTransportV1>(
    input: SchemaTransitionAuditInputV1<'_>,
    inventory: &ObservedStateDatabaseInventoryV1,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<PreparedSchemaTransitionAuditV1> {
    ensure(
        input.plan["version"] == 1,
        "autonomous_research_pristine_schema_rebind_target_configuration_restart_required",
    )?;
    ensure(
        crate::sqlite_mutation_coordinator::sha(&json!(input.expected_plan_hash))
            && input.plan["planHash"] == input.expected_plan_hash,
        "autonomous_research_online_schema_transition_final_receipt_plan_mismatch",
    )?;
    inventory.assert_current()?;
    let manifest_hash = writer_manifest_hash_v1(input.writer_manifest)?;
    ensure(
        authority.trust()["writerManifestHash"] == manifest_hash,
        "autonomous_research_online_schema_transition_final_receipt_authority_mismatch",
    )?;
    // This reconstructs the exact request from the independently pinned plan,
    // checks its fixed schema bundle and both manifests, and rejects extra keys.
    validate_installation_journal(
        &json!({"plan":input.plan,"request":input.reserve_request,
            "authorityConfigurationHash":authority.configuration_hash()}),
        input.state_database_manifest,
        input.writer_manifest,
        authority,
    )?;
    validate_installation_inventory(inventory.value(), input.state_database_manifest, input.plan)?;
    // Re-run the same opaque post-state observer used by the completion path.
    // Checking only schema hashes here would permit a signed installation list
    // to be paired with a different ten-database state. The observer owns the
    // descriptor-pinned inventory and checks every installation record against
    // the actual post-state before any FINAL.json bytes are assembled.
    let _post_state = super::observe_schema_transition_post_state_v1(
        inventory.runtime_root(),
        input.state_database_manifest,
        input.plan,
        input.installations,
        None,
    )?;
    let rows = input.plan["instances"].as_array().ok_or_else(invalid)?;
    let observed = inventory.value()["instances"]
        .as_array()
        .ok_or_else(invalid)?;
    ensure(rows.len() == observed.len(), &invalid().code)?;
    for (row, actual) in rows.iter().zip(observed) {
        let identity = &actual["sourceFileIdentity"];
        let stable = json!({"device":identity["device"],"inode":identity["inode"],
            "mode":identity["mode"],"links":identity["links"]});
        ensure(
            row["expectedPostSchemaHash"] == actual["schemaHash"]
                && row["sourceFileIdentityHash"]
                    == hash(
                        "AutonomousResearchOnlineSchemaTransitionSourceFileIdentity",
                        &stable,
                    )?,
            "autonomous_research_online_schema_transition_final_receipt_post_state_mismatch",
        )?;
    }
    let pristine = hash(
        "AutonomousResearchInitialSchemaTransitionPristineStateNotApplicable",
        &json!({"transitionId":input.plan["transitionId"]}),
    )?;
    ensure(
        input.finalize_request["postInventoryHash"] == inventory.value()["inventoryHash"]
            && input.finalize_request["postPristineRuntimeStateHash"] == pristine
            && input.observe_request["postInventoryHash"] == inventory.value()["inventoryHash"]
            && input.observe_request["postPristineRuntimeStateHash"] == pristine,
        "autonomous_research_online_schema_transition_final_receipt_post_state_mismatch",
    )?;
    let mut receipt = json!({
        "version":1,"kind":"AutonomousResearchOnlineSchemaTransitionAuditReceipt",
        "status":"autonomous_research_online_schema_transition_ready",
        "protocol":input.plan["protocol"],"transitionId":input.plan["transitionId"],
        "planHash":input.plan["planHash"],"databaseScopeHash":input.plan["databaseScopeHash"],
        "writerManifestHash":input.plan["writerManifestHash"],
        "transitionInventoryHash":input.plan["transitionInventoryHash"],
        "schemaBundleHash":input.plan["schemaBundleHash"],
        "postInventoryHash":inventory.value()["inventoryHash"],
        "postPristineRuntimeStateHash":pristine,
        "reserveRequest":input.reserve_request,"reservation":input.reservation,
        "finalizeRequest":input.finalize_request,"finalization":input.finalization,
        "observeRequest":input.observe_request,"observation":input.observation,
        "installations":input.installations,"completedAt":input.finalization["finalizedAt"],
        "externalAuthorityVerified":true,"crossDatabaseAtomicityClaimed":false,
        "recoveryProtocol":"external-authority-state-machine-idempotent-phases-v1"
    });
    receipt["schemaTransitionReceiptHash"] = hash(
        "AutonomousResearchOnlineSchemaTransitionAuditReceipt",
        &receipt,
    )?
    .into();
    let bytes = serde_json::to_vec(&receipt).map_err(|_| invalid())?;
    ensure(bytes.len() <= MAX_BYTES, &invalid().code)?;
    verify_audit(
        &receipt,
        &bytes,
        inventory.value(),
        &manifest_hash,
        authority,
    )?;
    let proof = PreparedSchemaTransitionAuditV1 {
        receipt,
        bytes,
        plan: input.plan.clone(),
        runtime_root: inventory.runtime_root().to_owned(),
        inventory_hash: text(inventory.value(), "inventoryHash")?.into(),
        authority_hash: authority.configuration_hash().into(),
        writer_manifest_hash: manifest_hash,
    };
    proof.assert_current(inventory, authority)?;
    Ok(proof)
}
pub trait SchemaFinalReceiptCheckpointV1 {
    fn checkpoint(&mut self, point: &str) -> Result<()>;
}
pub struct NoSchemaFinalReceiptCheckpointV1;
impl SchemaFinalReceiptCheckpointV1 for NoSchemaFinalReceiptCheckpointV1 {
    fn checkpoint(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
}
/// Returned diagnostic publication observation, never a runtime capability.
pub struct SchemaFinalReceiptPublicationV1 {
    pub receipt_path: PathBuf,
    pub file_sha256: String,
    pub replaced_existing_receipt: bool,
    pub already_published: bool,
}
/// Publish only to the prepared inventory's runtime. Cooperating runs hold the
/// root-inode maintenance lock and the repository's per-file CAS lock. A retry
/// after process death revalidates every signed record and actual database.
/// Conflicting existing bytes are retained unless their independent raw hash is
/// explicitly supplied; equal, verified receipt bytes are an idempotent success.
pub fn publish_schema_transition_final_receipt_v1<T: MutationAuthorityTransportV1>(
    proof: &PreparedSchemaTransitionAuditV1,
    inventory: &ObservedStateDatabaseInventoryV1,
    authority: &PinnedMutationAuthorityV1<T>,
    expected_previous_file_sha256: Option<&str>,
    checkpoint: &mut dyn SchemaFinalReceiptCheckpointV1,
) -> Result<SchemaFinalReceiptPublicationV1> {
    proof.assert_current(inventory, authority)?;
    let row = proof.plan["instances"]
        .as_array()
        .and_then(|r| r.first())
        .ok_or_else(invalid)?;
    let source = SchemaSource::observe(
        &proof.runtime_root,
        Path::new(text(row, "sourceRelativePath")?),
        text(row, "databaseRole")?,
    )?;
    let lock = SchemaMaintenanceLock::acquire(&source)?;
    let repo = SchemaFinalizationRepository::open(&lock, true)?;
    checkpoint.checkpoint("before_final_receipt_publication")?;
    proof.assert_current(inventory, authority)?;
    let old = repo.load()?;
    if let Some((value, bytes, digest)) = &old
        && value == &proof.receipt
    {
        verify_audit(
            value,
            bytes,
            inventory.value(),
            &proof.writer_manifest_hash,
            authority,
        )?;
        if expected_previous_file_sha256.is_some_and(|expected| expected != digest) {
            return Err(error(
                "autonomous_research_online_schema_transition_final_receipt_conflict",
            ));
        }
        proof.assert_current(inventory, authority)?;
        repo.assert_unchanged(digest)?;
        return Ok(SchemaFinalReceiptPublicationV1 {
            receipt_path: proof
                .runtime_root
                .join("autonomous-research/online-schema-transition/FINAL.json"),
            file_sha256: digest.clone(),
            replaced_existing_receipt: false,
            already_published: true,
        });
    }
    ensure(
        old.as_ref().map(|(_, _, hash)| hash.as_str()) == expected_previous_file_sha256,
        "autonomous_research_online_schema_transition_final_receipt_conflict",
    )?;
    let digest = repo.publish(&proof.receipt, expected_previous_file_sha256)?;
    checkpoint.checkpoint("after_final_receipt_publication")?;
    proof.assert_current(inventory, authority)?;
    repo.assert_unchanged(&digest)?;
    ensure(digest == hash_bytes(&proof.bytes), &invalid().code)?;
    Ok(SchemaFinalReceiptPublicationV1 {
        receipt_path: proof
            .runtime_root
            .join("autonomous-research/online-schema-transition/FINAL.json"),
        file_sha256: digest,
        replaced_existing_receipt: old.is_some(),
        already_published: false,
    })
}
