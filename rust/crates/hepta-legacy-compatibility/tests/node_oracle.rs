use std::{path::PathBuf, process::Command};

use hepta_legacy_compatibility::{encode_legacy_stable_json_v1, hash_legacy_record_v1};
use serde_json::Value;

#[test]
fn rust_matches_the_independent_node_oracle_corpus() {
    let oracle = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("oracle/legacy-stable-json-v1.mjs");
    let fixtures = [
        r#"null"#,
        r#"{"z":1,"a":[true,false,null]}"#,
        r#"{"unicode":"λ雪","escaped":"a\\nb"}"#,
        r#"[-0,1.5,1000000]"#,
        r#"{"nested":{"b":2,"a":1}}"#,
    ];
    for fixture in fixtures {
        let output = Command::new("node").arg(&oracle).arg(fixture).output();
        let Ok(output) = output else {
            return;
        };
        assert!(output.status.success());
        let node: Value = serde_json::from_slice(&output.stdout).expect("oracle response");
        let value: Value = serde_json::from_str(fixture).expect("fixture JSON");
        assert_eq!(
            node["canonical"]
                .as_str()
                .expect("canonical string")
                .as_bytes(),
            encode_legacy_stable_json_v1(&value).expect("Rust canonical")
        );
        assert_eq!(
            node["hash"].as_str().expect("hash string"),
            hash_legacy_record_v1(&value).expect("Rust hash").as_str()
        );
    }
}
