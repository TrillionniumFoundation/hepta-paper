//! Differential checks for the pure release-state contract.

use hepta_paper_service::release_state::inspect_release_state_v1;
use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn oracle(requests: &Value) -> Value {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = root.join("rust/oracle/release-state-v1.mjs");
    let mut child = Command::new("node")
        .arg(script)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("Node oracle");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(requests.to_string().as_bytes())
        .expect("request");
    let output = child.wait_with_output().expect("oracle output");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).expect("oracle JSON");
    assert_eq!(response["profile"]["node"], "v22.23.1");
    response
}

#[test]
fn release_state_contract_matches_node_oracle() {
    let base = serde_json::json!({
        "packageJson":{"name":"fixture","version":"0.21.0","engines":{"node":">=22.23.1 <23"},"packageManager":"npm@10.9.8"},
        "packageLock":{"name":"fixture","version":"0.21.0","packages":{"":{"name":"fixture","version":"0.21.0"}}},
        "headTags":[],"allTags":[]
    });
    let mut development = base.clone();
    development["currentStatus"] =
        "This is the normative status for the unreleased v0.21.0 development candidate.".into();
    development["releaseDocument"] =
        "Version 0.21.0 is an unreleased automation-first research-production candidate.".into();
    development["changelog"] = "## Unreleased (0.21.0 development)".into();
    let mut finalized = base.clone();
    finalized["currentStatus"] = "Release state: finalized v0.21.0 source.".into();
    finalized["releaseDocument"] =
        "Version 0.21.0 is finalized from this exact source commit.".into();
    finalized["changelog"] = "## 0.21.0 (finalized source)".into();
    let mut released = finalized.clone();
    released["headTags"] = serde_json::json!(["v0.21.0"]);
    released["allTags"] = serde_json::json!(["v0.21.0"]);
    let mut mismatch = finalized.clone();
    mismatch["allTags"] = serde_json::json!(["v0.21.0", "v0.22.0"]);
    let mut invalid = finalized.clone();
    invalid["packageJson"]["packageManager"] = "npm@9".into();
    let mut numeric_version = base.clone();
    numeric_version["packageJson"]["version"] = 1.into();
    numeric_version["packageLock"]["version"] = 1.into();
    numeric_version["packageLock"]["packages"][""]["version"] = 1.into();
    let mut array_version = base.clone();
    array_version["packageJson"]["version"] = serde_json::json!(["0.21.0"]);
    array_version["packageLock"]["version"] = serde_json::json!(["0.21.0"]);
    array_version["packageLock"]["packages"][""]["version"] = serde_json::json!(["0.21.0"]);
    let requests = serde_json::json!([
        development,
        finalized,
        released,
        mismatch,
        invalid,
        numeric_version,
        array_version,
        Value::Null
    ]);
    let expected = oracle(&requests);
    for (index, request) in requests.as_array().unwrap().iter().enumerate() {
        let result = match inspect_release_state_v1(request) {
            Ok(value) => serde_json::json!({"ok": true, "value": value}),
            Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
        };
        assert_eq!(result, expected["results"][index], "case {index}");
    }
}
