//! Ordinary CLI, SQLite and CAS integration against explicit local IPC fixtures.
//! These peers do not certify live models, independent installed principals,
//! request issuance, billing or commit-bound acknowledgements.
use super::*;
use hepta_codex_protocol::{AgentRole, SandboxPolicy, Sha256Digest};
use hepta_control_plane::{canonical_hash_v1, select_plan_v1};
use hepta_module_platform::{
    ModuleExecutionV1, ModuleManifestV1, ModuleRegistryV1, RegistryPolicyV1,
};
use hepta_paper_service::broker_prepared::{
    broker_execution_implementation_hash_v1, broker_prepared_request_filename_v1,
};
use hepta_paper_service::workflow::{
    ArtifactBindingV1, ArtifactEncodingV1, LocalWorkflowV1, WorkflowAmendmentV1, WorkflowGateV1,
};
use hepta_paper_service::{NativeJobV1, ServiceRunV1, WorkerBindingV1};
use serde_json::{Value, json};
use std::path::PathBuf;

const DRAFT: &[u8] = br#"{"manuscript":"draft requiring revision"}"#;
const REVISED: &[u8] = br#"{"manuscript":"revision addresses the retained assessment"}"#;

fn binding(from: &str, field: &str, encoding: ArtifactEncodingV1) -> ArtifactBindingV1 {
    ArtifactBindingV1 {
        from_step: from.into(),
        artifact_index: 0,
        artifact_name: None,
        target_pointer: format!("/input/inputManifest/{field}"),
        encoding,
    }
}

