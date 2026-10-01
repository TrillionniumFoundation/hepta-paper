//! Normal frontend lifecycle limits; peers are local protocol fixtures only.
use super::*;

fn subject(c: &Campaign) -> Value {
    let definition: hepta_paper_service::workflow::LocalWorkflowV1 =
        serde_json::from_slice(&fs::read(c.root.join("workflow.json")).unwrap()).unwrap();
    serde_json::from_slice(
        &ObjectStoreV1::open(&c.root)
            .unwrap()
            .read(&definition.template.initial_state_hash)
            .unwrap(),
    )
    .unwrap()
}

fn usage(c: &Campaign, cap: u64, committed: u64, reserved: u64) {
    assert_eq!(
        c.status()["providerCallUsage"],
        json!({"version":1,"maximumCalls":cap,"committedCalls":committed,"reservedCalls":reserved})
    );
}

#[test]
fn normal_agent_call_limit_persists_and_exhaustion_keeps_committed_result_and_ack() {
    let mut c = Campaign::new();
    let configured = fs::read(c.author.root.join("autonomous-research-request.v1.json")).unwrap();
    let prepared = c.invoke_with("prepare", None, &["--max-agent-calls", "1"]);
    assert_eq!(prepared["ready"], true, "{prepared}");
    assert_eq!(prepared["maxAgentCalls"], 1);
    assert!(prepared["campaignPersisted"].is_null());
    assert!(!c.root.exists());
    let launched = c.invoke_with("launch", Some(1), &["--max-agent-calls", "1"]);
    assert_eq!(launched["ready"], false);
    let first = subject(&c);
    assert_eq!(first[2]["maxAgentCalls"], 1);
    usage(&c, 1, 0, 1);
    c.stage(0, DRAFT, 6, true);
    usage(&c, 1, 1, 1);
    let before = c.status();
    let refused = c.advance(None);
    assert_eq!(
        refused["error"], "local_workflow_provider_call_budget_exhausted",
        "{refused}"
    );
    assert_eq!(refused["reconciliationRequired"], false);
    assert!(!c.root.join("step-0001.json").exists());
    assert_eq!(c.status(), before);
    // Absolute committed replay may recover only existing ACK/query facts.
    for equivalent in ["1", "1e0", "0x1", " 1 "] {
        let replay = c.invoke_with("converge", Some(1), &["--max-agent-calls", equivalent]);
        assert_eq!(replay["ready"], true, "{replay}");
        assert_eq!(replay["requestHash"], launched["requestHash"]);
        assert_eq!(c.status(), before);
    }
    for changed in ["0", "2", "513"] {
        assert_eq!(
            c.invoke_with("converge", Some(1), &["--max-agent-calls", changed])["error"],
            "autonomous_research_campaign_request_rejected"
        );
        assert_eq!(c.status(), before);
    }
    assert_eq!(subject(&c), first);
    assert_eq!(
        fs::read(c.author.root.join("autonomous-research-request.v1.json")).unwrap(),
        configured
    );
}

#[test]
fn normal_agent_call_defaults_and_configured_ceiling_allow_real_positive_values() {
    let mut c = Campaign::new();
    let default = c.invoke("prepare", None);
    assert_eq!(default["maxAgentCalls"], 48);
    for text in ["513", "1000", "1e300", "0x10000000000000000", "512.5"] {
        let allowed = c.invoke_with("prepare", None, &["--max-agent-calls", text]);
        assert_eq!(allowed["ready"], true, "{allowed}");
        assert_eq!(allowed["maxAgentCalls"], 512);
        assert!(!c.root.exists());
    }
    // A signed ceiling above the selected mode default is not a default
    // override and cannot silently turn an omitted flag into extra permission.
    c.request.max_agent_calls = Some(1000);
    c.write();
    assert_eq!(c.invoke("prepare", None)["maxAgentCalls"], 48);
    c.request.max_agent_calls = Some(2);
    c.write();
    let configured = fs::read(c.author.root.join("autonomous-research-request.v1.json")).unwrap();
    assert_eq!(
        c.invoke_with("prepare", None, &["--max-agent-calls", "1000"])["maxAgentCalls"],
        2
    );
    let launched = c.invoke_with("launch", Some(1), &["--max-agent-calls", "1000"]);
    assert_eq!(launched["maxAgentCalls"], 2);
    usage(&c, 2, 0, 1);
    c.stage(0, DRAFT, 6, true);
    let accepted = serde_json::to_vec(
        &json!({"accepted":true,"manuscriptHash":hash(DRAFT),"review":"accepted"}),
    )
    .unwrap();
    c.stage(1, &accepted, 3, true);
    assert_eq!(c.advance(None)["ready"], true);
    usage(&c, 2, 2, 2);
    assert_eq!(subject(&c)[2]["maxAgentCalls"], 2);
    assert_eq!(
        fs::read(c.author.root.join("autonomous-research-request.v1.json")).unwrap(),
        configured
    );
}

