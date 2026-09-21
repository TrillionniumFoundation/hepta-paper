//! Owning external-v2 transfer with no raw preimage reopen under SQLite locks.
use super::*;
use hepta_campaign_writer::VerifiedWriterCutoverV1;
use std::time::{SystemTime, UNIX_EPOCH};

mod preimage;
use preimage::ObservedExternalCutoverPreimageV2;

/// Expected values constrain an existing enrollment; none grants authority.
/// The complete shadow state is an optimistic concurrency precondition in
/// addition to its revision. Native epoch/configuration/qualification binding
/// belongs to the separate owning native composition.
pub struct ExternalProductionCanaryTransferRequestV2<'a> {
    pub database_path: &'a Path,
    pub expected_external_root: &'a Path,
    pub expected_enrollment_hash: &'a str,
    pub expected_revision: u64,
    pub expected_shadow_state: &'a DurableCutoverStateV1,
    pub scopes: &'a [String],
    pub writer_policy: CampaignWriterPolicyV1,
}

fn now() -> Result<u64, DurableCutoverError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| u64::try_from(value.as_millis()).ok())
        .filter(|value| *value > 0)
        .ok_or(DurableCutoverError::InvalidInput)
}
fn assert_time(
    authorization: &VerifiedWriterCutoverV1,
    started: u64,
    completed: u64,
) -> Result<(), DurableCutoverError> {
    if completed < started {
        return Err(DurableCutoverError::InvalidInput);
    }
    authorization.assert_current(completed)?;
    Ok(())
}

impl DurableCutoverCoordinatorV1 {
    /// Transfers an existing external-v2 production shadow enrollment using a
    /// genuine verified signature and a fresh exact, sidecar-free preimage.
    /// This owning entry opens its coordinator only after all regular-file
    /// captures, then closes SQLite before dropping those captured descriptors.
    /// Callers must not keep another same-process target/journal SQLite handle
    /// alive during this operation. Other participating processes remain fenced.
    ///
    /// No callback, live Connection, preimage JSON, caller clock or readiness
    /// flag is accepted. The lower protocol does not interpret the signed
    /// initial-writer-lease hash's native/HPCW domain or qualify native business
    /// code; the higher composition must bind those before authorizing writes.
    ///
    /// Existing generic activation is unchanged. A COMMIT error is not proof
    /// that no transition committed: reopen and inspect before deciding a retry.
    pub fn start_production_canary_external_v2(
        request: ExternalProductionCanaryTransferRequestV2<'_>,
        authorization: &VerifiedWriterCutoverV1,
    ) -> Result<DurableCutoverStateV1, DurableCutoverError> {
        validate_scopes(request.scopes)?;
        if request.expected_shadow_state.database_path != path_string(request.database_path)?
            || request.expected_shadow_state.revision != request.expected_revision
        {
            return Err(DurableCutoverError::InvalidInput);
        }
        let started = now()?;
        authorization.assert_current(started)?;
        // Both the incumbent strict observer and every retained raw descriptor
        // are created before the owning SQLite journal connection exists.
        let preimage = ObservedExternalCutoverPreimageV2::observe(
            request.database_path,
            request.writer_policy,
        )?;
        let mut coordinator = Self::open_with_expected_external_storage_v2(
            request.database_path,
            request.expected_external_root,
            Some(request.expected_enrollment_hash),
        )?;
        let result = transfer(
            &mut coordinator,
            &preimage,
            &request,
            authorization,
            started,
        );
        // Explicit ordering is also the reverse declaration order on unwind.
        drop(coordinator);
        result
    }
}

fn transfer(
    coordinator: &mut DurableCutoverCoordinatorV1,
    preimage: &ObservedExternalCutoverPreimageV2,
    request: &ExternalProductionCanaryTransferRequestV2<'_>,
    authorization: &VerifiedWriterCutoverV1,
    started: u64,
) -> Result<DurableCutoverStateV1, DurableCutoverError> {
    coordinator.validate_identity()?;
    let storage = coordinator
        .external_storage
        .as_ref()
        .ok_or(DurableCutoverError::InvalidInput)?;
    let tx = coordinator
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    storage.assert_current(&coordinator.database_path, &tx)?;
    let mut state = load_state(&tx)?;
    if state.revision != request.expected_revision || &state != request.expected_shadow_state {
        return Err(DurableCutoverError::RevisionConflict);
    }
    if state.mode != DurableCutoverModeV1::Production {
        return Err(DurableCutoverError::ProductionAuthorityRequired);
    }
    require_shadow(&state)?;
    if state.writer_id.is_some()
        || !state.canary_scopes.is_empty()
        || state.production_activation
        || state.activation_receipt_hash.is_some()
        || state.shadow_cases > MAX_SAFE_INTEGER
        || state.revision == 0
    {
        return Err(DurableCutoverError::IllegalTransition);
    }
    preimage.assert_current()?;
    if preimage.path() != coordinator.database_path
        || authorization.cutover_id() != state.cutover_id
    {
        return Err(DurableCutoverError::ProductionAuthorityRequired);
    }
    if preimage.hash()? != *authorization.database_preimage_hash() {
        return Err(DurableCutoverError::DatabasePreimageChanged);
    }
    let previous: String = tx.query_row(
        "SELECT entry_hash FROM hepta_cutover_journal WHERE revision=?1",
        [to_sql_integer(state.revision)?],
        |row| row.get(0),
    )?;
    advance_epoch(
        &mut state,
        Some(request.expected_shadow_state.new_writer_id.clone()),
    )?;
    state.canary_scopes = request.scopes.to_vec();
    state.phase = DurableCutoverPhaseV1::Canary;
    state.production_activation = true;
    state.activation_receipt_hash = Some(authorization.authorization_hash().as_str().into());
    state.revision = increment(state.revision)?;
    let evidence = serde_json::json!({"authorizationHash":state.activation_receipt_hash,
        "productionQualification":false,"schemaTranslationVerified":false});
    append(
        &tx,
        &state,
        "production_canary_authorized",
        &evidence,
        &previous,
    )?;
    // The actual local state now includes our uncommitted append. Recheck its
    // exact schema/tail and retained namespace without an old-state observer.
    preimage.assert_current()?;
    storage.assert_current(&coordinator.database_path, &tx)?;
    if load_state(&tx)? != state {
        return Err(DurableCutoverError::JournalCorrupt);
    }
    // No filesystem or signature I/O follows this owned terminal time sample.
    assert_time(authorization, started, now()?)?;
    tx.commit()?;
    Ok(state)
}

#[cfg(test)]
mod tests;