struct RevisionFixture {
    peer: Fixture,
    definition: LocalWorkflowV1,
    definition_path: PathBuf,
    current_hash: Sha256Digest,
}
impl RevisionFixture {
    fn new() -> Self {
        let peer = Fixture::new_execution();
        let mut definition = broker_workflow_definition(&peer, &peer.root.join("revision-state"));
        let author = definition.steps[0].clone();
        let registry: Value = serde_json::from_str(&definition.template.registry_json).unwrap();
        let mut policy: RegistryPolicyV1 =
            serde_json::from_value(registry["policy"].clone()).unwrap();
        let mut grant = policy.grants[&author.module_id].clone();
        grant.capability_ids = ["CAP-REVIEW".to_owned()].into();
        policy.grants.insert("module.broker-reviewer".into(), grant);
        let mut builder = ModuleRegistryV1::new(policy).unwrap();
        let author_manifest: ModuleManifestV1 =
            serde_json::from_value(registry["modules"][&author.module_id]["manifest"].clone())
                .unwrap();
        let WorkerBindingV1::BrokerExecute { source } =
            &definition.template.workers[&author.module_id]
        else {
            panic!("execution fixture");
        };
        let mut review_source = source.clone();
        review_source.role = AgentRole::Reviewer;
        review_source.socket_path = peer.root.join("reviewer.sock");
        review_source.runtime_identity_hash = hash(b"reviewer protocol fixture");
        let mut reviewer_manifest = author_manifest.clone();
        reviewer_manifest.module_id = "module.broker-reviewer".into();
        reviewer_manifest.capability_ids = vec!["CAP-REVIEW".into()];
        reviewer_manifest.execution = ModuleExecutionV1::InProcess {
            implementation_hash: broker_execution_implementation_hash_v1(&review_source).unwrap(),
        };
        builder.register(author_manifest).unwrap();
        builder.register(reviewer_manifest).unwrap();
        let registry = builder.finish().unwrap();
        definition.template.registry_json = serde_json::to_string(&registry).unwrap();
        definition.template.hard_policy.registry_policy_hash = registry.policy_hash().clone();
        definition.template.snapshot.registry_hash = registry.registry_hash().clone();
        definition.template.snapshot.registry_policy_hash = registry.policy_hash().clone();
        definition.template.snapshot.constraint_set_hash =
            definition.template.hard_policy.policy_hash().unwrap();
        definition
            .template
            .snapshot
            .required_capability_ids
            .insert("CAP-REVIEW".into());
        for _ in 0..7 {
            definition.template.snapshot.resource_limit = definition
                .template
                .snapshot
                .resource_limit
                .checked_add(author.resources)
                .unwrap();
        }
        definition.template.frontier.snapshot_hash =
            definition.template.snapshot.snapshot_hash().unwrap();
        definition.template.workers.insert(
            "module.broker-reviewer".into(),
            WorkerBindingV1::BrokerExecute {
                source: review_source,
            },
        );
        let mut reviewer = author.clone();
        reviewer.id = "review-1".into();
        reviewer.module_id = "module.broker-reviewer".into();
        reviewer.capability_id = "CAP-REVIEW".into();
        reviewer.job_template["input"]["taskKind"] = json!("review");
        reviewer.job_template["input"]["inputManifest"] = serde_json::from_slice(include_bytes!(
            "../../../../../docs/modules/examples/broker-manuscript-review-input.v1.json"
        ))
        .unwrap();
        reviewer.bindings = vec![
            binding(&author.id, "manuscript", ArtifactEncodingV1::Utf8),
            binding(&author.id, "manuscriptHash", ArtifactEncodingV1::Digest),
        ];
        reviewer.gate = Some(WorkflowGateV1 {
            accepted_pointer: "/accepted".into(),
            subject_step: author.id.clone(),
            subject_artifact_index: 0,
            subject_hash_pointer: "/manuscriptHash".into(),
        });
        let mut downstream = author;
        downstream.id = "downstream".into();
        definition.steps.extend([reviewer, downstream]);
        definition.validate().unwrap();
        let current_hash = canonical_hash_v1(&definition).unwrap();
        let definition_path = peer.root.join("role-workflow.json");
        fs::write(&definition_path, serde_json::to_vec(&definition).unwrap()).unwrap();
        fs::set_permissions(&definition_path, fs::Permissions::from_mode(0o600)).unwrap();
        Self {
            peer,
            definition,
            definition_path,
            current_hash,
        }
    }
    fn command(&self, action: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
        command.args([
            "autonomous-research",
            "--campaign-id",
            &self.peer.request.campaign_id,
        ]);
        if self.definition.template.state_directory.exists() {
            command
                .arg("--workflow-root")
                .arg(&self.definition.template.state_directory)
                .args(["--definition-hash", self.current_hash.as_str()]);
        } else {
            command.arg("--workflow-file").arg(&self.definition_path);
        }
        command.args(["--action", action]);
        command
    }
    fn advance(&self, through: usize) -> Value {
        let action = if self.definition.template.state_directory.exists() {
            "converge"
        } else {
            "launch"
        };
        let output = self
            .command(action)
            .args(["--through-steps", &through.to_string()])
            .output()
            .unwrap();
        let report: Value = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(&output.stderr)));
        assert_eq!(output.status.success(), report["ready"] == true);
        report
    }
    fn status(&self) -> Value {
        let output = self.command("status").output().unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["workflow"].clone()
    }
    // The signed request producer is deliberately external to this test. Its
    // protocol fixture reads the plan actually frozen by the ordinary entry,
    // rather than supplying a second planner/executor/commit implementation.
    fn publish_selected(&mut self, index: usize) -> Value {
        let config: ServiceRunV1 = serde_json::from_slice(
            &fs::read(
                self.definition
                    .template
                    .state_directory
                    .join(format!("step-{index:04}.json")),
            )
            .unwrap(),
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
        let job: NativeJobV1 = serde_json::from_slice(
            &ObjectStoreV1::open(&config.state_directory)
                .unwrap()
                .read(&candidate.payload_hash)
                .unwrap(),
        )
        .unwrap();
        let NativeJobV1::BrokerExecute { input } = job else {
            panic!("broker job")
        };
        let WorkerBindingV1::BrokerExecute { source } = &config.workers[&candidate.module_id]
        else {
            panic!("broker source")
        };
        let request = &mut self.peer.request;
        request.attempt_id = format!("{}:attempt:1", plan.plan_hash.as_str());
        request.operation_id = request.attempt_id.clone();
        request.idempotency_key = plan.plan_hash;
        request.node_id = candidate.candidate_id.clone();
        request.campaign_revision = config.snapshot.campaign_revision;
        request.lease_generation = config.writer_lease.generation;
        request.role = source.role;
        request.task_kind = input.task_kind;
        request.codex_runtime_identity_hash = source.runtime_identity_hash.clone();
        request.prompt_envelope_hash = input.prompt_envelope_hash;
        request.input_manifest_hash = hash(&serde_json::to_vec(&input.input_manifest).unwrap());
        request.workspace_identity_hash = input.workspace_identity_hash;
        request.output_schema_hash = input.output_schema_hash;
        request.mutation_policy_hash = input.mutation_policy_hash;
        request.sandbox_policy = if source.role == AgentRole::Reviewer {
            SandboxPolicy::ReadOnly
        } else {
            SandboxPolicy::WorkspaceWrite
        };
        request.request_capability.nonce = hash(request.attempt_id.as_bytes())
            .as_str()
            .trim_start_matches("sha256:")
            .into();
        request.validate().unwrap();
        self.peer.socket_path = source.socket_path.clone();
        self.peer.request_path = source
            .request_directory
            .join(broker_prepared_request_filename_v1(&request.attempt_id).unwrap());
        self.peer.publish(&self.peer.request);
        input.input_manifest
    }
    fn stage(&mut self, index: usize, output: &[u8], response_mode: u8) -> (Value, Value) {
        assert_eq!(
            self.advance(index + 1)["ready"],
            false,
            "missing authority request must reject"
        );
        let manifest = self.publish_selected(index);
        let server = self
            .peer
            .serve_execution(self.peer.listener(), output, response_mode);
        let report = self.advance(index + 1);
        server.join().unwrap();
        fs::remove_file(&self.peer.socket_path).unwrap();
        (report, manifest)
    }
    fn assessment(manuscript: &[u8], accepted: bool) -> Vec<u8> {
        serde_json::to_vec(&json!({"accepted":accepted,"manuscriptHash":hash(manuscript),"reasons":["retained protocol assessment"]})).unwrap()
    }
    fn reject(&mut self) -> Vec<u8> {
        assert_eq!(self.stage(0, DRAFT, 0).0["ready"], true);
        let review = Self::assessment(DRAFT, false);
        let (report, manifest) = self.stage(1, &review, 0);
        assert_eq!(
            manifest["manuscript"],
            String::from_utf8(DRAFT.to_vec()).unwrap()
        );
        assert_eq!(manifest["manuscriptHash"], json!(hash(DRAFT)));
        assert_eq!(report["error"], "local_workflow_review_gate_rejected");
        let status = self.status();
        assert_eq!(status["committedSteps"], 2);
        assert_eq!(status["gateRejected"], true);
        review
    }
    fn amendment(&self) -> WorkflowAmendmentV1 {
        let mut author = self.definition.steps[0].clone();
        author.id = "author-revised".into();
        author.job_template["input"]["taskKind"] = json!("revise");
        author.job_template["input"]["inputManifest"] = serde_json::from_slice(include_bytes!(
            "../../../../../docs/modules/examples/broker-manuscript-revision-input.v1.json"
        ))
        .unwrap();
        author.bindings = vec![
            binding(
                &self.definition.steps[0].id,
                "previousManuscript",
                ArtifactEncodingV1::Utf8,
            ),
            binding(
                &self.definition.steps[0].id,
                "previousManuscriptHash",
                ArtifactEncodingV1::Digest,
            ),
            binding("review-1", "review", ArtifactEncodingV1::Utf8),
            binding("review-1", "reviewHash", ArtifactEncodingV1::Digest),
        ];
        let mut reviewer = self.definition.steps[1].clone();
        reviewer.id = "review-revised".into();
        for item in &mut reviewer.bindings {
            item.from_step = author.id.clone();
        }
        reviewer.gate.as_mut().unwrap().subject_step = author.id.clone();
        WorkflowAmendmentV1 {
            version: 1,
            operation_id: "broker-revision-1".into(),
            expected_revision: self.status()["campaignRevision"].as_u64().unwrap(),
            steps: vec![author, reviewer, self.definition.steps[2].clone()],
            additional_budget_microusd: 0,
            lease_expires_at_unix_ms: self.definition.template.writer_lease.expires_at_unix_ms,
            repair_rejected_review: true,
        }
    }
    fn amend(&self, request: &WorkflowAmendmentV1) -> Value {
        let path = self.peer.root.join("revision-request.json");
        fs::write(&path, serde_json::to_vec(request).unwrap()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let output = self
            .command("amend")
            .arg("--amendment-file")
            .arg(path)
            .output()
            .unwrap();
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(output.status.success(), report["ready"] == true);
        report
    }
}

#[test]
fn broker_revision_cli_preserves_policy_cas_inputs_rejection_and_exact_replay() {
    let mut f = RevisionFixture::new();
    let rejection = f.reject();
    let before = f.status();
    let request = f.amendment();
    let report = f.amend(&request);
    assert_eq!(report["ready"], true, "{report}");
    let replay = f.amend(&request);
    assert_eq!(report["amendment"], replay["amendment"]);
    f.current_hash = report["definitionHash"].as_str().unwrap().parse().unwrap();
    let (report, manifest) = f.stage(2, REVISED, 0);
    assert_eq!(report["ready"], true, "{report}");
    assert_eq!(
        manifest["previousManuscript"],
        String::from_utf8(DRAFT.to_vec()).unwrap()
    );
    assert_eq!(manifest["previousManuscriptHash"], json!(hash(DRAFT)));
    assert_eq!(
        manifest["review"],
        String::from_utf8(rejection.clone()).unwrap()
    );
    assert_eq!(manifest["reviewHash"], json!(hash(&rejection)));
    assert_eq!(
        f.status()["gateRejected"],
        true,
        "author output cannot clear review"
    );
    let accepted = RevisionFixture::assessment(REVISED, true);
    let (report, manifest) = f.stage(3, &accepted, 0);
    assert_eq!(report["ready"], true, "{report}");
    assert_eq!(manifest["manuscriptHash"], json!(hash(REVISED)));
    assert_eq!(f.status()["gateRejected"], false);
    assert_eq!(f.status()["budgetRemainingMicrousd"], 60);
    for (id, artifacts) in before["artifactsByStep"].as_object().unwrap() {
        assert_eq!(f.status()["artifactsByStep"][id], *artifacts);
    }
    let replay = f.advance(4);
    assert_eq!(replay["ready"], true);
    assert_eq!(replay["workflow"], report["workflow"]);
    assert_eq!(replay["scientificAcceptance"], false);
    assert_eq!(replay["productionActivation"], false);
    assert!(
        !f.definition
            .template
            .state_directory
            .join("step-0004.json")
            .exists()
    );
}

#[test]
fn broker_revision_cli_rejects_rubric_identity_input_and_scope_substitution() {
    let mut f = RevisionFixture::new();
    f.reject();
    let before = f.status();
    for case in 0..12 {
        let mut request = f.amendment();
        match case {
            0 => {
                request.steps[1].job_template["input"]["inputManifest"]["policy"] =
                    json!({"weaker":true})
            }
            1 => {
                request.steps[1].job_template["input"]["promptEnvelopeHash"] =
                    json!(hash(b"different review prompt"))
            }
            2 => {
                request.steps[1].job_template["input"]["outputSchemaHash"] =
                    json!(hash(b"different review schema"))
            }
            3 => request.steps[0].bindings[2].from_step = "draft-1".into(),
            4 => request.steps[1].bindings[0].from_step = "draft-1".into(),
            5 => request.steps[0].job_template["input"]["taskKind"] = json!("draft"),
            6 => {
                request.steps[0].job_template["input"]["outputSchemaHash"] =
                    json!(hash(b"different author schema"))
            }
            7 => request.steps[1].resources.tokens -= 1,
            8 => request.steps[0].job_template["input"]["inputManifest"]["version"] = json!(2),
            9 => {
                request.steps[0].job_template["input"]["inputManifest"]["releaseAuthority"] =
                    json!(true)
            }
            10 => request.steps[1].gate.as_mut().unwrap().subject_step = "draft-1".into(),
            _ => request.steps[1].module_id = request.steps[0].module_id.clone(),
        }
        assert_eq!(f.amend(&request)["ready"], false, "case {case}");
        assert_eq!(f.status(), before, "case {case} must not mutate history");
    }
}

#[test]
fn broker_revision_lost_response_recovers_query_only_and_second_rejection_is_durable() {
    let mut f = RevisionFixture::new();
    f.reject();
    let report = f.amend(&f.amendment());
    assert_eq!(report["ready"], true, "{report}");
    f.current_hash = report["definitionHash"].as_str().unwrap().parse().unwrap();
    let report = f.stage(2, REVISED, 1).0;
    assert_eq!(report["ready"], false);
    assert_eq!(f.status()["committedSteps"], 2);
    assert_eq!(f.status()["budgetRemainingMicrousd"], 80);
    assert_eq!(f.status()["gateRejected"], true);
    let server = f.peer.serve(f.peer.listener(), REVISED, false, false);
    let report = f.advance(3);
    server.join().unwrap();
    fs::remove_file(&f.peer.socket_path).unwrap();
    assert_eq!(report["ready"], true, "{report}");
    let rejected = RevisionFixture::assessment(REVISED, false);
    assert_eq!(f.stage(3, &rejected, 0).0["ready"], false);
    let status = f.status();
    assert_eq!(status["gateRejected"], true);
    assert_eq!(status["committedSteps"], 4);
    assert_eq!(status["budgetRemainingMicrousd"], 60);
    assert_eq!(f.advance(5)["error"], "local_workflow_review_gate_rejected");
    assert_eq!(f.status(), status);
    assert!(
        !f.definition
            .template
            .state_directory
            .join("step-0004.json")
            .exists()
    );
}
