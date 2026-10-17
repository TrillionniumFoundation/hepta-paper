//! Durable pristine-v2 restart boundary over the existing normalization journal.
//!
//! This module never controls a service manager. It persists the exact target
//! observation before an external installed owner restarts the authority, then
//! accepts only an authority instance whose pinned target configuration matches
//! the signed finalization. An uncertain restart retries the exact observation;
//! it never blindly repeats stop/start.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetRestartObservationProgressV2 {
    version: u16,
    source_authority_configuration_hash: String,
    target_authority_configuration_hash: String,
    request: Value,
    request_hash: String,
    receipt: Option<Value>,
}

fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_pristine_schema_rebind_restart_progress_invalid")
}

fn restart_progress(journal: &Value) -> Result<TargetRestartObservationProgressV2> {
    ensure(
        crate::sqlite_mutation_coordinator::keys(
            &journal["targetRestartObservationProgress"],
            &[
                "version",
                "sourceAuthorityConfigurationHash",
                "targetAuthorityConfigurationHash",
                "request",
                "requestHash",
                "receipt",
            ],
        ),
        &invalid().code,
    )?;
    let progress: TargetRestartObservationProgressV2 =
        serde_json::from_value(journal["targetRestartObservationProgress"].clone())
            .map_err(|_| invalid())?;
    ensure(
        progress.version == 2
            && crate::sqlite_mutation_coordinator::sha(&json!(
                progress.source_authority_configuration_hash
            ))
            && crate::sqlite_mutation_coordinator::sha(&json!(
                progress.target_authority_configuration_hash
            ))
            && progress.request_hash == observation_request_hash(&progress.request)?,
        &invalid().code,
    )?;
    Ok(progress)
}

/// Opaque v2 handoff retaining the root lock and actual post-state across restart.
pub struct PreparedSchemaTargetRestartV2 {
    progress: TargetRestartObservationProgressV2,
    finalization: VerifiedMutationReceiptV1,
    owner: FinalizationHandoff,
}

impl PreparedSchemaTargetRestartV2 {
    pub fn request(&self) -> &Value {
        &self.progress.request
    }
    pub fn request_hash(&self) -> &str {
        &self.progress.request_hash
    }
    pub fn target_authority_configuration_hash(&self) -> &str {
        &self.progress.target_authority_configuration_hash
    }
    pub fn journal_hash(&self) -> &str {
        &self.owner.journal_hash
    }

    fn source_guard<T: MutationAuthorityTransportV1>(
        &self,
        source_authority: &PinnedMutationAuthorityV1<T>,
    ) -> Result<()> {
        self.owner.lock.assert_current()?;
        self.owner.post_state.assert_current(
            &self.owner.journal["plan"],
            Some(&self.owner.journal["installations"]),
        )?;
        ensure(
            self.owner.journal["plan"]["version"] == 2
                && self.owner.journal["authorityConfigurationHash"]
                    == source_authority.configuration_hash()
                && self.progress.source_authority_configuration_hash
                    == self.owner.journal["authorityConfigurationHash"],
            &invalid().code,
        )?;
        let reservation = source_authority.verify_historical_schema_transition_reservation(
            &self.owner.journal["reservation"],
            &self.owner.journal["request"],
        )?;
        let finalization_progress = progress(&self.owner.journal)?;
        let finalization_receipt = finalization_progress.receipt.as_ref().ok_or_else(|| {
            error("autonomous_research_online_schema_transition_finalization_recovery_required")
        })?;
        let verified = source_authority.verify_historical_schema_transition_finalization(
            finalization_receipt,
            &finalization_progress.request,
            &reservation,
        )?;
        ensure(
            verified.value() == self.finalization.value()
                && finalization_receipt["targetAuthorityConfigurationHash"]
                    == self.progress.target_authority_configuration_hash
                && self.owner.journal["reservation"]["targetAuthorityConfigurationHash"]
                    == self.progress.target_authority_configuration_hash,
            &invalid().code,
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
            "autonomous_research_pristine_schema_rebind_restart_request_changed",
        )?;
        let current = NormalizationRepository::open(&self.owner.lock, false)?
            .load()?
            .ok_or_else(invalid)?;
        ensure(
            current.0 == self.owner.journal && current.1 == self.owner.journal_hash,
            "autonomous_research_pristine_schema_rebind_restart_journal_changed",
        )
    }

