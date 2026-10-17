//! Bounded observation for the EXISTING passive reconciliation planner. The
//! retained generic store owns filesystem coordination/currentness; this
//! module neither accepts writer admission nor exposes a new SQL interface.
use super::{AutomationRuntimeReconciliationError as Error, LocalReconciliationOperationV1};
use rusqlite::{Connection, Row, types::ValueRef};
use std::{
    cell::Cell,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};

pub(crate) const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_ROWS: usize = 20_000;
const MAX_CELL_BYTES: usize = 1024 * 1024;
const MAX_SELECTED_BYTES: usize = 4 * 1024 * 1024;
const MAX_VM_STEPS: u64 = 20_000_000;

pub(crate) struct ReconciliationReadControlV1 {
    pub(crate) cancelled: Arc<AtomicBool>,
    pub(crate) deadline: Instant,
    rows: Cell<usize>,
    bytes: Cell<usize>,
    vm_steps: Arc<AtomicU64>,
}
impl ReconciliationReadControlV1 {
    pub(crate) fn new(cancelled: Arc<AtomicBool>, deadline: Instant) -> Self {
        Self {
            cancelled,
            deadline,
            rows: Cell::new(0),
            bytes: Cell::new(0),
            vm_steps: Arc::new(AtomicU64::new(0)),
        }
    }
    pub(crate) fn checkpoint(&self) -> Result<(), Error> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(Error::Precondition("automation_reconciliation_cancelled"));
        }
        if Instant::now() >= self.deadline {
            return Err(Error::Precondition(
                "automation_reconciliation_deadline_exceeded",
            ));
        }
        if self.vm_steps.load(Ordering::Acquire) >= MAX_VM_STEPS {
            return Err(Error::Precondition(
                "automation_reconciliation_vm_limit_exceeded",
            ));
        }
        Ok(())
    }
    pub(crate) fn map_database(&self, error: rusqlite::Error) -> Error {
        self.checkpoint().err().unwrap_or(Error::Database(error))
    }
    fn charge(&self, bytes: usize) -> Result<(), Error> {
        self.checkpoint()?;
        let next = self
            .bytes
            .get()
            .checked_add(bytes)
            .filter(|n| *n <= MAX_SELECTED_BYTES)
            .ok_or(Error::Precondition(
                "automation_reconciliation_selected_bytes_exceeded",
            ))?;
        self.bytes.set(next);
        Ok(())
    }
    pub(super) fn charge_row(&self, row: &Row<'_>) -> Result<(), Error> {
        self.checkpoint()?;
        let next = self
            .rows
            .get()
            .checked_add(1)
            .filter(|n| *n <= MAX_ROWS)
            .ok_or(Error::Precondition(
                "automation_reconciliation_selected_rows_exceeded",
            ))?;
        self.rows.set(next);
        for i in 0..row.as_ref().column_count() {
            self.charge(row.as_ref().column_name(i)?.len())?;
            let bytes = match row.get_ref(i)? {
                ValueRef::Text(value) | ValueRef::Blob(value) => value.len(),
                _ => 32,
            };
            if bytes > MAX_CELL_BYTES {
                return Err(Error::Precondition(
                    "automation_reconciliation_cell_bytes_exceeded",
                ));
            }
            self.charge(bytes)?;
        }
        Ok(())
    }
    pub(crate) fn install(&self, connection: &Connection) -> Result<(), Error> {
        self.checkpoint()?;
        let cancelled = self.cancelled.clone();
        let deadline = self.deadline;
        let steps = self.vm_steps.clone();
        connection.progress_handler(
            1000,
            Some(move || {
                let used = steps.fetch_add(1000, Ordering::AcqRel);
                cancelled.load(Ordering::Acquire)
                    || Instant::now() >= deadline
                    || used >= MAX_VM_STEPS - 1000
            }),
        )?;
        connection.set_limit(
            rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
            MAX_CELL_BYTES as i32,
        )?;
        connection.busy_timeout(std::time::Duration::from_secs(10))?;
        Ok(())
    }
}

fn verify_campaign_scope_with_control(
    connection: &Connection,
    campaign: Option<&str>,
    control: &ReconciliationReadControlV1,
) -> Result<(), Error> {
    let Some(campaign) = campaign else {
        return Ok(());
    };
    if !super::valid_campaign_id(campaign) {
        return Err(Error::Precondition(
            "automation_runtime_reconciliation_campaign_id_invalid",
        ));
    }
    // Same fixed scope SQL as the original planner; retain its exact count and
    // reason instead of flattening ordinary refusals into the flat Input error.
    let rows = super::rows_with_control(
        connection,
        "SELECT campaign_id, CAST(coalesce(json_extract(spec_json, '$.terminalSiblingSettlementPolicyVersion'),0) AS INTEGER) AS policy_version FROM paper_campaigns WHERE campaign_id=?1 LIMIT 2",
        [campaign],
        Some(control),
    )?;
    if rows.len() != 1 || rows[0]["campaign_id"] != campaign {
        return Err(Error::Precondition(
            "automation_runtime_reconciliation_campaign_scope_not_found",
        ));
    }
    if rows[0]["policy_version"].as_f64() != Some(1.0) {
        return Err(Error::Precondition(
            "automation_runtime_reconciliation_campaign_scope_policy_unsupported",
        ));
    }
    Ok(())
}

pub(crate) fn inspect_current_with_control_v1(
    database: &Path,
    campaign: Option<&str>,
    operation: LocalReconciliationOperationV1,
    control: &ReconciliationReadControlV1,
) -> Result<
    (
        serde_json::Value,
        hepta_readonly_store::OrdinaryReadOnlyStoreV1,
    ),
    Error,
