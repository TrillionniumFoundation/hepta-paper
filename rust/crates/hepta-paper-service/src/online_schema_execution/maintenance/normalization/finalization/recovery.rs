//! V1 finalization request/receipt recovery through the existing normalization
//! journal and root maintenance owner. No second journal, writer or activation.
//! A caller retains the request hash independently before dispatch; recovery
//! cannot create a missing intent, choose another timestamp or repeat SQL work.
use super::super::installation::{
    FinalizationHandoff, InstalledSchemaMaintenanceV1, verify_finalization_post_state,
};
use super::*;
use crate::{
    online_schema_execution::plan::installation_support::{
        validate_installation_inventory, validate_installation_journal,
    },
    sqlite_mutation_coordinator::clock::{MutationClockV1, iso},
    state_database_inventory::schema_source::maintenance_lock::SchemaMaintenanceLock,
    state_recoverability::schema_normalization_repository::NormalizationRepository,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinalizationProgress {
    version: u16,
    request: Value,
    request_hash: String,
    // Only a verified receipt may fill this slot. Null is durable uncertainty,
    // not proof that the authority did not finalize the selected request.
    receipt: Option<Value>,
}
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_online_schema_transition_finalization_progress_invalid")
}
fn request_hash(request: &Value) -> Result<String> {
    hash(
        "AutonomousResearchOnlineSchemaTransitionFinalizeRequest",
        request,
    )
}
fn progress(journal: &Value) -> Result<FinalizationProgress> {
    ensure(
        crate::sqlite_mutation_coordinator::keys(
            &journal["finalizationProgress"],
            &["version", "request", "requestHash", "receipt"],
        ),
        &invalid().code,
    )?;
    let value: FinalizationProgress =
        serde_json::from_value(journal["finalizationProgress"].clone()).map_err(|_| invalid())?;
    ensure(
        value.version == 1 && value.request_hash == request_hash(&value.request)?,
        &invalid().code,
    )?;
    Ok(value)
}

/// Held source observation and the original exclusive root owner. Neither JSON
/// nor a caller-ready boolean can construct a prepared finalization operation.
///
/// ```compile_fail
/// use hepta_paper_service::online_schema_execution::maintenance::normalization::finalization::recovery::PreparedSchemaFinalizationV1;
/// let value: PreparedSchemaFinalizationV1 = serde_json::from_str("{}").unwrap();
/// ```
pub struct PreparedSchemaFinalizationV1 {
    progress: FinalizationProgress,
    owner: FinalizationHandoff,
}
impl PreparedSchemaFinalizationV1 {
    pub fn request_hash(&self) -> &str {
        &self.progress.request_hash
    }
    pub fn request(&self) -> &Value {
        &self.progress.request
    }
    pub fn journal_hash(&self) -> &str {
        &self.owner.journal_hash
    }
    fn guard<T: MutationAuthorityTransportV1>(
        &self,
        authority: &PinnedMutationAuthorityV1<T>,
    ) -> Result<()> {
        self.owner.lock.assert_current()?;
        self.owner.post_state.assert_current(
            &self.owner.journal["plan"],
            Some(&self.owner.journal["installations"]),
        )?;
        ensure(
            self.owner.journal["authorityConfigurationHash"] == authority.configuration_hash(),
            "autonomous_research_online_schema_transition_authority_configuration_mismatch",
        )?;
        authority.verify_historical_schema_transition_reservation(
            &self.owner.journal["reservation"],
            &self.owner.journal["request"],
        )?;
        let expected = build_schema_transition_finalize_request_v1(
            &self.owner.journal["plan"],
            &self.owner.reservation,
            &self.owner.journal["installations"],
            text_field(self.owner.post_state.inventory(), "inventoryHash")?,
            self.owner.post_state.pristine_runtime_state_hash(),
            text_field(&self.progress.request, "completedAt")?,
        )?;
        ensure(
            expected == self.progress.request
                && request_hash(&expected)? == self.progress.request_hash,
            "autonomous_research_online_schema_transition_finalization_request_changed",
        )?;
        let current = NormalizationRepository::open(&self.owner.lock, false)?
            .load()?
            .ok_or_else(invalid)?;
        ensure(
            current.0 == self.owner.journal && current.1 == self.owner.journal_hash,
            "autonomous_research_online_schema_transition_finalization_journal_changed",
        )
    }
    fn save(&mut self) -> Result<()> {
        self.owner.journal["finalizationProgress"] =
            serde_json::to_value(&self.progress).map_err(|_| invalid())?;
        self.owner.journal_hash = NormalizationRepository::open(&self.owner.lock, false)?
            .publish(&self.owner.journal, Some(&self.owner.journal_hash))?;
        Ok(())
    }
    fn clock(&self, clock: &mut dyn MutationClockV1) -> Result<i64> {
        let now = clock.now_millis()?;
        ensure(
            now >= int(&self.owner.journal, "checkedAtMillis")?,
            "autonomous_research_online_schema_transition_clock_regressed",
        )?;
        Ok(now)
    }
}

