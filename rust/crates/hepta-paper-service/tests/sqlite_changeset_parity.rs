use hepta_paper_service::sqlite_changeset::{
    ChangesetEffectV1, assert_sqlite_changeset_effects_authorized_v1,
    inspect_sqlite_changeset_effects_v1,
};
use serde_json::{Value, json};
use std::{path::Path, process::Command};

#[test]
fn actual_sqlite_changesets_malformed_records_and_authorization_match_node() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let oracle = Command::new("node")
        .arg(root.join("rust/oracle/sqlite-changeset-v1.mjs"))
        .output()
        .expect("Node 22.23.1 oracle is required");
    assert!(
        oracle.status.success(),
        "{}",
        String::from_utf8_lossy(&oracle.stderr)
    );
    let cases: Vec<Value> = serde_json::from_slice(&oracle.stdout).expect("oracle corpus");
    assert!(cases.len() > 400);
    for case in cases {
        let bytes = if let Some(encoded) = case["hex"].as_str() {
            hex::decode(encoded).unwrap()
        } else {
            let repeat = &case["repeat"];
            let unit: Vec<u8> = serde_json::from_value(repeat["unit"].clone()).unwrap();
            let mut bytes: Vec<u8> = serde_json::from_value(repeat["prefix"].clone()).unwrap();
            for _ in 0..repeat["count"].as_u64().unwrap() {
                bytes.extend_from_slice(&unit);
            }
            bytes
        };
        let authorized: Vec<ChangesetEffectV1> =
            serde_json::from_value(case["authorized"].clone()).unwrap();
        let executed: Vec<ChangesetEffectV1> =
            serde_json::from_value(case["executed"].clone()).unwrap();
        let inspect = match inspect_sqlite_changeset_effects_v1(&bytes) {
            Ok(value) => json!({"ok":value}),
            Err(error) => json!({"error":error.to_string()}),
        };
        assert_eq!(inspect, case["inspect"], "inspection: {}", case["name"]);
        let authorization =
            match assert_sqlite_changeset_effects_authorized_v1(&bytes, &authorized, &executed) {
                Ok(value) => json!({"ok":value}),
                Err(error) => json!({"error":error.to_string()}),
            };
        assert_eq!(
            authorization, case["authorization"],
            "authorization: {}",
            case["name"]
        );
    }
}
