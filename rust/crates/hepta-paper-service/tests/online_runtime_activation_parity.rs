use hepta_paper_service::online_runtime_activation::{contracts::*, database::*, inventory::*};
use serde_json::{Value, json};
use std::io::Write;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
fn oracle(input: Value) -> Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("node")
        .arg(root.join("oracle/online-runtime-activation-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node 22 oracle");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(input.to_string().as_bytes())
        .expect("input");
    let output = child.wait_with_output().expect("oracle exit");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("oracle JSON")
}
fn fixture() -> Value {
    oracle(json!({"mode":"fixture"}))
}
fn rehash_receipt(v: &mut Value) {
    v["activationReceiptHash"] = json!(runtime_activation_receipt_hash_v1(v).unwrap());
}
fn rehash_inventory(v: &mut Value) {
    v["databaseScopeHash"] = json!(state_database_scope_hash_v1(&v["instances"]).unwrap());
    v["inventoryHash"] = json!(state_database_inventory_hash_v1(v).unwrap());
}
#[test]
fn activation_receipt_hash_and_rejections_match_node_without_minting_authority() {
    let f = fixture();
    let original = &f["receipt"];
    assert_runtime_activation_receipt_v1(original).unwrap();
    assert_eq!(
        runtime_activation_receipt_hash_v1(original).unwrap(),
        original["activationReceiptHash"]
    );
    let mut cases = vec![original.clone()];
    for key in [
        "version",
        "kind",
        "status",
        "protocol",
        "inventoryHash",
        "databaseScopeHash",
        "writerManifestHash",
        "authorityId",
        "keyId",
        "authorityGlobalSequence",
        "authorityGlobalHash",
        "databaseActivations",
        "activeRefreshReceiptHash",
        "authorityEvidenceCacheReceiptHash",
        "restoreDrillReceiptHash",
        "schemaTransitionReceiptHash",
        "activatedAt",
        "coordinatorRuntimeReady",
        "remainingBlockers",
        "activationReceiptHash",
    ] {
        let mut v = original.clone();
        v.as_object_mut().unwrap().remove(key);
        cases.push(v);
    }
    for (key, value) in [
        ("version", json!(2)),
        ("authorityGlobalSequence", json!(-1)),
        ("authorityGlobalSequence", json!(1.5)),
        ("authorityGlobalSequence", json!(9007199254740992_i64)),
        ("authorityId", json!("")),
        ("keyId", json!(false)),
        ("activatedAt", json!("invalid")),
        ("coordinatorRuntimeReady", json!(false)),
        ("remainingBlockers", json!(["required"])),
        ("extra", json!(true)),
    ] {
        let mut v = original.clone();
        v[key] = value;
        rehash_receipt(&mut v);
        cases.push(v);
    }
    for (key, value) in [
        ("databaseRole", json!("unknown")),
        ("databaseInstanceId", json!("")),
        ("schemaContractId", json!(false)),
        ("schemaHash", json!("bad")),
        ("startupReconciliationReceiptHash", json!(null)),
        ("finalizedHeadInspectionReceiptHash", json!("bad")),
        ("databaseSequence", json!(-1)),
        ("databaseHash", json!("bad")),
        ("stateHash", json!("bad")),
        ("extra", json!(1)),
    ] {
        let mut v = original.clone();
        v["databaseActivations"][0][key] = value;
        rehash_receipt(&mut v);
        cases.push(v);
    }
    for kind in ["duplicate-role", "duplicate-id", "reverse", "missing"] {
        let mut v = original.clone();
        match kind {
            "duplicate-role" => {
                v["databaseActivations"][1]["databaseRole"] =
                    v["databaseActivations"][0]["databaseRole"].clone()
            }
            "duplicate-id" => {
                v["databaseActivations"][1]["databaseInstanceId"] =
                    v["databaseActivations"][0]["databaseInstanceId"].clone()
            }
            "reverse" => v["databaseActivations"].as_array_mut().unwrap().reverse(),
            _ => {
                v["databaseActivations"].as_array_mut().unwrap().pop();
            }
        };
        rehash_receipt(&mut v);
        cases.push(v);
    }
    for (i, v) in cases.into_iter().enumerate() {
        let actual = match assert_runtime_activation_receipt_v1(&v) {
            Ok(()) => {
                json!({"accepted":true,"hash":runtime_activation_receipt_hash_v1(&v).unwrap()})
            }
            Err(e) => json!({"error":e.code}),
        };
        assert_eq!(
            actual,
            oracle(json!({"mode":"receipt","value":v})),
            "case {i}"
        );
    }
}
#[test]
fn closed_inventory_hash_scope_collation_and_preflight_match_node() {
    let f = fixture();
    let original = &f["inventory"];
    assert_closed_activation_inventory_v1(original, &f["manifest"]).unwrap();
    assert_eq!(
        state_database_inventory_hash_v1(original).unwrap(),
        original["inventoryHash"]
    );
    let mut rows = original["instances"].clone();
    for (row, id) in rows
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(["a-z", "A_z", "é", "E", "😀", "𐀀", "_", "Z", "z", "10"])
    {
        row["instanceId"] = json!(id);
    }
    assert_eq!(
        json!({"hash":state_database_scope_hash_v1(&rows).unwrap()}),
        oracle(json!({"mode":"scope","value":rows}))
    );
    let mut cases = vec![original.clone()];
    for kind in [
        "extra",
        "duplicate-role",
        "duplicate-id",
        "reverse",
        "scope",
        "inventory",
        "quick-check",
        "foreign-key",
        "missing-schema",
        "empty-schema-id",
        "path-traversal",
        "path-backslash",
        "unknown-role",
        "blocker",
    ] {
        let mut v = original.clone();
        match kind {
            "extra" => {
                let mut extra = v["instances"][0].clone();
                extra["instanceId"] = json!("zz-extra");
                v["instances"].as_array_mut().unwrap().push(extra);
                rehash_inventory(&mut v);
            }
            "duplicate-role" => {
                v["instances"][1]["role"] = v["instances"][0]["role"].clone();
                rehash_inventory(&mut v);
            }
            "duplicate-id" => {
                v["instances"][1]["instanceId"] = v["instances"][0]["instanceId"].clone();
                rehash_inventory(&mut v);
            }
            "reverse" => {
                v["instances"].as_array_mut().unwrap().reverse();
                rehash_inventory(&mut v);
            }
            "scope" => v["databaseScopeHash"] = f["receipt"]["authorityGlobalHash"].clone(),
            "inventory" => v["inventoryHash"] = f["receipt"]["authorityGlobalHash"].clone(),
            "quick-check" => {
                v["instances"][0]["quickCheck"] = json!("bad");
                rehash_inventory(&mut v);
            }
            "foreign-key" => {
                v["instances"][0]["foreignKeyViolationCount"] = json!(1);
                rehash_inventory(&mut v);
            }
            "missing-schema" => {
                v["instances"][0]["missingSchemaObjects"] = json!(["table:missing"]);
                rehash_inventory(&mut v);
            }
            "empty-schema-id" => {
                v["instances"][0]["schemaContractId"] = json!("");
                rehash_inventory(&mut v);
            }
            "path-traversal" => {
                v["instances"][0]["sourceRelativePath"] = json!("../outside.sqlite")
            }
            "path-backslash" => v["instances"][0]["sourceRelativePath"] = json!("foo\\bar.sqlite"),
            "unknown-role" => {
                v["instances"][0]["role"] = json!("unknown");
                rehash_inventory(&mut v);
            }
            _ => v["blockers"] = json!(["blocked"]),
        };
        cases.push(v);
    }
    for (i, v) in cases.into_iter().enumerate() {
        let code = match assert_closed_activation_inventory_v1(&v, &f["manifest"]) {
            Ok(()) => "autonomous_research_online_runtime_activation_schema_transition_required"
                .to_owned(),
            Err(e) => e.code,
        };
        assert_eq!(
            json!({"error":code}),
            oracle(
                json!({"mode":"preflight","inventory":v,"manifest":f["manifest"],"now":f["now"]})
            ),
            "inventory {i}"
        );
    }
}
#[test]
fn schema_transition_readiness_claim_hash_expiry_and_binding_match_node() {
    let f = fixture();
    let now = 1784365200000_i64;
    assert_schema_transition_readiness_claim_v1(
        &f["readiness"],
        &f["inventory"],
        &f["manifest"],
        now,
    )
    .unwrap();
    let mut cases = vec![f["readiness"].clone()];
    for (key, value) in [
        ("version", json!(2)),
        ("kind", json!("wrong")),
        ("status", json!("wrong")),
        ("protocol", json!("wrong")),
        (
            "databaseScopeHash",
            f["receipt"]["authorityGlobalHash"].clone(),
        ),
        ("writerManifestHash", json!("bad")),
        ("inventoryHash", json!("bad")),
        ("schemaTransitionReceiptHash", json!("bad")),
        ("liveObservationReceiptHash", json!("bad")),
        ("externalAuthorityVerified", json!(false)),
        ("blockers", json!(["blocked"])),
        ("observedAt", json!("invalid")),
        ("expiresAt", json!("2026-07-18T09:00:00.000Z")),
        ("expiresAt", json!("2026-07-18T08:59:00.000Z")),
        ("readinessReceiptHash", json!("bad")),
    ] {
        let mut candidate = f["readiness"].clone();
        candidate[key] = value;
        if key != "readinessReceiptHash" {
            let mut payload = candidate.clone();
            payload
                .as_object_mut()
                .unwrap()
                .remove("readinessReceiptHash");
            candidate["readinessReceiptHash"] =
                oracle(json!({"mode":"readinessHash","value":payload}))["hash"].clone();
        }
        cases.push(candidate);
    }
    for (i, v) in cases.into_iter().enumerate() {
        let valid =
            assert_schema_transition_readiness_claim_v1(&v, &f["inventory"], &f["manifest"], now)
                .is_ok();
        let node = oracle(
            json!({"mode":"preflight","inventory":f["inventory"],"manifest":f["manifest"],"readiness":v,"now":f["now"]}),
        );
        if valid {
            assert_ne!(
                node["error"],
                "autonomous_research_online_runtime_activation_schema_transition_required",
                "case {i}"
            );
        } else {
            assert_eq!(
                node["error"],
                "autonomous_research_online_runtime_activation_schema_transition_required",
                "case {i}"
            );
        }
    }
}
struct Temp {
    root: PathBuf,
}
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-native-activation-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn instance(&self, role: &str, mode: u32) -> Value {
        let file = self.root.join("state.sqlite");
        let database = rusqlite::Connection::open(&file).unwrap();
        database
            .execute_batch(
                "CREATE TABLE state(value TEXT NOT NULL); INSERT INTO state VALUES('test');",
            )
            .unwrap();
        drop(database);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
        json!({"role":role,"sourceRelativePath":"state.sqlite","sourceFileIdentity":oracle(json!({"mode":"identity","path":file}))})
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[test]
fn actual_database_opening_role_permissions_and_changed_identity_match_node() {
    for (role, mode) in [
        ("resident-instance", 0o600),
        ("submission-handoff", 0o660),
        ("resident-instance", 0o660),
        ("submission-handoff", 0o662),
    ] {
        let t = Temp::new();
        let instance = t.instance(role, mode);
        let result = open_runtime_activation_database_v1(&t.root, &instance);
        let actual = match result {
            Ok(mut db) => json!({"opened":true,"inspection":db.inspect().unwrap()}),
            Err(e) => json!({"error":e.code}),
        };
        assert_eq!(
            actual,
            oracle(json!({"mode":"open","runtimeRoot":t.root,"instance":instance})),
            "{role} {mode:o}"
        );
    }
    for kind in ["missing", "identity", "symlink", "outside"] {
        let t = Temp::new();
        let mut instance = t.instance("resident-instance", 0o600);
        match kind {
            "missing" => instance["sourceRelativePath"] = json!("missing.sqlite"),
            "identity" => instance["sourceFileIdentity"]["inode"] = json!("0"),
            "symlink" => {
                std::fs::rename(t.root.join("state.sqlite"), t.root.join("other.sqlite")).unwrap();
                symlink("other.sqlite", t.root.join("state.sqlite")).unwrap();
            }
            _ => instance["sourceRelativePath"] = json!("../outside.sqlite"),
        };
        let code = open_runtime_activation_database_v1(&t.root, &instance)
            .err()
            .unwrap()
            .code;
        assert_eq!(
            json!({"error":code}),
            oracle(json!({"mode":"open","runtimeRoot":t.root,"instance":instance})),
            "{kind}"
        );
    }
}
#[test]
fn database_descriptor_guards_reject_rebinding_and_expose_fixed_observations_only() {
    for kind in ["replace", "chmod", "symlink", "parent"] {
        let t = Temp::new();
        let instance = t.instance("resident-instance", 0o600);
        let result =
            open_runtime_activation_database_with_hook_v1(&t.root, &instance, || match kind {
                "replace" => {
                    std::fs::rename(t.root.join("state.sqlite"), t.root.join("old.sqlite"))
                        .unwrap();
                    std::fs::copy(t.root.join("old.sqlite"), t.root.join("state.sqlite")).unwrap();
                }
                "chmod" => std::fs::set_permissions(
                    t.root.join("state.sqlite"),
                    std::fs::Permissions::from_mode(0o644),
                )
                .unwrap(),
                "symlink" => {
                    std::fs::rename(t.root.join("state.sqlite"), t.root.join("old.sqlite"))
                        .unwrap();
                    symlink("old.sqlite", t.root.join("state.sqlite")).unwrap();
                }
                _ => {
                    let moved = t.root.with_extension("moved");
                    std::fs::rename(&t.root, &moved).unwrap();
                    std::fs::create_dir(&t.root).unwrap();
                    std::fs::rename(moved.join("state.sqlite"), t.root.join("state.sqlite"))
                        .unwrap();
                    std::fs::remove_dir(moved).unwrap();
                }
            });
        assert!(result.is_err(), "{kind}");
    }
    let t = Temp::new();
    let instance = t.instance("resident-instance", 0o600);
    let mut db = open_runtime_activation_database_v1(&t.root, &instance).unwrap();
    assert_eq!(db.observed_identity(), &instance["sourceFileIdentity"]);
    assert_eq!(db.inspect().unwrap()["quickCheck"], "ok");
    db.assert_current().unwrap();
    std::fs::rename(t.root.join("state.sqlite"), t.root.join("old.sqlite")).unwrap();
    std::fs::copy(t.root.join("old.sqlite"), t.root.join("state.sqlite")).unwrap();
    assert!(db.inspect().is_err());
}
#[test]
fn stable_inventory_preserves_nested_member_order_and_detects_physical_drift() {
    let f = fixture();
    let original = &f["inventory"];
    assert!(
        stable_activation_inventory_scope_json_v1(
            original.to_string().as_bytes(),
            original.to_string().as_bytes()
        )
        .unwrap()
    );
    for key in [
        "sourceSha256",
        "sourceFileIdentity",
        "walSha256",
        "walFileIdentity",
        "quickCheck",
        "schemaHash",
    ] {
        let mut other = original.clone();
        other["instances"][0][key] = json!("changed");
        assert!(
            !stable_activation_inventory_scope_json_v1(
                original.to_string().as_bytes(),
                other.to_string().as_bytes()
            )
            .unwrap(),
            "{key}"
        );
    }
    let mut reordered = original.clone();
    reordered["instances"].as_array_mut().unwrap().reverse();
    assert!(
        stable_activation_inventory_scope_json_v1(
            original.to_string().as_bytes(),
            reordered.to_string().as_bytes()
        )
        .unwrap()
    );
    let left = r#"{"databaseScopeHash":"same","instances":[{"instanceId":"test","sourceFileIdentity":{"a":1,"b":2}}]}"#;
    let right = r#"{"databaseScopeHash":"same","instances":[{"instanceId":"test","sourceFileIdentity":{"b":2,"a":1}}]}"#;
    let repeated = r#"{"databaseScopeHash":"same","instances":[{"instanceId":"test","sourceFileIdentity":{"a":0,"b":2,"a":1}}]}"#;
    let numeric1 = r#"{"databaseScopeHash":"same","instances":[{"instanceId":"test","sourceFileIdentity":{"2":2,"1":1,"a":3}}]}"#;
    let numeric2 = r#"{"databaseScopeHash":"same","instances":[{"instanceId":"test","sourceFileIdentity":{"1":1,"2":2,"a":3}}]}"#;
    for (a, b) in [(left, right), (left, repeated), (numeric1, numeric2)] {
        assert_eq!(
            json!({"stable":stable_activation_inventory_scope_json_v1(a.as_bytes(),b.as_bytes()).unwrap()}),
            oracle(json!({"mode":"stable","left":a,"right":b}))
        );
    }
    assert!(!stable_activation_inventory_scope_json_v1(left.as_bytes(), right.as_bytes()).unwrap());
}
