use super::*;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
const NOW: &str = "2026-08-01T05:00:00.000Z";
const CAMPAIGN: &str = "legacy-campaign";
static NEXT: AtomicU64 = AtomicU64::new(0);
fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
struct Fixture {
    root: PathBuf,
    node: PathBuf,
    rust: PathBuf,
}
impl Fixture {
    fn new(queued: usize) -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-legacy-residue-rust-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let node = root.join("node.sqlite");
        let rust = root.join("rust.sqlite");
        let f = Self { root, node, rust };
        let output = f.oracle(&[
            "--prepare",
            "--prepare-only",
            "--queued",
            &queued.to_string(),
        ]);
        assert_eq!(output["ok"], true, "{output}");
        f.copy();
        f
    }
    fn oracle(&self, args: &[&str]) -> Value {
        let output = Command::new("node")
            .arg(repo().join("rust/oracle/legacy-terminal-active-residue-v1.mjs"))
            .args(["--database", self.node.to_str().unwrap(), "--at", NOW])
            .args(args)
            .env_remove("HEPTA_RELEASE_COMMIT")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    fn copy(&self) {
        fs::copy(&self.node, &self.rust).unwrap();
    }
    fn native(&self) -> Connection {
        let db = Connection::open(&self.rust).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
            .unwrap();
        db
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn canonical_snapshot(v: &Value) -> Value {
    let mut v = v.clone();
    for table in v.as_object_mut().unwrap().values_mut() {
        table
            .as_array_mut()
            .unwrap()
            .sort_by_key(|v| serde_json::to_string(v).unwrap());
    }
    v
}
fn snapshot(db: &Connection) -> Value {
    let mut out = json!({});
    for table in rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",[]).unwrap(){
        let name=table["name"].as_str().unwrap();let mut contents=rows(db,&format!("SELECT * FROM \"{}\"",name.replace('"',"\"\"")),[]).unwrap();
        for row in &mut contents{for v in row.as_object_mut().unwrap().values_mut(){if v.is_number(){*v=serde_json::from_str(&wire(v).unwrap()).unwrap();}}}out[name]=json!(contents);
    }
    canonical_snapshot(&out)
}
fn run(db: &mut Connection) -> Result<Value> {
    execute_on_admitted_connection(
        db,
        CAMPAIGN,
        None,
        &mut || Ok(NOW.into()),
        |_| Ok(()),
        || Ok(()),
    )
}
#[test]
fn legacy_residue_scope_and_clock_validation_order_matches_node() {
    for scenario in ["valid", "invalid", "nonterminal", "missing"] {
        let fixture = Fixture::new(1);
        if scenario == "nonterminal" {
            fixture.oracle(&["--setup", "nonterminal"]);
            fixture.copy();
        }
        let campaign = match scenario {
            "invalid" => "bad/id",
            "missing" => "missing-campaign",
            _ => CAMPAIGN,
        };
        let mut database = fixture.native();
        let expected = fixture.oracle(&["--campaign-id", campaign]);
        let mut samples = 0;
        let planned = plan_with_clock(&database, campaign, &mut || {
            samples += 1;
            Ok(NOW.into())
        });
        assert_eq!(json!(samples), expected["clockCalls"], "{scenario}");
        match planned {
            Ok(plan) => assert_eq!(plan, expected["report"], "{scenario}"),
            Err(cause) => assert_eq!(cause.to_string(), expected["error"], "{scenario}"),
        }

        // The same ordering must be retained by prepare_operation, including
        // the early ID rejection before any receipt or business mutation.
        let expected = fixture.oracle(&["--execute", "--campaign-id", campaign]);
        let mut samples = 0;
        let executed = execute_on_admitted_connection(
            &mut database,
            campaign,
            None,
            &mut || {
                samples += 1;
                Ok(NOW.into())
            },
            |_| Ok(()),
            || Ok(()),
        );
        assert_eq!(json!(samples), expected["clockCalls"], "{scenario}");
        match executed {
            Ok(receipt) => assert_eq!(receipt, expected["report"], "{scenario}"),
            Err(cause) => assert_eq!(cause.to_string(), expected["error"], "{scenario}"),
        }
        assert_eq!(
            snapshot(&database),
            canonical_snapshot(&expected["snapshot"])
        );
    }
}
#[test]
fn legacy_residue_plan_and_execution_match_node_full_state_and_exact_wire() {
    for queued in [0, 512, 2538] {
        let f = Fixture::new(queued);
        let mut db = f.native();
        let before = snapshot(&db);
        let expected = f.oracle(&[]);
        let planned = plan_on_connection(&db, NOW, CAMPAIGN).unwrap();
        assert_eq!(planned, expected["report"]);
        assert_eq!(snapshot(&db), before);
        let expected = f.oracle(&["--execute"]);
        let receipt = run(&mut db).unwrap();
        assert_eq!(receipt, expected["report"]);
        assert_eq!(snapshot(&db), canonical_snapshot(&expected["snapshot"]));
        assert_eq!(
            receipt["preservedQueuedNodeStateHash"],
            receipt["after"]["preservedQueuedNodeStateHash"]
        );
        let repeated = run(&mut db).unwrap_err();
        assert!(repeated.to_string().contains("nothing_to_settle"));
        let node = f.oracle(&["--execute"]);
        assert_eq!(node["ok"], false);
        assert!(
            node["error"]
                .as_str()
                .unwrap()
                .contains("nothing_to_settle")
        );
    }
}
#[test]
fn legacy_residue_rejects_unsafe_policy_scope_lease_and_coordination_without_writes() {
    for setup in [
        "policy-one",
        "policy-text",
        "policy-false",
        "policy-null",
        "policy-real",
        "nonterminal",
        "expired-missing",
        "expired-invalid",
        "unexpired",
        "integrating",
        "integrated",
        "lease",
        "waiter-node",
    ] {
        let f = Fixture::new(1);
        let expected = f.oracle(&["--setup", setup]);
        assert_eq!(expected["ok"], false, "{setup}: {expected}");
        f.copy();
        let db = f.native();
        let before = snapshot(&db);
        let actual = plan_on_connection(&db, NOW, CAMPAIGN)
            .unwrap_err()
            .to_string();
        assert_eq!(actual, expected["error"].as_str().unwrap(), "{setup}");
        assert_eq!(snapshot(&db), before);
    }
    for campaign in ["", "invalid id", "unknown"] {
        let f = Fixture::new(0);
        let db = f.native();
        let expected = f.oracle(&["--campaign-id", campaign]);
        assert_eq!(
            plan_on_connection(&db, NOW, campaign)
                .unwrap_err()
                .to_string(),
            expected["error"].as_str().unwrap()
        );
    }
}
fn fault_sql(fault: &str) -> Option<&'static str> {
    Some(match fault {
        "stale-revision" => {
            "UPDATE campaign_nodes SET node_revision=node_revision+1 WHERE node_id='legacy:expired-b'"
        }
        "stale-owner" => {
            "UPDATE campaign_nodes SET lease_owner='different-worker' WHERE node_id='legacy:expired-b'"
        }
        "stale-generation" => {
            "UPDATE campaign_nodes SET lease_generation=lease_generation+1 WHERE node_id='legacy:expired-b'"
        }
        "stale-expiry" => {
            "UPDATE campaign_nodes SET lease_expires_at='2026-07-31T05:00:00.000Z' WHERE node_id='legacy:expired-b'"
        }
        "stale-parent" => {
            "UPDATE paper_campaigns SET revision=revision+1 WHERE campaign_id='legacy-campaign'"
        }
        "stale-queued-count" => {
            "UPDATE campaign_nodes SET status='queued' WHERE node_id='legacy:terminal'"
        }
        "same-count-queued" => {
            "UPDATE campaign_nodes SET node_revision=node_revision+1, failure_class='concurrent' WHERE node_id='legacy:queued-0000'"
        }
        "integrated" => {
            "UPDATE campaign_nodes SET prepared_integration_status='integrated' WHERE node_id='legacy:expired-a'"
        }
        "lease" => {
            "INSERT INTO automation_resource_leases(lease_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,acquired_at,renewed_at,expires_at) VALUES('blocked-lease','global','old-owner','legacy-campaign',NULL,1,0,0,0,'2026-01-01','2026-01-01','2026-01-01')"
        }
        "event-failure" => {
            "CREATE TEMP TRIGGER residue_test_fail BEFORE INSERT ON campaign_events BEGIN SELECT RAISE(ABORT,'injected_event_failure'); END"
        }
        "receipt-failure" => {
            "CREATE TEMP TRIGGER residue_test_fail BEFORE INSERT ON receipt_ledger BEGIN SELECT RAISE(ABORT,'injected_receipt_failure'); END"
        }
        _ => return None,
    })
}
fn inject(db: &mut Connection, fault: &str, prepared: &PreparedOperation) {
    if let Some(sql) = fault_sql(fault) {
        db.execute_batch(sql).unwrap();
        return;
    }
    if fault == "duplicate-event" {
        let s = prepared.settlements.last().unwrap();
        db.execute("INSERT INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) VALUES(?,?,?,?,?,?,?)",params![s.event_id,CAMPAIGN,s.node["nodeId"].as_str().unwrap(),"collision","{}",s.event_hash,NOW]).unwrap();
    } else if fault == "duplicate-receipt" {
        let tx = db.transaction().unwrap();
        one(&tx,"INSERT INTO receipt_ledger(receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",prepared.receipt.parameters.clone()).unwrap();
        tx.commit().unwrap();
    } else {
        panic!("unknown fault");
    }
}
#[test]
fn legacy_residue_stale_rows_late_collisions_and_triggers_roll_back_all_business_changes() {
    for fault in [
        "stale-revision",
        "stale-owner",
        "stale-generation",
        "stale-expiry",
        "stale-parent",
        "stale-queued-count",
        "integrated",
        "lease",
        "duplicate-event",
        "duplicate-receipt",
        "event-failure",
        "receipt-failure",
    ] {
        let f = Fixture::new(1);
        let mut db = f.native();
        let prepared = prepare_operation(&db, CAMPAIGN, None, &mut || Ok(NOW.into())).unwrap();
        inject(&mut db, fault, &prepared);
        let before = snapshot(&db);
        assert!(
            execute_prepared(
                &mut db,
                prepared,
                &mut || Ok(NOW.into()),
                |_| Ok(()),
                || Ok(())
            )
            .is_err(),
            "{fault}"
        );
        assert_eq!(snapshot(&db), before, "{fault}");
        let expected = f.oracle(&["--execute", "--fault", fault]);
        assert_eq!(expected["ok"], false, "{fault}: {expected}");
        assert_eq!(
            snapshot(&db),
            canonical_snapshot(&expected["snapshot"]),
            "{fault}"
        );
    }
}
#[test]
fn legacy_residue_same_count_queued_changes_are_observed_not_hash_fenced() {
    let f = Fixture::new(2);
    let mut db = f.native();
    let prepared = prepare_operation(&db, CAMPAIGN, None, &mut || Ok(NOW.into())).unwrap();
    inject(&mut db, "same-count-queued", &prepared);
    let actual = execute_prepared(
        &mut db,
        prepared,
        &mut || Ok(NOW.into()),
        |_| Ok(()),
        || Ok(()),
    )
    .unwrap();
    let expected = f.oracle(&["--execute", "--fault", "same-count-queued"]);
    assert_eq!(actual, expected["report"]);
    assert_ne!(
        actual["preservedQueuedNodeStateHash"],
        actual["after"]["preservedQueuedNodeStateHash"]
    );
    assert_eq!(snapshot(&db), canonical_snapshot(&expected["snapshot"]));
}
#[test]
fn legacy_residue_uses_plan_time_for_settlement_but_samples_ledger_and_after_separately() {
    let f = Fixture::new(1);
    let mut db = f.native();
    let times = [NOW, "2026-08-01T05:00:01.000Z", "2026-08-01T05:00:02.000Z"];
    let mut calls = 0;
    let actual = execute_on_admitted_connection(
        &mut db,
        CAMPAIGN,
        Some("source-commit"),
        &mut || {
            let result = Ok(times[calls].into());
            calls += 1;
            result
        },
        |_| Ok(()),
        || Ok(()),
    )
    .unwrap();
    let expected = f.oracle(&[
        "--execute",
        "--times",
        &serde_json::to_string(&times).unwrap(),
        "--release-commit",
        "source-commit",
    ]);
    assert_eq!(calls, 3);
    assert_eq!(expected["clockCalls"], 3);
    assert_eq!(actual, expected["report"]);
    assert_eq!(actual["settledAt"], NOW);
    assert_eq!(snapshot(&db), canonical_snapshot(&expected["snapshot"]));
}
#[test]
fn legacy_residue_precommit_scope_failure_rolls_back_and_explicit_zero_policy_matches() {
    let f = Fixture::new(1);
    let expected = f.oracle(&["--setup", "policy-zero"]);
    f.copy();
    let mut db = f.native();
    assert_eq!(
        plan_on_connection(&db, NOW, CAMPAIGN).unwrap(),
        expected["report"]
    );
    let before = snapshot(&db);
    let failed = execute_on_admitted_connection(
        &mut db,
        CAMPAIGN,
        None,
        &mut || Ok(NOW.into()),
        |_| Ok(()),
        || Err(failure("scope_lost")),
    );
    assert!(failed.is_err());
    assert_eq!(snapshot(&db), before);
    let actual = run(&mut db).unwrap();
    let expected = f.oracle(&["--execute"]);
    assert_eq!(actual, expected["report"]);
    assert_eq!(snapshot(&db), canonical_snapshot(&expected["snapshot"]));
}

