//! Fixed native observation behind Node's automation-store operational integrity
//! inspection. This is a store diagnostic, not an automation-readiness result,
//! schema qualification, recovery action, or permission to mutate a campaign.
use crate::{OrdinaryReadOnlyStoreV1, ReadOnlyStoreError as Error, ordinary::ReadControl};
use rusqlite::{Connection, Params, types::ValueRef};
use serde::Serialize;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

const MAX_VM_STEPS: u64 = 20_000_000;
const MAX_COLUMN_BYTES: usize = 64 * 1024;
const MAX_COLUMNS: usize = 4096;
const MAX_SELECTED_BYTES: usize = 1024 * 1024;
const DATE_LIMIT: i64 = 8_640_000_000_000_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Finite, integral millisecond profile of Node's Date/ISO observation clock.
/// No clock here establishes lease authority. The default no-progress window is
/// the incumbent's thirty minutes; callers can supply a nonnegative window
/// within JavaScript's safe-integer range. Larger integers are rejected rather
/// than silently using a different cutoff from Node's Number conversion.
#[derive(Clone, Debug)]
pub struct AutomationIntegrityTimeV1 {
    inspected_at: String,
    no_progress_cutoff: String,
}
impl AutomationIntegrityTimeV1 {
    pub fn new(inspected_at_unix_ms: i64) -> Result<Self, Error> {
        Self::with_no_progress_window(inspected_at_unix_ms, 30 * 60 * 1000)
    }
    pub fn with_no_progress_window(
        inspected_at_unix_ms: i64,
        window_ms: u64,
    ) -> Result<Self, Error> {
        let inspected_at =
            iso(inspected_at_unix_ms).ok_or(Error::AutomationInspectionTimeInvalid)?;
        if window_ms > MAX_SAFE_INTEGER {
            return Err(Error::AutomationNoProgressWindowInvalid);
        }
        let cutoff = i64::try_from(window_ms)
            .ok()
            .and_then(|window| inspected_at_unix_ms.checked_sub(window))
            .and_then(iso)
            .ok_or(Error::AutomationNoProgressWindowInvalid)?;
        Ok(Self {
            inspected_at,
            no_progress_cutoff: cutoff,
        })
    }
}

// Gregorian UTC formatting over the ECMAScript TimeClip domain, including its
// signed six-digit extended years. Values are bound as SQL parameters below.
fn iso(value: i64) -> Option<String> {
    if !(-DATE_LIMIT..=DATE_LIMIT).contains(&value) {
        return None;
    }
    let days = value.div_euclid(86_400_000);
    let clock = value.rem_euclid(86_400_000);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!(
            "{}{year:06}",
            if year < 0 { "-" } else { "+" },
            year = year.abs()
        )
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        clock / 3_600_000,
        (clock / 60_000) % 60,
        (clock / 1000) % 60,
        clock % 1000
    ))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationStoreQuickCheckV1 {
    pub value: Option<String>,
    pub ready: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationStoreTableInspectionV1 {
    pub table: &'static str,
    pub required_columns: &'static [&'static str],
    pub observed_columns: Vec<String>,
    pub missing_columns: Vec<&'static str>,
    pub ready: bool,
}
/// The incumbent diagnostic wire fields, populated only from fixed SQL over a
/// retained read-only SQLite snapshot. Missing/failed counts remain null.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationStoreOperationalIntegrityV1 {
    pub version: u8,
    pub kind: &'static str,
    pub status: &'static str,
    pub inspected_at: String,
    pub quick_check: AutomationStoreQuickCheckV1,
    pub required_table_inspections: Vec<AutomationStoreTableInspectionV1>,
    pub expired_active_node_count: Option<u64>,
    pub expired_resource_lease_count: Option<u64>,
    pub expired_waiter_count: Option<u64>,
    pub stalled_recoverable_campaign_count: Option<u64>,
    pub no_progress_running_campaign_count: Option<u64>,
    pub terminal_campaign_queued_node_count: Option<u64>,
    pub reconcilable_terminal_campaign_queued_node_count: Option<u64>,
    pub preserved_legacy_terminal_campaign_queued_node_count: Option<u64>,
    pub invalid_terminal_campaign_settlement_policy_queued_node_count: Option<u64>,
    pub query_ready: bool,
    pub degraded: bool,
    pub blockers: Vec<String>,
}

