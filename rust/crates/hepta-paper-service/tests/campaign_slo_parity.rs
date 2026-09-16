//! Source-bound checks for the incumbent campaign SLO report.

use hepta_paper_service::campaign_slo::{CampaignSloRequestV1, build_campaign_slo_report_v1};
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

const NODE_SOURCE: &str = "paper-domain/automation/campaign-slo.mjs";
const ORACLE: &str = "rust/oracle/campaign-slo-v1.mjs";
const EXAMPLE: &str = "docs/modules/examples/campaign-slo.v1.json";

#[test]
fn documented_slo_request_matches_report_shape() {
    assert!(!NODE_SOURCE.is_empty() && !ORACLE.is_empty() && !EXAMPLE.is_empty());
    let request: CampaignSloRequestV1 = serde_json::from_str(include_str!(
        "../../../../docs/modules/examples/campaign-slo.v1.json"
    ))
    .expect("documented campaign SLO request");
    let report = build_campaign_slo_report_v1(&request).expect("bounded SLO report");
    assert_eq!(report["version"], 2);
    assert_eq!(report["kind"], "CampaignSloReport");
    assert_eq!(report["observed"]["runtimeBytes"], 4096);
    assert_eq!(report["observed"]["terminalNodeSuccessRate"], 1.0);
    assert_eq!(report["objectives"]["costsAuditable"], true);
    assert_eq!(report["status"], "campaign_slos_met");
    assert_eq!(report["observed"]["queueWaitP95Ms"], 100.0);
    assert_eq!(report["observed"]["recoveryP95Ms"], 50.0);
    assert_eq!(
        report["campaignSloReportHash"],
        "sha256:ac1f4ac8ababc464513c3a6df8a65ac19af2b1e8311a6574799bd50141dfef88"
    );
}

#[test]
fn bounded_corpus_matches_the_production_node_oracle() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../docs/modules/examples/campaign-slo.v1.json"
    ))
    .expect("documented SLO fixture");
    let edge = serde_json::json!({
        "version": 1,
        "campaigns": [
            {"status":"A","costKnown":true,"agentCallCount":0,"cpuJobCount":0,"gpuJobCount":0,"tokenCount":0},
            {"status":"a","costKnown":true,"agentCallCount":0,"cpuJobCount":0,"gpuJobCount":0,"tokenCount":0},
            {"status":"é","costKnown":true,"agentCallCount":0,"cpuJobCount":0,"gpuJobCount":0,"tokenCount":0},
            {"status":"雪","costKnown":true,"agentCallCount":0,"cpuJobCount":0,"gpuJobCount":0,"tokenCount":0}
        ],
        "nodes": [
            {"nodeId":"empty-session","status":"queued","createdAtUnixMs":0,"dependencies":[],"childSessionId":""},
            {"nodeId":"session","status":"queued","createdAtUnixMs":0,"dependencies":[],"childSessionId":"s"}
        ],
        "events": [],
        "telemetrySamples": [],
        "runtimeBytes": 0,
        "targets": {}
    });
    let requests = serde_json::json!([fixture, edge]);
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/campaign-slo-v1.mjs"))
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
        let typed: CampaignSloRequestV1 =
            serde_json::from_value(request.clone()).expect("typed SLO request");
        let rust = build_campaign_slo_report_v1(&typed).expect("Rust SLO request");
        assert_eq!(rust, oracle["results"][index], "corpus case {index}");
    }
}
