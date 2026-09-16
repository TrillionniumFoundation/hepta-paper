//! Bounded source-port checks against the incumbent campaign policy surface.
//!
//! The literal source/oracle/example references are intentional: the repository
//! validator binds this test to the exact Node denominator and review fixtures.

use hepta_paper_service::campaign_policy::{CampaignPolicyRequestV1, evaluate_campaign_policy_v1};
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

const NODE_SOURCE: &str = "paper-domain/automation/campaign-state-policy.mjs";
const NODE_RESOURCE_SOURCE: &str = "paper-domain/automation/campaign-mode-resource-budget.mjs";
const ORACLE: &str = "rust/oracle/campaign-policy-v1.mjs";
const EXAMPLE: &str = "docs/modules/examples/campaign-policy.v1.json";

#[test]
fn documented_ready_request_matches_the_closed_rust_port() {
    assert!(!NODE_SOURCE.is_empty() && !NODE_RESOURCE_SOURCE.is_empty());
    assert!(!ORACLE.is_empty() && !EXAMPLE.is_empty());
    let request: CampaignPolicyRequestV1 = serde_json::from_str(include_str!(
        "../../../../docs/modules/examples/campaign-policy.v1.json"
    ))
    .expect("documented campaign-policy request");
    let result = evaluate_campaign_policy_v1(request).expect("bounded policy evaluation");
    assert_eq!(result, serde_json::json!(["write"]));
}

#[test]
fn constants_are_stable_and_closed() {
    let result = evaluate_campaign_policy_v1(CampaignPolicyRequestV1::Constants).unwrap();
    let value: Value = result;
    assert_eq!(
        value["CAMPAIGN_NODE_DONE_STATUSES"],
        serde_json::json!(["completed", "skipped"])
    );
    assert_eq!(
        value["CAMPAIGN_TERMINAL_STATUSES"],
        serde_json::json!(["completed", "failed", "cancelled"])
    );
}

#[test]
fn ready_order_uses_pinned_node_locale_collation_and_js_priority_coercion() {
    let request: CampaignPolicyRequestV1 = serde_json::from_value(serde_json::json!({
        "kind": "ready",
        "limit": 99,
        "nodes": [
            {"nodeId":"z","kind":"x","status":"queued","priority":-1,"dependencies":[]},
            {"nodeId":"A","kind":"x","status":"queued","priority":1,"dependencies":[]},
            {"nodeId":"a","kind":"x","status":"queued","priority":1,"dependencies":[]},
            {"nodeId":"雪","kind":"x","status":"queued","priority":1,"dependencies":[]},
            {"nodeId":"é","kind":"x","status":"queued","priority":1,"dependencies":[]},
            {"nodeId":"e","kind":"x","status":"queued","priority":1,"dependencies":[]}
        ]
    }))
    .expect("ready request");
    assert_eq!(
        evaluate_campaign_policy_v1(request).unwrap(),
        serde_json::json!(["z", "a", "A", "e", "é", "雪"])
    );
}

#[test]
fn bounded_corpus_matches_the_production_node_oracle() {
    let requests = serde_json::json!([
        {"kind":"constants"},
        {"kind":"projection","nodes":[
            {"nodeId":"雪","kind":"research","status":"queued","priority":1,"createdAt":"2024-01-01","roundIndex":1,"dependencies":[]},
            {"nodeId":"a","kind":"writer","status":"running","priority":1,"createdAt":"2024-01-01","roundIndex":2,"dependencies":[]},
            {"nodeId":"done","kind":"package","status":"completed","priority":2,"createdAt":"2024-01-02","roundIndex":2,"dependencies":[]}
        ]},
        {"kind":"ready","limit":2,"nodes":[
            {"nodeId":"z","kind":"x","status":"queued","priority":-1,"dependencies":[]},
            {"nodeId":"A","kind":"x","status":"queued","priority":1,"dependencies":[]},
            {"nodeId":"a","kind":"x","status":"queued","priority":1,"dependencies":[]},
            {"nodeId":"blocked","kind":"x","status":"queued","priority":1,"dependencies":["missing"]}
        ]},
        {"kind":"failure","retryable":true,"node":{"nodeId":"n","kind":"x","status":"running","attemptCount":2,"maxAttempts":2,"preparedIntegrationStatus":"integrated","dependencies":[]}},
        {"kind":"descendants","root_node_id":"雪","nodes":[
            {"nodeId":"é","kind":"x","status":"queued","dependencies":["雪"]},
            {"nodeId":"a","kind":"x","status":"queued","dependencies":["é"]}
        ]},
        {"kind":"future_round","after_round":1,"nodes":[
            {"nodeId":"雪","kind":"x","status":"queued","roundIndex":2,"dependencies":[]},
            {"nodeId":"package","kind":"package","status":"queued","roundIndex":2,"dependencies":[]},
            {"nodeId":"a","kind":"x","status":"queued","roundIndex":3,"dependencies":[]}
        ]},
        {"kind":"command","campaign_status":"paused","command":"resume"},
        {"kind":"manual_retry","node":{"nodeId":"n","kind":"x","status":"failed_terminal","dependencies":[]}},
        {"kind":"resource_budget","nodes":[
            {"nodeId":"r","kind":"research-plan","status":"queued","maxAttempts":2,"dependencies":[]},
            {"nodeId":"f","kind":"formal-verify","status":"queued","maxAttempts":1,"dependencies":[]},
            {"nodeId":"e","kind":"empirical-reproduce","status":"queued","maxAttempts":1,"requiresGpu":true,"dependencies":[]}
        ],"selector":{"selectorType":"authorized_dataset_mount","seedCount":2,"minimumRepetitions":3}},
        {"kind":"empirical_profiles","languages":["python","lean","latex","gpu"],"requires_gpu":false,"exclude_lean":true}
    ]);
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/campaign-policy-v1.mjs"))
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("Node 22.23.1 oracle runtime is required");
    child
        .stdin
        .take()
        .expect("oracle stdin")
        .write_all(requests.to_string().as_bytes())
        .expect("oracle request");
    let output = child.wait_with_output().expect("oracle process");
    assert!(
        output.status.success(),
        "Node oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout).expect("oracle response");
    assert_eq!(oracle["profile"]["node"], "v22.23.1");
    for (index, request) in requests
        .as_array()
        .expect("corpus array")
        .iter()
        .enumerate()
    {
        let typed: CampaignPolicyRequestV1 =
            serde_json::from_value(request.clone()).expect("typed campaign request");
        let rust = evaluate_campaign_policy_v1(typed).expect("Rust campaign request");
        assert_eq!(rust, oracle["results"][index], "corpus case {index}");
    }
}
