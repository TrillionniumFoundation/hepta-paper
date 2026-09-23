//! Initial owning composition of actual online proof producers. This stage is
//! sealed inside the crate: Node writer provenance is not native authorization,
//! and construction never exposes a business mutation or an inner coordinator.
use super::{BuiltinOnlineMutationPlansV1, coordinator_database_instances};
use crate::{
    automation_runtime_reconciliation::RECONCILIATION_WRITER_SCOPE_V1,
    node_package_deletion_writer::PackageDeletionWriterGuard,
    online_authority_evidence_cache::verified::{
        VerifiedAuthorityCacheWriteV1, record_verified_authority_evidence_cache_v1,
    },
    online_authority_inspection::{
        OnlineAuthorityInspectionInputV1, VerifiedOnlineAuthorityInspectionV1,
        inspect_active_online_authority_v1,
    },
    online_runtime_activation::{
        active_refresh::{VerifiedActiveAuthorityEvidenceV1, refresh_online_authority_evidence_v1},
        finalized_inventory::{
            VerifiedFinalizedInventoryV1, inspect_online_finalized_inventory_v1,
        },
        startup_inventory::{
            VerifiedStartupReconciliationSetV1, reconcile_online_mutation_startup_set_v1,
        },
    },
    online_writer_static::{
        VerifiedWriterStaticCoverageV1, verify_online_writer_static_coverage_v1,
    },
    sqlite_mutation_coordinator::{
        Result, SqliteMutationCoordinatorOptionsV1, SqliteMutationCoordinatorV1,
        authority::{PinnedMutationAuthorityV1, ProcessMutationAuthorityTransportV1},
        clock::{MutationClockV1, SystemMutationClockV1},
        error,
    },
    state_backup_authority::{
        PinnedStateBackupAuthorityV1, ProcessStateBackupAuthorityTransportV1,
    },
    state_database_inventory::{
        ObservedStateDatabaseInventoryV1, observe_state_database_inventory_v1,
    },
    state_recoverability::{
        cli::ManifestFile,
        controller::{
            RecoverabilityPolicyV1, SharedRecoverabilityEpochFenceV1,
            StateRecoverabilityControllerV1, VerifiedRecoverabilityActivationBindingV1,
        },
        resident::ResidentLeaseV1,
        service::{BackupRecoveryServiceOptionsV1, BackupRecoveryServiceV1},
    },
    state_safety::evaluate_state_safety_readiness_v1,
};
use serde_json::{Value, json};
use std::{cell::Cell, fs, path::PathBuf};

mod admission;
mod admission_hashes;
mod execution;
mod native_process;
mod schema;
mod signing_preview;
mod temporal;
mod transaction;
mod transfer;
use schema::{PreparedSchemaInputV1, RetainedSchemaEvidenceV1};
#[cfg(test)]
mod tests;

type Online = PinnedMutationAuthorityV1<ProcessMutationAuthorityTransportV1>;
type Fence = SharedRecoverabilityEpochFenceV1<
    ProcessStateBackupAuthorityTransportV1,
    ProcessMutationAuthorityTransportV1,
>;
const NATIVE_BINDING_REQUIRED: &str =
    "autonomous_research_online_native_provenance_binding_required";

pub(crate) struct InitialOnlineMutationCompositionRequestV1 {
    pub workspace_root: PathBuf,
    pub runtime_root: PathBuf,
    pub backup_root: PathBuf,
    pub online_process_configuration_path: PathBuf,
    pub online_process_configuration_file_hash: String,
    pub backup_process_configuration_path: PathBuf,
    pub backup_process_configuration_file_hash: String,
    pub resident_owner_id: String,
    pub resident_lease_token: String,
    pub resident_lease_generation: i64,
    pub schema_checkpoint_root: Option<PathBuf>,
}

