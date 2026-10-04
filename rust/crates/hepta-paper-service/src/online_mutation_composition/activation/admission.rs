//! Exact signed subject binding for one fixed native reconciliation. Diagnostics
//! and pure hashes are not permits. Construction consumes actual producers and
//! occurs under the retained external writer transaction before SQLite opens.
use super::admission_hashes::native_reconciliation_durable_epoch_hash_v1;
use super::native_process::{
    RetainedNativeControlProcessV1, native_reconciliation_implementation_hash_v1,
};
use super::*;
use crate::sqlite_mutation_coordinator::{hash, text};
use hepta_campaign_writer::{
    VerifiedWriterCutoverV1, WriterDatabasePreimageV1, WriterDatabaseStateV1,
    writer_database_preimage_hash_v1,
};
use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::canonical_hash_v1;
use hepta_cutover::{DurableCutoverStateV1, ExternalWriterStorageObservationV2};
use hepta_qualification_ingest::VerifiedExternalQualificationClosureV1;

pub(super) const ONLINE_WRITER: &str = "writer:native-store:automation-runtime-reconciler:v1";
pub(super) const OPERATIONS: [&str; 2] = [
    "native-store.automation-runtime-reconciler.executeAutomationRuntimeReconciliation.v1",
    "native-store.legacy-terminal-active-residue-settlement.executeLegacyTerminalActiveResidueSettlement.v1",
];

