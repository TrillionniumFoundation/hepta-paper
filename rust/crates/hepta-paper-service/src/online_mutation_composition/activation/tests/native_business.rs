//! Lower composition integration only. Genuine schema/source/cache/recovery
//! producers feed the real fixed business coordinator, but these fixtures never
//! construct production native/deployment admission or an activated runtime.
use super::*;
use crate::automation_runtime_reconciliation::{
    LocalReconciliationOperationV1, OnlineReconciliationBindingV1, OnlineReconciliationRequestV1,
    execute_retained_online_reconciliation_v1,
};
use crate::online_mutation_composition::activation::transaction::NativeTransactionEvidenceV1;
use base64ct::{Base64, Encoding};
use rusqlite::{Connection, ErrorCode, OpenFlags, types::Value as SqlValue};
use std::{collections::BTreeSet, time::Duration};

fn probe(path: &Path, busy: bool) {
    let output = Command::new("/proc/self/exe")
        .args(["--exact", "online_mutation_composition::activation::tests::native_business::native_business_lock_probe_child", "--nocapture"])
        .env("HEPTA_NATIVE_BUSINESS_PROBE", path)
        .env("HEPTA_NATIVE_BUSINESS_BUSY", if busy { "yes" } else { "no" })
        .output().unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("native business lock observed"));
}

#[test]
fn native_business_lock_probe_child() {
    let Some(path) = std::env::var_os("HEPTA_NATIVE_BUSINESS_PROBE") else {
        return;
    };
    let db = Connection::open(path).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    let result = db.execute_batch("BEGIN IMMEDIATE");
    if std::env::var("HEPTA_NATIVE_BUSINESS_BUSY").unwrap() == "yes" {
        assert_eq!(
            result.unwrap_err().sqlite_error_code(),
            Some(ErrorCode::DatabaseBusy)
        );
    } else {
        result.unwrap();
        db.execute_batch("ROLLBACK").unwrap();
    }
    println!("native business lock observed");
}

