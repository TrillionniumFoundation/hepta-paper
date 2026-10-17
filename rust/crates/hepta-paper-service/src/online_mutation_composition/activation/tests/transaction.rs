use super::*;
use rusqlite::{Connection, ErrorCode};
use std::time::Duration;

fn probe(path: &Path, busy: bool) {
    let output = Command::new("/proc/self/exe")
        .args(["--exact", "online_mutation_composition::activation::tests::transaction::retained_composition_lock_probe_child", "--nocapture"])
        .env("HEPTA_RETAINED_COMPOSITION_PROBE", path)
        .env("HEPTA_RETAINED_COMPOSITION_BUSY", if busy { "yes" } else { "no" })
        .output().unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("retained composition lock observed"));
}

#[test]
fn retained_composition_lock_probe_child() {
    let Some(path) = std::env::var_os("HEPTA_RETAINED_COMPOSITION_PROBE") else {
        return;
    };
    let db = Connection::open(path).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    let result = db.execute_batch("BEGIN IMMEDIATE");
    if std::env::var("HEPTA_RETAINED_COMPOSITION_BUSY").unwrap() == "yes" {
        assert_eq!(
            result.unwrap_err().sqlite_error_code(),
            Some(ErrorCode::DatabaseBusy)
        );
    } else {
        result.unwrap();
        db.execute_batch("ROLLBACK").unwrap();
    }
    println!("retained composition lock observed");
}

fn retained_composition(historical: bool) {
    let root = Root::new();
    let value = oracle(&root.0, "fixture");
    let mut request = request_from_fixture(&value);
    if historical {
        let pending = oracle(&root.0, "pending-heartbeat");
        assert_eq!(pending["markerCount"], 1);
        assert_eq!(pending["finalizationCount"], 0);
        assert_eq!(pending["outcome"]["committed"], true);
        request.schema_checkpoint_root =
            Some(PathBuf::from(value["checkpointRoot"].as_str().unwrap()));
    }
    let prepared = prepare_initial_online_mutation_composition_v1(&request)
        .unwrap_or_else(|e| panic!("{} {}", e.code, e.details));
    // Exercise unchanged complete checks before opening any owning connection.
    prepared.assert_current().unwrap();
    let inventory = prepared.startup.post_inventory();
    assert_eq!(
        prepared.initial_inventory.value() == inventory.value(),
        !historical
    );
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
    // Even an equal fresh report is a different retained observation. Create
    // every raw FD before opening SQLite, including the negative-test guard.
    let other_inventory =
        observe_state_database_inventory_v1(&request.runtime_root, &prepared.manifest.value)
            .unwrap();
    assert_eq!(inventory.value(), other_inventory.value());
    let other_guard = other_inventory.native_store_transaction_guard_v1().unwrap();
    let guard = inventory.native_store_transaction_guard_v1().unwrap();
    let recovery = prepared
        .fence
        .retain_native_store_with_pins(&prepared.fence_binding, &guard, &prepared.verifier, || {
            assert_product_owner_current(
                prepared.installed_authority.as_ref(),
                &prepared.fence,
                &prepared.verifier,
            )
        })
        .unwrap_or_else(|e| panic!("recovery {} {}", e.code, e.details));
    let calls = fs::read(root.0.join("calls.jsonl")).unwrap();
    let target = request
        .runtime_root
        .join(guard.instance()["sourceRelativePath"].as_str().unwrap());
    let schema_path = if historical {
        request
            .schema_checkpoint_root
            .as_ref()
            .unwrap()
            .join("POST_INVENTORY.json")
    } else {
        request
            .runtime_root
            .join("autonomous-research/online-schema-transition/FINAL.json")
    };
    let schema_bytes = fs::read(&schema_path).unwrap();
    // Reverse local-drop order is intentional: on panic/unwind SQLite closes
    // before the recovery Rc, scopes and any observed raw target descriptors.
    let database = Connection::open(&target).unwrap();
    database
        .execute_batch(
            "BEGIN IMMEDIATE; UPDATE fixture_anchor SET value='staged-retained-composition'",
        )
        .unwrap();
    prepared
        .assert_retained_evidence_for_native_store_transaction(&source, &cache, &guard, &recovery)
        .unwrap_or_else(|e| panic!("retained {} {}", e.code, e.details));
    probe(&target, true);
    assert!(
        prepared
            .assert_retained_evidence_for_native_store_transaction(
                &source,
                &cache,
                &other_guard,
                &recovery,
            )
            .is_err()
    );
    probe(&target, true);
    if historical {
        // Binding the historical startup to its post inventory would lose the
        // genuine recovery input. This must fail even though guard is correct.
        let err = prepared
            .startup
            .assert_retained_for_native_store_transaction(
                inventory,
                &prepared.verifier,
                &guard,
                &mut clock,
            )
            .unwrap_err();
        assert_eq!(
            err.code,
            "autonomous_research_online_runtime_activation_startup_subject_changed"
        );
        prepared
            .startup
            .assert_retained_for_native_store_transaction(
                &prepared.initial_inventory,
                &prepared.verifier,
                &guard,
                &mut clock,
            )
            .unwrap();
    }
    assert_eq!(fs::read(root.0.join("calls.jsonl")).unwrap(), calls);
    // Replacing a schema/checkpoint report with identical bytes must invalidate
    // the held identity. Failure must leave the real database lock intact.
    let replacement = schema_path.with_extension("replacement");
    fs::write(&replacement, schema_bytes).unwrap();
    fs::set_permissions(&replacement, fs::Permissions::from_mode(0o600)).unwrap();
    fs::rename(replacement, &schema_path).unwrap();
    let err = prepared
        .schema
        .assert_retained_for_native_store_transaction(
            inventory,
            &prepared.source,
            &prepared.active,
            &prepared.finalized,
            &prepared.verifier,
            &source,
            &guard,
            &mut clock,
        )
        .unwrap_err();
    assert!(
        err.code.contains(if historical {
            "online_schema_checkpoint_files_changed"
        } else {
            "online_schema_transition_audit_changed"
        }),
        "{}",
        err.code
    );
    probe(&target, true);
    assert_eq!(fs::read(root.0.join("calls.jsonl")).unwrap(), calls);
    for key in [
        "runtimeReady",
        "productionActivation",
        "nodeRetirementVerified",
    ] {
        assert_eq!(prepared.value()[key], false);
    }
    database.execute_batch("ROLLBACK").unwrap();
    database.close().unwrap();
    drop(recovery);
    drop(guard);
    drop(cache);
    drop(source);
    probe(&target, false);
}

#[test]
fn retained_composition_initial_schema_preserves_actual_evidence_and_sqlite_lock() {
    retained_composition(false);
}

#[test]
fn retained_composition_recovered_history_preserves_actual_post_inventory_and_sqlite_lock() {
    retained_composition(true);
}