#[test]
fn legacy_residue_explicit_offset_matches_but_timezone_less_lease_fails_closed() {
    let f = Fixture::new(1);
    let expected = f.oracle(&["--setup", "offset-lease"]);
    f.copy();
    let mut db = f.native();
    assert_eq!(
        plan_on_connection(&db, NOW, CAMPAIGN).unwrap(),
        expected["report"]
    );
    let actual = run(&mut db).unwrap();
    let expected = f.oracle(&["--execute"]);
    assert_eq!(actual, expected["report"]);
    assert_eq!(snapshot(&db), canonical_snapshot(&expected["snapshot"]));
    let f = Fixture::new(1);
    let node = f.oracle(&["--setup", "naive-lease", "--timezone", "Asia/Shanghai"]);
    assert_eq!(
        node["ok"], true,
        "V8 reads noon Shanghai as 04:00 UTC: {node}"
    );
    f.copy();
    let mut db = f.native();
    let before = snapshot(&db);
    assert!(millis("2026-08-01T12:00:00").is_none());
    assert!(
        run(&mut db)
            .unwrap_err()
            .to_string()
            .contains("lease_not_expired")
    );
    assert_eq!(snapshot(&db), before);
}
#[test]
fn legacy_residue_midnight_checks_raw_fraction_before_millisecond_truncation() {
    let inputs = [
        "2026-07-30T24:00:00Z",
        "2026-07-30T24:00:00.0000Z",
        "2026-07-30T24:00:00.00000000000000+08:00",
        "2026-07-30T24:00:00.0001Z",
        "2026-07-30T24:00:00.00000000000001+08:00",
        "2026-07-30T24:00:00.0010Z",
        "2026-07-30T24:00:01.0000Z",
        "2026-07-30T24:01:00.0000Z",
        "2026-07-30T23:59:59.0001Z",
    ];
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "-e",
            "if(process.versions.node!=='22.23.1')throw Error('pinned_node_required');process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(Date.parse)));",
            &serde_json::to_string(&inputs).unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<Option<i64>> = serde_json::from_slice(&output.stdout).unwrap();
    for (input, expected) in inputs.into_iter().zip(expected) {
        assert_eq!(millis(input), expected, "{input}");
    }

    let f = Fixture::new(1);
    Connection::open(&f.node)
        .unwrap()
        .execute(
            "UPDATE campaign_nodes SET lease_expires_at=? WHERE node_id='legacy:expired-b'",
            ["2026-07-30T24:00:00.0001Z"],
        )
        .unwrap();
    f.copy();
    let mut db = f.native();
    let before = snapshot(&db);
    let expected = f.oracle(&["--execute"]);
    assert_eq!(expected["ok"], false);
    assert_eq!(run(&mut db).unwrap_err().to_string(), expected["error"]);
    assert_eq!(snapshot(&db), before);
}