> {
    use super::offline_execution::{ReconciliationClockV1, SystemReconciliationClockV1};
    control.checkpoint()?;
    super::canonical_database(database)?;
    // Reuse the held main/WAL/SHM/journal and typed coordination owner. A
    // second fixed read-only planner connection carries the same absolute
    // controls and is closed before the retained owner performs final checks.
    let retained = hepta_readonly_store::OrdinaryReadOnlyStoreV1::open_with_cancellation(
        database,
        control.cancelled.clone(),
        control.deadline,
    )
    .map_err(|error| Error::Admission(error.to_string()))?;
    control.checkpoint()?;
    let connection = super::open_database(database)?;
    control.install(&connection)?;
    let mut clock = SystemReconciliationClockV1;
    let plan = match operation {
        LocalReconciliationOperationV1::Standard => {
            verify_campaign_scope_with_control(&connection, campaign, control)?;
            control.checkpoint()?;
            let now = clock.now_iso()?;
            let cutoff_now = clock.now_millis()?;
            super::plan_on_connection_at_with_control(
                &connection,
                &now,
                cutoff_now,
                1800.0,
                campaign,
                Some(control),
            )
        }
        LocalReconciliationOperationV1::LegacyTerminalActiveResidue => {
            let campaign = campaign.ok_or(Error::Precondition(
                "legacy_terminal_active_residue_campaign_id_invalid",
            ))?;
            super::legacy_terminal_residue::plan_with_clock_and_control(
                &connection,
                campaign,
                &mut || clock.now_iso(),
                control,
            )
        }
    }
    .map_err(|error| control.checkpoint().err().unwrap_or(error));
    drop(connection);
    // After the planner returns, check currentness before considering its
    // result. Earlier scope/open refusals close the retained owner through RAII.
    retained
        .verify_unchanged()
        .map_err(|error| Error::Admission(error.to_string()))?;
    control.checkpoint()?;
    plan.map(|report| (report, retained))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inherited_cancel_and_deadline_refuse_before_database_io() {
        let flag = Arc::new(AtomicBool::new(true));
        let cancelled = ReconciliationReadControlV1::new(
            flag,
            Instant::now() + std::time::Duration::from_secs(120),
        );
        assert!(matches!(
            inspect_current_with_control_v1(
                Path::new("/missing-reconcile-input"),
                None,
                LocalReconciliationOperationV1::Standard,
                &cancelled
            ),
            Err(Error::Precondition("automation_reconciliation_cancelled"))
        ));
        let expired =
            ReconciliationReadControlV1::new(Arc::new(AtomicBool::new(false)), Instant::now());
        assert!(matches!(
            inspect_current_with_control_v1(
                Path::new("/missing-reconcile-input"),
                None,
                LocalReconciliationOperationV1::LegacyTerminalActiveResidue,
                &expired
            ),
            Err(Error::Precondition(
                "automation_reconciliation_deadline_exceeded"
            ))
        ));
    }
    #[test]
    fn selected_rows_and_cells_are_charged_before_json_allocation_and_fresh_retry() {
        let connection = Connection::open_in_memory().unwrap();
        let control = ReconciliationReadControlV1::new(
            Arc::new(AtomicBool::new(false)),
            Instant::now() + std::time::Duration::from_secs(120),
        );
        let oversized = super::super::rows_with_control(
            &connection,
            "SELECT zeroblob(?1) AS data",
            [(MAX_CELL_BYTES + 1) as i64],
            Some(&control),
        );
        assert!(matches!(
            oversized,
            Err(Error::Precondition(
                "automation_reconciliation_cell_bytes_exceeded"
            ))
        ));
        let fresh =
            ReconciliationReadControlV1::new(Arc::new(AtomicBool::new(false)), control.deadline);
        assert_eq!(
            super::super::rows_with_control(
                &connection,
                "SELECT 'actual' AS data",
                [],
                Some(&fresh)
            )
            .unwrap(),
            vec![serde_json::json!({"data":"actual"})]
        );
        fresh.rows.set(MAX_ROWS);
        assert!(matches!(
            super::super::rows_with_control(&connection, "SELECT 1 AS data", [], Some(&fresh)),
            Err(Error::Precondition(
                "automation_reconciliation_selected_rows_exceeded"
            ))
        ));
    }
    #[test]
    fn sqlite_vm_progress_refuses_exhaustion_and_actual_cancel_then_fresh_connection() {
        let connection = Connection::open_in_memory().unwrap();
        let control = ReconciliationReadControlV1::new(
            Arc::new(AtomicBool::new(false)),
            Instant::now() + std::time::Duration::from_secs(120),
        );
        control.install(&connection).unwrap();
        control
            .vm_steps
            .store(MAX_VM_STEPS - 1000, Ordering::Release);
        let error = connection.query_row::<i64,_,_>("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) FROM n", [], |row| row.get(0)).unwrap_err();
        assert!(matches!(
            control.map_database(error),
            Error::Precondition("automation_reconciliation_vm_limit_exceeded")
        ));
        let actual_cancel = ReconciliationReadControlV1::new(
            Arc::new(AtomicBool::new(false)),
            Instant::now() + std::time::Duration::from_secs(120),
        );
        actual_cancel.install(&connection).unwrap();
        actual_cancel.cancelled.store(true, Ordering::Release);
        let cancelled = connection.query_row::<i64,_,_>("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) FROM n", [], |row| row.get(0)).unwrap_err();
        assert!(matches!(
            actual_cancel.map_database(cancelled),
            Error::Precondition("automation_reconciliation_cancelled")
        ));
        let fresh = Connection::open_in_memory().unwrap();
        assert_eq!(
            fresh
                .query_row::<i64, _, _>("SELECT 1", [], |row| row.get(0))
                .unwrap(),
            1
        );
    }
}
