use super::authority::{
    MutationAuthorityTransportV1, PinnedMutationAuthorityV1, VerifiedMutationReceiptV1,
};
use super::clock::{MutationClockV1, nonce, observe};
use super::*;
use crate::sqlite_mutation_plan::{
    RestrictedMutationTransactionV1, ValidatedPlanRegistryV1,
    assert_sqlite_mutation_database_surface_v1, validate_sqlite_mutation_plans_v1,
    with_restricted_sqlite_mutation_v1,
};
use base64ct::{Base64, Encoding};
use rusqlite::Connection;

/// External epoch fencing is a separate authority. Implementations must preserve
/// their fatal errors; the coordinator never manufactures a current epoch.
pub trait RecoverabilityEpochFenceV1 {
    fn mark_mutation_finalized(&mut self, head: &Value) -> Result<()>;
    fn mark_mutation_reconciliation_required(&mut self, requirement: &Value) -> Result<()>;
    fn assert_current(&mut self) -> Result<Value>;
    fn reconcile(&mut self) -> Result<Value>;
}
pub struct SqliteMutationCoordinatorOptionsV1 {
    pub manifest: Value,
    pub operation_plans: Value,
    pub database_instances: Value,
    pub requested_lease_ms: Option<i64>,
    pub commit_safety_margin_ms: i64,
}
pub struct SqliteMutationCoordinatorV1<T: MutationAuthorityTransportV1> {
    authority: PinnedMutationAuthorityV1<T>,
    manifest: Value,
    plans: ValidatedPlanRegistryV1,
    database_instances: Value,
    requested_lease_ms: i64,
    commit_safety_margin_ms: i64,
    clock: Box<dyn MutationClockV1>,
    fence: Option<Box<dyn RecoverabilityEpochFenceV1>>,
}
impl SqliteMutationCoordinatorError {
    pub fn projection(&self) -> Value {
        json!({"code":self.code,"details":self.details,"stateRecoverabilityFatal":self.state_recoverability_fatal,"stateRecoverabilityDeferred":self.state_recoverability_deferred,"retryable":self.retryable})
    }
}
// A caller catching an unexpected callback unwind must not retain an open
// local transaction. External reservations are never implicitly finalized.
struct RollbackOnExit<'a>(&'a mut Connection);
impl Drop for RollbackOnExit<'_> {
    fn drop(&mut self) {
        if !self.0.is_autocommit() {
            let _ = self.0.execute_batch("ROLLBACK;");
        }
    }
}