/// No Clone, Deserialize, caller clock, raw connection or arbitrary operation.
/// The only owner mints and consumes this in one locked callback. Fresh writes
/// need a newly observed preimage and a matching independent authorization.
pub(super) struct NativeReconciliationAdmissionV1<'a> {
    qualification: &'a VerifiedExternalQualificationClosureV1,
    cutover: &'a VerifiedWriterCutoverV1,
    configuration_hash: Sha256Digest,
    epoch_hash: Sha256Digest,
}
fn reject() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    fail("native_admission_subject_mismatch")
}
fn digest(value: &str) -> Result<Sha256Digest> {
    value.parse().map_err(|_| reject())
}
pub(super) struct NativeAdmissionInputsV1<'a> {
    pub(super) workspace_root: &'a std::path::Path,
    pub(super) backup_root: &'a std::path::Path,
    pub(super) startup: &'a VerifiedStartupReconciliationSetV1,
    pub(super) source: &'a VerifiedWriterStaticCoverageV1,
    pub(super) verifier: &'a Online,
    pub(super) fence_binding: &'a VerifiedRecoverabilityActivationBindingV1,
    pub(super) checked_at: &'a Cell<i64>,
}
pub(super) struct NativeConfigurationV1 {
    pub(super) hash: Sha256Digest,
    pub(super) epoch_hash: Sha256Digest,
    pub(super) body: Value,
}
pub(super) fn configuration(
    prepared: &NativeAdmissionInputsV1<'_>,
    native: &RetainedNativeControlProcessV1,
    state: &DurableCutoverStateV1,
    storage: &ExternalWriterStorageObservationV2<'_>,
) -> Result<NativeConfigurationV1> {
    let inventory = prepared.startup.post_inventory();
    let external_root = storage.external_storage_root_v2();
    let enrollment = digest(storage.external_storage_enrollment_hash_v2())?;
    let epoch = native_reconciliation_durable_epoch_hash_v1(state, external_root, &enrollment)?;
    let unit = native.control_unit();
    for path in [
        inventory.runtime_root(),
        prepared.backup_root,
        external_root,
    ] {
        if !unit
            .writable_roots
            .iter()
            .any(|root| path.starts_with(&root.path))
        {
            return Err(fail("native_admission_writable_root_not_declared"));
        }
    }
    let instances = inventory.value()["instances"]
        .as_array()
        .ok_or_else(reject)?;
    if instances.len() != 10 {
        return Err(reject());
    }
    let mut projection = instances
        .iter()
        .map(|row| {
            json!({
                "role":row["role"],"instanceId":row["instanceId"],
                "schemaContractId":row["schemaContractId"],"schemaHash":row["schemaHash"],
                "sourceRelativePath":row["sourceRelativePath"]
            })
        })
        .collect::<Vec<_>>();
    projection.sort_by(|a, b| a["instanceId"].as_str().cmp(&b["instanceId"].as_str()));
    let native_rows = instances
        .iter()
        .filter(|row| row["role"] == "native-store")
        .collect::<Vec<_>>();
    if native_rows.len() != 1 {
        return Err(reject());
    }
    let target = native_rows[0];
    if target["sourceRelativePath"] != "hepta-paper.sqlite"
        || target["schemaContractId"] != "native-store-schema-v23"
        || inventory.runtime_root().join("hepta-paper.sqlite")
            != std::path::Path::new(&state.database_path)
    {
        return Err(reject());
    }
    let builtin = BuiltinOnlineMutationPlansV1::load()?;
    let plans = OPERATIONS
        .iter()
        .map(|id| {
            builtin
                .checked_plans()
                .get(id)
                .map(|plan| plan.projection())
                .ok_or_else(reject)
        })
        .collect::<Result<Vec<_>>>()?;
    let binding = prepared.fence_binding.value();
    let (profile_field, profile_hash) = prepared.verifier.inspect_transport_v1(|transport| {
        (
            transport.profile_field(),
            transport.profile_hash().to_owned(),
        )
    });
    let mut body = json!({
        "domain":"HeptaNativeAutomationReconciliationConfigurationV1","version":1,
        "workspaceRoot":prepared.workspace_root,"runtimeRoot":inventory.runtime_root(),
        "backupRoot":prepared.backup_root,"databasePath":state.database_path,
        "databaseInstanceId":target["instanceId"],"schemaContractId":target["schemaContractId"],
        "schemaHash":target["schemaHash"],
        "databaseInstancesHash":hash("HeptaNativeReconciliationDatabaseInstancesV1", &json!(projection))?,
        "stateDatabaseManifestHash":binding["stateDatabaseManifestHash"],
        "databaseScopeHash":binding["databaseScopeHash"],"writerManifestHash":binding["writerManifestHash"],
        "operationPlansHash":hash("HeptaNativeReconciliationOperationPlansV1", &json!(plans))?,
        "onlineWriterId":ONLINE_WRITER,"operationIds":OPERATIONS,
        "durableWriterId":crate::automation_runtime_reconciliation::LOCAL_RECONCILIATION_WRITER_ID_V1,
        "writerScope":RECONCILIATION_WRITER_SCOPE_V1,
        "nativeImplementationHash":native_reconciliation_implementation_hash_v1(),
        "sourceAstGateReceiptHash":digest(text(prepared.source.value(), "astGateReceiptHash")?)?,
        "sourceCodeProvenanceHash":digest(text(prepared.source.value(), "codeProvenanceHash")?)?,
        "deploymentIdentityHash":native.deployment().identity_hash(),
        "controlUnitHash":canonical_hash_v1(unit).map_err(|_| reject())?,
        "binaryHash":native.executable_hash(),
        "onlineAuthorityConfigurationHash":prepared.verifier.configuration_hash(),
        "backupAuthorityConfigurationHash":binding["backupAuthorityConfigurationHash"],
        "externalStorageRoot":external_root,"externalStorageEnrollmentHashV2":enrollment,
        "durableEpochHash":epoch
    });
    body.as_object_mut()
        .ok_or_else(reject)?
        .insert(profile_field.into(), json!(profile_hash));
    Ok(NativeConfigurationV1 {
        hash: canonical_hash_v1(&body).map_err(|_| reject())?,
        epoch_hash: epoch,
        body,
    })
}
impl<'a> NativeReconciliationAdmissionV1<'a> {
    #[allow(clippy::too_many_arguments)] // Actual independent producers, never a serialized permit.
    pub(super) fn observe(
        prepared: &NativeAdmissionInputsV1<'_>,
        native: &RetainedNativeControlProcessV1,
        qualification: &'a VerifiedExternalQualificationClosureV1,
        cutover: &'a VerifiedWriterCutoverV1,
        state: &DurableCutoverStateV1,
        storage: &ExternalWriterStorageObservationV2<'_>,
        guard: &crate::state_database_inventory::NativeStoreTransactionInventoryGuardV1<'_>,
        preimage: &WriterDatabasePreimageV1,
    ) -> Result<Self> {
        storage.assert_current().map_err(|e| error(e.to_string()))?;
        let configuration = configuration(prepared, native, state, storage)?;
        let configuration_hash = configuration.hash;
        let epoch_hash = configuration.epoch_hash;
        let deployment = native.deployment();
        let subject = cutover.subject();
        let qualification_subject = qualification.subject();
        let facts = qualification.runtime_facts();
        if subject.repository != deployment.repository()
            || subject.commit_sha != deployment.commit()
            || subject.tree_sha != deployment.tree()
            || subject.binary_hash != *native.executable_hash()
            || subject.configuration_hash != configuration_hash
            || subject.service_identity_hash != *deployment.identity_hash()
            || qualification_subject.repository != subject.repository
            || qualification_subject.commit != subject.commit_sha
            || qualification_subject.tree != subject.tree_sha
            || facts.host_identity_hash != subject.host_identity_hash.as_str()
            || facts.service_identity_hash != subject.service_identity_hash.as_str()
            || cutover.initial_writer_lease_hash() != &epoch_hash
            || cutover.cutover_id() != state.cutover_id
            || state.activation_receipt_hash.as_deref()
                != Some(cutover.authorization_hash().as_str())
        {
            return Err(reject());
        }
        let preimage_hash = original_preimage_hash(prepared, guard, preimage)?;
        if &preimage_hash != cutover.database_preimage_hash()
            || facts.database_identity_hash != preimage_hash.as_str()
        {
            return Err(reject());
        }
        // Verify that every digest-bearing field used above comes from actual
        // complete evidence; none of the optional diagnostic values is a grant.
        digest(text(
            prepared.fence_binding.value(),
            "backupAuthorityConfigurationHash",
        )?)?;
        let result = Self {
            qualification,
            cutover,
            configuration_hash,
            epoch_hash,
        };
        result.assert_valid_at(CompositionClock(prepared.checked_at).now_millis()?)?;
        Ok(result)
    }
    pub(super) fn assert_valid_at(&self, now: i64) -> Result<()> {
        let now = u64::try_from(now).map_err(|_| reject())?;
        self.qualification
            .assert_current(now)
            .map_err(|e| error(e.to_string()))?;
        self.cutover
            .assert_current(now)
            .map_err(|e| error(e.to_string()))?;
        if self.cutover.subject().configuration_hash != self.configuration_hash
            || self.cutover.initial_writer_lease_hash() != &self.epoch_hash
        {
            return Err(reject());
        }
        Ok(())
    }
}

/// Only original held files are read; safe under the cutover journal lock.
pub(super) fn original_preimage_hash(
    prepared: &NativeAdmissionInputsV1<'_>,
    guard: &crate::state_database_inventory::NativeStoreTransactionInventoryGuardV1<'_>,
    preimage: &WriterDatabasePreimageV1,
) -> Result<Sha256Digest> {
    guard.assert_bound_to(prepared.startup.post_inventory())?;
    guard.assert_original_target_current_v1()?;
    if preimage.content_hash.as_ref().map(Sha256Digest::as_str)
        != guard.instance()["sourceSha256"].as_str()
        || preimage.byte_count
            != guard.instance()["sourceFileIdentity"]["bytes"]
                .as_str()
                .and_then(|v| v.parse::<u64>().ok())
    {
        return Err(reject());
    }
    let preimage_hash =
        writer_database_preimage_hash_v1(preimage).map_err(|e| error(e.to_string()))?;
    if preimage.state != WriterDatabaseStateV1::Existing {
        return Err(reject());
    }
    Ok(preimage_hash)
}