#[test]
fn normal_agent_call_unknown_query_retry_and_cancel_never_refund_or_double_count() {
    let mut c = Campaign::new();
    let first = c.invoke_with("launch", Some(1), &["--max-agent-calls", "1"]);
    c.capture(0);
    let request = fs::read(&c.author.request_path).unwrap();
    let server = c.author.serve_execution(c.author.listener(), DRAFT, 1);
    let unknown = c.advance(Some(1));
    server.join().unwrap();
    fs::remove_file(&c.author.socket_path).unwrap();
    assert_eq!(unknown["ready"], false);
    usage(&c, 1, 0, 1);
    let unknown_again = c.advance(Some(1));
    assert_eq!(unknown_again["ready"], false);
    usage(&c, 1, 0, 1);
    assert_eq!(fs::read(&c.author.request_path).unwrap(), request);
    c.author.publish_cost_settlement(DRAFT, 6);
    let server = c.author.serve(c.author.listener(), DRAFT, false, false);
    let recovered = c.advance(Some(1));
    server.join().unwrap();
    fs::remove_file(&c.author.socket_path).unwrap();
    assert_eq!(recovered["requestHash"], first["requestHash"]);
    usage(&c, 1, 1, 1);
    let ack = c.author.publish_commit_acknowledgement(DRAFT);
    let server = c
        .author
        .serve_commit_acknowledgement(c.author.listener(), ack, false);
    assert_eq!(c.advance(Some(1))["ready"], true);
    server.join().unwrap();
    fs::remove_file(&c.author.socket_path).unwrap();
    assert_eq!(
        c.advance(None)["error"],
        "local_workflow_provider_call_budget_exhausted"
    );
    usage(&c, 1, 1, 1);
    assert_eq!(fs::read(&c.author.request_path).unwrap(), request);
    let revision = c.status()["campaignRevision"].as_u64().unwrap().to_string();
    assert_eq!(
        c.invoke_with("cancel", None, &["--expected-revision", &revision])["ready"],
        true
    );
    usage(&c, 1, 1, 1);
    assert_eq!(c.status()["campaignState"], "cancelled");
    assert_eq!(c.advance(None)["ready"], false);
    assert!(!c.root.join("step-0001.json").exists());
}

#[test]
fn normal_agent_call_ceiling_survives_review_revision_and_fences_all_entrypoints() {
    let mut c = Campaign::new();
    c.invoke_with("launch", Some(1), &["--max-agent-calls", "2"]);
    c.stage(0, DRAFT, 6, true);
    let rejected = serde_json::to_vec(
        &json!({"accepted":false,"manuscriptHash":hash(DRAFT),"review":"needs correction"}),
    )
    .unwrap();
    c.stage(1, &rejected, 3, false);
    let refused = c.advance(None);
    assert_eq!(
        refused["error"], "local_workflow_provider_call_budget_exhausted",
        "{refused}"
    );
    usage(&c, 2, 2, 2);
    assert!(!c.root.join("step-0002.json").exists());
    let status = c.status();
    assert_eq!(status["amendmentCount"], 1);
    let digest: hepta_codex_protocol::Sha256Digest =
        status["definitionHash"].as_str().unwrap().parse().unwrap();
    let result = hepta_paper_service::workflow::operate_local_workflow_v1(
        &c.root,
        &digest,
        hepta_paper_service::workflow::WorkflowActionV1::Advance { through_steps: 4 },
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .try_into()
            .unwrap(),
    );
    assert!(matches!(
        result,
        Err(hepta_paper_service::workflow::WorkflowError::ProviderCallBudgetExhausted)
    ));
    assert!(!c.root.join("step-0002.json").exists());
    usage(&c, 2, 2, 2);
}

#[test]
fn normal_agent_call_term_and_kill_keep_first_ceiling_and_query_only_retry() {
    super::budgets::exercise_signal_recovery(Some(1));
}

#[test]
fn normal_agent_call_zero_precision_and_missing_billing_refusals_leave_no_namespace() {
    let mut c = Campaign::new();
    for text in ["0", "-0"] {
        assert_eq!(
            c.invoke_with("launch", Some(1), &["--max-agent-calls", text])["ready"],
            false
        );
        assert!(!c.root.exists());
    }
    for text in ["1.5", "NaN", "Infinity", "-1"] {
        let out = c
            .command("launch")
            .args(["--max-agent-calls", text])
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
        assert!(!c.root.exists());
    }
    c.request.author.source.cost_settlement = None;
    c.write();
    assert_eq!(
        c.invoke_with("launch", Some(1), &["--max-agent-calls", "1"])["ready"],
        false
    );
    assert!(!c.root.exists());
}

#[test]
fn normal_agent_call_pending_unknown_cancel_retains_occupancy_and_prevents_later_dispatch() {
    let mut c = Campaign::new();
    let first = c.invoke_with("launch", Some(1), &["--max-agent-calls", "1"]);
    c.capture(0);
    let request = fs::read(&c.author.request_path).unwrap();
    let server = c.author.serve_execution(c.author.listener(), DRAFT, 1);
    assert_eq!(c.advance(Some(1))["ready"], false);
    server.join().unwrap();
    fs::remove_file(&c.author.socket_path).unwrap();
    usage(&c, 1, 0, 1);
    let revision = c.status()["campaignRevision"].as_u64().unwrap().to_string();
    let cancelled = c.invoke_with("cancel", None, &["--expected-revision", &revision]);
    assert_eq!(cancelled["ready"], true, "{cancelled}");
    assert_eq!(cancelled["requestHash"], first["requestHash"]);
    usage(&c, 1, 0, 1);
    assert_eq!(c.status()["campaignState"], "cancelled");
    let retained = subject(&c);
    assert_eq!(c.advance(None)["ready"], false);
    assert_eq!(subject(&c), retained);
    assert_eq!(fs::read(&c.author.request_path).unwrap(), request);
    assert!(!c.root.join("step-0001.json").exists());
    usage(&c, 1, 0, 1);
}