const TABLES: &[(&str, &[&str])] = &[
    ("paper_campaigns", &["campaign_id", "status", "updated_at"]),
    (
        "campaign_nodes",
        &["node_id", "campaign_id", "status", "lease_expires_at"],
    ),
    ("campaign_events", &["event_id", "campaign_id", "kind"]),
    ("automation_resource_leases", &["lease_id", "expires_at"]),
    ("automation_resource_waiters", &["waiter_id", "expires_at"]),
];

struct ProjectionControl<'a> {
    original: &'a ReadControl,
    steps: Arc<AtomicU64>,
    bytes: usize,
}
impl ProjectionControl<'_> {
    fn check(&self) -> Result<(), Error> {
        self.original.check()?;
        if self.steps.load(Ordering::Acquire) >= MAX_VM_STEPS {
            return Err(Error::OrdinaryBudgetExceeded(
                "automation_integrity_vm_steps_v1",
            ));
        }
        Ok(())
    }
    fn text(&mut self, value: ValueRef<'_>) -> Result<String, Error> {
        let ValueRef::Text(bytes) = value else {
            return Err(Error::Serialization);
        };
        if bytes.len() > MAX_COLUMN_BYTES {
            return Err(Error::OrdinaryBudgetExceeded(
                "automation_integrity_cell_bytes_v1",
            ));
        }
        self.bytes = self
            .bytes
            .checked_add(bytes.len())
            .filter(|n| *n <= MAX_SELECTED_BYTES)
            .ok_or(Error::OrdinaryBudgetExceeded(
                "automation_integrity_selected_bytes_v1",
            ))?;
        Ok(String::from_utf8_lossy(bytes).into_owned())
    }
    fn outcome<T>(
        &self,
        result: Result<T, Error>,
        blocker: String,
        blockers: &mut Vec<String>,
    ) -> Result<Option<T>, Error> {
        self.check()?;
        match result {
            Ok(value) => Ok(Some(value)),
            Err(Error::Sqlite(_)) => {
                blockers.push(blocker);
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}

fn count<P: Params>(
    connection: &Connection,
    sql: &str,
    params: P,
    name: &str,
    control: &ProjectionControl<'_>,
    blockers: &mut Vec<String>,
) -> Result<Option<u64>, Error> {
    control.check()?;
    let result = connection
        .query_row(sql, params, |row| row.get::<_, i64>(0))
        .map_err(Error::from);
    let value = control.outcome(
        result,
        format!("automation_store_operational_query_failed:{name}"),
        blockers,
    )?;
    match value {
        Some(value) if (0..=9_007_199_254_740_991).contains(&value) => Ok(Some(value as u64)),
        Some(_) => {
            blockers.push(format!("automation_store_operational_count_invalid:{name}"));
            Ok(None)
        }
        None => Ok(None),
    }
}

fn inspect(
    connection: &Connection,
    time: &AutomationIntegrityTimeV1,
    control: &mut ProjectionControl<'_>,
) -> Result<AutomationStoreOperationalIntegrityV1, Error> {
    let mut blockers = Vec::new();
    control.check()?;
    let quick = (|| {
        let mut statement = connection.prepare("PRAGMA quick_check")?;
        let mut rows = statement.query([])?;
        let mut first = None;
        let mut count = 0;
        // Node materializes the complete query before selecting its first
        // value. Drain it so a later SQLite error cannot become an "ok" report.
        while let Some(row) = rows.next()? {
            control.check()?;
            if count >= MAX_COLUMNS {
                return Err(Error::OrdinaryBudgetExceeded(
                    "automation_integrity_quick_check_rows_v1",
                ));
            }
            count += 1;
            let value = control.text(row.get_ref(0)?)?;
            first.get_or_insert(value);
        }
        Ok(first.unwrap_or_default())
    })();
    let quick = control.outcome(
        quick,
        "automation_store_quick_check_query_failed".into(),
        &mut blockers,
    )?;
    if quick.as_deref().is_some_and(|value| value != "ok") {
        blockers.push("automation_store_quick_check_failed".into());
    }
    let mut tables = Vec::new();
    for &(table, required_columns) in TABLES {
        control.check()?;
        let columns = (|| {
            // `table` belongs to the closed internal vocabulary, never caller SQL.
            let mut statement = connection.prepare(&format!("PRAGMA table_info('{table}')"))?;
            let mut rows = statement.query([])?;
            let mut columns = Vec::new();
            while let Some(row) = rows.next()? {
                control.check()?;
                if columns.len() >= MAX_COLUMNS {
                    return Err(Error::OrdinaryBudgetExceeded(
                        "automation_integrity_columns_v1",
                    ));
                }
                let column = control.text(row.get_ref(1)?)?;
                if !column.is_empty() {
                    columns.push(column);
                }
            }
            // Node's default sort compares UTF-16 code units.
            columns.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            columns.dedup();
            Ok(columns)
        })();
        let columns = control.outcome(
            columns,
            format!("automation_store_table_info_query_failed:{table}"),
            &mut blockers,
        )?;
        let queried = columns.is_some();
        let observed_columns = columns.unwrap_or_default();
        let missing_columns = required_columns
            .iter()
            .copied()
            .filter(|required| !observed_columns.iter().any(|observed| observed == required))
            .collect::<Vec<_>>();
        if queried && !missing_columns.is_empty() {
            blockers.push(format!(
                "automation_store_required_columns_missing:{table}:{}",
                missing_columns.join(",")
            ));
        }
        let ready = queried && missing_columns.is_empty();
        tables.push(AutomationStoreTableInspectionV1 {
            table,
            required_columns,
            observed_columns,
            missing_columns,
            ready,
        });
    }
    let at = &time.inspected_at;
    let expired_active_node_count = count(
        connection,
        "SELECT count(*) FROM campaign_nodes WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at<=?",
        [at],
        "expiredActiveNodeCount",
        control,
        &mut blockers,
    )?;
    let expired_resource_lease_count = count(
        connection,
        "SELECT count(*) FROM automation_resource_leases WHERE expires_at<=?",
        [at],
        "expiredResourceLeaseCount",
        control,
        &mut blockers,
    )?;
    let expired_waiter_count = count(
        connection,
        "SELECT count(*) FROM automation_resource_waiters WHERE expires_at IS NOT NULL AND expires_at<=?",
        [at],
        "expiredWaiterCount",
        control,
        &mut blockers,
    )?;
    let stalled_recoverable_campaign_count = count(
        connection,
        "SELECT count(DISTINCT campaign_id) FROM campaign_nodes WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at<=?",
        [at],
        "stalledRecoverableCampaignCount",
        control,
        &mut blockers,
    )?;
    let no_progress_running_campaign_count = count(
        connection,
        "SELECT count(*) FROM paper_campaigns c WHERE c.status='running' AND c.updated_at<=? AND EXISTS(SELECT 1 FROM campaign_nodes queued WHERE queued.campaign_id=c.campaign_id AND queued.status='queued') AND NOT EXISTS(SELECT 1 FROM campaign_nodes active WHERE active.campaign_id=c.campaign_id AND active.status IN ('leased','running'))",
        [&time.no_progress_cutoff],
        "noProgressRunningCampaignCount",
        control,
        &mut blockers,
    )?;
    let terminal_campaign_queued_node_count = count(
        connection,
        "SELECT count(*) FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status='queued' AND c.status IN ('failed','cancelled','stopped','completed')",
        [],
        "terminalCampaignQueuedNodeCount",
        control,
        &mut blockers,
    )?;
    let reconcilable_terminal_campaign_queued_node_count = count(
        connection,
        "SELECT count(*) FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status='queued' AND c.status IN ('failed','cancelled','stopped','completed') AND json_type(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')='integer' AND json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')=1",
        [],
        "reconcilableTerminalCampaignQueuedNodeCount",
        control,
        &mut blockers,
    )?;
    let preserved_legacy_terminal_campaign_queued_node_count = count(
        connection,
        "SELECT count(*) FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status='queued' AND c.status IN ('failed','cancelled','stopped','completed') AND (json_type(c.spec_json,'$.terminalSiblingSettlementPolicyVersion') IS NULL OR (json_type(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')='integer' AND json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')=0))",
        [],
        "preservedLegacyTerminalCampaignQueuedNodeCount",
        control,
        &mut blockers,
    )?;
    let invalid_terminal_campaign_settlement_policy_queued_node_count = count(
        connection,
        "SELECT count(*) FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.status='queued' AND c.status IN ('failed','cancelled','stopped','completed') AND NOT (json_type(c.spec_json,'$.terminalSiblingSettlementPolicyVersion') IS NULL OR (json_type(c.spec_json,'$.terminalSiblingSettlementPolicyVersion')='integer' AND json_extract(c.spec_json,'$.terminalSiblingSettlementPolicyVersion') IN (0,1)))",
        [],
        "invalidTerminalCampaignSettlementPolicyQueuedNodeCount",
        control,
        &mut blockers,
    )?;
    let query_ready = blockers.is_empty();
    let stale = [
        expired_active_node_count,
        expired_resource_lease_count,
        expired_waiter_count,
        stalled_recoverable_campaign_count,
        no_progress_running_campaign_count,
        reconcilable_terminal_campaign_queued_node_count,
        invalid_terminal_campaign_settlement_policy_queued_node_count,
    ]
    .into_iter()
    .flatten()
    .any(|n| n > 0);
    Ok(AutomationStoreOperationalIntegrityV1 {
        version: 1,
        kind: "AutomationStoreOperationalIntegrityInspection",
        status: if !query_ready {
            "automation_store_operational_integrity_blocked"
        } else if stale {
            "automation_store_operational_integrity_degraded"
        } else {
            "automation_store_operational_integrity_verified"
        },
        inspected_at: at.clone(),
        quick_check: AutomationStoreQuickCheckV1 {
            ready: quick.as_deref() == Some("ok"),
            value: quick,
        },
        required_table_inspections: tables,
        expired_active_node_count,
        expired_resource_lease_count,
        expired_waiter_count,
        stalled_recoverable_campaign_count,
        no_progress_running_campaign_count,
        terminal_campaign_queued_node_count,
        reconcilable_terminal_campaign_queued_node_count,
        preserved_legacy_terminal_campaign_queued_node_count,
        invalid_terminal_campaign_settlement_policy_queued_node_count,
        query_ready,
        degraded: !query_ready || stale,
        blockers,
    })
}

impl OrdinaryReadOnlyStoreV1 {
    /// Runs only the incumbent's closed operational queries on this handle's
    /// existing snapshot. Uses its original cancellation/deadline and checks
    /// main/WAL/journal/path identities before and after, including SQL failure.
    /// Bounded profile v1 refuses >20M VM steps, >4096 columns/table or quick
    /// check rows, >64 KiB text cells, or >1 MiB selected text instead of
    /// returning partial success.
    pub fn automation_store_operational_integrity_v1(
        &self,
        time: &AutomationIntegrityTimeV1,
    ) -> Result<AutomationStoreOperationalIntegrityV1, Error> {
        self.verify_unchanged()?;
        let steps = Arc::new(AtomicU64::new(0));
        let observed = Arc::clone(&steps);
        let original = self.control.clone();
        self.connection.progress_handler(
            1000,
            Some(move || {
                #[cfg(test)]
                if let Some(progress) = &original.observed_sqlite_progress {
                    progress.store(true, Ordering::Release);
                }
                observed.fetch_add(1000, Ordering::AcqRel) >= MAX_VM_STEPS - 1000
                    || original.check().is_err()
            }),
        )?;
        let mut control = ProjectionControl {
            original: &self.control,
            steps,
            bytes: 0,
        };
        let result = inspect(&self.connection, time, &mut control);
        self.control.install_sqlite_progress(&self.connection)?;
        control.check()?;
        self.verify_unchanged()?;
        result.map_err(|error| self.control.map(error))
    }
}

#[cfg(test)]
mod tests;