/// Transfer the actual completed installation's root owner, validate all business
/// rows from the original signed preimages, then publish one immutable request.
/// This performs no RPC. The caller must retain `request_hash()` independently
/// before calling `finalize_prepared_schema_transition_v1`.
pub fn prepare_schema_transition_finalization_v1<T: MutationAuthorityTransportV1>(
    installed: InstalledSchemaMaintenanceV1,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
) -> Result<PreparedSchemaFinalizationV1> {
    let mut owner = installed.into_finalization(authority, clock)?;
    ensure(
        owner.journal.get("finalizationProgress").is_none(),
        "autonomous_research_online_schema_transition_finalization_recovery_required",
    )?;
    let before = clock.now_millis()?;
    ensure(
        before >= int(&owner.journal, "checkedAtMillis")?,
        "autonomous_research_online_schema_transition_clock_regressed",
    )?;
    owner.reservation = authority.verify_schema_transition_reservation(
        &owner.journal["reservation"],
        &owner.journal["request"],
        before,
    )?;
    owner.post_state.assert_current(
        &owner.journal["plan"],
        Some(&owner.journal["installations"]),
    )?;
    let now = clock.now_millis()?;
    ensure(
        now >= before
            && timestamp(&owner.reservation.value()["expiresAt"])
                .is_some_and(|expires| now < expires),
        "autonomous_research_online_schema_transition_finalization_lease_expired",
    )?;
    let request = build_schema_transition_finalize_request_v1(
        &owner.journal["plan"],
        &owner.reservation,
        &owner.journal["installations"],
        text_field(owner.post_state.inventory(), "inventoryHash")?,
        owner.post_state.pristine_runtime_state_hash(),
        &iso(now)?,
    )?;
    crate::sqlite_mutation_coordinator::contracts::schema_transition::assert_schema_transition_finalize_request_v1(
        &request, owner.reservation.value())?;
    let progress = FinalizationProgress {
        version: 1,
        request_hash: request_hash(&request)?,
        request,
        receipt: None,
    };
    owner.journal["checkedAtMillis"] = json!(now);
    let mut prepared = PreparedSchemaFinalizationV1 { progress, owner };
    prepared.save()?;
    prepared.guard(authority)?;
    Ok(prepared)
}

pub trait SchemaFinalizationCheckpointV1 {
    fn checkpoint(&mut self, point: &str) -> Result<()>;
}
pub struct NoSchemaFinalizationCheckpointV1;
impl SchemaFinalizationCheckpointV1 for NoSchemaFinalizationCheckpointV1 {
    fn checkpoint(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
}

/// An uncertain reply retries only the independently selected original finalize
/// request. The existing protocol is idempotent at the authority, including after
/// expiry when it already stored a receipt; this caller never renews the lease.
/// A recorded receipt is reverified historically without any RPC or clock demand.
/// Neither path yields an active capability, FINAL.json or a v2 restart proof.
pub fn finalize_prepared_schema_transition_v1<T: MutationAuthorityTransportV1>(
    prepared: &mut PreparedSchemaFinalizationV1,
    authority: &mut PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
    checkpoint: &mut dyn SchemaFinalizationCheckpointV1,
) -> Result<SchemaTransitionFinalizationResult> {
    prepared.guard(authority)?;
    if let Some(receipt) = &prepared.progress.receipt {
        let finalization = authority.verify_historical_schema_transition_finalization(
            receipt,
            &prepared.progress.request,
            &prepared.owner.reservation,
        )?;
        prepared.guard(authority)?;
        return Ok(SchemaTransitionFinalizationResult {
            finalize_request: prepared.progress.request.clone(),
            finalization,
        });
    }
    checkpoint.checkpoint("before_finalization_rpc")?;
    prepared.guard(authority)?;
    let now = prepared.clock(clock)?;
    prepared.owner.journal["checkedAtMillis"] = json!(now);
    prepared.save()?;
    prepared.guard(authority)?;
    let invoke_at = prepared.clock(clock)?;
    let finalization = authority.finalize_schema_transition(
        &prepared.progress.request,
        &prepared.owner.reservation,
        invoke_at,
    )?;
    checkpoint.checkpoint("after_finalization_rpc_before_publication")?;
    prepared.guard(authority)?;
    let after = prepared.clock(clock)?;
    ensure(
        after >= invoke_at,
        "autonomous_research_online_schema_transition_clock_regressed",
    )?;
    prepared.progress.receipt = Some(finalization.value().clone());
    prepared.owner.journal["checkedAtMillis"] = json!(after);
    prepared.save()?;
    checkpoint.checkpoint("after_finalization_receipt_publication")?;
    prepared.guard(authority)?;
    Ok(SchemaTransitionFinalizationResult {
        finalize_request: prepared.progress.request.clone(),
        finalization,
    })
}

pub struct ResumeSchemaFinalizationOptionsV1<'a> {
    pub runtime_root: &'a Path,
    pub state_database_manifest: &'a Value,
    pub writer_manifest: &'a Value,
    pub expected_transition_id: &'a str,
    pub expected_plan_hash: &'a str,
    /// Retained outside the progress being recovered, never inferred from it.
    pub expected_request_hash: &'a str,
}