// Read the owning SQLite handle only. No raw target/sidecar FD is opened or
// closed, even in test assertions, while any SQLite transaction is alive.
fn snapshot(db: &Connection) -> Vec<(String, Vec<String>)> {
    let names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap()
        .query_map([], |row| row.get::<_, String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    names
        .into_iter()
        .map(|name| {
            let mut statement = db
                .prepare(&format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")))
                .unwrap();
            let columns = statement.column_count();
            let mut rows = statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|column| row.get::<_, SqlValue>(column))
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .map(|values| format!("{values:?}"))
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            rows.sort();
            (name, rows)
        })
        .collect()
}
fn journal(root: &Root) -> Value {
    serde_json::from_slice(&fs::read(root.0.join("journal-fixture.json")).unwrap()).unwrap()
}
fn assert_business_changeset(reserve: &Value) {
    let bytes = Base64::decode_vec(reserve["changesetBase64"].as_str().unwrap()).unwrap();
    assert_eq!(
        crate::sqlite_mutation_coordinator::hash_bytes(&bytes),
        reserve["changesetHash"]
    );
    let effects = crate::sqlite_changeset::inspect_sqlite_changeset_effects_v1(&bytes).unwrap();
    let actual = effects
        .iter()
        .map(|effect| (effect.table.as_str(), effect.operation.as_str()))
        .collect::<BTreeSet<_>>();
    assert_eq!(
        actual,
        BTreeSet::from([
            ("campaign_nodes", "UPDATE"),
            ("campaign_events", "INSERT"),
            ("receipt_ledger", "INSERT")
        ])
    );
    assert_eq!(
        reserve["writerId"],
        "writer:native-store:automation-runtime-reconciler:v1"
    );
    assert_ne!(reserve["preStateHash"], reserve["postStateHash"]);
}

fn native_business(legacy: bool, reject_commit: bool) {
    let root = Root::new();
    let fixture = oracle(&root.0, "native-fixture");
    assert_eq!(fixture["nativeBusiness"], true);
    let request = request_from_fixture(&fixture);
    let mut prepared = prepare_initial_online_mutation_composition_v1(&request)
        .unwrap_or_else(|e| panic!("prepare {} {}", e.code, e.details));
    prepared.assert_current().unwrap();
    for key in [
        "runtimeReady",
        "productionActivation",
        "nodeRetirementVerified",
    ] {
        assert_eq!(prepared.value()[key], false);
    }
    let inventory = prepared.startup.post_inventory();
    let mut clock = CompositionClock(&prepared.checked_at);
    let source = prepared
        .source
        .retain_for_native_store_transaction_v1(
            inventory,
            &prepared.verifier,
            &prepared.active,
            &mut clock,
        )
        .unwrap();
    let cache = prepared
        .cache
        .retain_for_native_store_transaction_v1(
            &prepared.verifier,
            &prepared.active,
            inventory,
            &prepared.source,
            &mut clock,
        )
        .unwrap();
    let guard = inventory.native_store_transaction_guard_v1().unwrap();
    let recovery = prepared
        .fence
        .retain_native_store_transaction_v1(&prepared.fence_binding, &guard, &prepared.verifier)
        .unwrap();
    let binding = OnlineReconciliationBindingV1 {
        database_instance_id: guard.instance()["instanceId"].as_str().unwrap().into(),
        schema_contract_id: guard.instance()["schemaContractId"]
            .as_str()
            .unwrap()
            .into(),
    };
    let path = request
        .runtime_root
        .join(guard.instance()["sourceRelativePath"].as_str().unwrap());
    let evidence = NativeTransactionEvidenceV1 {
        manifest: &prepared.manifest,
        initial_inventory: &prepared.initial_inventory,
        startup: &prepared.startup,
        schema: &prepared.schema,
        source: &prepared.source,
        active: &prepared.active,
        finalized: &prepared.finalized,
        inspection: &prepared.inspection,
        cache: &prepared.cache,
        fence: &prepared.fence,
        verifier: &prepared.verifier,
        checked_at: &prepared.checked_at,
        package: &prepared.package,
    };
    // All regular-file observations above predate this only writable handle.
    // Its declaration order keeps retained target descriptors alive on unwind.
    let mut db = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .unwrap();
    let before = snapshot(&db);
    let version: i64 = db
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(version, 25);
    let checked = Cell::new(0);
    let check = || {
        let calls = fs::read(root.0.join("calls.jsonl")).unwrap();
        evidence.assert_current(&source, &cache, &guard, &recovery)?;
        assert_eq!(
            fs::read(root.0.join("calls.jsonl")).unwrap(),
            calls,
            "retained evidence must not call the authority"
        );
        probe(&path, true);
        checked.set(checked.get() + 1);
        Ok(())
    };
    let campaign = if legacy {
        "legacy-campaign"
    } else {
        "standard-campaign"
    };
    let result = execute_retained_online_reconciliation_v1(
        &mut db,
        &mut prepared.coordinator,
        &binding,
        &OnlineReconciliationRequestV1 {
            operation: if legacy {
                LocalReconciliationOperationV1::LegacyTerminalActiveResidue
            } else {
                LocalReconciliationOperationV1::Standard
            },
            campaign_id: Some(campaign.into()),
            no_progress_seconds: 1800.0,
            release_commit: Some("native-lower-composition-fixture".into()),
        },
        check,
        check,
        || {
            check()?;
            let pending = journal(&root);
            assert!(pending["pending"]["reservation"]["signature"].is_string());
            assert_business_changeset(&pending["pending"]["reserveRequest"]);
            if reject_commit {
                Err(error("native_business_precommit_rejected"))
            } else {
                Ok(())
            }
        },
    );
    assert_eq!(
        checked.get(),
        3,
        "all real transaction boundaries must execute: {result:?}"
    );
    let journal = journal(&root);
    assert!(journal.get("pending").is_none());
    let count = |table: &str| {
        db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap()
    };
    if reject_commit {
        let failure = result.unwrap_err();
        assert_eq!(
            failure.code, "native_business_precommit_rejected",
            "{}",
            failure.details
        );
        assert_ne!(failure.details["committed"], true);
        assert_eq!(
            snapshot(&db),
            before,
            "business rows, events, receipt and marker must all roll back"
        );
        assert_eq!(journal["entries"].as_array().unwrap().len(), 0);
        assert_eq!(journal["aborts"].as_array().unwrap().len(), 1);
        assert_eq!(
            journal["aborts"][0]["abortReceipt"]["status"],
            "autonomous_research_online_mutation_aborted"
        );
        assert_business_changeset(&journal["aborts"][0]["reserveRequest"]);
        assert_eq!(
            count("autonomous_research_online_mutation_authority_marker"),
            0
        );
        assert_eq!(
            count("autonomous_research_online_mutation_finalization_receipt"),
            0
        );
        // The one-shot scope is consumed after refusal too. In DELETE mode the
        // observed journal has now disappeared; its retained identity cannot
        // be reused as proof for a second transaction, even after full rollback.
    } else {
        let receipt = result.unwrap_or_else(|e| panic!("business {} {}", e.code, e.details));
        assert!(receipt["ledgerReceipt"].is_object());
        assert_ne!(snapshot(&db), before);
        assert_eq!(journal["entries"].as_array().unwrap().len(), 1);
        let entry = &journal["entries"][0];
        assert_business_changeset(&entry["reserveRequest"]);
        let finalized = prepared
            .coordinator
            .verify_latest_finalized_mutation(&db, &binding.database_instance_id)
            .unwrap();
        assert_eq!(finalized.value(), &entry["finalizationReceipt"]);
        assert_eq!(journal["globalHash"], finalized.value()["globalHash"]);
        let head = journal["databaseHeads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|head| head["databaseInstanceId"] == binding.database_instance_id)
            .unwrap();
        assert_eq!(head["hash"], finalized.value()["databaseHash"]);
        assert_eq!(head["stateHash"], finalized.value()["postStateHash"]);
        assert_eq!(
            count("autonomous_research_online_mutation_authority_marker"),
            1
        );
        assert_eq!(
            count("autonomous_research_online_mutation_finalization_receipt"),
            1
        );
        let status = |suffix: &str| {
            db.query_row(
                "SELECT status FROM campaign_nodes WHERE node_id=?",
                [format!("{campaign}:{suffix}")],
                |row| row.get::<_, String>(0),
            )
            .unwrap()
        };
        assert_eq!(status("expired"), "skipped");
        assert_eq!(status("queued"), if legacy { "queued" } else { "skipped" });
        assert!(
            prepared
                .fence
                .assert_native_store_transaction_current_v1(&recovery, &prepared.verifier)
                .is_err(),
            "actual coordinator finalization feedback must invalidate the original epoch token"
        );
        assert!(
            evidence
                .assert_current(&source, &cache, &guard, &recovery)
                .is_err()
        );
    }
    db.close().unwrap();
    drop(recovery);
    drop(guard);
    drop(cache);
    drop(source);
    probe(&path, false);
    // A new real process observation authenticates the terminal authority head;
    // it cannot revive the now-invalid original evidence or grant activation.
    let mut authority = Online::load_process(
        &request.online_process_configuration_path,
        &request.online_process_configuration_file_hash,
    )
    .unwrap();
    let now = SystemMutationClockV1.now_millis().unwrap();
    let trust = authority.trust();
    let head_request = json!({"version":1,"kind":"AutonomousResearchOnlineMutationCurrentHeadRequest",
        "protocol":crate::sqlite_mutation_coordinator::ONLINE_MUTATION_PROTOCOL,
        "scopeId":trust["scopeId"],"databaseScopeHash":trust["databaseScopeHash"],"writerManifestHash":trust["writerManifestHash"],
        "nonce":"head:native-business-terminal","requestedAt":crate::sqlite_mutation_coordinator::clock::iso(now).unwrap()});
    let terminal = authority
        .observe_current_head(&head_request, None, now)
        .unwrap();
    assert_eq!(
        terminal.value()["globalSequence"],
        if reject_commit { 0 } else { 1 }
    );
    assert_eq!(terminal.value()["globalHash"], journal["globalHash"]);
    assert_eq!(terminal.value()["databaseHeads"], journal["databaseHeads"]);
    assert_eq!(terminal.value()["unresolvedReservationCount"], 0);
}

#[test]
fn retained_composition_standard_business_finalizes_signed_changeset_and_invalidates_epoch() {
    native_business(false, false);
}
#[test]
fn retained_composition_legacy_business_finalizes_signed_changeset_and_preserves_queued() {
    native_business(true, false);
}
#[test]
fn retained_composition_business_precommit_refusal_aborts_signed_reservation_and_rolls_back() {
    native_business(false, true);
}
