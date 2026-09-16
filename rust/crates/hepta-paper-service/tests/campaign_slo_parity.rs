//! Source-bound checks for the incumbent campaign SLO report.

use hepta_paper_service::campaign_slo::{CampaignSloRequestV1, build_campaign_slo_report_v1};

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