/// Read-only reconstruction of the selected completed installation and durable
/// request. Missing intent, changed post-state, configuration or independent pin
/// fails closed. Expected state is replayed only in private memory copies;
/// no live database writes, new reservation, replacement intent or RPC occurs.
pub fn resume_schema_transition_finalization_v1<T: MutationAuthorityTransportV1>(
    options: ResumeSchemaFinalizationOptionsV1<'_>,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<PreparedSchemaFinalizationV1> {
    for pin in [
        options.expected_transition_id,
        options.expected_plan_hash,
        options.expected_request_hash,
    ] {
        ensure(
            crate::sqlite_mutation_coordinator::sha(&json!(pin)),
            "autonomous_research_online_schema_transition_finalization_pin_invalid",
        )?;
    }
    let inventory =
        observe_state_database_inventory_v1(options.runtime_root, options.state_database_manifest)?;
    let row = inventory.value()["instances"]
        .as_array()
        .and_then(|rows| rows.first())
        .ok_or_else(invalid)?;
    let source = SchemaSource::observe(
        options.runtime_root,
        Path::new(text_field(row, "sourceRelativePath")?),
        text_field(row, "role")?,
    )?;
    let lock = SchemaMaintenanceLock::acquire(&source)?;
    let (journal, journal_hash) = NormalizationRepository::open(&lock, false)?
        .load()?
        .ok_or_else(invalid)?;
    ensure(
        journal["version"].as_f64() == Some(1.)
            && journal["kind"] == "NativeSchemaJournalNormalizationProgress"
            && journal["runtimeRootIdentity"] == *lock.identity()
            && journal["plan"]["transitionId"] == options.expected_transition_id
            && journal["plan"]["planHash"] == options.expected_plan_hash,
        &invalid().code,
    )?;
    ensure(
        journal["plan"]["version"] == 1,
        "autonomous_research_pristine_schema_rebind_target_configuration_restart_required",
    )?;
    let progress = progress(&journal)?;
    ensure(
        progress.request_hash == options.expected_request_hash,
        "autonomous_research_online_schema_transition_finalization_request_changed",
    )?;
    validate_installation_journal(
        &journal,
        options.state_database_manifest,
        options.writer_manifest,
        authority,
    )?;
    validate_installation_inventory(
        inventory.value(),
        options.state_database_manifest,
        &journal["plan"],
    )?;
    let reservation = authority.verify_historical_schema_transition_reservation(
        &journal["reservation"],
        &journal["request"],
    )?;
    let post_state = observe_schema_transition_post_state_v1(
        options.runtime_root,
        options.state_database_manifest,
        &journal["plan"],
        &journal["installations"],
        None,
    )?;
    verify_finalization_post_state(&lock, &journal, &reservation, post_state.held_inventory())?;
    let prepared = PreparedSchemaFinalizationV1 {
        progress,
        owner: FinalizationHandoff {
            journal,
            journal_hash,
            reservation,
            post_state,
            lock,
        },
    };
    prepared.guard(authority)?;
    if let Some(receipt) = &prepared.progress.receipt {
        authority.verify_historical_schema_transition_finalization(
            receipt,
            &prepared.progress.request,
            &prepared.owner.reservation,
        )?;
    }
    Ok(prepared)
}
