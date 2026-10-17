//! V1 finalization request/receipt recovery through the existing normalization
//! journal and root maintenance owner. No second journal, writer or activation.
//! A caller retains the request independently before dispatch. Public hash-only
//! recovery cannot create missing intent; installed recovery can reconstitute
//! only its separately retained original request, without a new time or SQL work.
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

pub mod restart;

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
    prepare_schema_transition_finalization_with_selection_v1(
        installed,
        authority,
        clock,
        &mut |_, _, _| Ok(()),
    )
}

/// Installed composition records this exact validated request in its independent
/// root intent before publishing kernel progress. Failure keeps the original
/// installation owner and produces no RPC or new reservation.
pub(crate) fn prepare_schema_transition_finalization_with_selection_v1<
    T: MutationAuthorityTransportV1,
>(
    installed: InstalledSchemaMaintenanceV1,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
    select: &mut dyn FnMut(&Value, &str, i64) -> Result<()>,
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
    select(prepared.request(), prepared.request_hash(), now)?;
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
    resume_finalization_impl(options, authority, None)
}

/// Reconstitute only an exact request already retained outside kernel progress.
/// The completed SQL post-state and signed reservation are reverified; this
/// never substitutes a new completion time or renews an expired lease.
pub(crate) fn resume_schema_transition_finalization_from_selected_request_v1<
    T: MutationAuthorityTransportV1,
>(
    options: ResumeSchemaFinalizationOptionsV1<'_>,
    selected_request: &Value,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<PreparedSchemaFinalizationV1> {
    resume_finalization_impl(options, authority, Some(selected_request))
}
fn resume_finalization_impl<T: MutationAuthorityTransportV1>(
    options: ResumeSchemaFinalizationOptionsV1<'_>,
    authority: &PinnedMutationAuthorityV1<T>,
    selected_request: Option<&Value>,
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
        [json!(1), json!(2)].contains(&journal["plan"]["version"]),
        "autonomous_research_online_schema_transition_finalization_progress_invalid",
    )?;
    let missing = journal.get("finalizationProgress").is_none();
    let progress = if missing {
        let request = selected_request.ok_or_else(invalid)?;
        FinalizationProgress {
            version: 1,
            request: request.clone(),
            request_hash: request_hash(request)?,
            receipt: None,
        }
    } else {
        progress(&journal)?
    };
    if let Some(selected) = selected_request {
        ensure(
            *selected == progress.request,
            "autonomous_research_online_schema_transition_finalization_request_changed",
        )?;
    }
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
    if missing {
        crate::sqlite_mutation_coordinator::contracts::schema_transition::assert_schema_transition_finalize_request_v1(&progress.request,reservation.value())?;
        let completed = timestamp(&progress.request["completedAt"]).ok_or_else(invalid)?;
        ensure(
            completed >= int(&journal, "checkedAtMillis")?
                && completed >= timestamp(&reservation.value()["issuedAt"]).ok_or_else(invalid)?
                && completed < timestamp(&reservation.value()["expiresAt"]).ok_or_else(invalid)?,
            &invalid().code,
        )?;
    }
    let mut prepared = PreparedSchemaFinalizationV1 {
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
    if missing {
        prepared.owner.journal["checkedAtMillis"] =
            json!(timestamp(&prepared.progress.request["completedAt"]).ok_or_else(invalid)?);
        prepared.save()?;
        prepared.guard(authority)?;
    }
    if let Some(receipt) = &prepared.progress.receipt {
        authority.verify_historical_schema_transition_finalization(
            receipt,
            &prepared.progress.request,
            &prepared.owner.reservation,
        )?;
    }
    Ok(prepared)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObservationProgress {
    version: u16,
    request: Value,
    request_hash: String,
    // A missing receipt is durable ambiguity, never proof that observation did
    // not happen. Recovery may retry only this exact request.
    receipt: Option<Value>,
}
fn observation_invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_online_schema_transition_observation_progress_invalid")
}
fn observation_request_hash(request: &Value) -> Result<String> {
    hash(
        "AutonomousResearchOnlineSchemaTransitionObserveRequest",
        request,
    )
}
fn observation_progress(journal: &Value) -> Result<ObservationProgress> {
    ensure(
        crate::sqlite_mutation_coordinator::keys(
            &journal["observationProgress"],
            &["version", "request", "requestHash", "receipt"],
        ),
        &observation_invalid().code,
    )?;
    let value: ObservationProgress = serde_json::from_value(journal["observationProgress"].clone())
        .map_err(|_| observation_invalid())?;
    ensure(
        value.version == 1 && value.request_hash == observation_request_hash(&value.request)?,
        &observation_invalid().code,
    )?;
    Ok(value)
}
fn random_observation_nonce() -> Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| {
        error("autonomous_research_online_schema_transition_observation_randomness_unavailable")
    })?;
    Ok(format!(
        "schema-transition-observation:{}",
        hex::encode(bytes)
    ))
}

