#[path = "native_parity_bounded_support/mod.rs"]
mod native_oracle;
use hepta_legacy_compatibility::production_stable_json_v1;
use hepta_paper_service::native_parity_bounded_v1::{
    campaign_policy::{CampaignPolicyRequestV1, evaluate_campaign_policy_v1},
    campaign_slo::{CampaignSloRequestV1, build_campaign_slo_report_v1},
};
use serde_json::json;
fn request() -> CampaignSloRequestV1 {
    serde_json::from_slice(include_bytes!(
        "../../../../docs/modules/examples/campaign-slo.v1.json"
    ))
    .unwrap()
}
#[test]
fn complete_slo_reports_and_hashes_match_the_actual_node_function() {
    let mut requests = Vec::new();
    for case in 0..64 {
        let mut r = request();
        r.campaigns[0].cost_known = case % 3 != 0;
        r.campaigns[0].status = if case % 2 == 0 { "running" } else { "stopped" }.into();
        for i in 1..8 {
            let mut n = r.nodes[0].clone();
            n.node_id = format!("node-{i}");
            n.status = if (case + i) % 3 == 0 {
                "failed_terminal"
            } else {
                "completed"
            }
            .into();
            n.child_session_id = Some(format!("child-{}", i % 3));
            n.dependencies = vec!["author".into()];
            if case % 7 == 0 {
                n.dependencies.push("missing".into());
            }
            r.nodes.push(n.clone());
            for (kind, time) in [
                ("campaign_node_retry_queued", 1500),
                ("campaign_node_started", 1600),
                ("campaign_node_manually_retried", 2000),
                ("campaign_node_started", 2100),
            ] {
                r.events.push(
                    serde_json::from_value(
                        json!({"nodeId":n.node_id,"kind":kind,"atUnixMs":time+case*10}),
                    )
                    .unwrap(),
                );
            }
        }
        if case % 4 == 0 {
            r.events.reverse();
        }
        if case % 5 == 0 {
            r.events[0].at_unix_ms = None;
        }
        if case % 6 == 0 {
            r.events[0].node_id = None;
        }
        r.telemetry_samples[0].lock_wait_ms = Some(case as f64 * 3.0);
        r.telemetry_samples[0].queue_contention_count = Some((case % 10) as f64);
        r.targets.maximum_queue_wait_p95_ms = case * 20;
        r.runtime_bytes = case * 1024;
        requests.push(r);
    }
    let mut empty = request();
    empty.campaigns.clear();
    empty.nodes.clear();
    empty.events.clear();
    empty.telemetry_samples.clear();
    requests.push(empty);
    let result = native_oracle::oracle(
        "rust/oracle/campaign-slo-v1.mjs",
        &serde_json::to_value(&requests).unwrap(),
        &[(
            "paper-domain/automation/campaign-slo.mjs",
            include_bytes!("../../../../paper-domain/automation/campaign-slo.mjs"),
        )],
    );
    for (i, r) in requests.iter().enumerate() {
        let actual = build_campaign_slo_report_v1(r).unwrap();
        assert_eq!(
            actual["campaignSloReportHash"], result["results"][i]["campaignSloReportHash"],
            "case {i}"
        );
        assert_eq!(
            production_stable_json_v1(&actual).unwrap(),
            production_stable_json_v1(&result["results"][i]).unwrap(),
            "case {i}"
        );
    }
    eprintln!(
        "source-bound SLO reports including legacy hashes: {}",
        requests.len()
    );
}
#[test]
fn absent_samples_remain_insufficient_not_zero() {
    let mut r = request();
    r.events.clear();
    r.nodes.clear();
    let v = build_campaign_slo_report_v1(&r).unwrap();
    assert_eq!(v["objectiveStates"]["queueWaitP95"], "insufficient_data");
    assert!(v["observed"]["queueWaitP95Ms"].is_null());
    assert_eq!(v["status"], "campaign_slos_not_met");
}
#[test]
fn required_data_produces_known_fixture_values() {
    let v = build_campaign_slo_report_v1(&request()).unwrap();
    assert_eq!(v["observed"]["queueWaitP95Ms"], 100.0);
    assert_eq!(v["observed"]["recoveryP95Ms"], 50.0);
    assert_eq!(v["status"], "campaign_slos_met");
}
#[test]
fn duplicate_node_identifiers_rejected() {
    let mut r = request();
    r.nodes.push(r.nodes[0].clone());
    assert!(build_campaign_slo_report_v1(&r).is_err());
}
#[test]
fn counters_beyond_exact_js_integer_domain_rejected() {
    let mut r = request();
    r.campaigns[0].token_count = u64::MAX;
    assert!(build_campaign_slo_report_v1(&r).is_err());
}
#[test]
fn counter_sum_cannot_saturate_into_valid_slo() {
    let mut r = request();
    r.campaigns[0].token_count = 9_007_199_254_740_991;
    r.campaigns.push(r.campaigns[0].clone());
    assert!(build_campaign_slo_report_v1(&r).is_err());
}
#[test]
fn nan_and_negative_metrics_are_rejected() {
    for v in [f64::NAN, f64::INFINITY, -1.0] {
        let mut r = request();
        r.telemetry_samples[0].lock_wait_ms = Some(v);
        assert!(build_campaign_slo_report_v1(&r).is_err());
    }
}
#[test]
fn future_timestamp_bound_rejected() {
    let mut r = request();
    r.events[0].at_unix_ms = Some(u64::MAX);
    assert!(r.validate().is_err());
}
#[test]
fn unknown_cost_and_runtime_overrun_are_not_met() {
    let mut r = request();
    r.campaigns[0].cost_known = false;
    r.runtime_bytes = 100;
    r.targets.maximum_runtime_bytes = 50;
    let v = build_campaign_slo_report_v1(&r).unwrap();
    assert_eq!(v["objectiveStates"]["costsAuditable"], "not_met");
    assert_eq!(v["objectiveStates"]["runtimeQuota"], "not_met");
}
#[test]
fn native_policy_surface_routes_slo_without_a_writer() {
    let r = CampaignPolicyRequestV1::Slo { request: request() };
    assert_eq!(
        evaluate_campaign_policy_v1(r).unwrap()["kind"],
        "CampaignSloReport"
    );
}
#[test]
fn request_rejects_unknown_authority_claim() {
    let mut v = serde_json::to_value(request()).unwrap();
    v["productionActivation"] = json!(true);
    assert!(serde_json::from_value::<CampaignSloRequestV1>(v).is_err());
}
#[test]
fn unknown_phase_is_rejected() {
    let mut r = request();
    r.telemetry_samples[0]
        .phases
        .insert("private_prompt".into(), 1.0);
    assert!(r.validate().is_err());
}
