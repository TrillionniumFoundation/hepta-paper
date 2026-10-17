use super::*;
use rusqlite::params;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

const NOW: i64 = 1_791_158_400_123; // 2026-10-05T00:00:00.123Z
const SCHEMA: &str = "
CREATE TABLE paper_campaigns(campaign_id TEXT PRIMARY KEY,status TEXT,updated_at TEXT,spec_json TEXT);
CREATE TABLE campaign_nodes(node_id TEXT PRIMARY KEY,campaign_id TEXT,status TEXT,lease_expires_at TEXT);
CREATE TABLE campaign_events(event_id TEXT,campaign_id TEXT,kind TEXT);
CREATE TABLE automation_resource_leases(lease_id TEXT,expires_at TEXT);
CREATE TABLE automation_resource_waiters(waiter_id TEXT,expires_at TEXT);";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-automation-integrity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn path(&self) -> PathBuf {
        self.root.join("store.sqlite")
    }
    fn writer(&self) -> Connection {
        Connection::open(self.path()).unwrap()
    }
    fn initialize(&self) {
        self.writer().execute_batch(SCHEMA).unwrap();
    }
    fn report(&self, now: i64, window: u64) -> Value {
        let before = fs::read(self.path()).unwrap();
        let node = oracle(&self.path(), now, window);
        let store = OrdinaryReadOnlyStoreV1::open(self.path()).unwrap();
        let report = store
            .automation_store_operational_integrity_v1(
                &AutomationIntegrityTimeV1::with_no_progress_window(now, window).unwrap(),
            )
            .unwrap();
        let rust = serde_json::to_value(report).unwrap();
        assert_eq!(rust, node);
        store.verify_unchanged().unwrap();
        drop(store);
        assert_eq!(fs::read(self.path()).unwrap(), before);
        for suffix in ["-wal", "-shm", "-journal"] {
            assert!(!PathBuf::from(format!("{}{suffix}", self.path().display())).exists());
        }
        rust
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn node() -> PathBuf {
    std::env::var_os("HEPTA_TEST_NODE")
        .or_else(|| std::env::var_os("HEPTA_NODE_BINARY"))
        .map(PathBuf::from)
        .unwrap_or_else(|| "node".into())
}
fn oracle(path: &Path, now: i64, window: u64) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let result = Command::new(node()).current_dir(&root).env_clear()
        .env("PATH", "/usr/bin:/bin").env("LANG", "C.UTF-8").env("TZ", "UTC")
        .args(["--input-type=module", "-e", r#"
import assert from 'node:assert/strict';
import { createReadOnlySqliteStore } from './paper-adapters/persistence/sqlite-store.mjs';
import { inspectAutomationStoreOperationalIntegrity } from './paper-composition/automation/automation-status-inspection.mjs';
assert.equal(process.version, 'v22.23.1', 'production Node oracle identity');
const store = createReadOnlySqliteStore({dbPath: process.argv[1]});
try { process.stdout.write(JSON.stringify(inspectAutomationStoreOperationalIntegrity({store, now: new Date(Number(process.argv[2])), noProgressWindowMs: Number(process.argv[3])}))); }
finally { store.close(); }
"#]).arg(path).arg(now.to_string()).arg(window.to_string()).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}
fn campaign(connection: &Connection, id: &str, status: &str, updated: &str, spec: &str) {
    connection
        .execute(
            "INSERT INTO paper_campaigns VALUES(?,?,?,?)",
            params![id, status, updated, spec],
        )
        .unwrap();
}
fn node_row(
    connection: &Connection,
    id: &str,
    campaign: &str,
    status: &str,
    expires: Option<&str>,
) {
    connection
        .execute(
            "INSERT INTO campaign_nodes VALUES(?,?,?,?)",
            params![id, campaign, status, expires],
        )
        .unwrap();
}

#[test]
fn empty_and_actual_node_migrated_store_match_the_incumbent() {
    let fixture = Fixture::new();
    fixture.initialize();
    let report = fixture.report(NOW, 1_800_000);
    assert_eq!(
        report["status"],
        "automation_store_operational_integrity_verified"
    );
    assert_eq!(report["inspectedAt"], "2026-10-05T00:00:00.123Z");
    fs::remove_file(fixture.path()).unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = Command::new(node())
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .current_dir(root)
        .args([
            "--input-type=module",
            "-e",
            r#"
import assert from 'node:assert/strict';
import { createDefaultPaperStore } from './paper-adapters/persistence/store-provider.mjs';
assert.equal(process.version, 'v22.23.1');
const store = createDefaultPaperStore({dbPath:process.argv[1]});
store.close();
"#,
        ])
        .arg(fixture.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fixture
        .writer()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE")
        .unwrap();
    assert_eq!(fixture.report(NOW, 1_800_000)["queryReady"], true);
}

#[test]
fn expired_leases_distinct_campaigns_and_no_progress_boundaries_match() {
    let fixture = Fixture::new();
    fixture.initialize();
    let connection = fixture.writer();
    let at = iso(NOW).unwrap();
    let after = iso(NOW + 1).unwrap();
    let cutoff = iso(NOW - 1_800_000).unwrap();
    for id in ["expired", "queued", "active", "fresh", "empty"] {
        campaign(
            &connection,
            id,
            "running",
            if id == "fresh" { &at } else { &cutoff },
            "{}",
        );
    }
    node_row(&connection, "expired-one", "expired", "leased", Some(&at));
    node_row(&connection, "expired-two", "expired", "running", Some(&at));
    node_row(&connection, "expired-queued", "expired", "queued", None);
    node_row(&connection, "queued", "queued", "queued", None);
    node_row(&connection, "active-queued", "active", "queued", None);
    node_row(&connection, "active-null-lease", "active", "running", None);
    node_row(&connection, "fresh-queued", "fresh", "queued", None);
    node_row(&connection, "future", "active", "leased", Some(&after));
    connection
        .execute(
            "INSERT INTO automation_resource_leases VALUES('expired',?),('future',?),('null',NULL)",
            params![at, after],
        )
        .unwrap();
    connection.execute("INSERT INTO automation_resource_waiters VALUES('expired',?),('future',?),('null',NULL)", params![at,after]).unwrap();
    drop(connection);
    let report = fixture.report(NOW, 1_800_000);
    assert_eq!(report["expiredActiveNodeCount"], 2);
    assert_eq!(report["stalledRecoverableCampaignCount"], 1);
    assert_eq!(report["expiredResourceLeaseCount"], 1);
    assert_eq!(report["expiredWaiterCount"], 1);
    assert_eq!(report["noProgressRunningCampaignCount"], 1);
    assert_eq!(report["queryReady"], true);
    assert_eq!(report["degraded"], true);
}

#[test]
fn legacy_terminal_residue_is_preserved_and_malformed_policy_is_debt() {
    let fixture = Fixture::new();
    fixture.initialize();
    let connection = fixture.writer();
    for (index, policy) in [
        None,
        Some(json!(0)),
        Some(json!(1)),
        Some(json!(1.0)),
        Some(json!("1")),
        Some(json!(true)),
        Some(Value::Null),
        Some(json!(2)),
        Some(json!({})),
    ]
    .into_iter()
    .enumerate()
    {
        let spec = policy.map_or(
            json!({}),
            |policy| json!({"terminalSiblingSettlementPolicyVersion":policy}),
        );
        let id = index.to_string();
        campaign(
            &connection,
            &id,
            ["failed", "cancelled", "stopped", "completed"][index % 4],
            &iso(NOW).unwrap(),
            &spec.to_string(),
        );
        node_row(&connection, &id, &id, "queued", None);
    }
    drop(connection);
    let report = fixture.report(NOW, 1_800_000);
    assert_eq!(report["terminalCampaignQueuedNodeCount"], 9);
    assert_eq!(report["reconcilableTerminalCampaignQueuedNodeCount"], 1);
    assert_eq!(report["preservedLegacyTerminalCampaignQueuedNodeCount"], 2);
    assert_eq!(
        report["invalidTerminalCampaignSettlementPolicyQueuedNodeCount"],
        6
    );
    let connection = fixture.writer();
    connection.execute_batch("DELETE FROM campaign_nodes WHERE campaign_id NOT IN ('0','1'); DELETE FROM paper_campaigns WHERE campaign_id NOT IN ('0','1');").unwrap();
    drop(connection);
    let report = fixture.report(NOW, 1_800_000);
    assert_eq!(report["terminalCampaignQueuedNodeCount"], 2);
    assert_eq!(report["degraded"], false);
}

#[test]
fn missing_schema_and_invalid_json_stay_blocked_with_null_counts() {
    let fixture = Fixture::new();
    fixture
        .writer()
        .execute_batch("CREATE TABLE unrelated(x)")
        .unwrap();
    let missing = fixture.report(NOW, 1_800_000);
    assert_eq!(missing["queryReady"], false);
    assert_eq!(missing["expiredActiveNodeCount"], Value::Null);
    assert_eq!(missing["blockers"].as_array().unwrap().len(), 14);
    fixture.initialize();
    let connection = fixture.writer();
    campaign(&connection, "broken", "completed", &iso(NOW).unwrap(), "{");
    node_row(&connection, "broken", "broken", "queued", None);
    drop(connection);
    let broken = fixture.report(NOW, 1_800_000);
    assert_eq!(broken["terminalCampaignQueuedNodeCount"], 1);
    assert_eq!(
        broken["reconcilableTerminalCampaignQueuedNodeCount"],
        Value::Null
    );
    assert_eq!(broken["blockers"].as_array().unwrap().len(), 3);
}

#[test]
fn column_order_uses_node_utf16_sort_and_missing_columns_keep_incumbent_order() {
    let fixture = Fixture::new();
    fixture.initialize();
    fixture.writer().execute_batch("ALTER TABLE campaign_events ADD COLUMN \"😀\" TEXT; ALTER TABLE campaign_events ADD COLUMN \"\u{e000}\" TEXT; ALTER TABLE campaign_events DROP COLUMN campaign_id; ALTER TABLE campaign_events DROP COLUMN event_id;").unwrap();
    let report = fixture.report(NOW, 1_800_000);
    assert_eq!(
        report["requiredTableInspections"][2]["observedColumns"],
        json!(["kind", "😀", "\u{e000}"])
    );
    assert_eq!(
        report["requiredTableInspections"][2]["missingColumns"],
        json!(["event_id", "campaign_id"])
    );
}

#[test]
fn date_clip_extended_years_and_window_cutoff_match_node() {
    let fixture = Fixture::new();
    fixture.initialize();
    for now in [
        -DATE_LIMIT,
        -62_167_219_200_001,
        -62_167_219_200_000,
        -1,
        0,
        951_782_400_000,
        253_402_300_800_000,
        DATE_LIMIT,
    ] {
        fixture.report(now, 0);
    }
    assert!(matches!(
        AutomationIntegrityTimeV1::new(i64::MAX),
        Err(Error::AutomationInspectionTimeInvalid)
    ));
    assert!(matches!(
        AutomationIntegrityTimeV1::new(-DATE_LIMIT),
        Err(Error::AutomationNoProgressWindowInvalid)
    ));
    assert!(matches!(
        AutomationIntegrityTimeV1::with_no_progress_window(0, u64::MAX),
        Err(Error::AutomationNoProgressWindowInvalid)
    ));
}

fn expensive_fixture(fixture: &Fixture) {
    fixture.initialize();
    fixture.writer().execute_batch("DROP TABLE automation_resource_leases; CREATE VIEW automation_resource_leases AS WITH RECURSIVE many(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM many WHERE n<1000000000000) SELECT n AS lease_id, '2000-01-01' AS expires_at FROM many;").unwrap();
}
#[test]
fn sql_vm_budget_exhaustion_is_not_reported_as_a_semantic_blocker() {
    let fixture = Fixture::new();
    expensive_fixture(&fixture);
    let before = fs::read(fixture.path()).unwrap();
    let store = OrdinaryReadOnlyStoreV1::open(fixture.path()).unwrap();
    let result = store
        .automation_store_operational_integrity_v1(&AutomationIntegrityTimeV1::new(NOW).unwrap());
    assert!(matches!(
        result,
        Err(Error::OrdinaryBudgetExceeded(
            "automation_integrity_vm_steps_v1"
        ))
    ));
    store.verify_unchanged().unwrap();
    assert_eq!(fs::read(fixture.path()).unwrap(), before);
}
#[test]
fn cancellation_and_deadline_during_sql_never_return_a_report() {
    let fixture = Fixture::new();
    expensive_fixture(&fixture);
    let flag = Arc::new(AtomicBool::new(false));
    let observed = Arc::new(AtomicBool::new(false));
    let mut store = OrdinaryReadOnlyStoreV1::open_with_cancellation(
        fixture.path(),
        Arc::clone(&flag),
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    store.control.observed_sqlite_progress = Some(Arc::clone(&observed));
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !observed.load(Ordering::Acquire) {
                assert!(Instant::now() < deadline, "observer did not enter SQL");
                std::thread::yield_now();
            }
            flag.store(true, Ordering::Release);
        });
        assert!(matches!(
            store.automation_store_operational_integrity_v1(
                &AutomationIntegrityTimeV1::new(NOW).unwrap()
            ),
            Err(Error::OrdinaryCancelled)
        ));
    });
    drop(store);
    let store = OrdinaryReadOnlyStoreV1::open_with_cancellation(
        fixture.path(),
        Arc::new(AtomicBool::new(false)),
        Instant::now() + Duration::from_millis(50),
    )
    .unwrap();
    assert!(matches!(
        store.automation_store_operational_integrity_v1(
            &AutomationIntegrityTimeV1::new(NOW).unwrap()
        ),
        Err(Error::OrdinaryDeadlineExceeded)
    ));
}

#[test]
fn wal_rows_are_observed_and_later_commits_invalidate_the_retained_handle() {
    let fixture = Fixture::new();
    fixture.initialize();
    let writer = fixture.writer();
    writer
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    campaign(&writer, "actual", "completed", &iso(NOW).unwrap(), "{}");
    node_row(&writer, "actual", "actual", "queued", None);
    let expected = oracle(&fixture.path(), NOW, 1_800_000);
    let store = OrdinaryReadOnlyStoreV1::open(fixture.path()).unwrap();
    let report = store
        .automation_store_operational_integrity_v1(&AutomationIntegrityTimeV1::new(NOW).unwrap())
        .unwrap();
    assert_eq!(serde_json::to_value(report).unwrap(), expected);
    writer
        .execute(
            "UPDATE paper_campaigns SET spec_json=?",
            ["{\"terminalSiblingSettlementPolicyVersion\":1}"],
        )
        .unwrap();
    assert!(matches!(
        store.automation_store_operational_integrity_v1(
            &AutomationIntegrityTimeV1::new(NOW).unwrap()
        ),
        Err(Error::DatabaseChanged)
    ));
}

#[test]
fn selected_cell_bound_and_replaced_database_refuse_instead_of_projecting() {
    let fixture = Fixture::new();
    fixture.initialize();
    let name = "x".repeat(MAX_COLUMN_BYTES + 1);
    fixture
        .writer()
        .execute_batch(&format!(
            "ALTER TABLE campaign_events ADD COLUMN \"{name}\" TEXT"
        ))
        .unwrap();
    let store = OrdinaryReadOnlyStoreV1::open(fixture.path()).unwrap();
    assert!(matches!(
        store.automation_store_operational_integrity_v1(
            &AutomationIntegrityTimeV1::new(NOW).unwrap()
        ),
        Err(Error::OrdinaryBudgetExceeded(
            "automation_integrity_cell_bytes_v1"
        ))
    ));
    fs::rename(fixture.path(), fixture.root.join("old.sqlite")).unwrap();
    fixture.writer().execute_batch(SCHEMA).unwrap();
    assert!(matches!(
        store.automation_store_operational_integrity_v1(
            &AutomationIntegrityTimeV1::new(NOW).unwrap()
        ),
        Err(Error::DatabaseChanged)
    ));
}

#[test]
fn failed_quick_check_is_a_blocked_diagnostic_without_repair() {
    let fixture = Fixture::new();
    fixture.initialize();
    // Leave an unreachable allocated page in this disposable fixture. A CHECK
    // violation alone is not reported by SQLite's read-only quick_check.
    fixture.writer().execute_batch("CREATE TABLE orphaned(x); INSERT INTO orphaned VALUES(1); PRAGMA writable_schema=ON; DELETE FROM sqlite_schema WHERE name='orphaned'; PRAGMA writable_schema=OFF;").unwrap();
    let report = fixture.report(NOW, 1_800_000);
    assert_eq!(report["quickCheck"]["ready"], false, "{report}");
    assert_eq!(report["queryReady"], false);
    assert_eq!(
        report["blockers"],
        json!(["automation_store_quick_check_failed"])
    );
}

#[test]
fn wal_commit_during_observation_invalidates_the_finished_projection() {
    let fixture = Fixture::new();
    fixture.initialize();
    let writer = fixture.writer();
    writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; DROP TABLE automation_resource_leases; CREATE VIEW automation_resource_leases AS WITH RECURSIVE many(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM many WHERE n<250000) SELECT n AS lease_id, '2000-01-01' AS expires_at FROM many;").unwrap();
    campaign(&writer, "changed", "running", &iso(NOW).unwrap(), "{}");
    let observed = Arc::new(AtomicBool::new(false));
    let mut store = OrdinaryReadOnlyStoreV1::open(fixture.path()).unwrap();
    store.control.observed_sqlite_progress = Some(Arc::clone(&observed));
    std::thread::scope(|scope| {
        scope.spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !observed.load(Ordering::Acquire) {
                assert!(Instant::now() < deadline, "observer did not enter SQL");
                std::thread::yield_now();
            }
            writer
                .execute("UPDATE paper_campaigns SET status='completed'", [])
                .unwrap();
        });
        assert!(matches!(
            store.automation_store_operational_integrity_v1(
                &AutomationIntegrityTimeV1::new(NOW).unwrap()
            ),
            Err(Error::DatabaseChanged)
        ));
    });
}

