//! Three owning phases: observe, transfer, then freshly admit one business write.
//! Each phase closes SQLite before dropping its retained raw-file scopes.
use super::{
    execution::NativeOnlineReconciliationRequestV1, native_process::RetainedNativeControlProcessV1,
    signing_preview::ObservedNativeSigningSubjectV1, *,
};
use hepta_campaign_writer::{CampaignWriterPolicyV1, VerifiedWriterCutoverV1};
use hepta_cutover::{
    DurableCutoverCoordinatorV1, DurableCutoverStateV1, ExternalProductionCanaryTransferRequestV2,
    WriterFenceV1,
};
use hepta_qualification_ingest::VerifiedExternalQualificationClosureV1;

impl ObservedNativeSigningSubjectV1 {
    /// Only equality against facts freshly produced in the actual native unit.
    /// This does not extend the independently verified signature's lifetime.
    pub(super) fn assert_authorization(&self, cutover: &VerifiedWriterCutoverV1) -> Result<()> {
        if cutover.subject() != &self.subject
            || cutover.cutover_id() != self.shadow.cutover_id
            || cutover.database_preimage_hash() != &self.preimage_hash
            || cutover.initial_writer_lease_hash() != &self.epoch_hash
        {
            return Err(fail("native_transfer_subject_mismatch"));
        }
        Ok(())
    }
    pub(super) fn actual_lease(
        &self,
        actual: &DurableCutoverStateV1,
        cutover: &VerifiedWriterCutoverV1,
    ) -> Result<WriterFenceV1> {
        let mut expected = self.prospective_canary.clone();
        expected.activation_receipt_hash = Some(cutover.authorization_hash().as_str().into());
        if actual != &expected {
            return Err(fail("native_transfer_result_mismatch"));
        }
        actual
            .writer_fence()
            .ok_or_else(|| fail("native_transfer_lease_missing"))
    }
}

impl PreparedInitialOnlineMutationCompositionV1 {
    /// No caller lease, expected state, diagnostic JSON or arbitrary SQL.
    /// This remains private until the native authority adapter topology and
    /// complete installed production invocation have independently qualified.
    pub(crate) fn transfer_and_execute_native_reconciliation_v1(
        self,
        native: RetainedNativeControlProcessV1,
        qualification: VerifiedExternalQualificationClosureV1,
        cutover: VerifiedWriterCutoverV1,
        request: NativeOnlineReconciliationRequestV1,
    ) -> Result<Value> {
        // This call closes its journal, then destroys all preview scopes. Do not
        // carry a recovery token into the next phase or reopen while WAL lives.
        let observed = self.observe_native_reconciliation_signing_v1(&native, &qualification)?;
        observed.assert_authorization(&cutover)?;
        let now = CompositionClock(&self.checked_at).now_millis()?;
        self.assert_valid_at(now)?;
        let now = u64::try_from(now).map_err(|_| fail("native_transfer_clock_invalid"))?;
        qualification
            .assert_current(now)
            .map_err(|e| error(e.to_string()))?;
        cutover
            .assert_current(now)
            .map_err(|e| error(e.to_string()))?;
        // Lower performs exact Shadow CAS and fresh retained preimage checks.
        // Its journal is fully closed before any new business observation.
        let actual = DurableCutoverCoordinatorV1::start_production_canary_external_v2(
            ExternalProductionCanaryTransferRequestV2 {
                database_path: std::path::Path::new(&observed.shadow.database_path),
                expected_external_root: &observed.external_root,
                expected_enrollment_hash: observed.enrollment_hash.as_str(),
                expected_revision: observed.shadow.revision,
                expected_shadow_state: &observed.shadow,
                scopes: &observed.prospective_canary.canary_scopes,
                writer_policy: CampaignWriterPolicyV1::strict(native.control_unit().principal_uid),
            },
            &cutover,
        )
        .map_err(unresolved_transfer)?;
        let result = (|| {
            let lease = observed.actual_lease(&actual, &cutover)?;
            // Fresh full checks and fresh scopes, including actual Canary/native
            // admission. Expired/changed proofs are rejected, never patched.
            self.execute_native_reconciliation_v1(native, qualification, cutover, &lease, request)
        })();
        after_transfer(result, &actual)
    }
}

fn unresolved_transfer(
    cause: hepta_cutover::DurableCutoverError,
) -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    let mut failure = fail("native_transfer_requires_inspection");
    // Conservative for every lower error, including uncertain SQLite COMMIT.
    // No execute or automatic retry follows an error from the owning transfer.
    failure.details = json!({"cutoverCommitted":null,"cutoverOutcome":"requires_inspection",
        "businessExecutionStarted":false,"productionActivationPerformed":null,
        "cutoverError":cause.to_string()});
    failure
}

fn after_transfer(result: Result<Value>, actual: &DurableCutoverStateV1) -> Result<Value> {
    match result {
        Ok(business) => Ok(
            json!({"version":1,"kind":"NativeReconciliationTransferResult",
            "cutoverCommitted":true,"productionActivationPerformed":true,
            "cutoverState":actual,"businessResult":business,
            "nodeRetirementVerified":false}),
        ),
        Err(mut cause) => {
            // Preserve code, fatal/deferred classification and every original
            // detail (including committed/unknown). The whole two-phase action
            // cannot automatically retry after a successful cutover; retain the
            // business retry classification in the nested original projection.
            let original = cause.projection();
            let mut details = cause.details.as_object().cloned().unwrap_or_default();
            details.insert("cutoverCommitted".into(), json!(true));
            details.insert("productionActivationPerformed".into(), json!(true));
            details.insert("cutoverState".into(), json!(actual));
            details.insert("businessError".into(), original);
            details.insert("nodeRetirementVerified".into(), json!(false));
            cause.details = Value::Object(details);
            cause.retryable = false;
            Err(cause)
        }
    }
}

#[cfg(test)]
mod tests;
