#[path = "native_parity_bounded_support/mod.rs"]
mod native_oracle;
use hepta_paper_service::native_parity_bounded_v1::campaign_policy::{
    CampaignNodeViewV1, CampaignPolicyRequestV1, evaluate_campaign_policy_v1,
};
use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};
fn node(id: &str, status: &str) -> Value {
    json!({"nodeId":id,"kind":"writer","status":status})
}
fn evaluate(request: Value) -> Value {
    evaluate_campaign_policy_v1(serde_json::from_value(request).unwrap()).unwrap()
}

#[test]
fn all_nine_native_decisions_match_source_bound_node_oracle() {
    let statuses = [
        "queued",
        "leased",
        "running",
        "completed",
        "skipped",
        "failed_terminal",
        "stopped",
        "cancelled",
    ];
    let kinds = [
        "research-plan",
        "writer",
        "referee-1",
        "referee-x",
        "revision-referee-02",
        "coder-python",
        "formal-verify",
        "empirical",
        "empirical-reproduce-python",
        "revalidate-empirical-python",
        "final-compile",
        "package",
        "release-package",
    ];
    let mut requests = Vec::new();
    for status in [
        "running",
        "paused",
        "stopped",
        "completed",
        "failed",
        "cancelled",
        "unknown",
    ] {
        for command in ["pause", "resume", "cancel", "fail", "stop"] {
            requests.push(json!({"kind":"command","campaign_status":status,"command":command}));
        }
    }
    for (round, status) in statuses.iter().enumerate() {
        for attempt in 0..6 {
            for integrated in [false, true] {
                for retryable in [false, true] {
                    let mut n = node("n", status);
                    n["attemptCount"] = json!(attempt);
                    n["maxAttempts"] = json!(3);
                    if integrated {
                        n["preparedIntegrationStatus"] = json!("integrated");
                    }
                    requests.push(json!({"kind":"failure","node":n,"retryable":retryable}));
                }
            }
        }
        let mut n = node("n", status);
        n["roundIndex"] = json!(round);
        requests.push(json!({"kind":"manual_retry","node":n}));
    }
    // Many deterministic graphs, including missing prerequisites and cycles.
    for seed in 0..96 {
        let nodes: Vec<Value> = (0..12)
            .map(|i| {
                let mut n = node(&format!("n-{i}"), statuses[(seed * 3 + i) % statuses.len()]);
                n["kind"] = json!(kinds[(seed + i) % kinds.len()]);
                n["priority"] = json!([-3, 0, 1, 100, 200][(seed + i) % 5]);
                n["createdAt"] = json!(format!("2026-09-15T00:00:{:02}Z", i % 3));
                n["roundIndex"] = json!((seed + i) % 4);
                n["maxAttempts"] = json!((seed + i) % 5);
                n["requiresGpu"] = json!(i % 2 == 0);
                n["dependencies"] = if i == 0 {
                    json!([])
                } else {
                    json!([format!("n-{}", i - 1)])
                };
                n
            })
            .collect();
        requests.push(json!({"kind":"projection","nodes":nodes}));
        requests.push(json!({"kind":"ready","nodes":nodes,"limit":seed%5}));
        requests.push(
            json!({"kind":"descendants","nodes":nodes,"root_node_id":format!("n-{}",seed%12)}),
        );
        requests.push(json!({"kind":"future_round","nodes":nodes,"after_round":seed%3}));
        requests.push(json!({"kind":"resource_budget","nodes":nodes,"selector":if seed%3==0{Value::Null}else{json!({"selectorType":if seed%2==0{"authorized_dataset_mount"}else{"fixed"},"seedCount":seed%6,"minimumRepetitions":2})}}));
    }
    // Stable collation ties, composed/decomposed strings and UTF-16 vs scalar order.
    let ids = [
        "é", "e\u{301}", "z", "Z", "ä", "a", "𐀀", "\u{e000}", "中", "-", "_",
    ];
    let mut unicode: Vec<_> = ids.iter().map(|id| node(id, "queued")).collect();
    for n in &mut unicode {
        n["dependencies"] = json!(["root"]);
    }
    requests.push(json!({"kind":"descendants","nodes":unicode,"root_node_id":"root"}));
    for n in &mut unicode {
        n["dependencies"] = json!([]);
    }
    requests.push(json!({"kind":"ready","nodes":unicode,"limit":32}));
    requests.push(json!({"kind":"projection","nodes":[]}));
    for gpu in [false, true] {
        for lean in [false, true] {
            requests.push(json!({"kind":"empirical_profiles","languages":["python","r","gpu","lean","latex","python"],"requires_gpu":gpu,"exclude_lean":lean}));
        }
    }
    let result = native_oracle::oracle(
        "rust/oracle/campaign-policy-v1.mjs",
        &json!(requests),
        &[
            (
                "paper-domain/automation/campaign-state-policy.mjs",
                include_bytes!("../../../../paper-domain/automation/campaign-state-policy.mjs"),
            ),
            (
                "paper-domain/automation/campaign-mode-resource-budget.mjs",
                include_bytes!(
                    "../../../../paper-domain/automation/campaign-mode-resource-budget.mjs"
                ),
            ),
        ],
    );
    for (i, request) in requests.iter().enumerate() {
        assert_eq!(
            evaluate(request.clone()),
            result["results"][i],
            "case {i}: {request}"
        );
    }
    eprintln!("source-bound campaign policy cases: {}", requests.len());
}
#[test]
fn zero_priority_uses_node_fallback() {
    let mut a = node("a", "queued");
    a["priority"] = json!(0);
    let mut b = node("b", "queued");
    b["priority"] = json!(1);
    assert_eq!(
        evaluate(json!({"kind":"ready","nodes":[a,b],"limit":2})),
        json!(["b", "a"])
    );
}
#[test]
fn empty_graph_is_not_completed() {
    assert_eq!(
        evaluate(json!({"kind":"projection","nodes":[]}))["terminal"],
        false
    );
}
#[test]
fn missing_dependency_blocks_ready() {
    let mut n = node("n", "queued");
    n["dependencies"] = json!(["missing"]);
    assert_eq!(
        evaluate(json!({"kind":"ready","nodes":[n],"limit":1})),
        json!([])
    );
}
#[test]
fn cycle_descendants_terminate() {
    let mut a = node("a", "running");
    a["dependencies"] = json!(["b"]);
    let mut b = node("b", "queued");
    b["dependencies"] = json!(["a"]);
    assert_eq!(
        evaluate(json!({"kind":"descendants","nodes":[a,b],"root_node_id":"a"})),
        json!(["a", "b"])
    );
}
#[test]
fn duplicate_node_ids_are_rejected() {
    let n = node("a", "queued");
    let r = serde_json::from_value(json!({"kind":"ready","nodes":[n,n],"limit":1})).unwrap();
    assert!(evaluate_campaign_policy_v1(r).is_err());
}
#[test]
fn unknown_request_fields_and_string_numbers_rejected() {
    for r in [
        json!({"kind":"command","campaign_status":"paused","command":"resume","productionActivation":true}),
        json!({"kind":"ready","nodes":[],"limit":"1"}),
    ] {
        assert!(serde_json::from_value::<CampaignPolicyRequestV1>(r).is_err());
    }
}
#[test]
fn numeric_resource_overflow_rejected() {
    let mut n = node("n", "queued");
    n["kind"] = json!("formal-verify");
    n["maxAttempts"] = json!(9_007_199_254_740_991u64);
    let r = serde_json::from_value(json!({"kind":"resource_budget","nodes":[n],"selector":null}))
        .unwrap();
    assert!(evaluate_campaign_policy_v1(r).is_err());
}
#[test]
fn failure_retry_extra_slot_only_for_integrated() {
    for integrated in [false, true] {
        let mut n = node("a", "running");
        n["attemptCount"] = json!(3);
        n["maxAttempts"] = json!(3);
        if integrated {
            n["preparedIntegrationStatus"] = json!("integrated");
        }
        assert_eq!(
            evaluate(json!({"kind":"failure","node":n,"retryable":true}))["canRetry"],
            integrated
        );
    }
}
#[test]
fn terminal_commands_do_not_reopen() {
    for s in ["completed", "failed", "cancelled"] {
        assert_eq!(
            evaluate(json!({"kind":"command","campaign_status":s,"command":"resume"}))["apply"],
            false
        );
    }
}
#[test]
fn node_count_bound_is_enforced() {
    let nodes: Vec<CampaignNodeViewV1> = (0..4097)
        .map(|i| serde_json::from_value(node(&format!("n-{i}"), "queued")).unwrap())
        .collect();
    assert!(evaluate_campaign_policy_v1(CampaignPolicyRequestV1::Projection { nodes }).is_err());
}
#[test]
fn documented_cli_executes_real_native_decision_and_rejects_authority() {
    for (bytes, good) in [
        (
            include_bytes!("../../../../docs/modules/examples/campaign-policy.v1.json").as_slice(),
            true,
        ),
        (
            b"{\"kind\":\"cutover\",\"credential\":\"SENSITIVE\"}".as_slice(),
            false,
        ),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_hepta-campaign-policy"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(output.status.success(), good);
        if good {
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                json!(["write"])
            );
        } else {
            assert!(output.stdout.is_empty());
            assert!(!String::from_utf8_lossy(&output.stderr).contains("SENSITIVE"));
        }
    }
}

#[test]
fn all_three_public_status_constants_match_actual_node_exports() {
    let requests = json!([{"kind":"constants"}]);
    let expected = native_oracle::oracle(
        "rust/oracle/campaign-policy-v1.mjs",
        &requests,
        &[(
            "paper-domain/automation/campaign-state-policy.mjs",
            include_bytes!("../../../../paper-domain/automation/campaign-state-policy.mjs"),
        )],
    );
    assert_eq!(
        evaluate(json!({"kind":"constants"})),
        expected["results"][0]
    );
}