#[test]
fn legacy_residue_crash_child() {
    let Ok(path) = std::env::var("HEPTA_LEGACY_RESIDUE_TEST_CRASH_DB") else {
        return;
    };
    let mut db = Connection::open(path).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
        .unwrap();
    let _ = execute_on_admitted_connection(
        &mut db,
        CAMPAIGN,
        None,
        &mut || Ok(NOW.into()),
        |_| Ok(()),
        || std::process::exit(74),
    );
    panic!("exit hook not reached");
}
#[test]
fn legacy_residue_process_death_before_commit_recovers_every_row() {
    let f = Fixture::new(2);
    let db = f.native();
    let before = snapshot(&db);
    drop(db);
    let status=Command::new(std::env::current_exe().unwrap()).args(["--exact","automation_runtime_reconciliation::legacy_terminal_residue::tests::legacy_residue_crash_child"]).env("HEPTA_LEGACY_RESIDUE_TEST_CRASH_DB",&f.rust).status().unwrap();
    assert_eq!(status.code(), Some(74));
    let mut db = f.native();
    assert_eq!(snapshot(&db), before);
    let actual = run(&mut db).unwrap();
    let expected = f.oracle(&["--execute"]);
    assert_eq!(actual, expected["report"]);
    assert_eq!(snapshot(&db), canonical_snapshot(&expected["snapshot"]));
}

