//! Signing diagnostics observed inside the actual declared control process.
//! This borrows an already prepared composition; its earlier startup/cache work
//! is not part of this read-only observation. No authorization is manufactured.
use super::admission::{NativeAdmissionInputsV1, configuration, original_preimage_hash};
use super::admission_hashes::native_reconciliation_durable_epoch_hash_v1;
use super::native_process::RetainedNativeControlProcessV1;
use super::transaction::NativeTransactionEvidenceV1;
use super::*;
use crate::automation_runtime_reconciliation::LOCAL_RECONCILIATION_WRITER_ID_V1;
use hepta_campaign_writer::{
    CampaignWriterPolicyV1, WriterCutoverSubjectV1, inspect_writer_database_preimage_v1,
};
use hepta_codex_protocol::Sha256Digest;
use hepta_cutover::{
    DurableCutoverCoordinatorV1, DurableCutoverModeV1, DurableCutoverPhaseV1, DurableCutoverStateV1,
};
use hepta_qualification_ingest::VerifiedExternalQualificationClosureV1;
use std::path::{Path, PathBuf};

/// Copied observations only: no connection, raw descriptor, proof scope or
/// deserializable capability crosses the fully closed observation phase.
pub(super) struct ObservedNativeSigningSubjectV1 {
    pub(super) shadow: DurableCutoverStateV1,
    pub(super) prospective_canary: DurableCutoverStateV1,
    pub(super) external_root: PathBuf,
    pub(super) enrollment_hash: Sha256Digest,
    pub(super) subject: WriterCutoverSubjectV1,
    pub(super) preimage_hash: Sha256Digest,
    pub(super) epoch_hash: Sha256Digest,
    report: Value,
}

