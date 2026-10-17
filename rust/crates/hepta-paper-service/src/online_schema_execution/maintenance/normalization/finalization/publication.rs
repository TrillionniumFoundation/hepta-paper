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
const V2_GENESIS_KEYS: &[&str] = &[
    "databaseRole",
    "databaseInstanceId",
    "schemaContractId",
    "schemaHash",
    "globalSequence",
    "globalHash",
    "databaseSequence",
    "databaseHash",
    "stateHash",
];
#[derive(Clone, Copy)]
enum AuditWireContext {
    Other,
    Reservation,
    GenesisArray,
    GenesisRow,
}
fn write_audit_json(value: &Value, output: &mut Vec<u8>, context: AuditWireContext) -> Result<()> {
    match value {
        Value::Object(map) => {
            output.push(b'{');
            let keys: Vec<&str> = if matches!(context, AuditWireContext::GenesisRow) {
                ensure(
                    map.len() == V2_GENESIS_KEYS.len()
                        && V2_GENESIS_KEYS.iter().all(|key| map.contains_key(*key)),
                    "autonomous_research_online_schema_transition_audit_genesis_shape_invalid",
                )?;
                V2_GENESIS_KEYS.to_vec()
            } else {
                map.keys().map(String::as_str).collect()
            };
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                serde_json::to_writer(&mut *output, key).map_err(|_| invalid())?;
                output.push(b':');
                let child = match (context, key) {
                    (AuditWireContext::Other, "reservation") => AuditWireContext::Reservation,
                    (AuditWireContext::Reservation, "databaseGenesis") => {
                        AuditWireContext::GenesisArray
                    }
                    _ => AuditWireContext::Other,
                };
                write_audit_json(&map[key], output, child)?;
            }
            output.push(b'}');
        }
        Value::Array(rows) => {
            output.push(b'[');
            for (index, row) in rows.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                let child = if matches!(context, AuditWireContext::GenesisArray) {
                    AuditWireContext::GenesisRow
                } else {
                    AuditWireContext::Other
                };
                write_audit_json(row, output, child)?;
            }
            output.push(b']');
        }
        _ => serde_json::to_writer(output, value).map_err(|_| invalid())?,
    }
    Ok(())
}
fn audit_bytes(receipt: &Value) -> Result<Vec<u8>> {
    if receipt["version"] != 2 {
        return serde_json::to_vec(receipt).map_err(|_| invalid());
    }
    let mut output = Vec::new();
    write_audit_json(receipt, &mut output, AuditWireContext::Other)?;
    ensure(
        serde_json::from_slice::<Value>(&output).map_err(|_| invalid())? == *receipt,
        "autonomous_research_online_schema_transition_audit_wire_projection_invalid",
    )?;
    Ok(output)
}
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
/// Prepare the exact Node audit from actual ten-database post-state and all three
/// real historical signatures. Historical receipt publication may finish after
/// receipt expiry; fresh runtime readiness remains a separate signed challenge.
/// V2 is admitted only after the target authority has signed an observation with
/// `authorityConfigurationActivated=true`; no caller boolean or source-config
/// receipt can substitute for that restart-bound fact.
pub fn prepare_schema_transition_audit_v1<T: MutationAuthorityTransportV1>(
    input: SchemaTransitionAuditInputV1<'_>,
    inventory: &ObservedStateDatabaseInventoryV1,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<PreparedSchemaTransitionAuditV1> {
    ensure(
        [json!(1), json!(2)].contains(&input.plan["version"]),
        "autonomous_research_online_schema_transition_final_receipt_version_invalid",
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
    let post_state = super::observe_schema_transition_post_state_v1(
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
    let pristine = if input.plan["version"] == 2 {
        post_state.pristine_runtime_state_hash().to_owned()
    } else {
        hash(
            "AutonomousResearchInitialSchemaTransitionPristineStateNotApplicable",
            &json!({"transitionId":input.plan["transitionId"]}),
        )?
    };
    ensure(
        input.finalize_request["postInventoryHash"] == inventory.value()["inventoryHash"]
            && input.finalize_request["postPristineRuntimeStateHash"] == pristine
            && input.observe_request["postInventoryHash"] == inventory.value()["inventoryHash"]
            && input.observe_request["postPristineRuntimeStateHash"] == pristine,
        "autonomous_research_online_schema_transition_final_receipt_post_state_mismatch",
    )?;
    if input.plan["version"] == 2 {
        ensure(
            input.reservation["targetAuthorityConfigurationHash"]
                == input.finalization["targetAuthorityConfigurationHash"]
                && crate::sqlite_mutation_coordinator::sha(
                    &input.finalization["targetAuthorityConfigurationHash"],
                )
                && input.observation["authorityConfigurationActivated"] == true,
            "autonomous_research_pristine_schema_rebind_target_configuration_not_activated",
        )?;
    }
    let mut receipt = json!({
        "version":input.plan["version"],"kind":"AutonomousResearchOnlineSchemaTransitionAuditReceipt",
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
    if input.plan["version"] == 2 {
        receipt["transitionMode"] = input.plan["transitionMode"].clone();
        receipt["sourceWriterManifestHash"] = input.plan["sourceWriterManifestHash"].clone();
        receipt["authorityConfigurationActivated"] = json!(true);
    }
    receipt["schemaTransitionReceiptHash"] = hash(
        "AutonomousResearchOnlineSchemaTransitionAuditReceipt",
        &receipt,
    )?
    .into();
    let bytes = audit_bytes(&receipt)?;
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
    let digest = repo.publish_bytes(&proof.receipt, &proof.bytes, expected_previous_file_sha256)?;
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
