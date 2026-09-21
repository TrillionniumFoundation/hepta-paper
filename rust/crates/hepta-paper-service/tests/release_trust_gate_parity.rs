//! Differential corpus for the pure release trust-layer gate.

use hepta_paper_service::release_trust_gate::build_release_trust_layer_gate_from_values_v1;
use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn oracle(requests: &Value) -> Value {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = root.join("rust/oracle/release-trust-gate-v1.mjs");
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

fn rust_result(request: &Value) -> Value {
    let result = build_release_trust_layer_gate_from_values_v1(request);
    match result {
        Ok(value) => serde_json::json!({"ok": true, "value": value}),
        Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
    }
}

#[test]
fn release_trust_gate_matches_node_oracle() {
    let requests = serde_json::json!([
        {"releaseCommit":"commit-a","capabilityCount":14,"implementationVerified":14,"releaseBoundConformanceVerified":0,"independentProductionOperationalVerified":14},
        {"releaseCommit":"commit-a","capabilityCount":14,"implementationVerified":14,"releaseBoundConformanceVerified":14,"independentProductionOperationalVerified":0},
        {"releaseCommit":"","capabilityCount":14,"implementationVerified":14,"releaseBoundConformanceVerified":14,"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":14,"implementationVerified":15,"releaseBoundConformanceVerified":14,"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":"14","implementationVerified":"14","releaseBoundConformanceVerified":null,"independentProductionOperationalVerified":false},
        {"releaseCommit":"commit-a","capabilityCount":14,"implementationVerified":[],"releaseBoundConformanceVerified":[14],"independentProductionOperationalVerified":0},
        {"releaseCommit":123,"capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":["commit-a"],"capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":{},"capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":[],"capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":1.0,"capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":"0b10","implementationVerified":2,"releaseBoundConformanceVerified":2,"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":"0o10","implementationVerified":8,"releaseBoundConformanceVerified":8,"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":[true],"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":[false],"implementationVerified":0,"releaseBoundConformanceVerified":0,"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":[null],"implementationVerified":0,"releaseBoundConformanceVerified":0,"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":[[true]],"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":"\u{FEFF}14","implementationVerified":14,"releaseBoundConformanceVerified":14,"independentProductionOperationalVerified":0},
        {"releaseCommit":"\u{FEFF}commit-a","capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":"\u{FEFF}","capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":1e21,"capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":1e20,"capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":1e-7,"capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":1e-6,"capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":1.2345678901234567,"capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":[1e21,1e-7,1e-6],"capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":{"nested":[1e21,1e-7,1e-6]},"capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":1,"implementationVerified":[true],"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":[false],"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":[[true]]},
        {"releaseCommit":"commit-a","capabilityCount":[["\u{FEFF}1\u{FEFF}"]],"implementationVerified":[[1]],"releaseBoundConformanceVerified":[["1"]],"independentProductionOperationalVerified":[null]},
        {"releaseCommit":"commit-a","capabilityCount":1,"implementationVerified":[null,null],"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":"commit-a","capabilityCount":"\u{0085}1","implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0},
        {"releaseCommit":"\u{0085}","capabilityCount":1,"implementationVerified":1,"releaseBoundConformanceVerified":1,"independentProductionOperationalVerified":0}
    ]);
    let expected = oracle(&requests);
    for (index, request) in requests.as_array().unwrap().iter().enumerate() {
        assert_eq!(
            rust_result(request),
            expected["results"][index],
            "case {index}"
        );
    }
}
