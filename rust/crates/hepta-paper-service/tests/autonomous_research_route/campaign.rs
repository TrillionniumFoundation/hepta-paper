//! Ordinary business-request CLI tests. The peers are local protocol fixtures;
//! their shared UID does not certify independently installed research accounts.
//! No workflow, planner frontier or prepared campaign state is supplied by tests.
#[allow(dead_code)]
#[path = "../broker_prepared_consumer/fixture.rs"]
mod fixture;
use fixture::{Fixture, hash};
use hepta_codex_protocol::{AgentRole, SandboxPolicy, TaskKind};
use hepta_control_plane::select_plan_v1;
use hepta_paper_service::autonomous_research::{
    AutonomousResearchCampaignRequestV1, AutonomousResearchRoleV1,
};
use hepta_paper_service::broker_prepared::broker_prepared_request_filename_v1;
use hepta_paper_service::{NativeJobV1, ObjectStoreV1, ServiceRunV1, WorkerBindingV1};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, process::Command};

const DRAFT: &[u8] = br#"{"manuscript":"draft requiring a correction"}"#;
const REVISED: &[u8] = br#"{"manuscript":"corrected with the retained review"}"#;
struct Campaign {
    author: Fixture,
    reviewer: Fixture,
    request: AutonomousResearchCampaignRequestV1,
    root: PathBuf,
}
impl Campaign {
    fn new() -> Self {
        let author = Fixture::new_issued_acknowledged_execution();
        let mut reviewer = Fixture::new_issued_acknowledged_execution();
        let role = |peer: &Fixture| {
            let WorkerBindingV1::BrokerExecute { source } =
                &peer.config.workers["module.broker-author"]
            else {
                panic!("fixture broker source")
            };
            AutonomousResearchRoleV1 {
                source: source.clone(),
                resources: peer.config.frontier.candidates[0].resources,
                maximum_cost_microusd: 10,
                prompt_envelope_hash: peer.request.prompt_envelope_hash.clone(),
                output_schema_hash: peer.request.output_schema_hash.clone(),
                workspace_identity_hash: peer.request.workspace_identity_hash.clone(),
                mutation_policy_hash: peer.request.mutation_policy_hash.clone(),
            }
        };
        let mut reviewer_role = role(&reviewer);
        reviewer_role.source.role = AgentRole::Reviewer;
        reviewer.socket_path = reviewer_role.source.socket_path.clone();
        let request = AutonomousResearchCampaignRequestV1 {
            version: 1,
            kind: "AutonomousResearchCampaignRequestV1".into(),
            objective: "Write a bounded manuscript from the declared research input".into(),
            author: role(&author),
            reviewer: reviewer_role,
            review_rubric: "Check every claim and retain the exact manuscriptHash".into(),
            revision_instructions: "Address the committed assessment without inventing results"
                .into(),
            revision_rounds: 2,
            budget_microusd: 100,
            maximum_wall_ms: 600_000,
            max_agent_calls: None,
            research_profile: None,
        };
        let identity =
            hepta_control_plane::canonical_hash_v1(&"autonomous-research:ordinary-paper").unwrap();
        let root = author
            .root
            .join(format!("campaign-{}", &identity.as_str()[7..]));
        let campaign = Self {
            author,
            reviewer,
            request,
            root,
        };
        campaign.write();
        campaign
    }
    fn write(&self) {
        let path = self.author.root.join("autonomous-research-request.v1.json");
        fs::write(&path, serde_json::to_vec(&self.request).unwrap()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn command(&self, action: &str) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
        cmd.args([
            "operator",
            "autonomous-research",
            "--",
            "--paper-id",
            "ordinary-paper",
            "--action",
            action,
            "--runtime-root",
        ])
        .arg(&self.author.root);
        cmd
    }
    fn invoke(&self, action: &str, through: Option<usize>) -> Value {
        self.invoke_with(action, through, &[])
    }
    fn invoke_with(&self, action: &str, through: Option<usize>, overrides: &[&str]) -> Value {
        let mut cmd = self.command(action);
        if let Some(n) = through {
            cmd.args(["--through-steps", &n.to_string()]);
        }
        cmd.args(overrides);
        let out = cmd.output().unwrap();
        let report: Value = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&out.stderr)));
        assert_eq!(out.status.success(), report["ready"] == true, "{report}");
        report
    }
    fn advance(&self, through: Option<usize>) -> Value {
        self.invoke("converge", through)
    }
    fn status(&self) -> Value {
        let report = self.invoke("status", None);
        assert_eq!(report["ready"], true, "{report}");
        report["workflow"].clone()
    }
    fn capture(&mut self, index: usize) -> Value {
        let config: ServiceRunV1 = serde_json::from_slice(
            &fs::read(self.root.join(format!("step-{index:04}.json"))).unwrap(),
        )
        .unwrap();
        let plan = select_plan_v1(
            &config.snapshot,
            &config.frontier,
            &config.hard_policy,
            &config.planner_policy,
        )
        .unwrap();
        let candidate = &config.frontier.candidates[0];
        let NativeJobV1::BrokerExecute { input } = serde_json::from_slice(
            &ObjectStoreV1::open(&self.root)
                .unwrap()
                .read(&candidate.payload_hash)
                .unwrap(),
        )
        .unwrap() else {
            panic!("product broker input")
        };
        let WorkerBindingV1::BrokerExecute { source } = &config.workers[&candidate.module_id]
        else {
            panic!("product broker source")
        };
        let peer = if source.role == AgentRole::Author {
            &mut self.author
        } else {
            &mut self.reviewer
        };
        let attempt = format!("{}:attempt:1", plan.plan_hash);
        peer.request_path = source
            .request_directory
            .join(broker_prepared_request_filename_v1(&attempt).unwrap());
        peer.request = peer.published_request();
        let now = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        hepta_codex_broker::verify_request_capability(
            &peer.request,
            hepta_codex_broker::PeerIdentityV1 {
                pid: std::process::id() as i32,
                uid: source.request_owner_uid,
                gid: source.request_owner_gid,
            },
            now,
            hepta_codex_broker::CapabilityPolicyV1 {
                maximum_lifetime_ms: 60_000,
                maximum_future_skew_ms: 5_000,
            },
            &hepta_codex_broker::CapabilityTrustStoreV1::new([(
                "fixture-core-request-key".into(),
                peer.request_signer_verifying_key.unwrap(),
            )])
            .unwrap(),
        )
        .unwrap();
        assert_eq!(peer.request.operation_id, attempt);
        assert_eq!(peer.request.idempotency_key, plan.plan_hash);
        assert_eq!(peer.request.node_id, candidate.candidate_id);
        assert_eq!(
            peer.request.campaign_id,
            "autonomous-research:ordinary-paper"
        );
        assert_eq!(
            peer.request.input_manifest_hash,
            hash(&serde_json::to_vec(&input.input_manifest).unwrap())
        );
        assert_eq!(peer.request.task_kind, input.task_kind);
        assert_eq!(peer.request.role, source.role);
        if source.role == AgentRole::Reviewer {
            assert_eq!(peer.request.sandbox_policy, SandboxPolicy::ReadOnly);
        } else {
            assert_eq!(peer.request.sandbox_policy, SandboxPolicy::WorkspaceWrite);
        }
        peer.config = config;
        input.input_manifest
    }
    fn stage(&mut self, index: usize, output: &[u8], cost: u64, accepted: bool) -> Value {
        assert_eq!(self.advance(Some(index + 1))["ready"], false);
        let manifest = self.capture(index);
        let peer = if index.is_multiple_of(2) {
            &self.author
        } else {
            &self.reviewer
        };
        peer.publish_cost_settlement(output, cost);
        let server = peer.serve_execution(peer.listener(), output, 0);
        let report = self.advance(Some(index + 1));
        server.join().unwrap();
        fs::remove_file(&peer.socket_path).unwrap();
        assert_eq!(report["ready"], false, "missing independent ACK must block");
        assert_eq!(self.status()["committedSteps"], index + 1);
        let ack = peer.publish_commit_acknowledgement(output);
        assert_eq!(ack.actual_cost_microusd, cost);
        assert_eq!(ack.sequence, index as u64 + 1);
        let server = peer.serve_commit_acknowledgement(peer.listener(), ack, false);
        let report = self.advance(Some(index + 1));
        server.join().unwrap();
        fs::remove_file(&peer.socket_path).unwrap();
        assert_eq!(report["ready"], accepted, "{report}");
        manifest
    }
}
#[test]
fn ordinary_request_composes_signed_author_reviewer_revision_settlement_commit_ack_and_replay() {
    let mut c = Campaign::new();
    let prepared = c.invoke("prepare", None);
    assert_eq!(prepared["ready"], true);
    assert_eq!(prepared["composition"], "ordinary_campaign_request_v1");
    assert!(!c.root.exists());
    let authored = c.stage(0, DRAFT, 6, true);
    assert_eq!(authored["kind"], "ManuscriptDraftInputV1");
    assert_eq!(authored["objective"], c.request.objective);
    let rejected=serde_json::to_vec(&json!({"accepted":false,"manuscriptHash":hash(DRAFT),"review":"correct the unsupported claim"})).unwrap();
    let reviewed = c.stage(1, &rejected, 3, false);
    assert_eq!(reviewed["manuscript"], std::str::from_utf8(DRAFT).unwrap());
    assert_eq!(reviewed["manuscriptHash"], hash(DRAFT).as_str());
    assert!(c.status()["gateRejected"].as_bool().unwrap());
    // Default ordinary converge assembles repair; no amendment document supplied.
    assert_eq!(c.advance(None)["ready"], false);
    assert_eq!(c.status()["amendmentCount"], 1);
    let revision = c.stage(2, REVISED, 7, true);
    assert_eq!(revision["kind"], "ManuscriptRevisionInputV1");
    assert_eq!(revision["previousManuscriptHash"], hash(DRAFT).as_str());
    assert_eq!(revision["reviewHash"], hash(&rejected).as_str());
    assert_eq!(revision["review"], std::str::from_utf8(&rejected).unwrap());
    assert_eq!(c.author.request.task_kind, TaskKind::Revise);
    let accepted = serde_json::to_vec(
        &json!({"accepted":true,"manuscriptHash":hash(REVISED),"review":"addressed"}),
    )
    .unwrap();
    c.stage(3, &accepted, 4, true);
    let final_report = c.advance(None);
    assert_eq!(final_report["ready"], true, "{final_report}");
    assert_eq!(final_report["workflow"]["campaignState"], "completed");
    assert_eq!(final_report["workflow"]["budgetRemainingMicrousd"], 80);
    assert_eq!(final_report["researchActivation"], false);
    assert_eq!(final_report["releaseAuthority"], false);
    assert_eq!(final_report["submissionAuthority"], false);
    let definition: serde_json::Value =
        serde_json::from_slice(&fs::read(c.root.join("workflow.json")).unwrap()).unwrap();
    let initial_hash = definition["template"]["initialStateHash"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let initial: ObjectStoreV1 = ObjectStoreV1::open(&c.root).unwrap();
    let retained_request: Value =
        serde_json::from_slice(&initial.read(&initial_hash).unwrap()).unwrap();
    assert_eq!(
        retained_request[0],
        "autonomous-research-campaign-request-v1"
    );
    assert_eq!(retained_request[1], "autonomous-research:ordinary-paper");
    let mut effective = c.request.clone();
    effective.max_agent_calls = Some(48);
    assert_eq!(
        retained_request[2],
        serde_json::to_value(&effective).unwrap()
    );
    assert_eq!(
        retained_request[3],
        hepta_control_plane::canonical_hash_v1(&c.request)
            .unwrap()
            .as_str()
    );
    let before = c.status();
    let replay = c.advance(None);
    assert_eq!(replay["ready"], true, "{replay}");
    assert_eq!(c.status(), before);
    assert_eq!(
        ObjectStoreV1::open(&c.root)
            .unwrap()
            .read(&hash(REVISED))
            .unwrap(),
        REVISED
    );
    let objective = c.request.objective.clone();
    c.request.objective.push_str(" changed");
    c.write();
    assert_eq!(
        c.advance(None)["error"],
        "autonomous_research_campaign_request_rejected"
    );
    c.request.objective = objective;
    c.write();
    let initial_path = initial
        .root()
        .join(initial_hash.as_str().trim_start_matches("sha256:"));
    fs::set_permissions(&initial_path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&initial_path, b"corrupt initial request").unwrap();
    assert_eq!(c.advance(None)["ready"], false);
    assert_eq!(fs::read(&initial_path).unwrap(), b"corrupt initial request");
    // The ordinary adapter cannot reconstruct a business request from workflow
    // projections after its CAS subject is corrupt. Native owner inspection
    // still retains and verifies the existing committed accounting/history.
    assert_eq!(c.invoke("status", None)["ready"], false);
    let progress = hepta_paper_service::workflow::operate_local_workflow_v1(
        &c.root,
        &final_report["definitionHash"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
        hepta_paper_service::workflow::WorkflowActionV1::Status,
        0,
    )
    .unwrap();
    assert_eq!(progress.budget_remaining_microusd, 80);
}
#[test]
fn ordinary_cli_overrides_reopen_from_bound_request_and_reject_silent_replacement() {
    let mut c = Campaign::new();
    let configured = fs::read(c.author.root.join("autonomous-research-request.v1.json")).unwrap();
    let objective = "Use this first ordinary CLI objective through recovery and offline replay";
    let first = c.invoke_with(
        "converge",
        Some(1),
        &["--objective", objective, "--revision-rounds", "0"],
    );
    assert_eq!(first["ready"], false);
    assert_eq!(first["revisionRounds"], 0);
    let configured_hash = hepta_control_plane::canonical_hash_v1(&c.request).unwrap();
    assert_eq!(first["configuredRequestHash"], configured_hash.as_str());
    assert_ne!(first["requestHash"], first["configuredRequestHash"]);
    // The actual author receives the retained override on a subsequent plain
    // ordinary request. The configured file remains unchanged.
    let manifest = c.stage(0, DRAFT, 6, true);
    assert_eq!(manifest["objective"], objective);
    let accepted = serde_json::to_vec(
        &json!({"accepted":true,"manuscriptHash":hash(DRAFT),"review":"accepted"}),
    )
    .unwrap();
    c.stage(1, &accepted, 3, true);
    let before = c.status();
    let replay = c.advance(None);
    assert_eq!(replay["ready"], true, "{replay}");
    assert_eq!(replay["revisionRounds"], 0);
    assert_eq!(replay["requestHash"], first["requestHash"]);
    assert_eq!(
        replay["configuredRequestHash"],
        first["configuredRequestHash"]
    );
    assert_eq!(c.status(), before);
    assert_eq!(before["budgetRemainingMicrousd"], 91);
    assert_eq!(
        fs::read(c.author.root.join("autonomous-research-request.v1.json")).unwrap(),
        configured
    );
    assert_eq!(
        c.invoke_with(
            "converge",
            None,
            &["--objective", objective, "--revision-rounds", "0"],
        )["ready"],
        true
    );
    for options in [
        vec!["--objective", "silently changed objective"],
        vec!["--revision-rounds", "1"],
    ] {
        assert_eq!(
            c.invoke_with("converge", None, &options)["error"],
            "autonomous_research_campaign_request_rejected"
        );
        assert_eq!(c.status(), before);
    }
    let definition: hepta_paper_service::workflow::LocalWorkflowV1 =
        serde_json::from_slice(&fs::read(c.root.join("workflow.json")).unwrap()).unwrap();
    let retained: Value = serde_json::from_slice(
        &ObjectStoreV1::open(&c.root)
            .unwrap()
            .read(&definition.template.initial_state_hash)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(retained[2]["objective"], objective);
    assert_eq!(retained[2]["revisionRounds"], 0);
    assert_eq!(retained[3], configured_hash.as_str());
    // Even changing a configured default to the already admitted override must
    // be rejected: the original configuration is independently hash-bound.
    let original_objective = c.request.objective.clone();
    c.request.objective = objective.into();
    c.write();
    assert_eq!(
        c.advance(None)["error"],
        "autonomous_research_campaign_request_rejected"
    );
    c.request.objective = original_objective;
    c.write();
    assert_eq!(c.status(), before);
}
#[test]
fn unknown_author_result_reopens_by_query_and_never_issues_another_execution() {
    let mut c = Campaign::new();
    let objective = "Retain this CLI objective across an unknown author result";
    assert_eq!(
        c.invoke_with("converge", Some(1), &["--objective", objective])["ready"],
        false
    );
    assert_eq!(c.capture(0)["objective"], objective);
    let original = fs::read(&c.author.request_path).unwrap();
    let server = c.author.serve_execution(c.author.listener(), DRAFT, 1);
    let uncertain = c.advance(Some(1));
    server.join().unwrap();
    fs::remove_file(&c.author.socket_path).unwrap();
    assert_eq!(uncertain["ready"], false);
    assert_eq!(c.status()["committedSteps"], 0);
    assert_eq!(c.status()["pendingStep"], true);
    assert_eq!(c.status()["budgetRemainingMicrousd"], 100);
    c.author.publish_cost_settlement(DRAFT, 6);
    let server = c.author.serve(c.author.listener(), DRAFT, false, false);
    let recovered = c.advance(Some(1));
    server.join().unwrap();
    fs::remove_file(&c.author.socket_path).unwrap();
    assert_eq!(recovered["ready"], false);
    assert_eq!(c.status()["committedSteps"], 1);
    assert_eq!(fs::read(&c.author.request_path).unwrap(), original);
    let ack = c.author.publish_commit_acknowledgement(DRAFT);
    let server = c
        .author
        .serve_commit_acknowledgement(c.author.listener(), ack, false);
    assert_eq!(c.advance(Some(1))["ready"], true);
    server.join().unwrap();
    fs::remove_file(&c.author.socket_path).unwrap();
    assert_eq!(c.status()["budgetRemainingMicrousd"], 94);
}
#[test]
fn campaign_request_rejects_aliases_authority_missing_billing_and_budget_expansion_before_state() {
    let mut c = Campaign::new();
    c.request.reviewer.source.socket_path = c.request.author.source.socket_path.clone();
    c.write();
    assert_eq!(c.advance(None)["ready"], false);
    assert!(!c.root.exists());
    c.request.reviewer.source.socket_path = c.reviewer.socket_path.clone();
    c.request.author.source.cost_settlement = None;
    c.write();
    assert_eq!(c.advance(None)["ready"], false);
    assert!(!c.root.exists());
    c.request.author.source.cost_settlement = c.request.reviewer.source.cost_settlement.clone();
    c.request.budget_microusd = 1;
    c.write();
    assert_eq!(c.advance(None)["ready"], false);
    assert!(!c.root.exists());
}
#[test]
fn ordinary_campaign_pause_resume_cancel_and_pre_dispatch_interruption_use_existing_owner() {
    use hepta_paper_service::autonomous_research::{
        execute_autonomous_research_with_cancellation_v1, parse_autonomous_research_arguments,
    };
    use std::sync::{Arc, atomic::AtomicBool};
    let mut c = Campaign::new();
    let args = vec![
        "--paper-id".into(),
        "ordinary-paper".into(),
        "--runtime-root".into(),
        c.author.root.to_str().unwrap().into(),
        "--action".into(),
        "launch".into(),
    ];
    let interrupted = execute_autonomous_research_with_cancellation_v1(
        &parse_autonomous_research_arguments(&args).unwrap(),
        Arc::new(AtomicBool::new(true)),
    );
    assert_eq!(interrupted["ready"], false);
    assert_eq!(interrupted["interruptionRequested"], true);
    assert!(!c.root.exists());
    c.stage(0, DRAFT, 6, true);
    let lifecycle = |action: &str, revision: u64| {
        let out = c
            .command(action)
            .args(["--expected-revision", &revision.to_string()])
            .output()
            .unwrap();
        serde_json::from_slice::<Value>(&out.stdout).unwrap()
    };
    let paused = lifecycle("pause", c.status()["campaignRevision"].as_u64().unwrap());
    assert_eq!(paused["ready"], true, "{paused}");
    assert_eq!(c.status()["campaignState"], "paused");
    assert_eq!(
        c.advance(Some(1))["ready"],
        true,
        "committed replay remains readable"
    );
    assert_eq!(
        c.advance(Some(2))["ready"],
        false,
        "a new reviewer dispatch is blocked"
    );
    let resumed = lifecycle("resume", c.status()["campaignRevision"].as_u64().unwrap());
    assert_eq!(resumed["ready"], true, "{resumed}");
    let cancelled = lifecycle("cancel", c.status()["campaignRevision"].as_u64().unwrap());
    assert_eq!(cancelled["ready"], true, "{cancelled}");
    assert_eq!(c.status()["campaignState"], "cancelled");
    assert_eq!(
        c.advance(Some(1))["ready"],
        true,
        "committed replay remains readable"
    );
    assert_eq!(
        c.advance(Some(2))["ready"],
        false,
        "a new reviewer dispatch is blocked"
    );
    assert_eq!(c.status()["budgetRemainingMicrousd"], 94);
}

#[test]
fn rejected_review_with_no_remaining_rounds_keeps_committed_results_and_budget() {
    let mut c = Campaign::new();
    assert_eq!(
        c.invoke_with("converge", Some(1), &["--revision-rounds", "0"])["ready"],
        false
    );
    c.stage(0, DRAFT, 6, true);
    let rejected = serde_json::to_vec(
        &json!({"accepted":false,"manuscriptHash":hash(DRAFT),"review":"unsupported claim"}),
    )
    .unwrap();
    c.stage(1, &rejected, 3, false);
    let before = c.status();
    let rejected = c.advance(None);
    assert_eq!(rejected["error"], "local_workflow_review_gate_rejected");
    assert_eq!(c.status(), before);
    assert_eq!(before["committedSteps"], 2);
    assert_eq!(before["budgetRemainingMicrousd"], 91);
    assert_eq!(before["amendmentCount"], 0);
}

#[test]
fn ordinary_research_profile_requires_real_admission_and_independent_principals_before_dispatch() {
    use hepta_paper_service::{ResearchActivationStageV1, ResearchWorkflowProfileV1};
    let mut c = Campaign::new();
    c.request.reviewer.source.runtime_identity_hash =
        c.request.author.source.runtime_identity_hash.clone();
    c.request.author.source.broker_uid += 1;
    c.request.author.source.broker_gid += 1;
    c.request.reviewer.source.broker_uid = c.request.author.source.broker_uid + 1;
    c.request.reviewer.source.broker_gid = c.request.author.source.broker_gid + 1;
    for (role, agent_role) in [
        (&mut c.request.author, AgentRole::Author),
        (&mut c.request.reviewer, AgentRole::Reviewer),
    ] {
        role.source.operation_publisher=Some(serde_json::from_value(json!({"version":1,"role":agent_role,"operationDirectory":c.author.root.join(if agent_role==AgentRole::Author {"author-operations"} else {"reviewer-operations"}),"authorityUid":role.source.request_owner_uid,"brokerUid":role.source.broker_uid,"brokerGid":role.source.broker_gid,"workspacePath":c.author.root.join("workspace"),"promptPrefixPath":c.author.root.join("prefix.txt"),"promptPrefixHash":role.prompt_envelope_hash,"outputSchemaPath":c.author.root.join("schema.json"),"outputSchemaHash":role.output_schema_hash,"mutationPolicy":{"version":1,"readOnly":agent_role==AgentRole::Reviewer,"allowedPathPrefixes":["draft.md"],"allowedExtensions":["md"],"maximumChangedEntries":4,"maximumChangedFileBytes":1024}})).unwrap());
    }
    c.request.research_profile = Some(ResearchWorkflowProfileV1 {
        version: 1,
        stage: ResearchActivationStageV1::Canary,
        repository: "TrillionniumFoundation/hepta-paper".into(),
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        qualification_binding_hash: hash(b"non-authorizing expected binding"),
        qualification_trust_store_generation: 1,
        qualification_expires_at_unix_ms: u64::MAX / 2,
        qualified_codex_runtime_identity_hash: c
            .request
            .author
            .source
            .runtime_identity_hash
            .clone(),
        automatic_activation: false,
        production_activation: false,
        release_authority: false,
        submission_authority: false,
    });
    c.write();
    assert_eq!(c.invoke("prepare", None)["ready"], true);
    assert!(!c.root.exists());
    let report = c.advance(None);
    assert_eq!(
        report["error"],
        "local_workflow_research_qualification_rejected"
    );
    assert_eq!(report["researchQualificationAccepted"], false);
    assert!(!c.root.exists());
    c.request.reviewer.source.broker_uid = c.request.author.source.broker_uid;
    c.request
        .reviewer
        .source
        .operation_publisher
        .as_mut()
        .unwrap()
        .broker_uid = c.request.reviewer.source.broker_uid;
    c.write();
    assert_eq!(
        c.advance(None)["error"],
        "autonomous_research_campaign_qualification_binding_rejected"
    );
    assert!(!c.root.exists());
    c.request.reviewer.source.broker_uid += 1;
    c.request
        .reviewer
        .source
        .operation_publisher
        .as_mut()
        .unwrap()
        .broker_uid = c.request.reviewer.source.broker_uid;
    c.request
        .research_profile
        .as_mut()
        .unwrap()
        .release_authority = true;
    c.write();
    assert_eq!(
        c.advance(None)["error"],
        "autonomous_research_campaign_qualification_binding_rejected"
    );
    assert!(!c.root.exists());
}

/// Test-only separate numeric broker process. It reads the real product
/// descriptor through the installed reader guards; it does not call a provider.
#[test]
#[ignore = "spawned explicitly by the distinct-UID ordinary publication test"]
fn fixture_broker_prompt_reader_child() {
    let input =
        std::env::var_os("HEPTA_TEST_PRODUCT_PROMPT_READER").expect("fixture binding required");
    let path = std::path::PathBuf::from(input);
    assert_eq!(fs::canonicalize(&path).unwrap(), path);
    assert!(
        path.parent()
            .unwrap()
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("hbp-operation-publisher-")
    );
    let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let source: hepta_codex_broker::ProductCodexOperationPublisherV1 =
        serde_json::from_value(value["source"].clone()).unwrap();
    let request: hepta_codex_protocol::CodexExecutionRequestV1 =
        serde_json::from_value(value["request"].clone()).unwrap();
    let metadata = fs::metadata(&path).unwrap();
    use std::os::unix::fs::MetadataExt;
    assert_eq!(metadata.uid(), source.authority_uid);
    assert_eq!(metadata.gid(), source.broker_gid);
    assert_eq!(metadata.mode() & 0o7777, 0o440);
    assert_eq!(metadata.nlink(), 1);
    let now = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    let prompt =
        hepta_codex_broker::inspect_product_codex_operation_prompt_v1(&source, &request, now)
            .unwrap();
    let output = PathBuf::from(value["output"].as_str().unwrap());
    let output_parent = output.parent().unwrap();
    assert_eq!(fs::canonicalize(output_parent).unwrap(), output_parent);
    assert_eq!(output_parent.parent(), source.operation_directory.parent());
    let output_metadata = fs::metadata(output_parent).unwrap();
    assert_eq!(output_metadata.uid(), source.broker_uid);
    assert_eq!(output_metadata.gid(), source.broker_gid);
    assert_eq!(output_metadata.mode() & 0o7777, 0o750);
    let body = json!({"uid":nix::unistd::geteuid().as_raw(),"gid":nix::unistd::getegid().as_raw(),"prompt":String::from_utf8(prompt).unwrap(),"operationId":request.operation_id,"inputManifestHash":request.input_manifest_hash});
    fs::write(&output, serde_json::to_vec(&body).unwrap()).unwrap();
    fs::set_permissions(&output, fs::Permissions::from_mode(0o640)).unwrap();
    if let Some(mode) = value["mode"].as_str() {
        let key: [u8; 32] = serde_json::from_value(value["requestPublicKey"].clone()).unwrap();
        hepta_codex_broker::verify_request_capability(
            &request,
            hepta_codex_broker::PeerIdentityV1 {
                pid: std::process::id() as i32,
                uid: source.authority_uid,
                gid: request.request_capability.peer_gid,
            },
            now,
            hepta_codex_broker::CapabilityPolicyV1 {
                maximum_lifetime_ms: 60_000,
                maximum_future_skew_ms: 5_000,
            },
            &hepta_codex_broker::CapabilityTrustStoreV1::new([(
                "fixture-core-request-key".into(),
                ed25519_dalek::VerifyingKey::from_bytes(&key).unwrap(),
            )])
            .unwrap(),
        )
        .unwrap();
        let mut peer = Fixture::new();
        peer.request = request;
        peer.socket_path = PathBuf::from(value["socket"].as_str().unwrap());
        assert_eq!(peer.socket_path.parent(), Some(output_parent));
        let listener = peer.listener();
        fs::set_permissions(&peer.socket_path, fs::Permissions::from_mode(0o660)).unwrap();
        match mode {
            "execution" => peer
                .serve_execution(listener, value["result"].as_str().unwrap().as_bytes(), 0)
                .join()
                .unwrap(),
            "lost-execution" => peer
                .serve_execution(listener, value["result"].as_str().unwrap().as_bytes(), 1)
                .join()
                .unwrap(),
            "query" => peer
                .serve(
                    listener,
                    value["result"].as_str().unwrap().as_bytes(),
                    false,
                    false,
                )
                .join()
                .unwrap(),
            "ack" => peer
                .serve_commit_acknowledgement(
                    listener,
                    serde_json::from_value(value["ack"].clone()).unwrap(),
                    false,
                )
                .join()
                .unwrap(),
            _ => panic!("closed local protocol fixture mode"),
        }
    }
}

#[test]
#[ignore = "requires passwordless isolated numeric-UID ownership setup; run explicitly with --ignored"]
fn ordinary_cli_publishes_exact_inputs_read_by_a_distinct_broker_principal() {
    publication::run_distinct_uid_campaign();
}

#[path = "publication.rs"]
mod publication;

mod agent_calls;
#[path = "budgets.rs"]
mod budgets;