/// Private fields retain actual verification producers, not only their JSON
/// reports. In particular the same shared concrete fence is attached to the
/// coordinator and retained with its origin-bound activation proof.
pub(crate) struct PreparedInitialOnlineMutationCompositionV1 {
    report: Value,
    workspace_root: PathBuf,
    backup_root: PathBuf,
    manifest: ManifestFile,
    initial_inventory: ObservedStateDatabaseInventoryV1,
    startup: VerifiedStartupReconciliationSetV1,
    schema: RetainedSchemaEvidenceV1,
    source: VerifiedWriterStaticCoverageV1,
    active: VerifiedActiveAuthorityEvidenceV1,
    finalized: VerifiedFinalizedInventoryV1,
    inspection: VerifiedOnlineAuthorityInspectionV1,
    cache: VerifiedAuthorityCacheWriteV1,
    fence: Fence,
    fence_binding: VerifiedRecoverabilityActivationBindingV1,
    verifier: Online,
    coordinator: SqliteMutationCoordinatorV1<ProcessMutationAuthorityTransportV1>,
    checked_at: Cell<i64>,
    // Package lock remains held until the prepared object is dropped. This
    // filesystem exclusion is neither a cutover fence nor write authorization.
    package: PackageDeletionWriterGuard,
}
fn fail(suffix: &str) -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error(format!(
        "autonomous_research_online_initial_composition_{suffix}"
    ))
}
fn validate_request(request: &InitialOnlineMutationCompositionRequestV1) -> Result<()> {
    let roots = [
        &request.workspace_root,
        &request.runtime_root,
        &request.backup_root,
    ];
    for root in roots {
        if !root.is_absolute()
            || fs::canonicalize(root).ok().as_ref() != Some(root)
            || !fs::symlink_metadata(root).is_ok_and(|m| m.is_dir() && !m.is_symlink())
        {
            return Err(fail("canonical_roots_required"));
        }
    }
    // Backups may use the incumbent runtime's default backup subtree. The
    // immutable source checkout must never also be a mutable runtime/backup.
    if request.workspace_root.starts_with(&request.runtime_root)
        || request.runtime_root.starts_with(&request.workspace_root)
        || request.workspace_root.starts_with(&request.backup_root)
        || request.backup_root.starts_with(&request.workspace_root)
        || request.runtime_root.starts_with(&request.backup_root)
    {
        return Err(fail("roots_overlap"));
    }
    Ok(())
}
fn load_online(request: &InitialOnlineMutationCompositionRequestV1) -> Result<Online> {
    Online::load_process(
        &request.online_process_configuration_path,
        &request.online_process_configuration_file_hash,
    )
}

pub(crate) fn prepare_initial_online_mutation_composition_v1(
    request: &InitialOnlineMutationCompositionRequestV1,
) -> Result<PreparedInitialOnlineMutationCompositionV1> {
    validate_request(request)?;
    let package =
        PackageDeletionWriterGuard::acquire(&request.runtime_root, RECONCILIATION_WRITER_SCOPE_V1)
            .map_err(|e| error(e.to_string()))?;
    construct(request, package)
}