#[test]
fn cumulative_column_text_bound_is_an_infrastructure_refusal() {
    let fixture = Fixture::new();
    fixture.initialize();
    let columns = (0..17)
        .map(|index| format!("\"{index}{}\" TEXT", "x".repeat(63_000)))
        .collect::<Vec<_>>()
        .join(",");
    fixture.writer().execute_batch(&format!("DROP TABLE campaign_events; CREATE TABLE campaign_events(event_id TEXT,campaign_id TEXT,kind TEXT,{columns})")).unwrap();
    let store = OrdinaryReadOnlyStoreV1::open(fixture.path()).unwrap();
    assert!(matches!(
        store.automation_store_operational_integrity_v1(
            &AutomationIntegrityTimeV1::new(NOW).unwrap()
        ),
        Err(Error::OrdinaryBudgetExceeded(
            "automation_integrity_selected_bytes_v1"
        ))
    ));
}

#[test]
fn no_progress_window_rejects_unsafe_integers_and_matches_node_at_safe_boundary() {
    let fixture = Fixture::new();
    fixture.initialize();
    // These unsafe inputs round as JavaScript Numbers; accepting their exact
    // Rust u64 values would produce a different (otherwise valid) Date cutoff.
    for window in [MAX_SAFE_INTEGER + 1, MAX_SAFE_INTEGER + 2, u64::MAX] {
        assert!(matches!(
            AutomationIntegrityTimeV1::with_no_progress_window(DATE_LIMIT, window),
            Err(Error::AutomationNoProgressWindowInvalid)
        ));
    }
    let accepted =
        AutomationIntegrityTimeV1::with_no_progress_window(DATE_LIMIT, MAX_SAFE_INTEGER).unwrap();
    let connection = fixture.writer();
    campaign(
        &connection,
        "at-cutoff",
        "running",
        &accepted.no_progress_cutoff,
        "{}",
    );
    node_row(&connection, "queued", "at-cutoff", "queued", None);
    drop(connection);
    let report = fixture.report(DATE_LIMIT, MAX_SAFE_INTEGER);
    assert_eq!(report["noProgressRunningCampaignCount"], 1);
    // Changing the accepted window by one millisecond moves the SQL boundary.
    let report = fixture.report(DATE_LIMIT, MAX_SAFE_INTEGER - 1);
    assert_eq!(report["noProgressRunningCampaignCount"], 1);
    let connection = fixture.writer();
    connection
        .execute(
            "UPDATE paper_campaigns SET updated_at=?",
            [iso(DATE_LIMIT - MAX_SAFE_INTEGER as i64 + 1).unwrap()],
        )
        .unwrap();
    drop(connection);
    assert_eq!(
        fixture.report(DATE_LIMIT, MAX_SAFE_INTEGER)["noProgressRunningCampaignCount"],
        0
    );
    assert_eq!(
        fixture.report(DATE_LIMIT, MAX_SAFE_INTEGER - 1)["noProgressRunningCampaignCount"],
        1
    );
}