const MAX_SAFE: u64 = 9_007_199_254_740_991;
fn rejected() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    fail("native_signing_preview_invalid")
}
/// Pure expected transition, not an activated durable state or writer grant.
/// Actual runtime admission must independently read the post-transition state.
pub(super) fn prospective_canary(
    state: &DurableCutoverStateV1,
    root: &Path,
    enrollment: &Sha256Digest,
) -> Result<DurableCutoverStateV1> {
    if state.version != 1
        || state.mode != DurableCutoverModeV1::Production
        || state.phase != DurableCutoverPhaseV1::ShadowVerified
        || state.writer_id.is_some()
        || !state.canary_scopes.is_empty()
        || state.production_activation
        || state.activation_receipt_hash.is_some()
        || state.new_writer_id != LOCAL_RECONCILIATION_WRITER_ID_V1
        || state.generation == 0
        || state.revision == 0
        || state.token != format!("{}:{}", state.cutover_id, state.generation)
    {
        return Err(rejected());
    }
    let mut expected = state.clone();
    expected.generation = expected
        .generation
        .checked_add(1)
        .filter(|v| *v <= MAX_SAFE)
        .ok_or_else(rejected)?;
    expected.revision = expected
        .revision
        .checked_add(1)
        .filter(|v| *v <= MAX_SAFE)
        .ok_or_else(rejected)?;
    expected.token = format!("{}:{}", expected.cutover_id, expected.generation);
    expected.writer_id = Some(LOCAL_RECONCILIATION_WRITER_ID_V1.into());
    expected.canary_scopes = vec![RECONCILIATION_WRITER_SCOPE_V1.into()];
    expected.phase = DurableCutoverPhaseV1::Canary;
    expected.production_activation = true;
    // This validates closed identifiers, safe integers, shadow counts, paths
    // and exact fixed scopes using the same runtime epoch encoding.
    native_reconciliation_durable_epoch_hash_v1(&expected, root, enrollment)?;
    Ok(expected)
}
impl PreparedInitialOnlineMutationCompositionV1 {
    /// The native producer still requires the ACTUAL kernel argv/principal/ELF.
    /// A different CLI invocation cannot preview another service unit's identity.
    /// Output is diagnostic JSON, never a deserializable admitted capability.
    pub(crate) fn inspect_native_reconciliation_signing_v1(
        &self,
        native: &RetainedNativeControlProcessV1,
        qualification: &VerifiedExternalQualificationClosureV1,
    ) -> Result<Value> {
        Ok(self
            .observe_native_reconciliation_signing_v1(native, qualification)?
            .report)
    }
    pub(super) fn observe_native_reconciliation_signing_v1(
        &self,
        native: &RetainedNativeControlProcessV1,
        qualification: &VerifiedExternalQualificationClosureV1,
    ) -> Result<ObservedNativeSigningSubjectV1> {
        self.assert_current()?;
        let inventory = self.startup.post_inventory();
        let native_scope = native.retain_for_native_store_transaction_v1(inventory)?;
        let mut clock = CompositionClock(&self.checked_at);
        let source = self.source.retain_for_native_store_transaction_v1(
            inventory,
            &self.verifier,
            &self.active,
            &mut clock,
        )?;
        let cache = self.cache.retain_for_native_store_transaction_v1(
            &self.verifier,
            &self.active,
            inventory,
            &self.source,
            &mut clock,
        )?;
        let guard = inventory.native_store_transaction_guard_v1()?;
        let recovery = self.fence.retain_native_store_with_pins(
            &self.fence_binding,
            &guard,
            &self.verifier,
            || {
                assert_product_owner_current(
                    self.installed_authority.as_ref(),
                    &self.fence,
                    &self.verifier,
                )
            },
        )?;
        let path = inventory
            .runtime_root()
            .join(crate::sqlite_mutation_coordinator::text(
                guard.instance(),
                "sourceRelativePath",
            )?);
        let preimage = inspect_writer_database_preimage_v1(
            &path,
            CampaignWriterPolicyV1::strict(native.control_unit().principal_uid),
        )
        .map_err(|e| error(e.to_string()))?;
        let inputs = NativeAdmissionInputsV1 {
            workspace_root: &self.workspace_root,
            backup_root: &self.backup_root,
            startup: &self.startup,
            source: &self.source,
            verifier: &self.verifier,
            fence_binding: &self.fence_binding,
            checked_at: &self.checked_at,
        };
        let evidence = NativeTransactionEvidenceV1::from(self);
        // Must be declared after all raw-file scopes, including the original
        // recovery allocation. Idle journal WAL locks survive through close.
        let mut durable =
            DurableCutoverCoordinatorV1::open(&path).map_err(|e| error(e.to_string()))?;
        let mut outcome = None;
        let scoped = durable.with_production_shadow_observation_v2(|state, storage| {
            let result = (|| {
                storage.assert_current().map_err(|e| error(e.to_string()))?;
                native_scope.assert_current(native, &guard)?;
                evidence.assert_current(&source, &cache, &guard, &recovery)?;
                let enrollment = storage.external_storage_enrollment_hash_v2().parse().map_err(|_| rejected())?;
                let expected = prospective_canary(state, storage.external_storage_root_v2(), &enrollment)?;
                let configuration = configuration(&inputs, native, &expected, storage)?;
                let preimage_hash = original_preimage_hash(&inputs, &guard, &preimage)?;
                let deployment = native.deployment();
                let qualified = qualification.subject();
                let facts = qualification.runtime_facts();
                if qualified.repository != deployment.repository()
                    || qualified.commit != deployment.commit() || qualified.tree != deployment.tree()
                    || facts.service_identity_hash != deployment.identity_hash().as_str()
                    || facts.database_identity_hash != preimage_hash.as_str()
                { return Err(rejected()); }
                let subject = WriterCutoverSubjectV1 {
                    repository: deployment.repository().into(), commit_sha: deployment.commit().into(),
                    tree_sha: deployment.tree().into(), binary_hash: native.executable_hash().clone(),
                    configuration_hash: configuration.hash,
                    host_identity_hash: facts.host_identity_hash.parse().map_err(|_| rejected())?,
                    service_identity_hash: deployment.identity_hash().clone(),
                };
                // Last common sample follows every retained I/O and projection.
                storage.assert_current().map_err(|e| error(e.to_string()))?;
                native_scope.assert_current(native, &guard)?;
                guard.assert_original_target_current_v1()?;
                let now = clock.now_millis()?;
                evidence.assert_evidence_valid_at(now)?;
                self.fence.assert_native_store_time(&recovery, now)?;
                qualification.assert_current(u64::try_from(now).map_err(|_| rejected())?)
                    .map_err(|e| error(e.to_string()))?;
                let report = json!({"version":1,"kind":"NativeReconciliationSigningDiagnostic",
                    "status":"independent_native_cutover_signature_required",
                    "subject":subject,"configuration":configuration.body,
                    "databasePreimageHash":preimage_hash,"initialWriterLeaseHash":configuration.epoch_hash,
                    "cutoverId":state.cutover_id,"expectedShadowRevision":state.revision,
                    "expectedCanaryRevision":expected.revision,"expectedGeneration":expected.generation,
                    "expectedWriterId":expected.writer_id,"expectedToken":expected.token,
                    "expectedScopes":expected.canary_scopes,"externalStorageEnrollmentHashV2":enrollment,
                    "qualificationReceiptHash":qualification.receipt_hash(),"checkedAtMillis":now,
                    "runtimeReady":false,"productionActivation":false,"productionActivationPerformed":false,"nodeRetirementVerified":false});
                Ok(ObservedNativeSigningSubjectV1 {
                    shadow: state.clone(), prospective_canary: expected,
                    external_root: storage.external_storage_root_v2().to_path_buf(),
                    enrollment_hash: enrollment, subject, preimage_hash,
                    epoch_hash: configuration.epoch_hash, report,
                })
            })();
            let failure = result.as_ref().err().map(|e| e.code.clone());
            outcome = Some(result);
            match failure { Some(code) => Err(code), None => Ok(()) }
        });
        match (outcome, scoped) {
            (Some(Err(cause)), _) => Err(cause),
            (Some(Ok(value)), Ok(())) => Ok(value),
            (_, Err(cause)) => Err(error(cause.to_string())),
            (None, Ok(())) => Err(rejected()),
        }
    }
}

#[cfg(test)]
mod tests;
