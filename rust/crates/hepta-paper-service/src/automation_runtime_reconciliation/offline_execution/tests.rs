use super::*;
use crate::automation_runtime_reconciliation::rows;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
const NOW: &str = "2026-07-13T08:00:00.000Z";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    node: PathBuf,
    rust: PathBuf,
}
fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
impl Fixture {
    fn new(populated: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-reconciliation-execute-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let node = root.join("node.sqlite");
        let rust = root.join("rust.sqlite");
        let mut command = Command::new("node");
        command
            .arg(repo().join("rust/oracle/automation-runtime-reconciliation-v1.mjs"))
            .args(["--database", node.to_str().unwrap(), "--at", NOW]);
        if populated {
            command.arg("--prepare");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        fs::copy(&node, &rust).unwrap();
        Self { root, node, rust }
    }
    fn native(&self) -> Connection {
        let db = Connection::open(&self.rust).unwrap();
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
        )
        .unwrap();
        db
    }
    fn oracle(&self, args: &[&str]) -> Value {
        let output = Command::new("node")
            .arg(repo().join("rust/oracle/automation-runtime-reconciliation-execute-v1.mjs"))
            .args(["--database", self.node.to_str().unwrap(), "--at", NOW])
            .args(args)
            .env_remove("HEPTA_RELEASE_COMMIT")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn snapshot(db: &Connection) -> Value {
    let tables=rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",[]).unwrap();
    let mut result = json!({});
    for table in tables {
        let name = table["name"].as_str().unwrap();
        let mut contents = rows(
            db,
            &format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")),
            [],
        )
        .unwrap();
        // Node serializes a SQLite REAL 0.0 as JSON 0. Match that observer
        // boundary without parsing or normalizing persisted JSON text columns.
        for row in &mut contents {
            for value in row.as_object_mut().unwrap().values_mut() {
                if value.is_number() {
                    *value = serde_json::from_str(&wire(value)).unwrap();
                }
            }
        }
        // Different runtimes enumerate row object keys differently. Sort by
        // values under canonical JSON here; nested persisted JSON stays text.
        contents.sort_by_key(|a| serde_json::to_string(a).unwrap());
        result[name] = json!(contents);
    }
    result
}
fn canonical_snapshot(value: &Value) -> Value {
    let mut value = value.clone();
    for rows in value.as_object_mut().unwrap().values_mut() {
        rows.as_array_mut()
            .unwrap()
            .sort_by_key(|a| serde_json::to_string(a).unwrap());
    }
    value
}
#[test]
fn offline_reconciliation_matches_complete_node_state_and_receipts() {
    for (populated, campaign) in [
        (false, None),
        (true, None),
        (true, Some("campaign-3")),
        (true, Some("campaign-4")),
        (true, Some("campaign-5")),
    ] {
        let fixture = Fixture::new(populated);
        let mut db = fixture.native();
        let args = campaign
            .map(|id| vec!["--campaign-id", id])
            .unwrap_or_default();
        let node = fixture.oracle(&args);
        assert_eq!(node["ok"], true);
        let receipt = execute_on_admitted_connection(
            &mut db,
            NOW,
            1800.0,
            campaign,
            None,
            |_| Ok(()),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(receipt, node["receipts"][0], "campaign: {campaign:?}");
        assert_snapshot_eq(snapshot(&db), canonical_snapshot(&node["snapshot"]));
        assert_eq!(receipt["workersStarted"], false);
        assert_eq!(receipt["externalActionPerformed"], false);
        assert_eq!(receipt["ledgerReceipt"]["environment"], "administrative");
        if populated && campaign.is_none() {
            assert_eq!(receipt["recoveredNodeCount"], 1);
            assert_eq!(receipt["pausedNoProgressCampaignCount"], 1);
            assert_eq!(receipt["closedTerminalCampaignQueuedNodeCount"], 1);
            assert_eq!(receipt["closedTerminalCampaignActiveNodeCount"], 2);
            assert_eq!(receipt["preservedLegacyTerminalNodeCount"], 1);
            assert_eq!(
                receipt["after"]["status"],
                "automation_runtime_reconciliation_legacy_terminal_evidence_preserved"
            );
        }
    }
}
fn inject(db: &mut Connection, fault: &str, prepared: &PreparedReceipt) {
    let sql = match fault {
        "stale-node" => {
            "UPDATE campaign_nodes SET status='completed',node_revision=node_revision+1 WHERE node_id='node-3'"
        }
        "stale-resource" => {
            "UPDATE automation_resource_leases SET renewed_at='2026-07-13T07:59:00.000Z' WHERE lease_id='expired-lease'"
        }
        "stale-campaign" => {
            "UPDATE paper_campaigns SET revision=revision+1 WHERE campaign_id='campaign-2'"
        }
        "stale-active" => {
            "UPDATE campaign_nodes SET prepared_integration_status='integrated' WHERE node_id='node-4'"
        }
        "stale-generation" => {
            "UPDATE campaign_nodes SET lease_generation=lease_generation+1 WHERE node_id='node-4'"
        }
        "stale-expiry" => {
            "UPDATE campaign_nodes SET lease_expires_at='2026-07-13T09:00:00.000Z' WHERE node_id='node-4'"
        }
        "stale-campaign-lineage" => {
            "UPDATE paper_campaigns SET revision=revision+1 WHERE campaign_id='campaign-4'"
        }
        "stale-waiter" => {
            "UPDATE automation_resource_waiters SET owner_id='replacement-owner' WHERE waiter_id='expired-waiter'"
        }
        "event-failure" => {
            "CREATE TEMP TRIGGER reconciliation_test_fail BEFORE INSERT ON campaign_events BEGIN SELECT RAISE(ABORT,'injected_event_failure'); END"
        }
        "receipt-failure" => {
            "CREATE TEMP TRIGGER reconciliation_test_fail BEFORE INSERT ON receipt_ledger BEGIN SELECT RAISE(ABORT,'injected_receipt_failure'); END"
        }
        "duplicate-event" => {
            let detail = Record::new()
                .field("campaignStatus", json!("failed"))
                .field("campaignStopReason", json!("historical_failure"))
                .field(
                    "reconciliationPlanHash",
                    prepared.payload.value["reconciliationPlanHash"].clone(),
                );
            let e = event(
                "campaign_terminal_child_closed",
                &json!("campaign-3"),
                &json!("node-3"),
                &detail,
                NOW,
            )
            .unwrap();
            let tx = db.transaction().unwrap();
            insert_event(&tx, e, NOW).unwrap();
            tx.commit().unwrap();
            return;
        }
        "duplicate-receipt" => {
            let values = prepared
                .parameters
                .clone()
                .into_iter()
                .map(sql_value)
                .collect::<Result<Vec<_>>>()
                .unwrap();
            db.execute("INSERT INTO receipt_ledger(receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params_from_iter(values)).unwrap();
            return;
        }
        _ => panic!("unknown fault"),
    };
    db.execute_batch(sql).unwrap();
}
#[test]
fn offline_reconciliation_rolls_back_all_changes_on_stale_rows_events_or_receipts() {
    for fault in [
        "stale-node",
        "stale-resource",
        "stale-campaign",
        "stale-active",
        "stale-generation",
        "stale-expiry",
        "stale-campaign-lineage",
        "stale-waiter",
        "event-failure",
        "receipt-failure",
        "duplicate-receipt",
        "duplicate-event",
    ] {
        let fixture = Fixture::new(true);
        let mut db = fixture.native();
        let plan = plan_on_connection(&db, NOW, 1800.0, None).unwrap();
        let prepared = prepare_receipt(&plan, NOW, NOW, None).unwrap();
        inject(&mut db, fault, &prepared);
        let before = snapshot(&db);
        assert!(
            execute_prepared(
                &mut db,
                &plan,
                prepared,
                (NOW, 1800.0, None),
                |_| Ok(()),
                || Ok(())
            )
            .is_err(),
            "{fault}"
        );
        assert!(db.is_autocommit());
        assert_eq!(snapshot(&db), before, "{fault}");
        let node = fixture.oracle(&["--fault", fault]);
        assert_eq!(node["ok"], false, "{fault}");
        assert_snapshot_eq(snapshot(&db), canonical_snapshot(&node["snapshot"]));
        if matches!(fault, "event-failure" | "receipt-failure") {
            db.execute_batch("DROP TRIGGER reconciliation_test_fail")
                .unwrap();
        }
        if !matches!(fault, "duplicate-receipt" | "duplicate-event") {
            // Reopening and replanning must operate on the recovered database,
            // not a partial transaction or an implicit rollback epoch.
            drop(db);
            let mut db = fixture.native();
            let recovered = execute_on_admitted_connection(
                &mut db,
                NOW,
                1800.0,
                None,
                None,
                |_| Ok(()),
                || Ok(()),
            )
            .unwrap();
            let node = fixture.oracle(&[]);
            assert_eq!(node["ok"], true, "recovery {fault}");
            assert_eq!(recovered, node["receipts"][0], "recovery {fault}");
            assert_snapshot_eq(snapshot(&db), canonical_snapshot(&node["snapshot"]));
        }
    }
}
#[test]
fn fixed_clock_repeat_uses_strict_receipt_insert_and_preserves_prior_commit() {
    for populated in [false, true] {
        let fixture = Fixture::new(populated);
        let mut db = fixture.native();
        let count = if populated { 3 } else { 2 };
        let mut successes = 0;
        for _ in 0..count {
            let before = snapshot(&db);
            match execute_on_admitted_connection(
                &mut db,
                NOW,
                1800.0,
                None,
                None,
                |_| Ok(()),
                || Ok(()),
            ) {
                Ok(_) => successes += 1,
                Err(_) => assert_eq!(snapshot(&db), before),
            }
        }
        assert_eq!(successes, count - 1);
        let node = fixture.oracle(&["--repeat", &count.to_string()]);
        assert_eq!(node["ok"], false);
        assert!(node["error"].as_str().unwrap().contains("UNIQUE"));
        assert_snapshot_eq(snapshot(&db), canonical_snapshot(&node["snapshot"]));
    }
}
#[test]
fn reconciliation_crash_child() {
    let Ok(path) = std::env::var("HEPTA_RECONCILIATION_CRASH_TEST_DATABASE") else {
        return;
    };
    let mut db = Connection::open(path).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
        .unwrap();
    let plan = plan_on_connection(&db, NOW, 1800.0, None).unwrap();
    let prepared = prepare_receipt(&plan, NOW, NOW, None).unwrap();
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    apply(&tx, &plan, &prepared, NOW).unwrap();
    // Terminate with no Rust destructors after all DML, before commit.
    std::process::exit(73);
}
#[test]
fn process_death_before_commit_recovers_without_partial_business_state() {
    let fixture = Fixture::new(true);
    let db = fixture.native();
    let before = snapshot(&db);
    drop(db);
    let child=Command::new(std::env::current_exe().unwrap()).args(["--exact","automation_runtime_reconciliation::offline_execution::tests::reconciliation_crash_child","--nocapture"]).env("HEPTA_RECONCILIATION_CRASH_TEST_DATABASE",&fixture.rust).output().unwrap();
    assert_eq!(
        child.status.code(),
        Some(73),
        "{}",
        String::from_utf8_lossy(&child.stdout)
    );
    let mut db = fixture.native();
    assert_eq!(snapshot(&db), before);
    let recovered =
        execute_on_admitted_connection(&mut db, NOW, 1800.0, None, None, |_| Ok(()), || Ok(()))
            .unwrap();
    let node = fixture.oracle(&[]);
    assert_eq!(recovered, node["receipts"][0]);
    assert_snapshot_eq(snapshot(&db), canonical_snapshot(&node["snapshot"]));
}

#[test]
fn writer_scope_revalidation_failure_rolls_back_receipt_and_every_transition() {
    let fixture = Fixture::new(true);
    let mut db = fixture.native();
    let before = snapshot(&db);
    let result = execute_on_admitted_connection(
        &mut db,
        NOW,
        1800.0,
        None,
        None,
        |_| Ok(()),
        || Err(Error::Admission("test_writer_scope_lost".into())),
    );
    assert!(matches!(result, Err(Error::Admission(_))));
    assert!(db.is_autocommit());
    assert_eq!(snapshot(&db), before);
    let recovered =
        execute_on_admitted_connection(&mut db, NOW, 1800.0, None, None, |_| Ok(()), || Ok(()))
            .unwrap();
    let node = fixture.oracle(&[]);
    assert_eq!(recovered, node["receipts"][0]);
    assert_snapshot_eq(snapshot(&db), canonical_snapshot(&node["snapshot"]));
}

#[test]
fn scoped_resources_elapsed_run_time_integrated_outcomes_and_release_commit_match_node() {
    let fixture = Fixture::new(true);
    for path in [&fixture.node, &fixture.rust] {
        let db = Connection::open(path).unwrap();
        db.execute_batch("UPDATE paper_campaigns SET last_resumed_at='2026-07-13T07:00:00.000Z',accumulated_run_ms=123 WHERE campaign_id='campaign-2';
            UPDATE campaign_nodes SET prepared_integration_status='integrated' WHERE node_id='node-4';
            UPDATE automation_resource_leases SET campaign_id='campaign-3',node_id='node-3' WHERE lease_id='expired-lease';
            UPDATE automation_resource_waiters SET campaign_id='campaign-3',node_id='node-3' WHERE waiter_id='expired-waiter';").unwrap();
    }
    let mut db = fixture.native();
    let node = fixture.oracle(&["--campaign-id", "campaign-3", "--release-commit", "abc123"]);
    let actual = execute_on_admitted_connection(
        &mut db,
        NOW,
        1800.0,
        Some("campaign-3"),
        Some("abc123"),
        |_| Ok(()),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(actual, node["receipts"][0]);
    assert_eq!(actual["removedResourceLeaseCount"], 1);
    assert_eq!(actual["removedWaiterCount"], 1);
    assert_snapshot_eq(snapshot(&db), canonical_snapshot(&node["snapshot"]));
    let node = fixture.oracle(&["--release-commit", "abc123"]);
    let actual = execute_on_admitted_connection(
        &mut db,
        NOW,
        1800.0,
        None,
        Some("abc123"),
        |_| Ok(()),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(actual, node["receipts"][0]);
    assert_snapshot_eq(snapshot(&db), canonical_snapshot(&node["snapshot"]));
    let elapsed: i64 = db
        .query_row(
            "SELECT accumulated_run_ms FROM paper_campaigns WHERE campaign_id='campaign-2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(elapsed > 3_599_000);
}

fn assert_snapshot_eq(actual: Value, expected: Value) {
    assert_eq!(
        actual.as_object().unwrap().keys().collect::<Vec<_>>(),
        expected.as_object().unwrap().keys().collect::<Vec<_>>(),
        "complete table inventory"
    );
    for (table, rows) in actual.as_object().unwrap() {
        let other = &expected[table];
        assert_eq!(
            rows.as_array().unwrap().len(),
            other.as_array().unwrap().len(),
            "table {table} length"
        );
        for (index, (row, expected)) in rows
            .as_array()
            .unwrap()
            .iter()
            .zip(other.as_array().unwrap())
            .enumerate()
        {
            assert_eq!(
                row.as_object().unwrap().keys().collect::<Vec<_>>(),
                expected.as_object().unwrap().keys().collect::<Vec<_>>(),
                "table {table} row {index} columns"
            );
            for (column, value) in row.as_object().unwrap() {
                assert_eq!(
                    value, &expected[column],
                    "table {table} row {index} column {column}"
                );
            }
        }
    }
}