// Do not use the production row observer for rejection evidence: it correctly
// refuses these integers. Preserve SQLite storage classes and exact i64 text in
// an independent test-only snapshot, including every table and every column.
fn exact_sqlite_snapshot(db: &Connection) -> Vec<(String, Vec<Vec<String>>)> {
    use rusqlite::types::ValueRef;
    let tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap()
        .query_map([], |row| row.get::<_, String>(0)).unwrap()
        .collect::<rusqlite::Result<Vec<_>>>().unwrap();
    tables
        .into_iter()
        .map(|table| {
            let mut statement = db
                .prepare(&format!("SELECT * FROM \"{}\"", table.replace('"', "\"\"")))
                .unwrap();
            let width = statement.column_count();
            let mut rows = statement
                .query_map([], |row| {
                    (0..width)
                        .map(|column| {
                            Ok(match row.get_ref(column)? {
                                ValueRef::Null => "null".into(),
                                ValueRef::Integer(value) => format!("integer:{value}"),
                                ValueRef::Real(value) => format!("real:{value:?}"),
                                ValueRef::Text(value) => format!("text:{}", hex::encode(value)),
                                ValueRef::Blob(value) => format!("blob:{}", hex::encode(value)),
                            })
                        })
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            rows.sort();
            (table, rows)
        })
        .collect()
}
fn node_integer_boundary_call(fixture: &Fixture, execute: bool) -> Value {
    // Catch the actual business call directly. The ordinary differential
    // fixture's final snapshot itself cannot encode an unsafe node:sqlite
    // integer, and could otherwise obscure the operation's original error.
    let script = r#"
import path from 'node:path';
import {createReadOnlyPaperStore,openExistingWritablePaperStore} from './paper-adapters/persistence/store-provider.mjs';
import {planLegacyTerminalActiveResidueSettlement,executeLegacyTerminalActiveResidueSettlement} from './paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs';
import {createSqliteReceiptLedger} from './paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {issueAutomationReconcilerWriter} from './paper-adapters/persistence/receipt-writer-broker.mjs';
const dbPath=process.argv[1],execute=process.argv[2]==='execute',root=path.dirname(dbPath);
const store=(execute?openExistingWritablePaperStore:createReadOnlyPaperStore)({root,runtimeRoot:root,dbPath});
const clock={nowIso:()=> '2026-08-01T05:00:00.000Z'};
let result;
try {
  const receiptLedger=createSqliteReceiptLedger({store,clock,issuerCapability:issueAutomationReconcilerWriter()});
  const report=(execute?executeLegacyTerminalActiveResidueSettlement:planLegacyTerminalActiveResidueSettlement)({store,clock,receiptLedger,campaignId:'legacy-campaign'});
  result={ok:true,report};
} catch(error) {result={ok:false,error:String(error.message),code:error.code};}
finally {store.close();}
process.stdout.write(JSON.stringify(result));
"#;
    let output = Command::new("node")
        .current_dir(repo())
        .args(["--input-type=module", "--eval", script, "--"])
        .arg(&fixture.node)
        .arg(if execute { "execute" } else { "plan" })
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
const INTEGER_FIELDS: [(&str, &str, &str, &str); 4] = [
    (
        "campaign_nodes",
        "lease_generation",
        "node_id",
        "legacy:expired-a",
    ),
    (
        "campaign_nodes",
        "node_revision",
        "node_id",
        "legacy:expired-a",
    ),
    (
        "campaign_nodes",
        "node_revision",
        "node_id",
        "legacy:queued-0000",
    ),
    ("paper_campaigns", "revision", "campaign_id", CAMPAIGN),
];
#[test]
fn legacy_residue_rejects_unsafe_sqlite_integers_like_node_before_any_mutation() {
    for (table, column, id_column, id) in INTEGER_FIELDS {
        for value in [9_007_199_254_740_992_i64, -9_007_199_254_740_992_i64] {
            let fixture = Fixture::new(1);
            let node = Connection::open(&fixture.node).unwrap();
            node.execute(
                &format!("UPDATE {table} SET {column}=? WHERE {id_column}=?"),
                params![value, id],
            )
            .unwrap();
            let node_before = exact_sqlite_snapshot(&node);
            drop(node);
            fixture.copy();
            let mut native = fixture.native();
            let native_before = exact_sqlite_snapshot(&native);
            assert_eq!(native_before, node_before);
            for execute in [false, true] {
                let observed = node_integer_boundary_call(&fixture, execute);
                assert_eq!(
                    observed["ok"], false,
                    "{table}.{column} {id} {value}: {observed}"
                );
                assert_eq!(observed["code"], "ERR_OUT_OF_RANGE");
                assert!(
                    observed["error"]
                        .as_str()
                        .unwrap()
                        .contains(&value.to_string())
                );
                let result = if execute {
                    run(&mut native)
                } else {
                    plan_on_connection(&native, NOW, CAMPAIGN)
                };
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("unrepresentable reconciliation row")
                );
                assert!(native.is_autocommit());
                assert_eq!(exact_sqlite_snapshot(&native), native_before);
                let node = Connection::open(&fixture.node).unwrap();
                assert_eq!(exact_sqlite_snapshot(&node), node_before);
            }
        }
    }
}
#[test]
fn legacy_residue_safe_integer_limits_preserve_node_plan_and_queued_digest_parity() {
    for (table, column, id_column, id) in INTEGER_FIELDS {
        for value in [9_007_199_254_740_991_i64, -9_007_199_254_740_991_i64] {
            let fixture = Fixture::new(1);
            let node = Connection::open(&fixture.node).unwrap();
            node.execute(
                &format!("UPDATE {table} SET {column}=? WHERE {id_column}=?"),
                params![value, id],
            )
            .unwrap();
            drop(node);
            fixture.copy();
            let native = fixture.native();
            let before = exact_sqlite_snapshot(&native);
            let observed = node_integer_boundary_call(&fixture, false);
            assert_eq!(
                observed["ok"], true,
                "{table}.{column} {id} {value}: {observed}"
            );
            assert_eq!(
                plan_on_connection(&native, NOW, CAMPAIGN).unwrap(),
                observed["report"]
            );
            assert_eq!(exact_sqlite_snapshot(&native), before);
        }
    }
}