/// Durable v1 observation intent under the same root owner and normalization
/// journal as installation/finalization. JSON cannot construct this capability.
///
/// ```compile_fail
/// use hepta_paper_service::online_schema_execution::maintenance::normalization::finalization::recovery::PreparedSchemaObservationV1;
/// let value: PreparedSchemaObservationV1 = serde_json::from_str("{}").unwrap();
/// ```
pub struct PreparedSchemaObservationV1 {
    progress: ObservationProgress,
    finalization: VerifiedMutationReceiptV1,
    owner: FinalizationHandoff,
}
impl PreparedSchemaObservationV1 {
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
            self.owner.journal["plan"]["version"] == 1,
            "autonomous_research_pristine_schema_rebind_target_configuration_restart_required",
        )?;
        ensure(
            self.owner.journal["authorityConfigurationHash"] == authority.configuration_hash(),
            "autonomous_research_online_schema_transition_authority_configuration_mismatch",
        )?;
        authority.verify_historical_schema_transition_reservation(
            &self.owner.journal["reservation"],
            &self.owner.journal["request"],
        )?;
        let finalization_progress = progress(&self.owner.journal)?;
        let finalization_receipt = finalization_progress.receipt.as_ref().ok_or_else(|| {
            error("autonomous_research_online_schema_transition_finalization_recovery_required")
        })?;
        let verified = authority.verify_historical_schema_transition_finalization(
            finalization_receipt,
            &finalization_progress.request,
            &self.owner.reservation,
        )?;
        ensure(
            verified.value() == self.finalization.value(),
            "autonomous_research_online_schema_transition_observation_finalization_changed",
        )?;
        let expected = build_schema_transition_observe_request_v1(
            &self.owner.journal["plan"],
            &self.finalization,
            text_field(self.owner.post_state.inventory(), "inventoryHash")?,
            self.owner.post_state.pristine_runtime_state_hash(),
            text_field(&self.progress.request, "nonce")?,
            text_field(&self.progress.request, "requestedAt")?,
        )?;
        ensure(
            expected == self.progress.request
                && observation_request_hash(&expected)? == self.progress.request_hash,
            "autonomous_research_online_schema_transition_observation_request_changed",
        )?;
        let current = NormalizationRepository::open(&self.owner.lock, false)?
            .load()?
            .ok_or_else(observation_invalid)?;
        ensure(
            current.0 == self.owner.journal && current.1 == self.owner.journal_hash,
            "autonomous_research_online_schema_transition_observation_journal_changed",
        )
    }
    fn save(&mut self) -> Result<()> {
        self.owner.journal["observationProgress"] =
            serde_json::to_value(&self.progress).map_err(|_| observation_invalid())?;
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

/// Convert a completed, durably recorded v1 finalization into one persisted
/// observation request before any authority RPC. V2 intentionally remains at
/// the target-configuration restart boundary.
pub fn prepare_schema_transition_observation_v1<T: MutationAuthorityTransportV1>(
    finalized: PreparedSchemaFinalizationV1,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
) -> Result<PreparedSchemaObservationV1> {
    prepare_schema_transition_observation_with_selection_v1(
        finalized,
        authority,
        clock,
        &mut |_, _, _| Ok(()),
    )
}
pub(crate) fn prepare_schema_transition_observation_with_selection_v1<
    T: MutationAuthorityTransportV1,
>(
    finalized: PreparedSchemaFinalizationV1,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
    select: &mut dyn FnMut(&Value, &str, i64) -> Result<()>,
) -> Result<PreparedSchemaObservationV1> {
    ensure(
        finalized.owner.journal["plan"]["version"] == 1,
        "autonomous_research_pristine_schema_rebind_target_configuration_restart_required",
    )?;
    ensure(
        finalized.owner.journal.get("observationProgress").is_none(),
        "autonomous_research_online_schema_transition_observation_recovery_required",
    )?;
    finalized.guard(authority)?;
    let finalization_receipt = finalized.progress.receipt.as_ref().ok_or_else(|| {
        error("autonomous_research_online_schema_transition_finalization_recovery_required")
    })?;
    let finalization = authority.verify_historical_schema_transition_finalization(
        finalization_receipt,
        &finalized.progress.request,
        &finalized.owner.reservation,
    )?;
    let now = finalized.clock(clock)?;
    let request = build_schema_transition_observe_request_v1(
        &finalized.owner.journal["plan"],
        &finalization,
        text_field(finalized.owner.post_state.inventory(), "inventoryHash")?,
        finalized.owner.post_state.pristine_runtime_state_hash(),
        &random_observation_nonce()?,
        &iso(now)?,
    )?;
    crate::sqlite_mutation_coordinator::contracts::schema_transition::assert_schema_transition_observe_request_v1(
        &request,
        authority.trust(),
    )?;
    let progress = ObservationProgress {
        version: 1,
        request_hash: observation_request_hash(&request)?,
        request,
        receipt: None,
    };
    let mut prepared = PreparedSchemaObservationV1 {
        progress,
        finalization,
        owner: finalized.owner,
    };
    prepared.owner.journal["checkedAtMillis"] = json!(now);
    select(prepared.request(), prepared.request_hash(), now)?;
    prepared.save()?;
    prepared.guard(authority)?;
    Ok(prepared)
}

pub trait SchemaObservationCheckpointV1 {
    fn checkpoint(&mut self, point: &str) -> Result<()>;
}
pub struct NoSchemaObservationCheckpointV1;
impl SchemaObservationCheckpointV1 for NoSchemaObservationCheckpointV1 {
    fn checkpoint(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
}

/// Retry only the durably selected observation request after an uncertain reply.
/// A recorded receipt is historical evidence and replays without RPC or clock;
/// it is not a fresh readiness observation and grants no activation.
pub fn observe_prepared_schema_transition_v1<T: MutationAuthorityTransportV1>(
    prepared: &mut PreparedSchemaObservationV1,
    authority: &mut PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
    checkpoint: &mut dyn SchemaObservationCheckpointV1,
) -> Result<SchemaTransitionObservationResult> {
    prepared.guard(authority)?;
    if let Some(receipt) = &prepared.progress.receipt {
        let observation = authority
            .verify_historical_schema_transition_observation(receipt, &prepared.progress.request)?;
        prepared.guard(authority)?;
        return Ok(SchemaTransitionObservationResult {
            observe_request: prepared.progress.request.clone(),
            observation,
        });
    }
    checkpoint.checkpoint("before_observation_rpc")?;
    prepared.guard(authority)?;
    let now = prepared.clock(clock)?;
    prepared.owner.journal["checkedAtMillis"] = json!(now);
    prepared.save()?;
    prepared.guard(authority)?;
    let invoke_at = prepared.clock(clock)?;
    let observation = authority.observe_schema_transition(&prepared.progress.request, invoke_at)?;
    checkpoint.checkpoint("after_observation_rpc_before_publication")?;
    prepared.guard(authority)?;
    let after = prepared.clock(clock)?;
    ensure(
        after >= invoke_at,
        "autonomous_research_online_schema_transition_clock_regressed",
    )?;
    prepared.progress.receipt = Some(observation.value().clone());
    prepared.owner.journal["checkedAtMillis"] = json!(after);
    prepared.save()?;
    checkpoint.checkpoint("after_observation_receipt_publication")?;
    prepared.guard(authority)?;
    Ok(SchemaTransitionObservationResult {
        observe_request: prepared.progress.request.clone(),
        observation,
    })
}

pub struct ResumeSchemaObservationOptionsV1<'a> {
    pub runtime_root: &'a Path,
    pub state_database_manifest: &'a Value,
    pub writer_manifest: &'a Value,
    pub expected_transition_id: &'a str,
    pub expected_plan_hash: &'a str,
    /// Retained independently from both durable progress records.
    pub expected_finalization_request_hash: &'a str,
    pub expected_observation_request_hash: &'a str,
}

/// Reopen only an independently selected v1 finalization and observation intent.
/// No intent is synthesized and no RPC, fresh clock or database write occurs.
pub fn resume_schema_transition_observation_v1<T: MutationAuthorityTransportV1>(
    options: ResumeSchemaObservationOptionsV1<'_>,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<PreparedSchemaObservationV1> {
    resume_observation_impl(options, authority, None)
}
pub(crate) fn resume_schema_transition_observation_from_selected_request_v1<
    T: MutationAuthorityTransportV1,
>(
    options: ResumeSchemaObservationOptionsV1<'_>,
    selected_request: &Value,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<PreparedSchemaObservationV1> {
    resume_observation_impl(options, authority, Some(selected_request))
}
fn resume_observation_impl<T: MutationAuthorityTransportV1>(
    options: ResumeSchemaObservationOptionsV1<'_>,
    authority: &PinnedMutationAuthorityV1<T>,
    selected_request: Option<&Value>,
) -> Result<PreparedSchemaObservationV1> {
    ensure(
        crate::sqlite_mutation_coordinator::sha(&json!(options.expected_observation_request_hash)),
        "autonomous_research_online_schema_transition_observation_pin_invalid",
    )?;
    let finalized = resume_schema_transition_finalization_v1(
        ResumeSchemaFinalizationOptionsV1 {
            runtime_root: options.runtime_root,
            state_database_manifest: options.state_database_manifest,
            writer_manifest: options.writer_manifest,
            expected_transition_id: options.expected_transition_id,
            expected_plan_hash: options.expected_plan_hash,
            expected_request_hash: options.expected_finalization_request_hash,
        },
        authority,
    )?;
    ensure(
        finalized.owner.journal["plan"]["version"] == 1,
        "autonomous_research_pristine_schema_rebind_target_configuration_restart_required",
    )?;
    let missing = finalized.owner.journal.get("observationProgress").is_none();
    let progress = if missing {
        let request = selected_request.ok_or_else(observation_invalid)?;
        ObservationProgress {
            version: 1,
            request: request.clone(),
            request_hash: observation_request_hash(request)?,
            receipt: None,
        }
    } else {
        observation_progress(&finalized.owner.journal)?
    };
    if let Some(selected) = selected_request {
        ensure(
            *selected == progress.request,
            "autonomous_research_online_schema_transition_observation_request_changed",
        )?;
    }
    ensure(
        progress.request_hash == options.expected_observation_request_hash,
        "autonomous_research_online_schema_transition_observation_request_changed",
    )?;
    let finalization_receipt = finalized.progress.receipt.as_ref().ok_or_else(|| {
        error("autonomous_research_online_schema_transition_finalization_recovery_required")
    })?;
    let finalization = authority.verify_historical_schema_transition_finalization(
        finalization_receipt,
        &finalized.progress.request,
        &finalized.owner.reservation,
    )?;
    if missing {
        crate::sqlite_mutation_coordinator::contracts::schema_transition::assert_schema_transition_observe_request_v1(&progress.request,authority.trust())?;
        ensure(
            timestamp(&progress.request["requestedAt"]).is_some_and(|now| {
                now >= int(&finalized.owner.journal, "checkedAtMillis").unwrap_or(i64::MAX)
            }),
            &observation_invalid().code,
        )?;
    }
    let mut prepared = PreparedSchemaObservationV1 {
        progress,
        finalization,
        owner: finalized.owner,
    };
    prepared.guard(authority)?;
    if missing {
        prepared.owner.journal["checkedAtMillis"] = json!(
            timestamp(&prepared.progress.request["requestedAt"]).ok_or_else(observation_invalid)?
        );
        prepared.save()?;
        prepared.guard(authority)?;
    }
    if let Some(receipt) = &prepared.progress.receipt {
        authority
            .verify_historical_schema_transition_observation(receipt, &prepared.progress.request)?;
    }
    Ok(prepared)
}

pub struct PublishPreparedSchemaObservationOptionsV1<'a> {
    pub state_database_manifest: &'a Value,
    pub writer_manifest: &'a Value,
    /// Retained outside both progress records; never inferred as authority.
    pub expected_plan_hash: &'a str,
    pub expected_previous_final_receipt_sha256: Option<&'a str>,
}

/// Compose the existing historical audit/publication owner directly from one
/// verified durable observation. No caller supplies reservation/finalization/
/// observation JSON. The maintenance lock is released before the publication
/// owner reacquires it and re-observes all ten databases.
pub fn publish_prepared_schema_transition_observation_v1<T: MutationAuthorityTransportV1>(
    prepared: PreparedSchemaObservationV1,
    authority: &PinnedMutationAuthorityV1<T>,
    options: PublishPreparedSchemaObservationOptionsV1<'_>,
    checkpoint: &mut dyn super::publication::SchemaFinalReceiptCheckpointV1,
) -> Result<super::publication::SchemaFinalReceiptPublicationV1> {
    ensure(
        crate::sqlite_mutation_coordinator::sha(&json!(options.expected_plan_hash)),
        "autonomous_research_online_schema_transition_final_receipt_plan_mismatch",
    )?;
    prepared.guard(authority)?;
    let finalization_progress = progress(&prepared.owner.journal)?;
    let finalization_receipt = finalization_progress.receipt.as_ref().ok_or_else(|| {
        error("autonomous_research_online_schema_transition_finalization_recovery_required")
    })?;
    let observation_receipt = prepared.progress.receipt.as_ref().ok_or_else(|| {
        error("autonomous_research_online_schema_transition_observation_recovery_required")
    })?;
    authority.verify_historical_schema_transition_observation(
        observation_receipt,
        &prepared.progress.request,
    )?;
    let runtime_root = prepared
        .owner
        .post_state
        .held_inventory()
        .runtime_root()
        .to_owned();
    let proof = super::publication::prepare_schema_transition_audit_v1(
        super::publication::SchemaTransitionAuditInputV1 {
            plan: &prepared.owner.journal["plan"],
            expected_plan_hash: options.expected_plan_hash,
            state_database_manifest: options.state_database_manifest,
            writer_manifest: options.writer_manifest,
            reserve_request: &prepared.owner.journal["request"],
            reservation: &prepared.owner.journal["reservation"],
            finalize_request: &finalization_progress.request,
            finalization: finalization_receipt,
            observe_request: &prepared.progress.request,
            observation: observation_receipt,
            installations: &prepared.owner.journal["installations"],
        },
        prepared.owner.post_state.held_inventory(),
        authority,
    )?;
    prepared.guard(authority)?;
    drop(prepared);
    let inventory =
        observe_state_database_inventory_v1(&runtime_root, options.state_database_manifest)?;
    let result = super::publication::publish_schema_transition_final_receipt_v1(
        &proof,
        &inventory,
        authority,
        options.expected_previous_final_receipt_sha256,
        checkpoint,
    )?;
    inventory.assert_current()?;
    Ok(result)
}

#[cfg(test)]
mod selected_request_tests;
