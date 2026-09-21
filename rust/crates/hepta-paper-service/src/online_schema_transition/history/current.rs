//! Authenticated original schema state, finalized mutation replay and a fresh
//! schema observation bound to the same current head. This is not activation.
use super::checkpoint::VerifiedSchemaTransitionCheckpointV1;
use crate::{
    online_runtime_activation::{
        active_refresh::VerifiedActiveAuthorityEvidenceV1,
        finalized_inventory::VerifiedFinalizedInventoryV1,
    },
    online_writer_static::{RetainedWriterStaticInputsV1, VerifiedWriterStaticCoverageV1},
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::{MutationClockV1, iso},
        contracts::schema_transition::schema_transition_receipt_hash_v1,
        error,
        finalized_history::{
            VerifiedFinalizedMutationChainV1, authenticate_schema_checkpoint_chain_v1,
        },
        hash, text,
    },
    state_database_inventory::{
        NativeStoreTransactionInventoryGuardV1, ObservedStateDatabaseInventoryV1,
    },
    state_recoverability::{VerifiedCheckpointReplayV1, verify_checkpoint_effective_state_v1},
};
use serde_json::{Value, json};
use std::cell::Cell;

pub(crate) struct SchemaHistoryInputsV1<'a> {
    pub(crate) checkpoint: &'a VerifiedSchemaTransitionCheckpointV1,
    pub(crate) current: &'a ObservedStateDatabaseInventoryV1,
    pub(crate) source: &'a VerifiedWriterStaticCoverageV1,
    pub(crate) active: &'a VerifiedActiveAuthorityEvidenceV1,
    pub(crate) finalized: &'a VerifiedFinalizedInventoryV1,
}
/// Private construction requires actual opaque input producers, actual private
/// replay and a fresh pinned signature. A report cannot restore this proof.
pub(crate) struct VerifiedSchemaTransitionHistoryV1 {
    report: Value,
    chain: VerifiedFinalizedMutationChainV1,
    replay: VerifiedCheckpointReplayV1,
    request: Value,
    observation: Value,
    authority_hash: String,
    source_hash: String,
    active_hash: String,
    finalized_hash: String,
    checked_at: Cell<i64>,
}
fn fail(reason: &str) -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error(format!("autonomous_research_schema_history_{reason}"))
}
struct Clock<'a> {
    inner: &'a mut dyn MutationClockV1,
    last: &'a Cell<i64>,
}
impl MutationClockV1 for Clock<'_> {
    fn now_millis(&mut self) -> Result<i64> {
        let now = self.inner.now_millis()?;
        if now < self.last.get() {
            return Err(fail("clock_invalid"));
        }
        iso(now)?;
        self.last.set(now);
        Ok(now)
    }
}
fn finalized_hash(proof: &VerifiedFinalizedInventoryV1) -> Result<String> {
    hash(
        "AutonomousResearchSchemaHistoryFinalizedInventory",
        proof.value(),
    )
}
fn same_json(a: &Value, b: &Value) -> Result<bool> {
    Ok(hepta_legacy_compatibility::production_stable_json_v1(a)
        .map_err(|e| error(e.to_string()))?
        == hepta_legacy_compatibility::production_stable_json_v1(b)
            .map_err(|e| error(e.to_string()))?)
}
fn assert_head(
    chain: &VerifiedFinalizedMutationChainV1,
    active: &VerifiedActiveAuthorityEvidenceV1,
    observation: Option<&Value>,
) -> Result<()> {
    let head = &active.value()["authorityEvidence"]["currentHead"]["receipt"];
    if !same_json(&chain.value()["toGlobalSequence"], &head["globalSequence"])?
        || chain.value()["toGlobalHash"] != head["globalHash"]
        || !same_json(&chain.value()["databaseHeads"], &head["databaseHeads"])?
        || observation.is_some_and(|v| {
            v["globalSequence"].as_f64() != head["globalSequence"].as_f64()
                || v["globalHash"] != head["globalHash"]
        })
    {
        return Err(fail("head_changed"));
    }
    Ok(())
}
impl VerifiedSchemaTransitionHistoryV1 {
    pub(crate) fn value(&self) -> &Value {
        &self.report
    }
    pub(crate) fn assert_current<T: MutationAuthorityTransportV1>(
        &self,
        input: &SchemaHistoryInputsV1<'_>,
        authority: &PinnedMutationAuthorityV1<T>,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        let mut clock = Clock {
            inner: clock,
            last: &self.checked_at,
        };
        let before = clock.now_millis()?;
        self.assert_subject(input, authority)?;
        input.checkpoint.assert_current(input.current, authority)?;
        input.source.assert_current()?;
        input
            .active
            .assert_current(authority, input.current.value(), input.source, before)?;
        input.finalized.assert_current(
            input.current,
            authority,
            input.source,
            input.active,
            &mut clock,
        )?;
        self.replay
            .assert_matches(input.checkpoint, input.current, &self.chain, authority)?;
        assert_head(&self.chain, input.active, Some(&self.observation))?;
        authority.verify_schema_transition_observation(
            &self.observation,
            &self.request,
            clock.now_millis()?,
        )?;
        let completed = clock.now_millis()?;
        // Every check below is memory-only. A late file/signature check cannot
        // leave an earlier schema or finalized/active observation expired.
        super::super::assert_readiness_time(
            &self.observation,
            authority.trust(),
            before,
            completed,
        )?;
        input
            .finalized
            .assert_time(authority.trust(), input.active, completed)
    }
    /// Recheck the actual completed history proof without obtaining another
    /// snapshot of a database whose transaction is in progress. All original
    /// FINAL, chain, replay, head, source and authority bindings remain required.
    pub(crate) fn assert_retained_for_native_store_transaction<T: MutationAuthorityTransportV1>(
        &self,
        input: &SchemaHistoryInputsV1<'_>,
        authority: &PinnedMutationAuthorityV1<T>,
        retained_source: &RetainedWriterStaticInputsV1<'_>,
        guard: &NativeStoreTransactionInventoryGuardV1<'_>,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        let mut clock = Clock {
            inner: clock,
            last: &self.checked_at,
        };
        let before = clock.now_millis()?;
        self.assert_subject(input, authority)?;
        input
            .checkpoint
            .assert_retained_for_native_store_transaction(input.current, authority, guard)?;
        input.active.assert_retained_for_native_store_transaction(
            authority,
            input.current,
            input.source,
            retained_source,
            guard,
            before,
        )?;
        input
            .finalized
            .assert_retained_for_native_store_transaction(
                input.current,
                authority,
                input.source,
                input.active,
                retained_source,
                guard,
                &mut clock,
            )?;
        self.replay.assert_retained_for_native_store_transaction(
            input.checkpoint,
            input.current,
            &self.chain,
            authority,
            guard,
        )?;
        assert_head(&self.chain, input.active, Some(&self.observation))?;
        authority.verify_schema_transition_observation(
            &self.observation,
            &self.request,
            clock.now_millis()?,
        )?;
        guard.assert_bound_to(input.current)?;
        let completed = clock.now_millis()?;
        super::super::assert_readiness_time(
            &self.observation,
            authority.trust(),
            before,
            completed,
        )?;
        input
            .finalized
            .assert_time(authority.trust(), input.active, completed)
    }
    fn assert_subject<T: MutationAuthorityTransportV1>(
        &self,
        input: &SchemaHistoryInputsV1<'_>,
        authority: &PinnedMutationAuthorityV1<T>,
    ) -> Result<()> {
        if self.authority_hash != authority.configuration_hash()
            || self.chain.authority_configuration_hash() != self.authority_hash
            || input.source.value()["astGateReceiptHash"] != self.source_hash
            || input.active.receipt_hash()? != self.active_hash
            || finalized_hash(input.finalized)? != self.finalized_hash
            || input.current.value()["inventoryHash"] != self.report["currentInventoryHash"]
            || input.checkpoint.historical_inventory()["inventoryHash"]
                != self.report["historicalInventoryHash"]
        {
            return Err(fail("subject_changed"));
        }
        Ok(())
    }
}
/// No backup reservation or journal-range request is synthesized. The source
/// entries are actual retained signed local records checked against fresh heads.
pub(crate) fn verify_schema_transition_history_v1<T: MutationAuthorityTransportV1>(
    input: &SchemaHistoryInputsV1<'_>,
    authority: &mut PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
) -> Result<VerifiedSchemaTransitionHistoryV1> {
    let checked_at = Cell::new(i64::MIN);
    let mut clock = Clock {
        inner: clock,
        last: &checked_at,
    };
    let started = clock.now_millis()?;
    input.checkpoint.assert_current(input.current, authority)?;
    input
        .active
        .assert_current(authority, input.current.value(), input.source, started)?;
    input.finalized.assert_current(
        input.current,
        authority,
        input.source,
        input.active,
        &mut clock,
    )?;
    let chain = authenticate_schema_checkpoint_chain_v1(
        input.checkpoint,
        input.finalized.database_inspections(),
        authority,
    )?;
    assert_head(&chain, input.active, None)?;
    let replay =
        verify_checkpoint_effective_state_v1(input.checkpoint, input.current, &chain, authority)?;
    // Bind the observation to the original FINAL postInventoryHash. Replacing
    // it with today's bytes would falsely reinterpret the original signature.
    let audit = input.checkpoint.schema_audit()?;
    let requested = clock.now_millis()?;
    let request = super::super::observe_request(
        &audit,
        input.checkpoint.historical_inventory(),
        &iso(requested)?,
    )?;
    let observation = authority
        .observe_schema_transition(&request, requested)?
        .value()
        .clone();
    assert_head(&chain, input.active, Some(&observation))?;
    let report = json!({"version":1,"kind":"AutonomousResearchSchemaTransitionHistory",
        "historicalInventoryHash":input.checkpoint.historical_inventory()["inventoryHash"],
        "currentInventoryHash":input.current.value()["inventoryHash"],
        "schemaTransitionReceiptHash":audit["schemaTransitionReceiptHash"],
        "liveObservationReceiptHash":schema_transition_receipt_hash_v1(&observation)?,
        "globalSequence":observation["globalSequence"],"globalHash":observation["globalHash"],
        "observedAt":observation["observedAt"],"expiresAt":observation["expiresAt"],
        "replay":replay.value(),"runtimeReady":false,"productionActivation":false,"nodeRetirementVerified":false});
    let source_hash = text(input.source.value(), "astGateReceiptHash")?.into();
    let active_hash = input.active.receipt_hash()?;
    let finalized_hash = finalized_hash(input.finalized)?;
    // Finish with the same monotonic clock before moving its high-water cell.
    let completed = clock.now_millis()?;
    super::super::assert_readiness_time(&observation, authority.trust(), requested, completed)?;
    let proof = VerifiedSchemaTransitionHistoryV1 {
        report,
        chain,
        replay,
        request,
        observation,
        authority_hash: authority.configuration_hash().into(),
        source_hash,
        active_hash,
        finalized_hash,
        checked_at: Cell::new(completed),
    };
    proof.assert_current(input, authority, &mut clock)?;
    Ok(proof)
}

#[cfg(test)]
mod tests;
