//! Private online business operation using the actual signed coordinator.
//!
//! This is not an admission or activation constructor. Only a future concrete
//! retained runtime capability may call it outside local differential tests.
//! Statement callbacks and the genuine post-reservation pre-COMMIT check are
//! distinct. None can substitute for retaining the writer scope throughout.
use super::{
    AutomationRuntimeReconciliationError, LocalReconciliationOperationV1,
    legacy_terminal_residue::online as legacy,
    offline_execution::{ReconciliationClockV1, online as standard},
};
use crate::sqlite_mutation_coordinator::{
    Result, SqliteMutationCoordinatorError, SqliteMutationCoordinatorV1,
    authority::MutationAuthorityTransportV1, error,
};
use crate::sqlite_mutation_plan::RestrictedMutationTransactionV1;
use rusqlite::{Connection, types::Value as SqlValue};
use serde_json::{Value, json};

const WRITER: &str = "writer:native-store:automation-runtime-reconciler:v1";
const STANDARD: &str =
    "native-store.automation-runtime-reconciler.executeAutomationRuntimeReconciliation.v1";
const LEGACY: &str = "native-store.legacy-terminal-active-residue-settlement.executeLegacyTerminalActiveResidueSettlement.v1";

pub(crate) struct OnlineReconciliationBindingV1 {
    pub(crate) database_instance_id: String,
    pub(crate) schema_contract_id: String,
}
pub(crate) struct OnlineReconciliationRequestV1 {
    pub(crate) operation: LocalReconciliationOperationV1,
    pub(crate) campaign_id: Option<String>,
    pub(crate) no_progress_seconds: f64,
    pub(crate) release_commit: Option<String>,
}
pub(super) fn business_error(
    cause: AutomationRuntimeReconciliationError,
) -> SqliteMutationCoordinatorError {
    error(cause.to_string())
}
fn sql_value(value: Value) -> Result<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::String(v) => SqlValue::Text(v),
        Value::Bool(v) => SqlValue::Integer(i64::from(v)),
        Value::Number(v) => {
            if let Some(v) = v.as_i64() {
                SqlValue::Integer(v)
            } else {
                SqlValue::Real(
                    v.as_f64().ok_or_else(|| {
                        error("automation_runtime_reconciliation_parameter_invalid")
                    })?,
                )
            }
        }
        _ => return Err(error("automation_runtime_reconciliation_parameter_invalid")),
    })
}
pub(super) fn run(
    transaction: &mut RestrictedMutationTransactionV1<'_>,
    statement: &str,
    values: Vec<Value>,
) -> Result<u64> {
    let id = if statement == "native-store.receipt-ledger.insert.v1" {
        statement.to_owned()
    } else {
        format!("native-store.automation-runtime-reconciliation.{statement}.v1")
    };
    let parameters = values
        .into_iter()
        .map(sql_value)
        .collect::<Result<Vec<_>>>()?;
    transaction.run(&id, &parameters)?["changes"]
        .as_u64()
        .ok_or_else(|| error("automation_runtime_reconciliation_changes_invalid"))
}
pub(super) fn one(
    transaction: &mut RestrictedMutationTransactionV1<'_>,
    statement: &str,
    values: Vec<Value>,
    failure: &str,
) -> Result<()> {
    if run(transaction, statement, values)? != 1 {
        return Err(error(failure));
    }
    Ok(())
}
fn committed(
    mut cause: SqliteMutationCoordinatorError,
    mutation: &Value,
) -> SqliteMutationCoordinatorError {
    cause.details["committed"] = json!(true);
    cause.details["reservationId"] = mutation["reservationId"].clone();
    cause.details["reservationReceiptHash"] = mutation["reservationReceiptHash"].clone();
    cause.details["finalizationReceiptHash"] = mutation["finalizationReceiptHash"].clone();
    cause
}
fn rejected_mutation(code: &str, mutation: &Value) -> SqliteMutationCoordinatorError {
    if mutation["status"] == "externally_fenced_sqlite_mutation_finalized" {
        committed(error(code), mutation)
    } else {
        let mut cause = error(code);
        cause.details["committed"] = json!(false);
        cause
    }
}

/// The input fixes the source-owned writer and operation membership. The real
/// coordinator independently authenticates its plan hash, exact database
/// metadata, signed head and finalization. It signs the actual captured changeset
/// containing both business rows and the strict receipt insertion.
#[allow(clippy::too_many_arguments)] // Keep the three distinct scope-check boundaries explicit.
pub(super) fn execute_with_coordinator<T: MutationAuthorityTransportV1>(
    connection: &mut Connection,
    coordinator: &mut SqliteMutationCoordinatorV1<T>,
    binding: &OnlineReconciliationBindingV1,
    request: &OnlineReconciliationRequestV1,
    clock: &mut dyn ReconciliationClockV1,
    before_apply: impl FnOnce() -> Result<()>,
    after_apply: impl FnOnce() -> Result<()>,
    before_commit: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let legacy = matches!(
        request.operation,
        LocalReconciliationOperationV1::LegacyTerminalActiveResidue
    );
    let input = json!({"databaseRole":"native-store","databaseInstanceId":binding.database_instance_id,
        "schemaContractId":binding.schema_contract_id,"writerId":WRITER,"operationId":if legacy {LEGACY} else {STANDARD},
        "authorizationReceiptHashes":[],"sideEffectReservationHashes":[]});
    if legacy {
        let campaign = request
            .campaign_id
            .as_deref()
            .ok_or_else(|| error("legacy_terminal_active_residue_campaign_id_required"))?;
        let prepared = legacy::prepare_online(
            connection,
            campaign,
            request.release_commit.as_deref(),
            clock,
        )?;
        let count = legacy::count(&prepared);
        let mutation = coordinator.execute_mutation_with_precommit_guard_v1(
            connection,
            &input,
            |transaction| {
                before_apply()?;
                let value = legacy::apply_online(transaction, &prepared)?;
                after_apply()?;
                Ok(value)
            },
            before_commit,
        )?;
        if mutation["status"] != "externally_fenced_sqlite_mutation_finalized"
            || mutation["value"]["ledgerChanges"] != 1
            || mutation["value"]["settledNodeCount"] != count
        {
            return Err(rejected_mutation(
                "legacy_terminal_active_residue_external_mutation_receipt_invalid",
                &mutation,
            ));
        }
        legacy::finish_online(connection, prepared, clock).map_err(|e| committed(e, &mutation))
    } else {
        let campaign = request.campaign_id.as_deref();
        let prepared = standard::prepare(
            connection,
            clock,
            request.no_progress_seconds,
            campaign,
            request.release_commit.as_deref(),
        )?;
        let mutation = coordinator.execute_mutation_with_precommit_guard_v1(
            connection,
            &input,
            |transaction| {
                before_apply()?;
                let value = standard::apply(transaction, &prepared)?;
                after_apply()?;
                Ok(value)
            },
            before_commit,
        )?;
        if mutation["status"] != "externally_fenced_sqlite_mutation_finalized"
            || mutation["value"]["ledgerChanges"] != 1
        {
            return Err(rejected_mutation(
                "automation_runtime_reconciliation_external_mutation_receipt_invalid",
                &mutation,
            ));
        }
        standard::finish(
            connection,
            prepared,
            clock,
            request.no_progress_seconds,
            campaign,
        )
        .map_err(|e| committed(e, &mutation))
    }
}

#[cfg(test)]
mod tests;
