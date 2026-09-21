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
fn offline_reconciliation_rejects_text_numeric_fences_like_node_without_partial_writes() {
    for column in ["lease_generation", "node_revision"] {
        for value in ["bogus", "0x10", "\u{feff}17", "inf", "Infinity", "", " "] {
            let fixture = Fixture::new(true);
            let node = Connection::open(&fixture.node).unwrap();
            node.execute(
                &format!("UPDATE campaign_nodes SET {column}=? WHERE node_id='node-4'"),
                [value],
            )
            .unwrap();
            assert_eq!(
                node.query_row(
                    &format!("SELECT typeof({column}) FROM campaign_nodes WHERE node_id='node-4'"),
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                "text"
            );
            drop(node);
            fs::copy(&fixture.node, &fixture.rust).unwrap();
            let mut db = fixture.native();
            let before = snapshot(&db);
            let expected = fixture.oracle(&[]);
            assert_eq!(expected["ok"], false, "{column}={value:?}");
            assert!(
                execute_on_admitted_connection(
                    &mut db,
                    NOW,
                    1800.,
                    None,
                    None,
                    |_| Ok(()),
                    || Ok(())
                )
                .is_err(),
                "{column}={value:?}"
            );
            assert_eq!(snapshot(&db), before, "{column}={value:?}");
            assert_eq!(
                snapshot(&Connection::open(&fixture.node).unwrap()),
                before,
                "Node changed rows for {column}={value:?}"
            );
        }
    }
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

struct ScriptClock {
    samples: Vec<Value>,
    calls: Vec<String>,
}
impl ScriptClock {
    fn new(samples: &Value) -> Self {
        Self {
            samples: samples.as_array().unwrap().clone(),
            calls: Vec::new(),
        }
    }
    fn take(&mut self, kind: &str) -> Result<Value> {
        let index = self.calls.len();
        self.calls.push(kind.into());
        let sample = self
            .samples
            .get(index)
            .ok_or_else(|| Error::Admission("fixture_clock_order_invalid".into()))?;
        if sample["kind"] != kind {
            return Err(Error::Admission("fixture_clock_order_invalid".into()));
        }
        if let Some(error) = sample["error"].as_str() {
            return Err(Error::Admission(error.into()));
        }
        Ok(sample["value"].clone())
    }
}
impl ReconciliationClockV1 for ScriptClock {
    fn now_iso(&mut self) -> Result<String> {
        self.take("nowIso")?
            .as_str()
            .map(str::to_owned)
            .ok_or(Error::Input)
    }
    fn now_millis(&mut self) -> Result<i64> {
        self.take("now")?.as_i64().ok_or(Error::Input)
    }
}
fn clock_samples(times: [&str; 6]) -> Value {
    json!(times.into_iter().enumerate().map(|(i,time)| if i==1 || i==5 {
        json!({"kind":"now","value":crate::journal_connector_coverage::qualification::canonical_instant_millis(time).unwrap()})
    } else { json!({"kind":"nowIso","value":time}) }).collect::<Vec<_>>())
}
fn advancing_samples() -> Value {
    clock_samples([
        "2026-07-13T08:00:00.000Z",
        "2026-07-13T08:00:00.100Z",
        "2026-07-13T08:00:00.200Z",
        "2026-07-13T08:00:00.300Z",
        "2026-07-13T09:00:00.000Z",
        "2026-07-13T09:00:00.100Z",
    ])
}
#[test]
fn distinct_clock_samples_match_node_receipts_events_cutoffs_and_after_state() {
    let backwards = clock_samples([
        "2026-07-13T08:00:00.000Z",
        "2026-07-13T07:59:59.800Z",
        "2026-07-13T08:00:00.200Z",
        "2026-07-13T07:59:59.900Z",
        "2026-07-13T07:59:59.500Z",
        "2026-07-13T07:00:00.100Z",
    ]);
    let negative = clock_samples([
        "1969-12-31T23:59:59.999Z",
        "1969-12-31T23:59:59.998Z",
        "1970-01-01T00:00:00.002Z",
        "1969-12-31T23:59:59.997Z",
        "1970-01-01T00:01:00.000Z",
        "1970-01-01T00:00:00.000Z",
    ]);
    for (samples, seconds, campaign) in [
        (advancing_samples(), 1800.0, None),
        (advancing_samples(), 60.0001, Some("campaign-3")),
        (backwards, 60.0009, None),
        (negative, 60.0001, None),
    ] {
        let fixture = Fixture::new(true);
        let mut db = fixture.native();
        let mut clock = ScriptClock::new(&samples);
        let samples_text = serde_json::to_string(&samples).unwrap();
        let seconds_text = seconds.to_string();
        let mut args = vec![
            "--clock-samples",
            &samples_text,
            "--no-progress-seconds",
            &seconds_text,
        ];
        if let Some(campaign) = campaign {
            args.extend(["--campaign-id", campaign]);
        }
        let node = fixture.oracle(&args);
        assert_eq!(node["ok"], true, "{node}");
        let receipt = execute_on_admitted_connection_with_clock(
            &mut db,
            &mut clock,
            seconds,
            campaign,
            None,
            |_| Ok(()),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(json!(clock.calls), node["clockCalls"]);
        assert_eq!(
            clock.calls,
            ["nowIso", "now", "nowIso", "nowIso", "nowIso", "now"]
        );
        assert_eq!(receipt, node["receipts"][0]);
        assert_eq!(receipt["reconciledAt"], samples[2]["value"]);
        assert_eq!(receipt["ledgerReceipt"]["createdAt"], samples[3]["value"]);
        assert_eq!(receipt["after"]["plannedAt"], samples[4]["value"]);
        assert_snapshot_eq(snapshot(&db), canonical_snapshot(&node["snapshot"]));
        if samples == advancing_samples() && campaign.is_none() {
            assert_eq!(
                receipt["after"]["expiredResourceLeases"][0]["lease_id"],
                "active-lease"
            );
            assert_eq!(
                receipt["after"]["noProgressCampaigns"][0]["campaign_id"],
                "campaign-1"
            );
            assert_eq!(
                receipt["after"]["noProgressCutoff"],
                "2026-07-13T08:30:00.100Z"
            );
        }
    }
}
#[test]
fn clock_failure_before_commit_preserves_state_and_after_commit_failure_preserves_commit() {
    for index in 0..6 {
        let fixture = Fixture::new(true);
        let mut db = fixture.native();
        let before = snapshot(&db);
        let mut samples = advancing_samples();
        samples[index].as_object_mut().unwrap().remove("value");
        samples[index]["error"] = json!("fixture_clock_unavailable");
        let mut clock = ScriptClock::new(&samples);
        let result = execute_on_admitted_connection_with_clock(
            &mut db,
            &mut clock,
            1800.0,
            None,
            None,
            |_| Ok(()),
            || Ok(()),
        );
        assert!(
            matches!(result,Err(Error::Admission(ref code)) if code=="fixture_clock_unavailable")
        );
        assert!(db.is_autocommit());
        let samples_text = serde_json::to_string(&samples).unwrap();
        let node = fixture.oracle(&["--clock-samples", &samples_text]);
        assert_eq!(node["ok"], false);
        assert_eq!(node["error"], "fixture_clock_unavailable");
        assert_eq!(json!(clock.calls), node["clockCalls"]);
        assert_eq!(clock.calls.len(), index + 1);
        assert_snapshot_eq(snapshot(&db), canonical_snapshot(&node["snapshot"]));
        if index < 4 {
            assert_eq!(snapshot(&db), before);
        } else {
            assert_ne!(snapshot(&db), before);
            let count: i64 = db
                .query_row(
                    "SELECT count(*) FROM receipt_ledger WHERE stream='automation-reconciliation'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
        }
    }
}
#[test]
fn transaction_failure_does_not_sample_after_clock_and_invalid_scope_never_samples() {
    let fixture = Fixture::new(true);
    let mut db = fixture.native();
    let mut clock = ScriptClock::new(&advancing_samples());
    let result = execute_on_admitted_connection_with_clock(
        &mut db,
        &mut clock,
        1800.0,
        Some("absent-campaign"),
        None,
        |_| Ok(()),
        || Ok(()),
    );
    assert!(result.is_err());
    let samples_text = advancing_samples().to_string();
    let node = fixture.oracle(&[
        "--clock-samples",
        &samples_text,
        "--campaign-id",
        "absent-campaign",
    ]);
    assert_eq!(node["ok"], false);
    assert!(clock.calls.is_empty());
    assert_eq!(node["clockCalls"], json!([]));
    let before = snapshot(&db);
    let mut clock = ScriptClock::new(&advancing_samples());
    let result = execute_on_admitted_connection_with_clock(
        &mut db,
        &mut clock,
        1800.0,
        None,
        None,
        |db| {
            db.execute_batch("CREATE TEMP TRIGGER reconciliation_test_fail BEFORE INSERT ON receipt_ledger BEGIN SELECT RAISE(ABORT,'injected_receipt_failure'); END")?;
            Ok(())
        },
        || Ok(()),
    );
    assert!(result.is_err());
    assert!(db.is_autocommit());
    let node = fixture.oracle(&[
        "--clock-samples",
        &samples_text,
        "--fault",
        "receipt-failure",
    ]);
    assert_eq!(node["ok"], false);
    assert_eq!(clock.calls, ["nowIso", "now", "nowIso", "nowIso"]);
    assert_eq!(json!(clock.calls), node["clockCalls"]);
    assert_eq!(snapshot(&db), before);
    assert_snapshot_eq(snapshot(&db), canonical_snapshot(&node["snapshot"]));
}
#[test]
fn system_reconciliation_clock_observes_wall_time_without_granting_authority() {
    use std::time::{SystemTime, UNIX_EPOCH};
    let before = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let mut clock = SystemReconciliationClockV1;
    let millis = clock.now_millis().unwrap();
    let text = clock.now_iso().unwrap();
    let after = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    assert!((before..=after).contains(&millis));
    let iso_millis =
        crate::journal_connector_coverage::qualification::canonical_instant_millis(&text).unwrap();
    assert!((before..=after).contains(&iso_millis));
}
