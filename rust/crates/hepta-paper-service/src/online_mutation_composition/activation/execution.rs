//! One owning native-store operation. All admission and evidence are internal;
//! no SQLite connection, SQL callback or generic writer scope escapes.
use super::*;
use super::{
    admission::{NativeAdmissionInputsV1, NativeReconciliationAdmissionV1},
    native_process::RetainedNativeControlProcessV1,
    transaction::NativeTransactionEvidenceV1,
};
use crate::automation_runtime_reconciliation::{
    LocalReconciliationOperationV1, OnlineReconciliationBindingV1, OnlineReconciliationRequestV1,
    execute_retained_online_reconciliation_v1,
};
use hepta_campaign_writer::{
    CampaignWriterPolicyV1, VerifiedWriterCutoverV1, inspect_writer_database_preimage_v1,
};
use hepta_cutover::{DurableCutoverCoordinatorV1, WriterFenceV1};
use hepta_qualification_ingest::VerifiedExternalQualificationClosureV1;
use rusqlite::{Connection, OpenFlags};
use std::time::Duration;

pub(crate) struct NativeOnlineReconciliationRequestV1 {
    pub operation: LocalReconciliationOperationV1,
    pub campaign_id: Option<String>,
    pub no_progress_seconds: f64,
    pub release_commit: Option<String>,
}
impl PreparedInitialOnlineMutationCompositionV1 {
    /// Consuming self prevents a second write with the old head/preimage/proofs,
    /// including after rejection, panic, commit or incomplete finalization.
    pub(crate) fn execute_native_reconciliation_v1(
        mut self,
        native: RetainedNativeControlProcessV1,
        qualification: VerifiedExternalQualificationClosureV1,
        cutover: VerifiedWriterCutoverV1,
        lease: &WriterFenceV1,
        request: NativeOnlineReconciliationRequestV1,
    ) -> Result<Value> {
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
        let recovery = self.fence.retain_native_store_transaction_v1(
            &self.fence_binding,
            &guard,
            &self.verifier,
        )?;
        let database_path =
            inventory
                .runtime_root()
                .join(crate::sqlite_mutation_coordinator::text(
                    guard.instance(),
                    "sourceRelativePath",
                )?);
        let preimage = inspect_writer_database_preimage_v1(
            &database_path,
            CampaignWriterPolicyV1::strict(native.control_unit().principal_uid),
        )
        .map_err(|e| error(e.to_string()))?;
        // The journal may keep WAL/SHM locks even outside BEGIN. Open it only
        // after ALL full observations and regular-file captures, and declare it
        // after their scopes so its Connection closes before their Files drop.
        let mut durable =
            DurableCutoverCoordinatorV1::open(&database_path).map_err(|e| error(e.to_string()))?;
        // Explicit field borrows leave coordinator exclusively
        // mutable while the callback sees only immutable evidence.
        let evidence = NativeTransactionEvidenceV1 {
            manifest: &self.manifest,
            initial_inventory: &self.initial_inventory,
            startup: &self.startup,
            schema: &self.schema,
            source: &self.source,
            active: &self.active,
            finalized: &self.finalized,
            inspection: &self.inspection,
            cache: &self.cache,
            fence: &self.fence,
            verifier: &self.verifier,
            checked_at: &self.checked_at,
            package: &self.package,
        };
        let admission_inputs = NativeAdmissionInputsV1 {
            workspace_root: &self.workspace_root,
            backup_root: &self.backup_root,
            startup: &self.startup,
            source: &self.source,
            verifier: &self.verifier,
            fence_binding: &self.fence_binding,
            checked_at: &self.checked_at,
        };
        // Keep the rich business result even if the outer storage post-check
        // rejects after COMMIT. Such a failure never becomes "not committed".
        let mut outcome = None;
        let scoped = durable.with_writer_state_and_external_storage_v2(
            lease,
            RECONCILIATION_WRITER_SCOPE_V1,
            |state, storage| {
                let result = (|| {
                    let admission = NativeReconciliationAdmissionV1::observe(
                        &admission_inputs,
                        &native,
                        &qualification,
                        &cutover,
                        state,
                        storage,
                        &guard,
                        &preimage,
                    )?;
                    let check = || {
                        storage.assert_current().map_err(|e| error(e.to_string()))?;
                        native_scope.assert_current(&native, &guard)?;
                        evidence.assert_current(&source, &cache, &guard, &recovery)?;
                        storage.assert_current().map_err(|e| error(e.to_string()))?;
                        let now = CompositionClock(evidence.checked_at).now_millis()?;
                        evidence.assert_evidence_valid_at(now)?;
                        evidence
                            .fence
                            .assert_native_store_transaction_valid_at_v1(&recovery, now)?;
                        admission.assert_valid_at(now)
                    };
                    check()?;
                    let binding = OnlineReconciliationBindingV1 {
                        database_instance_id: crate::sqlite_mutation_coordinator::text(
                            guard.instance(),
                            "instanceId",
                        )?
                        .into(),
                        schema_contract_id: crate::sqlite_mutation_coordinator::text(
                            guard.instance(),
                            "schemaContractId",
                        )?
                        .into(),
                    };
                    // This is the only target connection, declared AFTER all
                    // retained tokens. Reverse drop order also protects unwind.
                    let mut connection = Connection::open_with_flags(
                        &state.database_path,
                        OpenFlags::SQLITE_OPEN_READ_WRITE
                            | OpenFlags::SQLITE_OPEN_NO_MUTEX
                            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
                    )?;
                    connection.busy_timeout(Duration::from_secs(5))?;
                    check()?;
                    let value = execute_retained_online_reconciliation_v1(
                        &mut connection,
                        &mut self.coordinator,
                        &binding,
                        &OnlineReconciliationRequestV1 {
                            operation: request.operation,
                            campaign_id: request.campaign_id.clone(),
                            no_progress_seconds: request.no_progress_seconds,
                            release_commit: request.release_commit.clone(),
                        },
                        check,
                        check,
                        check,
                    );
                    drop(connection);
                    // Coordinator feedback deliberately invalidates the old
                    // proofs. Do not recheck them after an already final write.
                    value
                })();
                let failed = result.as_ref().err().map(|e| e.code.clone());
                outcome = Some(result);
                match failed {
                    Some(code) => Err(code),
                    None => Ok(()),
                }
            },
        );
        finish(outcome, scoped)
    }
}

fn finish(
    outcome: Option<Result<Value>>,
    scoped: std::result::Result<(), hepta_cutover::DurableCutoverError>,
) -> Result<Value> {
    match (outcome, scoped) {
        (Some(Err(cause)), _) => Err(cause),
        (Some(Ok(value)), Ok(())) => Ok(value),
        (Some(Ok(value)), Err(cause)) => {
            let mut failure = fail("native_cutover_postcheck_failed");
            failure.details =
                json!({"committed":true,"businessResult":value,"cutoverError":cause.to_string()});
            Err(failure)
        }
        (None, Err(cause)) => Err(error(cause.to_string())),
        (None, Ok(())) => Err(fail("native_execution_missing")),
    }
}

#[cfg(test)]
mod tests;