fn construct(
    request: &InitialOnlineMutationCompositionRequestV1,
    package: PackageDeletionWriterGuard,
) -> Result<PreparedInitialOnlineMutationCompositionV1> {
    package.assert_current().map_err(|e| error(e.to_string()))?;
    let manifest = ManifestFile::load(
        &request
            .workspace_root
            .join("paper-core/config/autonomous-research-state-databases.v1.json"),
    )?;
    let builtin = BuiltinOnlineMutationPlansV1::load()?;
    let mut authority = load_online(request)?;
    let verifier = load_online(request)?;
    let recovery_online = load_online(request)?;
    let backup = PinnedStateBackupAuthorityV1::load_process(
        &request.backup_process_configuration_path,
        &request.backup_process_configuration_file_hash,
    )?;
    authority.assert_process_current_v1()?;
    verifier.assert_process_current_v1()?;
    recovery_online.assert_process_current_v1()?;
    backup.assert_process_current_v1()?;
    let initial_inventory =
        observe_state_database_inventory_v1(&request.runtime_root, &manifest.value)?;
    let checked_at = Cell::new(i64::MIN);
    let mut clock = CompositionClock(&checked_at);
    let schema = PreparedSchemaInputV1::load(
        request,
        &initial_inventory,
        builtin.writer_manifest(),
        &mut authority,
        &mut clock,
    )?;
    let startup = reconcile_online_mutation_startup_set_v1(
        &initial_inventory,
        builtin.writer_manifest(),
        &mut authority,
        &mut clock,
    )?;
    let inventory = startup.post_inventory();
    schema.assert_post_startup(&initial_inventory, inventory, &authority, &mut clock)?;
    let service = BackupRecoveryServiceV1::new(
        backup,
        recovery_online,
        BackupRecoveryServiceOptionsV1 {
            runtime_root: request.runtime_root.clone(),
            backup_root: request.backup_root.clone(),
            state_database_manifest: manifest.value.clone(),
            writer_manifest: builtin.writer_manifest().clone(),
        },
    )?;
    let resident = ResidentLeaseV1::new(
        &request.runtime_root,
        &request.resident_owner_id,
        &request.resident_lease_token,
        request.resident_lease_generation,
    )?;
    let controller = StateRecoverabilityControllerV1::new(
        service,
        resident,
        Box::new(SystemMutationClockV1),
        RecoverabilityPolicyV1::default(),
    )?;
    let fence = Fence::new(controller);
    // Renewal can change the head, so it always precedes the fresh active chain.
    fence.reconcile_with_validity(0)?;
    let fence_binding = fence.observe_activation_binding_v1(inventory, &authority)?;
    let source = verify_online_writer_static_coverage_v1(
        &request.workspace_root,
        builtin.writer_manifest(),
    )?;
    let active = refresh_online_authority_evidence_v1(
        inventory.value(),
        builtin.writer_manifest(),
        &mut authority,
        &source,
        &mut clock,
        3,
    )?;
    let finalized = inspect_online_finalized_inventory_v1(
        inventory,
        builtin.writer_manifest(),
        &mut authority,
        &source,
        &active,
        &mut clock,
    )?;
    let schema = schema.finish(
        inventory,
        &source,
        &active,
        &finalized,
        &mut authority,
        &mut clock,
    )?;
    let head = &active.value()["authorityEvidence"]["currentHead"]["receipt"];
    if head["globalSequence"] != fence_binding.value()["globalSequence"]
        || head["globalHash"] != fence_binding.value()["globalHash"]
    {
        return Err(fail("recoverability_active_head_mismatch"));
    }
    fence.assert_activation_binding_current_v1(&fence_binding, inventory, &authority)?;
    startup.assert_current(&initial_inventory, &authority, &mut clock)?;
    schema.assert_current(
        inventory, &source, &active, &finalized, &authority, &mut clock,
    )?;
    manifest.assert_current()?;
    package.assert_current().map_err(|e| error(e.to_string()))?;
    authority.assert_process_current_v1()?;
    // All external proof production precedes the actual coordinator. No generic
    // fence, caller clock, arbitrary manifest or writable connection is accepted.
    let coordinator = SqliteMutationCoordinatorV1::new(
        authority,
        SqliteMutationCoordinatorOptionsV1 {
            manifest: builtin.writer_manifest().clone(),
            operation_plans: builtin.operation_plans().clone(),
            database_instances: coordinator_database_instances(inventory)?,
            requested_lease_ms: None,
            commit_safety_margin_ms: 1000,
        },
        Box::new(SystemMutationClockV1),
        Some(Box::new(fence.clone())),
    )?;
    let status = coordinator.inspect_status();
    let inspection = inspect_active_online_authority_v1(
        OnlineAuthorityInspectionInputV1 {
            authority: &verifier,
            inventory,
            source: &source,
            manifest: builtin.writer_manifest(),
            coordinator: &status,
        },
        &active,
        &mut clock,
    )?;
    let safety = evaluate_state_safety_readiness_v1(
        inventory.value(),
        fence_binding.restore_source_inspection(),
        Some(inspection.value()),
        clock.now_millis()?,
    )?;
    let cache = record_verified_authority_evidence_cache_v1(
        &request.runtime_root,
        &verifier,
        &active,
        inventory,
        &source,
        &mut clock,
    )?;
    let report = json!({"version":1,"kind":"PreparedInitialOnlineMutationComposition",
        "status":"online_initial_evidence_prepared_native_authorization_required",
        "inventoryHash":inventory.value()["inventoryHash"],"schemaReadiness":schema.value(),
        "schemaEvidenceMode":schema.mode(),
        "startupReconciliation":startup.value(),"recoverabilityBinding":fence_binding.value(),
        "activeRefresh":active.value(),"finalizedInventory":finalized.value(),
        "authorityCache":cache.value(),"onlineInspection":inspection.value(),"stateSafety":safety,
        "coordinator":status,"runtimeReady":false,"productionActivation":false,"nodeRetirementVerified":false,
        "remainingBlockers":[NATIVE_BINDING_REQUIRED,"autonomous_research_online_retained_transaction_scope_required", "autonomous_research_online_cutover_inventory_binding_required"]});
    let result = PreparedInitialOnlineMutationCompositionV1 {
        report,
        workspace_root: request.workspace_root.clone(),
        backup_root: request.backup_root.clone(),
        manifest,
        initial_inventory,
        startup,
        schema,
        source,
        active,
        finalized,
        inspection,
        cache,
        fence,
        fence_binding,
        verifier,
        coordinator,
        checked_at,
        package,
    };
    result.assert_current()?;
    Ok(result)
}
impl PreparedInitialOnlineMutationCompositionV1 {
    pub(crate) fn value(&self) -> &Value {
        &self.report
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        let mut clock = CompositionClock(&self.checked_at);
        let inventory = self.startup.post_inventory();
        self.package
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        self.manifest.assert_current()?;
        self.verifier.assert_process_current_v1()?;
        // Startup retains and checks its real post-write inventory. Its original
        // input remains the immutable subject binding, not a current byte claim.
        self.startup
            .assert_current(&self.initial_inventory, &self.verifier, &mut clock)?;
        self.schema.assert_current(
            inventory,
            &self.source,
            &self.active,
            &self.finalized,
            &self.verifier,
            &mut clock,
        )?;
        self.source.assert_current()?;
        self.finalized.assert_current(
            inventory,
            &self.verifier,
            &self.source,
            &self.active,
            &mut clock,
        )?;
        self.inspection
            .assert_current(&self.verifier, inventory, &self.source, &mut clock)?;
        self.cache.assert_current(
            &self.verifier,
            &self.active,
            inventory,
            &self.source,
            &mut clock,
        )?;
        self.fence.assert_activation_binding_current_v1(
            &self.fence_binding,
            inventory,
            &self.verifier,
        )?;
        self.coordinator.assert_configuration_current()?;
        self.package
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        // One shared final sample follows every I/O check. Earlier receipts
        // must still be live after later, potentially expensive checks finish.
        self.assert_valid_at(clock.now_millis()?)
    }
}

/// The composition owns its clock. Callers cannot inject side effects between
/// the final sample and the memory-only validity checks.
struct CompositionClock<'a>(&'a Cell<i64>);
impl MutationClockV1 for CompositionClock<'_> {
    fn now_millis(&mut self) -> Result<i64> {
        let now = SystemMutationClockV1.now_millis()?;
        if now < self.0.get() {
            return Err(fail("clock_invalid"));
        }
        self.0.set(now);
        Ok(now)
    }
}
