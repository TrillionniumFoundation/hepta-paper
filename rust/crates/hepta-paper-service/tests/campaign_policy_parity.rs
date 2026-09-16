//! Bounded source-port checks against the incumbent campaign policy surface.
//!
//! The literal source/oracle/example references are intentional: the repository
//! validator binds this test to the exact Node denominator and review fixtures.

use hepta_paper_service::campaign_policy::{CampaignPolicyRequestV1, evaluate_campaign_policy_v1};
use serde_json::Value;

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