    fn target_guard<S: MutationAuthorityTransportV1, T: MutationAuthorityTransportV1>(
        &self,
        source_authority: &PinnedMutationAuthorityV1<S>,
        target_authority: &PinnedMutationAuthorityV1<T>,
    ) -> Result<()> {
        self.source_guard(source_authority)?;
        ensure(
            target_authority.trust()["authorityId"] == source_authority.trust()["authorityId"]
                && target_authority.trust()["keyId"] == source_authority.trust()["keyId"]
                && target_authority.trust()["scopeId"] == source_authority.trust()["scopeId"]
                && target_authority.trust()["databaseScopeHash"]
                    == source_authority.trust()["databaseScopeHash"]
                && target_authority.trust()["writerManifestHash"]
                    == self.owner.journal["plan"]["writerManifestHash"],
            "autonomous_research_pristine_schema_rebind_target_configuration_mismatch",
        )?;
        let reservation = target_authority.verify_historical_schema_transition_reservation(
            &self.owner.journal["reservation"],
            &self.owner.journal["request"],
        )?;
        let finalization_progress = progress(&self.owner.journal)?;
        let finalization_receipt = finalization_progress.receipt.as_ref().ok_or_else(|| {
            error("autonomous_research_online_schema_transition_finalization_recovery_required")
        })?;
        target_authority.verify_historical_schema_transition_finalization(
            finalization_receipt,
            &finalization_progress.request,
            &reservation,
        )?;
        crate::sqlite_mutation_coordinator::contracts::schema_transition::assert_schema_transition_observe_request_v1(
            &self.progress.request,
            target_authority.trust(),
        )?;
        if let Some(receipt) = &self.progress.receipt {
            let verified = target_authority
                .verify_historical_schema_transition_observation(receipt, &self.progress.request)?;
            ensure(
                verified.value()["authorityConfigurationActivated"] == true,
                "autonomous_research_pristine_schema_rebind_target_configuration_not_activated",
            )?;
        }
        Ok(())
    }
    fn save(&mut self) -> Result<()> {
        self.owner.journal["targetRestartObservationProgress"] =
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

/// Persist the exact target observation before handing service control to the
/// installed restart owner. This performs no restart and no authority RPC.
pub fn prepare_schema_target_configuration_restart_v2<T: MutationAuthorityTransportV1>(
    finalized: PreparedSchemaFinalizationV1,
    source_authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
) -> Result<PreparedSchemaTargetRestartV2> {
    prepare_schema_target_configuration_restart_with_selection_v2(
        finalized,
        source_authority,
        clock,
        &mut |_, _, _| Ok(()),
    )
}
pub(crate) fn prepare_schema_target_configuration_restart_with_selection_v2<
    T: MutationAuthorityTransportV1,
>(
    finalized: PreparedSchemaFinalizationV1,
    source_authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
    select: &mut dyn FnMut(&Value, &str, i64) -> Result<()>,
) -> Result<PreparedSchemaTargetRestartV2> {
    ensure(
        finalized.owner.journal["plan"]["version"] == 2,
        "autonomous_research_pristine_schema_rebind_v2_required",
    )?;
    ensure(
        finalized
            .owner
            .journal
            .get("targetRestartObservationProgress")
            .is_none()
            && finalized.owner.journal.get("observationProgress").is_none(),
        "autonomous_research_pristine_schema_rebind_restart_recovery_required",
    )?;
    finalized.guard(source_authority)?;
    let finalization_receipt = finalized.progress.receipt.as_ref().ok_or_else(|| {
        error("autonomous_research_online_schema_transition_finalization_recovery_required")
    })?;
    let finalization = source_authority.verify_historical_schema_transition_finalization(
        finalization_receipt,
        &finalized.progress.request,
        &finalized.owner.reservation,
    )?;
    let target = text_field(finalization.value(), "targetAuthorityConfigurationHash")?.to_owned();
    ensure(
        crate::sqlite_mutation_coordinator::sha(&json!(target))
            && target != finalized.owner.journal["authorityConfigurationHash"],
        "autonomous_research_pristine_schema_rebind_target_configuration_mismatch",
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
        source_authority.trust(),
    )?;
    let progress = TargetRestartObservationProgressV2 {
        version: 2,
        source_authority_configuration_hash: finalized.owner.journal["authorityConfigurationHash"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned(),
        target_authority_configuration_hash: target,
        request_hash: observation_request_hash(&request)?,
        request,
        receipt: None,
    };
    let mut prepared = PreparedSchemaTargetRestartV2 {
        progress,
        finalization,
        owner: finalized.owner,
    };
    prepared.owner.journal["checkedAtMillis"] = json!(now);
    select(prepared.request(), prepared.request_hash(), now)?;
    prepared.save()?;
    prepared.source_guard(source_authority)?;
    Ok(prepared)
}

pub trait SchemaTargetRestartCheckpointV2 {
    fn checkpoint(&mut self, point: &str) -> Result<()>;
}

pub struct NoSchemaTargetRestartCheckpointV2;
impl SchemaTargetRestartCheckpointV2 for NoSchemaTargetRestartCheckpointV2 {
    fn checkpoint(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
}

/// Complete only after the external installed owner has restarted the authority
/// under the exact target configuration. The target authority's signed
/// observation is the proof; no caller-ready flag or manager report substitutes
/// for it. An unknown reply retries only the durable request and never restarts.
pub fn observe_restarted_schema_transition_v2<S, T>(
    prepared: &mut PreparedSchemaTargetRestartV2,
    source_authority: &PinnedMutationAuthorityV1<S>,
    target_authority: &mut PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
    checkpoint: &mut dyn SchemaTargetRestartCheckpointV2,
) -> Result<SchemaTransitionObservationResult>
where
    S: MutationAuthorityTransportV1,
    T: MutationAuthorityTransportV1,
{
    prepared.target_guard(source_authority, target_authority)?;
    if let Some(receipt) = &prepared.progress.receipt {
        let observation = target_authority
            .verify_historical_schema_transition_observation(receipt, &prepared.progress.request)?;
        prepared.target_guard(source_authority, target_authority)?;
        return Ok(SchemaTransitionObservationResult {
            observe_request: prepared.progress.request.clone(),
            observation,
        });
    }
    checkpoint.checkpoint("before_target_configuration_observation")?;
    prepared.target_guard(source_authority, target_authority)?;
    let now = prepared.clock(clock)?;
    prepared.owner.journal["checkedAtMillis"] = json!(now);
    prepared.save()?;
    prepared.target_guard(source_authority, target_authority)?;
    let invoke_at = prepared.clock(clock)?;
    let observation =
        target_authority.observe_schema_transition(&prepared.progress.request, invoke_at)?;
    ensure(
        observation.value()["authorityConfigurationActivated"] == true,
        "autonomous_research_pristine_schema_rebind_target_configuration_not_activated",
    )?;
    checkpoint.checkpoint("after_target_observation_before_publication")?;
    prepared.target_guard(source_authority, target_authority)?;
    let after = prepared.clock(clock)?;
    ensure(
        after >= invoke_at,
        "autonomous_research_online_schema_transition_clock_regressed",
    )?;
    prepared.progress.receipt = Some(observation.value().clone());
    prepared.owner.journal["checkedAtMillis"] = json!(after);
    prepared.save()?;
    checkpoint.checkpoint("after_target_observation_publication")?;
    prepared.target_guard(source_authority, target_authority)?;
    Ok(SchemaTransitionObservationResult {
        observe_request: prepared.progress.request.clone(),
        observation,
    })
}

pub struct ResumeSchemaTargetRestartOptionsV2<'a> {
    pub runtime_root: &'a Path,
    pub state_database_manifest: &'a Value,
    pub writer_manifest: &'a Value,
    pub expected_transition_id: &'a str,
    pub expected_plan_hash: &'a str,
    pub expected_finalization_request_hash: &'a str,
    /// Retained outside the normalization journal and service-manager state.
    pub expected_target_observation_request_hash: &'a str,
}

/// Reopen a selected v2 restart boundary without invoking either authority or a
/// service manager. The old source verifier remains a historical file/key owner.
pub fn resume_schema_target_configuration_restart_v2<T: MutationAuthorityTransportV1>(
    options: ResumeSchemaTargetRestartOptionsV2<'_>,
    source_authority: &PinnedMutationAuthorityV1<T>,
) -> Result<PreparedSchemaTargetRestartV2> {
    resume_restart_impl(options, source_authority, None)
}
pub(crate) fn resume_schema_target_configuration_restart_from_selected_request_v2<
    T: MutationAuthorityTransportV1,
>(
    options: ResumeSchemaTargetRestartOptionsV2<'_>,
    selected_request: &Value,
    source_authority: &PinnedMutationAuthorityV1<T>,
) -> Result<PreparedSchemaTargetRestartV2> {
    resume_restart_impl(options, source_authority, Some(selected_request))
}
fn resume_restart_impl<T: MutationAuthorityTransportV1>(
    options: ResumeSchemaTargetRestartOptionsV2<'_>,
    source_authority: &PinnedMutationAuthorityV1<T>,
    selected_request: Option<&Value>,
) -> Result<PreparedSchemaTargetRestartV2> {
    ensure(
        crate::sqlite_mutation_coordinator::sha(&json!(
            options.expected_target_observation_request_hash
        )),
        "autonomous_research_pristine_schema_rebind_restart_pin_invalid",
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
        source_authority,
    )?;
    ensure(
        finalized.owner.journal["plan"]["version"] == 2,
        "autonomous_research_pristine_schema_rebind_v2_required",
    )?;
    let missing = finalized
        .owner
        .journal
        .get("targetRestartObservationProgress")
        .is_none();
    let progress = if missing {
        let request = selected_request.ok_or_else(invalid)?;
        TargetRestartObservationProgressV2 {
            version: 2,
            source_authority_configuration_hash:
                finalized.owner.journal["authorityConfigurationHash"]
                    .as_str()
                    .ok_or_else(invalid)?
                    .to_owned(),
            target_authority_configuration_hash: finalized
                .progress
                .receipt
                .as_ref()
                .and_then(|receipt| receipt["targetAuthorityConfigurationHash"].as_str())
                .ok_or_else(invalid)?
                .to_owned(),
            request: request.clone(),
            request_hash: observation_request_hash(request)?,
            receipt: None,
        }
    } else {
        restart_progress(&finalized.owner.journal)?
    };
    if let Some(selected) = selected_request {
        ensure(
            *selected == progress.request,
            "autonomous_research_pristine_schema_rebind_restart_request_changed",
        )?;
    }
    ensure(
        progress.request_hash == options.expected_target_observation_request_hash,
        "autonomous_research_pristine_schema_rebind_restart_request_changed",
    )?;
    let finalization_receipt = finalized.progress.receipt.as_ref().ok_or_else(|| {
        error("autonomous_research_online_schema_transition_finalization_recovery_required")
    })?;
    let finalization = source_authority.verify_historical_schema_transition_finalization(
        finalization_receipt,
        &finalized.progress.request,
        &finalized.owner.reservation,
    )?;
    if missing {
        crate::sqlite_mutation_coordinator::contracts::schema_transition::assert_schema_transition_observe_request_v1(&progress.request,source_authority.trust())?;
        ensure(
            timestamp(&progress.request["requestedAt"]).is_some_and(|now| {
                now >= int(&finalized.owner.journal, "checkedAtMillis").unwrap_or(i64::MAX)
            }),
            &invalid().code,
        )?;
    }
    let mut prepared = PreparedSchemaTargetRestartV2 {
        progress,
        finalization,
        owner: finalized.owner,
    };
    prepared.source_guard(source_authority)?;
    if missing {
        prepared.owner.journal["checkedAtMillis"] =
            json!(timestamp(&prepared.progress.request["requestedAt"]).ok_or_else(invalid)?);
        prepared.save()?;
        prepared.source_guard(source_authority)?;
    }
    Ok(prepared)
}

pub struct PublishPreparedSchemaTargetRestartOptionsV2<'a> {
    pub state_database_manifest: &'a Value,
    pub writer_manifest: &'a Value,
    pub expected_plan_hash: &'a str,
    pub expected_previous_final_receipt_sha256: Option<&'a str>,
}

/// Publish FINAL.json only after the target authority signed exact activation.
pub fn publish_restarted_schema_transition_observation_v2<S, T>(
    prepared: PreparedSchemaTargetRestartV2,
    source_authority: &PinnedMutationAuthorityV1<S>,
    target_authority: &PinnedMutationAuthorityV1<T>,
    options: PublishPreparedSchemaTargetRestartOptionsV2<'_>,
    checkpoint: &mut dyn super::super::publication::SchemaFinalReceiptCheckpointV1,
) -> Result<super::super::publication::SchemaFinalReceiptPublicationV1>
where
    S: MutationAuthorityTransportV1,
    T: MutationAuthorityTransportV1,
{
    prepared.target_guard(source_authority, target_authority)?;
    let finalization_progress = progress(&prepared.owner.journal)?;
    let finalization_receipt = finalization_progress.receipt.as_ref().ok_or_else(|| {
        error("autonomous_research_online_schema_transition_finalization_recovery_required")
    })?;
    let observation_receipt = prepared.progress.receipt.as_ref().ok_or_else(|| {
        error("autonomous_research_pristine_schema_rebind_restart_recovery_required")
    })?;
    target_authority.verify_historical_schema_transition_observation(
        observation_receipt,
        &prepared.progress.request,
    )?;
    let runtime_root = prepared
        .owner
        .post_state
        .held_inventory()
        .runtime_root()
        .to_owned();
    let proof = super::super::publication::prepare_schema_transition_audit_v1(
        super::super::publication::SchemaTransitionAuditInputV1 {
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
        target_authority,
    )?;
    prepared.target_guard(source_authority, target_authority)?;
    drop(prepared);
    let inventory =
        observe_state_database_inventory_v1(&runtime_root, options.state_database_manifest)?;
    let result = super::super::publication::publish_schema_transition_final_receipt_v1(
        &proof,
        &inventory,
        target_authority,
        options.expected_previous_final_receipt_sha256,
        checkpoint,
    )?;
    inventory.assert_current()?;
    Ok(result)
}