impl<T: MutationAuthorityTransportV1> SqliteMutationCoordinatorV1<T> {
    pub fn new(
        authority: PinnedMutationAuthorityV1<T>,
        options: SqliteMutationCoordinatorOptionsV1,
        clock: Box<dyn MutationClockV1>,
        fence: Option<Box<dyn RecoverabilityEpochFenceV1>>,
    ) -> Result<Self> {
        let manifest_hash = manifest::writer_manifest_hash_v1(&options.manifest)?;
        if authority.trust()["writerManifestHash"] != manifest_hash
            || options
                .database_instances
                .as_array()
                .is_none_or(|a| a.is_empty())
        {
            return Err(error(
                "externally_fenced_sqlite_mutation_coordinator_configuration_invalid",
            ));
        }
        let plans = validate_sqlite_mutation_plans_v1(&options.manifest, &options.operation_plans)?;
        let lease = options
            .requested_lease_ms
            .unwrap_or(int(authority.trust(), "maximumReservationLeaseMs")?.min(60_000));
        if options.commit_safety_margin_ms < 100 || options.commit_safety_margin_ms >= lease {
            return Err(error(
                "externally_fenced_sqlite_mutation_commit_safety_margin_invalid",
            ));
        }
        Ok(Self {
            authority,
            manifest: options.manifest,
            plans,
            database_instances: options.database_instances,
            requested_lease_ms: lease,
            commit_safety_margin_ms: options.commit_safety_margin_ms,
            clock,
            fence,
        })
    }
    pub fn inspect_status(&self) -> Value {
        let complete = self.manifest["coverage"]["percent"].as_f64() == Some(100.0);
        let mut blockers = Vec::new();
        if !complete {
            blockers.push("autonomous_research_online_writer_manifest_100_percent_required");
        }
        blockers.push("autonomous_research_online_mutation_runtime_activation_required");
        json!({"version":1,"kind":"ExternallyFencedSqliteMutationCoordinatorStatus","status":if complete{"externally_fenced_sqlite_mutation_coordinator_configured"}else{"externally_fenced_sqlite_mutation_coordinator_partial"},"implemented":true,"coveredDatabaseRoles":self.manifest["coverage"]["coveredDatabaseRoles"],"blockers":blockers})
    }
    pub fn recover_pending_mutations(&mut self, database: &mut Connection) -> Result<Value> {
        let result = super::recovery::recover_sqlite_mutations_v1(
            database,
            &mut self.authority,
            self.clock.as_mut(),
        )?;
        self.mark_recovered_heads(&result)?;
        Ok(result)
    }
    fn mark_recovered_heads(&mut self, recovery: &Value) -> Result<()> {
        if let Some(fence) = &mut self.fence {
            for head in recovery["finalizedHeads"]
                .as_array()
                .ok_or_else(|| error("externally_fenced_sqlite_mutation_recovery_result_invalid"))?
            {
                fence.mark_mutation_finalized(&json!({"globalSequence":head["globalSequence"],"globalHash":head["globalHash"]}))?;
            }
        }
        Ok(())
    }
    fn control(
        &mut self,
        code: &str,
        input: &Value,
        extra: Value,
        reconcile: bool,
    ) -> Result<SqliteMutationCoordinatorError> {
        if reconcile && let Some(fence) = &mut self.fence {
            fence.mark_mutation_reconciliation_required(&json!({"reason":code,"databaseRole":input["databaseRole"],"databaseInstanceId":input["databaseInstanceId"],"reservationId":extra.get("reservationId").cloned().unwrap_or(Value::Null),"mutationAttemptId":extra.get("mutationAttemptId").cloned().unwrap_or(Value::Null),"committed":extra.get("committed").cloned().unwrap_or(json!(false))}))?;
        }
        let mut failure = error(code);
        failure.details = extra;
        if self.fence.is_some() {
            failure.state_recoverability_deferred = true;
            failure.retryable = true;
        }
        Ok(failure)
    }
    /// The callback receives only prepared, fixed statements; it never receives
    /// a raw Connection, SQL string execution surface, or external authority.
    ///
    /// A callback cannot simultaneously capture the coordinator's connection.
    /// ```compile_fail
    /// use hepta_paper_service::sqlite_mutation_coordinator::{SqliteMutationCoordinatorV1,
    ///     authority::MutationAuthorityTransportV1};
    /// use rusqlite::Connection;
    /// use serde_json::Value;
    /// fn escape<T: MutationAuthorityTransportV1>(coordinator: &mut SqliteMutationCoordinatorV1<T>,
    ///     database: &mut Connection, input: &Value) {
    ///     let _ = coordinator.execute_mutation(database, input, |_| {
    ///         database.execute_batch("COMMIT;")?;
    ///         Ok(Value::Null)
    ///     });
    /// }
    /// ```
    pub fn execute_mutation(
        &mut self,
        database: &mut Connection,
        input: &Value,
        mutate: impl FnOnce(&mut RestrictedMutationTransactionV1<'_>) -> Result<Value>,
    ) -> Result<Value> {
        let operation_id = input["operationId"].as_str().unwrap_or("");
        let operation = self.manifest["operations"]
            .as_array()
            .and_then(|a| a.iter().find(|o| o["operationId"] == operation_id));
        let writer = self.manifest["writers"].as_array().and_then(|a| {
            a.iter().find(|w| {
                w["writerId"] == input["writerId"]
                    && w["operationIds"]
                        .as_array()
                        .is_some_and(|a| a.contains(&input["operationId"]))
            })
        });
        let plan = self.plans.get(operation_id);
        if operation.is_none_or(|o| {
            o["coordinatorIntegrated"] != true || o["databaseRole"] != input["databaseRole"]
        }) || writer.is_none_or(|w| {
            !sha(&w["implementationHash"])
                || input
                    .get("codeProvenanceHash")
                    .is_some_and(|v| v != &w["implementationHash"])
        }) || plan.is_none()
            || !["databaseInstanceId", "schemaContractId"]
                .iter()
                .all(|k| input[k].as_str().is_some_and(|s| !s.is_empty()))
            || !input["authorizationReceiptHashes"].is_array()
            || !input["sideEffectReservationHashes"].is_array()
            || self.authority.trust()["writerManifestHash"]
                != manifest::writer_manifest_hash_v1(&self.manifest)?
        {
            return Err(error("externally_fenced_sqlite_mutation_input_invalid"));
        }
        let plan = plan
            .cloned()
            .ok_or_else(|| error("externally_fenced_sqlite_mutation_input_invalid"))?;
        let writer_hash=writer.ok_or_else(||error("externally_fenced_sqlite_mutation_input_invalid"))?["implementationHash"].clone();
        if !database.is_autocommit() {
            return Err(error("externally_fenced_sqlite_mutation_nested_forbidden"));
        }
        let meta = storage::metadata(database)?;
        let schema = storage::exact_schema_hash_v1(database)?;
        if meta["protocol"] != ONLINE_MUTATION_PROTOCOL
            || meta["database_role"] != input["databaseRole"]
            || meta["database_instance_id"] != input["databaseInstanceId"]
            || meta["schema_contract_id"] != input["schemaContractId"]
            || meta["schema_hash"] != schema
            || meta["database_scope_hash"] != self.authority.trust()["databaseScopeHash"]
            || meta["writer_manifest_hash"] != self.authority.trust()["writerManifestHash"]
        {
            return Err(error("externally_fenced_sqlite_mutation_metadata_mismatch"));
        }
        let pending = storage::pending_count(database)?;
        if pending != 0 {
            let recovered = match super::recovery::recover_sqlite_mutations_v1(
                database,
                &mut self.authority,
                self.clock.as_mut(),
            ) {
                Ok(recovered) => recovered,
                Err(cause) => {
                    if cause.state_recoverability_fatal {
                        return Err(cause);
                    }
                    return Err(self.control(
                        "externally_fenced_sqlite_mutation_pending_recovery_failed",
                        input,
                        json!({"pendingFinalizationCount":pending,"cause":cause.projection()}),
                        true,
                    )?);
                }
            };
            self.mark_recovered_heads(&recovered)?;
            if storage::pending_count(database)? != 0 {
                return Err(self.control("externally_fenced_sqlite_mutation_pending_recovery_incomplete",input,json!({"pendingFinalizationCount":pending,"recoveredReservationIds":recovered["recoveredReservationIds"]}),true)?);
            }
            return Err(self.control(
                "externally_fenced_sqlite_mutation_pending_recovery_completed_retry_required",
                input,
                json!({"recoveredReservationIds":recovered["recoveredReservationIds"]}),
                false,
            )?);
        }
        assert_sqlite_mutation_database_surface_v1(database, &plan)?;
        let requested_at = observe(self.clock.as_mut())?.1;
        let trust = self.authority.trust().clone();
        let head_request = json!({"version":1,"kind":"AutonomousResearchOnlineMutationCurrentHeadRequest","protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":trust["scopeId"],"databaseScopeHash":trust["databaseScopeHash"],"writerManifestHash":trust["writerManifestHash"],"nonce":nonce("head")?,"requestedAt":requested_at});
        let authority_head = self.authority.observe_current_head(
            &head_request,
            Some(&self.database_instances),
            observe(self.clock.as_mut())?.0,
        )?;
        let local_head = storage::latest_local_head(database, text(input, "databaseInstanceId")?)?;
        let heads = authority_head.value()["databaseHeads"]
            .as_array()
            .ok_or_else(|| error("externally_fenced_sqlite_mutation_authority_head_missing"))?;
        let matched = heads
            .iter()
            .filter(|h| {
                h["databaseRole"] == input["databaseRole"]
                    && h["databaseInstanceId"] == input["databaseInstanceId"]
            })
            .collect::<Vec<_>>();
        if matched.len() != 1 {
            return Err(error(
                "externally_fenced_sqlite_mutation_authority_head_missing",
            ));
        }
        let database_head = matched
            .first()
            .ok_or_else(|| error("externally_fenced_sqlite_mutation_authority_head_missing"))?;
        if !["sequence", "hash", "schemaHash", "stateHash"]
            .iter()
            .all(|k| database_head[k] == local_head[k])
        {
            return Err(error(
                "externally_fenced_sqlite_mutation_local_authority_head_mismatch",
            ));
        }
        let counts = storage::system_counts(database)?;
        let mut began = false;
        let mut committed = false;
        let mut commit_attempted = false;
        let mut reservation: Option<VerifiedMutationReceiptV1> = None;
        let mut abort_reason = "local-apply-failed";
        let operation = (|| {
            database.execute_batch("BEGIN IMMEDIATE;")?;
            let rollback_on_exit = RollbackOnExit(database);
            let database = &mut *rollback_on_exit.0;
            began = true;
            if local_head
                != storage::latest_local_head(database, text(input, "databaseInstanceId")?)?
            {
                return Err(error(
                    "externally_fenced_sqlite_mutation_local_head_changed",
                ));
            }
            let (value, changeset) = with_restricted_sqlite_mutation_v1(database, &plan, mutate)?;
            if database.is_autocommit() {
                return Err(error(
                    "externally_fenced_sqlite_mutation_transaction_boundary_escaped",
                ));
            }
            if storage::exact_schema_hash_v1(database)? != schema {
                return Err(error("externally_fenced_sqlite_mutation_ddl_forbidden"));
            }
            if counts != storage::system_counts(database)? {
                return Err(error(
                    "externally_fenced_sqlite_mutation_system_table_write_forbidden",
                ));
            }
            if changeset.is_empty() {
                database.execute_batch("ROLLBACK;")?;
                began = false;
                return Ok(
                    json!({"version":1,"kind":"ExternallyFencedSqliteMutationReceipt","status":"externally_fenced_sqlite_mutation_no_change","value":value,"sideEffectPermitHash":null}),
                );
            }
            let changeset_hash = hash_bytes(&changeset);
            let state = contracts::online_mutation_state_hash_v1(
                &json!({"databaseRole":input["databaseRole"],"databaseInstanceId":input["databaseInstanceId"],"writerId":input["writerId"],"operationId":input["operationId"],"schemaHash":schema,"previousStateHash":database_head["stateHash"],"changesetHash":changeset_hash,"databaseSequence":int(database_head,"sequence")?+1,"authorizationReceiptHashes":input["authorizationReceiptHashes"],"sideEffectReservationHashes":input["sideEffectReservationHashes"]}),
            )?;
            let request = json!({"version":1,"kind":"AutonomousResearchOnlineMutationReserveRequest","protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":trust["scopeId"],"databaseScopeHash":trust["databaseScopeHash"],"writerManifestHash":trust["writerManifestHash"],"databaseRole":input["databaseRole"],"databaseInstanceId":input["databaseInstanceId"],"writerId":input["writerId"],"operationId":input["operationId"],"codeProvenanceHash":writer_hash,"mutationAttemptId":nonce("mutation")?,"globalPreviousSequence":authority_head.value()["globalSequence"],"globalPreviousHash":authority_head.value()["globalHash"],"databasePreviousSequence":database_head["sequence"],"databasePreviousHash":database_head["hash"],"schemaContractId":input["schemaContractId"],"schemaHash":schema,"preStateHash":database_head["stateHash"],"postStateHash":state,"changesetEncoding":"base64","changesetBase64":Base64::encode_string(&changeset),"changesetByteLength":changeset.len(),"changesetHash":changeset_hash,"authorizationReceiptHashes":input["authorizationReceiptHashes"],"sideEffectReservationHashes":input["sideEffectReservationHashes"],"requestedAt":observe(self.clock.as_mut())?.1,"requestedLeaseMs":self.requested_lease_ms});
            contracts::assert_reserve_request_v1(&request, &trust)?;
            reservation = match self
                .authority
                .reserve_mutation(&request, observe(self.clock.as_mut())?.0)
            {
                Ok(reservation) => Some(reservation),
                Err(cause) => {
                    let resolution = contracts::build_resolution_request_v1(
                        &request,
                        &json!(observe(self.clock.as_mut())?.1),
                    )?;
                    match self.authority.resolve_mutation_attempt(&resolution,&request,observe(self.clock.as_mut())?.0){Ok(Some(reservation))=>Some(reservation),Ok(None)=>{let mut failure=error("externally_fenced_sqlite_mutation_reservation_not_applied");failure.details=json!({"mutationAttemptId":request["mutationAttemptId"],"cause":cause.projection()});return Err(failure)},Err(resolution_cause)=>return Err(self.control("externally_fenced_sqlite_mutation_reservation_resolution_pending",input,json!({"mutationAttemptId":request["mutationAttemptId"],"cause":cause.projection(),"resolutionCause":resolution_cause.projection()}),true)?)}
                }
            };
            let reserved = reservation.as_ref().ok_or_else(|| {
                error("externally_fenced_sqlite_mutation_reservation_not_applied")
            })?;
            let (commit_now, committed_at) = observe(self.clock.as_mut())?;
            let expires = timestamp(&reserved.value()["expiresAt"])
                .ok_or_else(|| error("externally_fenced_sqlite_mutation_reservation_expiring"))?;
            if expires - commit_now < self.commit_safety_margin_ms {
                return Err(error(
                    "externally_fenced_sqlite_mutation_reservation_expiring",
                ));
            }
            let final_request =
                contracts::build_finalize_request_v1(reserved.value(), &json!(committed_at))?;
            abort_reason = "local-marker-failed";
            storage::insert_marker(database, reserved.value(), &final_request, &request)?;
            abort_reason = "local-commit-failed";
            if expires - observe(self.clock.as_mut())?.0 < self.commit_safety_margin_ms {
                return Err(error(
                    "externally_fenced_sqlite_mutation_reservation_expiring",
                ));
            }
            commit_attempted = true;
            if let Err(cause) = database.execute_batch("COMMIT;") {
                return Err(self.control("externally_fenced_sqlite_mutation_commit_outcome_unknown",input,json!({"committed":"unknown","reservationId":reserved.value()["reservationId"],"mutationAttemptId":request["mutationAttemptId"],"cause":cause.to_string()}),true)?);
            }
            began = false;
            committed = true;
            let finalized=match self.authority.finalize_mutation(&final_request,reserved,observe(self.clock.as_mut())?.0){Ok(receipt)=>receipt,Err(cause)=>return Err(self.control("externally_fenced_sqlite_mutation_committed_finalization_pending",input,json!({"committed":true,"reservationId":reserved.value()["reservationId"],"mutationAttemptId":request["mutationAttemptId"],"cause":cause.projection()}),true)?)};
            if let Err(cause) = storage::record_finalization(
                database,
                finalized.value(),
                &observe(self.clock.as_mut())?.1,
            ) {
                return Err(self.control("externally_fenced_sqlite_mutation_committed_finalization_record_pending",input,json!({"committed":true,"reservationId":reserved.value()["reservationId"],"mutationAttemptId":request["mutationAttemptId"],"cause":cause.projection()}),true)?);
            }
            if let Some(fence) = &mut self.fence {
                fence.mark_mutation_finalized(&json!({"globalSequence":finalized.value()["globalSequence"],"globalHash":finalized.value()["globalHash"]})).map_err(|mut e|{e.details["committed"]=json!(true);e.details["reservationId"]=reserved.value()["reservationId"].clone();e})?;
            }
            Ok(
                json!({"version":1,"kind":"ExternallyFencedSqliteMutationReceipt","status":"externally_fenced_sqlite_mutation_finalized","value":value,"reservationId":reserved.value()["reservationId"],"reservationReceiptHash":contracts::online_mutation_receipt_hash_v1(reserved.value())?,"finalizationReceiptHash":contracts::online_mutation_receipt_hash_v1(finalized.value())?,"sideEffectPermitHash":finalized.value()["sideEffectPermitHash"]}),
            )
        })();
        if let Err(cause) = operation {
            if began && !database.is_autocommit() {
                let _ = database.execute_batch("ROLLBACK;");
            }
            if let Some(reserved) = reservation
                .as_ref()
                .filter(|_| !committed && !commit_attempted)
            {
                let aborted = (|| {
                    let request = contracts::build_abort_request_v1(
                        reserved.value(),
                        abort_reason,
                        &json!(observe(self.clock.as_mut())?.1),
                    )?;
                    self.authority.abort_mutation(
                        &request,
                        reserved,
                        observe(self.clock.as_mut())?.0,
                    )?;
                    Ok::<(), SqliteMutationCoordinatorError>(())
                })();
                if let Err(abort_cause) = aborted {
                    return Err(self.control("externally_fenced_sqlite_mutation_reservation_abort_pending",input,json!({"committed":false,"reservationId":reserved.value()["reservationId"],"mutationAttemptId":reserved.value()["mutationAttemptId"],"cause":cause.projection(),"abortCause":abort_cause.projection()}),true)?);
                }
            }
            return Err(cause);
        }
        operation
    }
}
