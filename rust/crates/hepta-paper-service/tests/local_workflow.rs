use hepta_campaign_writer::{CampaignStateV1, WriterLeaseV1};
use hepta_control_plane::{
    ControlPlaneSnapshotV1, HardPolicyV1, PlannerPolicyV1, PlanningFrontierV1,
};
use hepta_module_platform::*;
use hepta_paper_service::workflow::*;
use hepta_paper_service::*;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::Duration,
};

static NEXT: AtomicU64 = AtomicU64::new(1);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-workflow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn state(&self) -> PathBuf {
        self.0.join("state")
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn steps() -> Vec<WorkflowStepV1> {
    serde_json::from_slice(include_bytes!(
        "../../../../docs/modules/examples/local-workflow-steps.v1.json"
    ))
    .unwrap()
}
fn definition(temp: &Temp) -> LocalWorkflowV1 {
    LocalWorkflowV1 {
        version: 1,
        template: template(&temp.state(), WorkerBindingV1::Native).unwrap(),
        steps: steps(),
    }
}
fn fixture() -> (Temp, hepta_codex_protocol::Sha256Digest) {
    let temp = Temp::new();
    let hash = initialize_local_workflow_v1(definition(&temp)).unwrap();
    (temp, hash)
}
fn status(temp: &Temp, hash: &hepta_codex_protocol::Sha256Digest) -> WorkflowProgressV1 {
    operate_local_workflow_v1(&temp.state(), hash, WorkflowActionV1::Status, 0).unwrap()
}
fn attempt_count(temp: &Temp) -> usize {
    fs::read_dir(temp.state().join("attempts")).unwrap().count()
}
fn template(
    state: &Path,
    binding: WorkerBindingV1,
) -> Result<ServiceRunV1, Box<dyn std::error::Error>> {
    let source: hepta_codex_protocol::Sha256Digest =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111".parse()?;
    let cap = [
        "CAP-AUTHOR",
        "CAP-REVIEW",
        "CAP-FORMAL",
        "CAP-EMPIRICAL",
        "CAP-NUMERICAL",
        "CAP-BUILD",
        "CAP-SUBMIT",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<BTreeSet<_>>();
    let mut registry = ModuleRegistryV1::new(RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".into(),
        grants: BTreeMap::from([(
            "module.local-native".into(),
            ModuleGrantV1 {
                module_version: "1.0.0".into(),
                authority: AuthorityClassV1::PreparedResultOnly,
                minimum_qualification: QualificationTierV1::Source,
                activation: ActivationStateV1::Shadow,
                capability_ids: cap.clone(),
            },
        )]),
    })?;
    registry.register(ModuleManifestV1 {
        version: 1,
        module_id: "module.local-native".into(),
        module_version: "1.0.0".into(),
        protocol_min: 1,
        protocol_max: 1,
        module_kind: if matches!(binding, WorkerBindingV1::Native) {
            ModuleKindV1::TrustedInProcess
        } else {
            ModuleKindV1::IsolatedProcess
        },
        requested_authority: AuthorityClassV1::PreparedResultOnly,
        qualification: QualificationTierV1::Source,
        requested_activation: ActivationStateV1::Shadow,
        capability_ids: cap.iter().cloned().collect(),
        dependencies: vec![],
        primary_owner: "TEAM-KERNEL".into(),
        secondary_owner: "TEAM-RUNTIME".into(),
        independent_reviewer: "TEAM-EVIDENCE".into(),
        rollback_version: "0.9.0".into(),
        execution: match &binding {
            WorkerBindingV1::Native => ModuleExecutionV1::InProcess {
                implementation_hash: native_implementation_hash_v1()?,
            },
            WorkerBindingV1::Process {
                executable_hash,
                network_declared,
                ..
            } => ModuleExecutionV1::IsolatedProcess {
                executable_hash: executable_hash.clone(),
                configuration_hash: hepta_control_plane::canonical_hash_v1(&binding)?,
                network_declared: *network_declared,
            },
        },
    })?;
    let registry = registry.finish()?;
    let hard = HardPolicyV1 {
        version: 1,
        policy_id: "local-shadow-v1".into(),
        registry_policy_hash: registry.policy_hash().clone(),
        forbidden_module_ids: BTreeSet::new(),
        minimum_evidence_by_capability: BTreeMap::new(),
        external_actions_authorized: false,
        maximum_central_writer_turns: 0,
        maximum_candidates_per_decision_group: 4,
    };
    let capacity = ResourceVectorV1 {
        cpu_millis: 100,
        memory_bytes: 1024 * 1024,
        tokens: 100,
        ..ResourceVectorV1::default()
    };
    let snapshot = ControlPlaneSnapshotV1 {
        version: 1,
        campaign_id: "campaign-service".into(),
        campaign_revision: 1,
        state_hash: source.clone(),
        registry_hash: registry.registry_hash().clone(),
        registry_policy_hash: registry.policy_hash().clone(),
        objective_version: "build-v1".into(),
        constraint_set_hash: hard.policy_hash()?,
        resource_limit: capacity,
        budget_microusd: 100,
        required_capability_ids: cap,
        random_seed: None,
    };
    let frontier = PlanningFrontierV1 {
        version: 1,
        snapshot_hash: snapshot.snapshot_hash()?,
        candidates: vec![],
    };
    Ok(ServiceRunV1 {
        version: 1,
        production_activation: false,
        state_directory: state.to_path_buf(),
        registry_json: serde_json::to_string(&registry)?,
        hard_policy: hard,
        planner_policy: PlannerPolicyV1 {
            version: 1,
            maximum_exact_candidates: 16,
            cost_weight_ppm: 0,
            uncertainty_weight_micros_per_ppm: 0,
            maximum_selected_candidates: 16,
        },
        snapshot,
        frontier,
        verifier_hash: source.clone(),
        initial_state_hash: source,
        writer_lease: WriterLeaseV1 {
            generation: 1,
            token: "local-writer-token-unique-001".into(),
            expires_at_unix_ms: 100_000,
        },
        observed_at_unix_ms: 1_000,
        workers: BTreeMap::from([("module.local-native".into(), binding)]),
    })
}

#[test]
fn actual_artifacts_flow_through_all_seven_documented_steps() {
    let (temp, hash) = fixture();
    let done = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 7 },
        1100,
    )
    .unwrap();
    assert_eq!(done.committed_steps, 7);
    assert_eq!(done.campaign_state, CampaignStateV1::Completed);
    assert_eq!(done.budget_remaining_microusd, 93);
    assert!(
        !done.production_activation
            && !done.scientific_acceptance
            && !done.node_retirement_verified
    );
    let objects = ObjectStoreV1::open(&temp.state()).unwrap();
    let manuscript = objects.read(&done.artifacts_by_step["author"][0]).unwrap();
    let empirical = objects
        .read(&done.artifacts_by_step["empirical"][0])
        .unwrap();
    assert!(
        String::from_utf8(manuscript.clone())
            .unwrap()
            .contains(std::str::from_utf8(&empirical).unwrap())
    );
    let mut found = false;
    for digest in &done.artifacts_by_step["build"] {
        let bytes = objects.read(digest).unwrap();
        if bytes.starts_with(b"HEPTA-NATIVE-BUNDLE-V1") {
            let entries =
                native_business::verify_native_build_bundle_v1(&bytes, digest.as_str()).unwrap();
            assert_eq!(entries.len(), 5);
            assert_eq!(
                entries
                    .iter()
                    .find(|e| e.path == "manuscript.md")
                    .unwrap()
                    .content
                    .as_bytes(),
                manuscript
            );
            found = true;
        }
    }
    assert!(found);
    let count = attempt_count(&temp);
    let replay = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 7 },
        1200,
    )
    .unwrap();
    assert_eq!(replay.budget_remaining_microusd, 93);
    assert_eq!(attempt_count(&temp), count);
}

#[test]
fn pause_resume_and_absolute_progress_retry_preserve_commits() {
    let (temp, hash) = fixture();
    let first = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 2 },
        1100,
    )
    .unwrap();
    assert_eq!(first.committed_steps, 2);
    let retry = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 2 },
        1101,
    )
    .unwrap();
    assert_eq!(retry.campaign_revision, first.campaign_revision);
    let pause = WorkflowActionV1::Pause {
        expected_revision: first.campaign_revision,
    };
    let paused = operate_local_workflow_v1(&temp.state(), &hash, pause, 1200).unwrap();
    let duplicate = operate_local_workflow_v1(&temp.state(), &hash, pause, 1201).unwrap();
    assert_eq!(duplicate.campaign_revision, paused.campaign_revision);
    let attempts = attempt_count(&temp);
    assert!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: 3 },
            1202
        )
        .is_err()
    );
    assert_eq!(attempt_count(&temp), attempts);
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Resume {
            expected_revision: paused.campaign_revision,
        },
        1300,
    )
    .unwrap();
    let done = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 7 },
        1400,
    )
    .unwrap();
    assert_eq!(done.campaign_state, CampaignStateV1::Completed);
    assert_eq!(done.budget_remaining_microusd, 93);
}

#[test]
fn cancel_is_terminal_and_stale_or_rollback_commands_do_not_dispatch() {
    let (temp, hash) = fixture();
    let cancelled = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Cancel {
            expected_revision: 0,
        },
        1200,
    )
    .unwrap();
    assert_eq!(cancelled.campaign_state, CampaignStateV1::Cancelled);
    assert!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Resume {
                expected_revision: 1
            },
            1300
        )
        .is_err()
    );
    assert!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: 1 },
            1100
        )
        .is_err()
    );
    assert!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: 1 },
            1300
        )
        .is_err()
    );
    assert_eq!(attempt_count(&temp), 0);
}

#[test]
fn service_rejects_paused_cancelled_and_completed_before_dispatch() {
    for state in [
        CampaignStateV1::Paused,
        CampaignStateV1::Cancelled,
        CampaignStateV1::Completed,
    ] {
        let (temp, hash) = fixture();
        let end = if state == CampaignStateV1::Completed {
            7
        } else {
            1
        };
        let progress = operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: end },
            1100,
        )
        .unwrap();
        if state != CampaignStateV1::Completed {
            let action = if state == CampaignStateV1::Paused {
                WorkflowActionV1::Pause {
                    expected_revision: progress.campaign_revision,
                }
            } else {
                WorkflowActionV1::Cancel {
                    expected_revision: progress.campaign_revision,
                }
            };
            operate_local_workflow_v1(&temp.state(), &hash, action, 1200).unwrap();
        }
        let mut config: ServiceRunV1 =
            serde_json::from_slice(&fs::read(temp.state().join("step-0000.json")).unwrap())
                .unwrap();
        config.observed_at_unix_ms = 1300;
        config.frontier.candidates[0].candidate_id = "unexpected-after-stop".into();
        let before = attempt_count(&temp);
        assert!(run_service_v1(config).is_err());
        assert_eq!(attempt_count(&temp), before);
    }
}

#[test]
fn rejection_is_persisted_and_cannot_be_bypassed_by_resume_or_retry() {
    let temp = Temp::new();
    let mut def = definition(&temp);
    def.steps[4].job_template["job"]["policy"]["minimumWordCount"] = serde_json::json!(1_000_000);
    let hash = initialize_local_workflow_v1(def).unwrap();
    assert!(matches!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: 7 },
            1100
        ),
        Err(WorkflowError::GateRejected)
    ));
    let before = status(&temp, &hash);
    assert_eq!(before.committed_steps, 5);
    assert!(before.gate_rejected);
    assert!(!temp.state().join("step-0005.json").exists());
    assert!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: 7 },
            1200
        )
        .is_err()
    );
    let paused = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Pause {
            expected_revision: before.campaign_revision,
        },
        1300,
    )
    .unwrap();
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Resume {
            expected_revision: paused.campaign_revision,
        },
        1400,
    )
    .unwrap();
    assert!(matches!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: 7 },
            1500
        ),
        Err(WorkflowError::GateRejected)
    ));
    assert_eq!(status(&temp, &hash).committed_steps, 5);
}

#[test]
fn status_is_read_only_and_corrupt_or_missing_artifacts_are_not_repaired() {
    let (temp, hash) = fixture();
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        1100,
    )
    .unwrap();
    let db = temp.state().join("campaign.sqlite");
    let before = fs::read(&db).unwrap();
    let observed = status(&temp, &hash);
    assert_eq!(fs::read(&db).unwrap(), before);
    let artifact = &observed.artifacts_by_step["empirical"][0];
    let object = temp
        .state()
        .join("objects")
        .join(artifact.as_str().trim_start_matches("sha256:"));
    fs::remove_file(&object).unwrap();
    assert!(operate_local_workflow_v1(&temp.state(), &hash, WorkflowActionV1::Status, 0).is_err());
    assert!(!object.exists());
    assert!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: 2 },
            1200
        )
        .is_err()
    );
    assert!(!temp.state().join("step-0001.json").exists());
}

#[test]
fn definition_bindings_and_aggregate_limits_fail_before_state_creation() {
    let temp = Temp::new();
    let base = definition(&temp);
    let mut invalid = Vec::new();
    let mut d = base.clone();
    d.steps[3].bindings[0].from_step = "submission".into();
    invalid.push(d);
    let mut d = base.clone();
    d.steps[3].bindings[0].target_pointer = "/job/kind".into();
    invalid.push(d);
    let mut d = base.clone();
    let duplicate = d.steps[3].bindings[0].clone();
    d.steps[3].bindings.push(duplicate);
    invalid.push(d);
    let mut d = base.clone();
    d.steps[0].resources.cpu_millis = u64::MAX;
    invalid.push(d);
    let mut d = base.clone();
    d.steps[0].cost_microusd = 101;
    invalid.push(d);
    let mut d = base.clone();
    d.template.production_activation = true;
    invalid.push(d);
    let mut d = base;
    d.steps[0].resources.external_actions = 1;
    invalid.push(d);
    for def in invalid {
        assert!(initialize_local_workflow_v1(def).is_err());
        assert!(!temp.state().exists());
    }
}

#[test]
fn changed_definition_plan_and_wrong_subject_gate_are_rejected() {
    let (temp, hash) = fixture();
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        1100,
    )
    .unwrap();
    let file = temp.state().join("step-0000.json");
    let mut saved: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    saved["frontier"]["candidates"][0]["costMicrousd"] = serde_json::json!(0);
    fs::write(file, serde_json::to_vec(&saved).unwrap()).unwrap();
    assert!(operate_local_workflow_v1(&temp.state(), &hash, WorkflowActionV1::Status, 0).is_err());
    let temp = Temp::new();
    let mut def = definition(&temp);
    def.steps[4].gate.as_mut().unwrap().subject_step = "formal".into();
    let hash = initialize_local_workflow_v1(def).unwrap();
    assert!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: 7 },
            1100
        )
        .is_err()
    );
    assert!(!temp.state().join("step-0005.json").exists());
}

fn process_binding(executable: PathBuf, cwd: PathBuf, arguments: Vec<String>) -> WorkerBindingV1 {
    WorkerBindingV1::Process {
        executable_hash: format!(
            "sha256:{}",
            hex::encode(Sha256::digest(fs::read(&executable).unwrap()))
        )
        .parse()
        .unwrap(),
        executable,
        arguments,
        code_files: BTreeMap::new(),
        working_directory: cwd,
        implementation_language: "rust".into(),
        timeout_ms: 10_000,
        network_declared: false,
    }
}

#[test]
fn actual_rust_process_workers_consume_dynamic_bound_artifacts() {
    let temp = Temp::new();
    let binding = process_binding(
        fs::canonicalize(env!("CARGO_BIN_EXE_hepta-native-business")).unwrap(),
        temp.0.clone(),
        vec![],
    );
    let mut def = LocalWorkflowV1 {
        version: 1,
        template: template(&temp.state(), binding).unwrap(),
        steps: steps(),
    };
    for step in &mut def.steps {
        step.job_template = serde_json::json!({"kind":"process", "input":step.job_template["job"]});
        for binding in &mut step.bindings {
            binding.target_pointer = binding.target_pointer.replacen("/job/", "/input/", 1);
        }
    }
    let hash = initialize_local_workflow_v1(def).unwrap();
    let result = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 7 },
        1100,
    )
    .unwrap();
    assert_eq!(result.committed_steps, 7);
    assert!(!result.scientific_acceptance);
}

#[test]
fn crashing_worker_process() {
    let cwd = std::env::current_dir().unwrap();
    if cwd.file_name().and_then(|s| s.to_str()) != Some("crash-child") {
        return;
    }
    let marker = cwd.join("invocations");
    let count = fs::read_to_string(&marker)
        .unwrap_or_default()
        .parse::<usize>()
        .unwrap_or(0);
    fs::write(marker, (count + 1).to_string()).unwrap();
    std::process::exit(23);
}

#[test]
fn ambiguous_process_start_is_not_reexecuted_on_retry() {
    let temp = Temp::new();
    let cwd = temp.0.join("crash-child");
    fs::create_dir(&cwd).unwrap();
    fs::set_permissions(&cwd, fs::Permissions::from_mode(0o700)).unwrap();
    let binding = process_binding(
        std::env::current_exe().unwrap(),
        cwd.clone(),
        vec![
            "--exact".into(),
            "crashing_worker_process".into(),
            "--nocapture".into(),
        ],
    );
    let mut def = LocalWorkflowV1 {
        version: 1,
        template: template(&temp.state(), binding).unwrap(),
        steps: steps(),
    };
    def.steps.truncate(1);
    def.steps[0].job_template = serde_json::json!({"kind":"process","input":{}});
    let hash = initialize_local_workflow_v1(def).unwrap();
    for now in [1100, 1200] {
        assert!(
            operate_local_workflow_v1(
                &temp.state(),
                &hash,
                WorkflowActionV1::Advance { through_steps: 1 },
                now
            )
            .is_err()
        );
    }
    assert_eq!(fs::read_to_string(cwd.join("invocations")).unwrap(), "1");
    let observed = status(&temp, &hash);
    assert!(observed.pending_step);
    assert_eq!(observed.committed_steps, 0);
    assert_eq!(observed.budget_remaining_microusd, 100);
}

#[test]
fn subprocess_stops_after_committed_step() {
    let Ok(root) = std::env::var("HEPTA_WORKFLOW_TEST_ROOT") else {
        return;
    };
    let hash = std::env::var("HEPTA_WORKFLOW_TEST_HASH")
        .unwrap()
        .parse()
        .unwrap();
    operate_local_workflow_v1(
        Path::new(&root),
        &hash,
        WorkflowActionV1::Advance { through_steps: 3 },
        1100,
    )
    .unwrap();
    println!("WORKFLOW_COMMITTED");
    use std::io::Write;
    std::io::stdout().flush().unwrap();
    thread::sleep(Duration::from_secs(30));
}

#[test]
fn process_death_after_commit_preserves_history_and_resumes_remaining_work() {
    let (temp, hash) = fixture();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "subprocess_stops_after_committed_step",
            "--nocapture",
        ])
        .env("HEPTA_WORKFLOW_TEST_ROOT", temp.state())
        .env("HEPTA_WORKFLOW_TEST_HASH", hash.to_string())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let reader = BufReader::new(child.stdout.take().unwrap());
    let committed = reader
        .lines()
        .map(|s| s.unwrap())
        .any(|line| line.contains("WORKFLOW_COMMITTED"));
    child.kill().unwrap();
    let termination = child.wait().unwrap();
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(termination.signal(), Some(9));
    assert!(committed);
    assert_eq!(status(&temp, &hash).committed_steps, 3);
    let completed = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 7 },
        1200,
    )
    .unwrap();
    assert_eq!(completed.budget_remaining_microusd, 93);
    assert_eq!(completed.committed_steps, 7);
}

#[test]
fn cli_is_bounded_closed_and_status_works_after_lease_expiry() {
    let (temp, hash) = fixture();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-local-workflow"))
        .args([
            "advance",
            temp.state().to_str().unwrap(),
            hash.as_str(),
            "1",
            "1100",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["committedSteps"], 1);
    assert!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: 2 },
            100_000
        )
        .is_err()
    );
    assert_eq!(status(&temp, &hash).committed_steps, 1);
    assert!(
        serde_json::from_str::<WorkflowActionV1>(
            r#"{"action":"advance","through_steps":1,"productionActivation":true}"#
        )
        .is_err()
    );
    let out = Command::new(env!("CARGO_BIN_EXE_hepta-local-workflow"))
        .arg("production")
        .output()
        .unwrap();
    assert!(!out.status.success());
}

#[test]
fn symlinked_definition_and_contending_process_lock_are_rejected() {
    let (temp, hash) = fixture();
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(temp.state().join("workflow.lock"))
        .unwrap();
    let guard = nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock).unwrap();
    assert!(matches!(
        operate_local_workflow_v1(&temp.state(), &hash, WorkflowActionV1::Status, 0),
        Err(WorkflowError::Busy)
    ));
    drop(guard);
    let definition = temp.state().join("workflow.json");
    let moved = temp.0.join("moved.json");
    fs::rename(&definition, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, definition).unwrap();
    assert!(operate_local_workflow_v1(&temp.state(), &hash, WorkflowActionV1::Status, 0).is_err());
}

fn amendment(revision: u64) -> WorkflowAmendmentV1 {
    let mut request: WorkflowAmendmentV1 = serde_json::from_str(include_str!(
        "../../../../docs/modules/examples/workflow-amendment.v1.json"
    ))
    .unwrap();
    request.expected_revision = revision;
    request
}

#[test]
fn budget_and_lease_amendment_replay_is_exact_and_history_survives_old_expiry() {
    let (temp, hash) = fixture();
    let before = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 3 },
        1100,
    )
    .unwrap();
    let frozen = fs::read(temp.state().join("workflow.json")).unwrap();
    let request = amendment(before.campaign_revision);
    let applied = amend_local_workflow_v1(&temp.state(), &hash, request.clone(), 1200).unwrap();
    assert_eq!(applied.committed_steps, 3);
    assert_eq!(applied.applied_revision, before.campaign_revision + 1);
    assert_eq!(
        amend_local_workflow_v1(&temp.state(), &hash, request.clone(), 900_000).unwrap(),
        applied
    );
    assert!(operate_local_workflow_v1(&temp.state(), &hash, WorkflowActionV1::Status, 0).is_err());
    let now = status(&temp, &applied.definition_hash);
    assert_eq!(now.budget_remaining_microusd, 147);
    assert_eq!(now.artifacts_by_step, before.artifacts_by_step);
    let mut conflict = request;
    conflict.additional_budget_microusd += 1;
    assert!(amend_local_workflow_v1(&temp.state(), &hash, conflict, 1300).is_err());
    let done = operate_local_workflow_v1(
        &temp.state(),
        &applied.definition_hash,
        WorkflowActionV1::Advance { through_steps: 7 },
        150_000,
    )
    .unwrap();
    assert_eq!(done.budget_remaining_microusd, 143);
    assert_eq!(done.campaign_state, CampaignStateV1::Completed);
    assert_eq!(
        fs::read(temp.state().join("workflow.json")).unwrap(),
        frozen
    );
    let public = serde_json::to_string(&applied).unwrap();
    assert!(!public.contains("local-writer-token") && !public.contains("jobTemplate"));
    assert!(
        !applied.production_activation
            && !applied.scientific_acceptance
            && !applied.node_retirement_verified
    );
}

#[test]
fn appended_step_executes_once_without_replaying_committed_prefix() {
    let (temp, hash) = fixture();
    let before = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 3 },
        1100,
    )
    .unwrap();
    let mut request = amendment(before.campaign_revision);
    let mut extra = steps()[0].clone();
    extra.id = "extra-measurement".into();
    request.steps.push(extra);
    let applied = amend_local_workflow_v1(&temp.state(), &hash, request, 1200).unwrap();
    let done = operate_local_workflow_v1(
        &temp.state(),
        &applied.definition_hash,
        WorkflowActionV1::Advance { through_steps: 8 },
        1300,
    )
    .unwrap();
    assert_eq!(done.total_steps, 8);
    assert_eq!(done.committed_steps, 8);
    assert_eq!(done.budget_remaining_microusd, 142);
    for (id, values) in before.artifacts_by_step {
        assert_eq!(done.artifacts_by_step[&id], values);
    }
    let count = attempt_count(&temp);
    let replay = operate_local_workflow_v1(
        &temp.state(),
        &applied.definition_hash,
        WorkflowActionV1::Advance { through_steps: 8 },
        1400,
    )
    .unwrap();
    assert_eq!(replay.campaign_revision, done.campaign_revision);
    assert_eq!(attempt_count(&temp), count);
}

#[test]
fn amendments_preserve_pause_and_reject_stale_terminal_expired_and_pending_subjects() {
    let (temp, hash) = fixture();
    let paused = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Pause {
            expected_revision: 0,
        },
        1100,
    )
    .unwrap();
    assert!(amend_local_workflow_v1(&temp.state(), &hash, amendment(0), 1200).is_err());
    assert!(
        amend_local_workflow_v1(
            &temp.state(),
            &hash,
            amendment(paused.campaign_revision),
            100_001
        )
        .is_err()
    );
    let applied = amend_local_workflow_v1(
        &temp.state(),
        &hash,
        amendment(paused.campaign_revision),
        1200,
    )
    .unwrap();
    let now = status(&temp, &applied.definition_hash);
    assert_eq!(now.campaign_state, CampaignStateV1::Paused);
    assert!(
        operate_local_workflow_v1(
            &temp.state(),
            &applied.definition_hash,
            WorkflowActionV1::Advance { through_steps: 1 },
            1300
        )
        .is_err()
    );
    let cancelled = operate_local_workflow_v1(
        &temp.state(),
        &applied.definition_hash,
        WorkflowActionV1::Cancel {
            expected_revision: now.campaign_revision,
        },
        1300,
    )
    .unwrap();
    let mut request = amendment(cancelled.campaign_revision);
    request.operation_id = "another".into();
    assert!(
        amend_local_workflow_v1(&temp.state(), &applied.definition_hash, request, 1400).is_err()
    );
    let (pending, pending_hash) = fixture();
    fs::write(
        pending.state().join("step-0000.json"),
        b"interrupted intent",
    )
    .unwrap();
    assert!(matches!(
        amend_local_workflow_v1(&pending.state(), &pending_hash, amendment(0), 1100),
        Err(WorkflowError::Reconciliation)
    ));
    assert_eq!(
        status(&pending, &pending_hash).budget_remaining_microusd,
        100
    );
}

fn rejected_fixture() -> (Temp, hepta_codex_protocol::Sha256Digest) {
    let temp = Temp::new();
    let mut def = definition(&temp);
    def.steps[3].job_template["job"]["title"] = serde_json::json!("FORBIDDEN");
    def.steps[4].job_template["job"]["policy"]["forbiddenMarkers"] =
        serde_json::json!(["FORBIDDEN"]);
    let hash = initialize_local_workflow_v1(def).unwrap();
    assert!(matches!(
        operate_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowActionV1::Advance { through_steps: 7 },
            1100
        ),
        Err(WorkflowError::GateRejected)
    ));
    (temp, hash)
}
fn repair_request(revision: u64) -> WorkflowAmendmentV1 {
    let mut request = amendment(revision);
    request.repair_rejected_review = true;
    let mut suffix = steps()[3..].to_vec();
    suffix[0].id = "author-revised".into();
    suffix[1].id = "reviewer-revised".into();
    suffix[1].job_template["job"]["policy"]["forbiddenMarkers"] = serde_json::json!(["FORBIDDEN"]);
    for step in &mut suffix {
        for binding in &mut step.bindings {
            if binding.from_step == "author" {
                binding.from_step = "author-revised".into();
            }
            if binding.from_step == "reviewer" {
                binding.from_step = "reviewer-revised".into();
            }
        }
        if let Some(gate) = &mut step.gate {
            gate.subject_step = "author-revised".into();
        }
    }
    request.steps = suffix;
    request
}

#[test]
fn rejected_review_can_be_repaired_only_by_fresh_bound_author_and_same_policy_review() {
    let (temp, hash) = rejected_fixture();
    let before = status(&temp, &hash);
    assert_eq!(before.committed_steps, 5);
    assert!(before.gate_rejected);
    let request = repair_request(before.campaign_revision);
    let applied = amend_local_workflow_v1(&temp.state(), &hash, request, 1200).unwrap();
    let author = operate_local_workflow_v1(
        &temp.state(),
        &applied.definition_hash,
        WorkflowActionV1::Advance { through_steps: 6 },
        1300,
    )
    .unwrap();
    assert!(author.gate_rejected); // Repair input alone does not clear rejection.
    assert!(!author.artifacts_by_step.contains_key("build"));
    let done = operate_local_workflow_v1(
        &temp.state(),
        &applied.definition_hash,
        WorkflowActionV1::Advance { through_steps: 9 },
        1400,
    )
    .unwrap();
    assert_eq!(done.committed_steps, 9);
    assert!(!done.gate_rejected);
    assert_eq!(done.budget_remaining_microusd, 141);
    assert_ne!(
        done.artifacts_by_step["author"],
        done.artifacts_by_step["author-revised"]
    );
    for (id, values) in before.artifacts_by_step {
        assert_eq!(done.artifacts_by_step[&id], values);
    }
    assert!(!done.scientific_acceptance);
}

#[test]
fn repair_cannot_weaken_rubric_bypass_review_or_package_rejected_manuscript() {
    let (temp, hash) = rejected_fixture();
    let before = status(&temp, &hash);
    for mutation in 0..4 {
        let mut request = repair_request(before.campaign_revision);
        match mutation {
            0 => {
                request.steps[1].job_template["job"]["policy"]["forbiddenMarkers"] =
                    serde_json::json!([])
            }
            1 => {
                request.steps.remove(1);
            }
            2 => request.steps[2].bindings[0].from_step = "author".into(),
            _ => request.steps[1].bindings[0].from_step = "author".into(),
        }
        assert!(amend_local_workflow_v1(&temp.state(), &hash, request, 1200).is_err());
        assert_eq!(
            status(&temp, &hash).campaign_revision,
            before.campaign_revision
        );
    }
    assert!(
        amend_local_workflow_v1(
            &temp.state(),
            &hash,
            amendment(before.campaign_revision),
            1200
        )
        .is_err()
    );
}

#[test]
fn another_negative_review_blocks_packaging_and_keeps_both_rejections() {
    let (temp, hash) = rejected_fixture();
    let before = status(&temp, &hash);
    let mut request = repair_request(before.campaign_revision);
    request.steps[0].job_template["job"]["title"] = serde_json::json!("Still FORBIDDEN");
    let applied = amend_local_workflow_v1(&temp.state(), &hash, request, 1200).unwrap();
    assert!(matches!(
        operate_local_workflow_v1(
            &temp.state(),
            &applied.definition_hash,
            WorkflowActionV1::Advance { through_steps: 9 },
            1300
        ),
        Err(WorkflowError::GateRejected)
    ));
    let stopped = status(&temp, &applied.definition_hash);
    assert_eq!(stopped.committed_steps, 7);
    assert!(stopped.gate_rejected);
    assert!(!stopped.artifacts_by_step.contains_key("build"));
    assert!(
        stopped.artifacts_by_step.contains_key("reviewer")
            && stopped.artifacts_by_step.contains_key("reviewer-revised")
    );
}

#[test]
fn local_amend_cli_has_bounded_redacted_output_and_rejects_unknown_fields() {
    let (temp, hash) = fixture();
    let file = temp.0.join("amend.json");
    fs::write(&file, serde_json::to_vec(&amendment(0)).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-local-workflow"))
        .args([
            "amend",
            temp.state().to_str().unwrap(),
            hash.as_str(),
            file.to_str().unwrap(),
            "1100",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let receipt: WorkflowAmendmentReceiptV1 = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        !String::from_utf8(output.stdout)
            .unwrap()
            .contains("local-writer-token")
    );
    assert_eq!(
        status(&temp, &receipt.definition_hash).budget_remaining_microusd,
        150
    );
    let mut invalid = serde_json::to_value(amendment(receipt.applied_revision)).unwrap();
    invalid["productionActivation"] = serde_json::json!(true);
    fs::write(&file, serde_json::to_vec(&invalid).unwrap()).unwrap();
    assert!(
        !Command::new(env!("CARGO_BIN_EXE_hepta-local-workflow"))
            .args([
                "amend",
                temp.state().to_str().unwrap(),
                receipt.definition_hash.as_str(),
                file.to_str().unwrap(),
                "1200"
            ])
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn amendment_subprocess_waits_after_commit() {
    let Ok(root) = std::env::var("HEPTA_AMEND_TEST_ROOT") else {
        return;
    };
    let hash = std::env::var("HEPTA_AMEND_TEST_HASH")
        .unwrap()
        .parse()
        .unwrap();
    let request: WorkflowAmendmentV1 = serde_json::from_slice(
        &fs::read(Path::new(&root).parent().unwrap().join("request.json")).unwrap(),
    )
    .unwrap();
    let receipt = amend_local_workflow_v1(Path::new(&root), &hash, request, 1200).unwrap();
    println!("{}", serde_json::to_string(&receipt).unwrap());
    std::io::Write::flush(&mut std::io::stdout()).unwrap();
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

#[test]
fn sigkill_after_amendment_commit_recovers_one_budget_increase_and_one_definition() {
    let (temp, hash) = fixture();
    let before = operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 3 },
        1100,
    )
    .unwrap();
    let request = amendment(before.campaign_revision);
    fs::write(
        temp.0.join("request.json"),
        serde_json::to_vec(&request).unwrap(),
    )
    .unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "amendment_subprocess_waits_after_commit",
            "--nocapture",
        ])
        .env("HEPTA_AMEND_TEST_ROOT", temp.state())
        .env("HEPTA_AMEND_TEST_HASH", hash.as_str())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let receipt = loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if let Ok(value) = serde_json::from_str::<WorkflowAmendmentReceiptV1>(&line) {
            break value;
        }
    };
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
    assert_eq!(
        amend_local_workflow_v1(&temp.state(), &hash, request, 1300).unwrap(),
        receipt
    );
    let done = operate_local_workflow_v1(
        &temp.state(),
        &receipt.definition_hash,
        WorkflowActionV1::Advance { through_steps: 7 },
        1400,
    )
    .unwrap();
    assert_eq!(done.budget_remaining_microusd, 143);
    assert_eq!(done.committed_steps, 7);
}

#[test]
fn documented_inspection_queries_validate_real_history_without_writes() {
    let (temp, hash) = fixture();
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 2 },
        1100,
    )
    .unwrap();
    let before = fs::read(temp.state().join("campaign.sqlite")).unwrap();
    let attempts = attempt_count(&temp);
    let requests: Vec<WorkflowInspectionRequestV1> = serde_json::from_slice(include_bytes!(
        "../../../../docs/modules/examples/local-inspection-requests.v1.json"
    ))
    .unwrap();
    for request in requests {
        assert_inspection_schema(
            include_str!(
                "../../../../docs/modules/schemas/local-workflow-inspection-request-v1.schema.json"
            ),
            &request,
        );
        let response = inspect_local_workflow_v1(&temp.state(), &hash, request).unwrap();
        assert_inspection_schema(
            include_str!(
                "../../../../docs/modules/schemas/local-workflow-inspection-response-v1.schema.json"
            ),
            &response,
        );
        assert_eq!(response.version, 1);
        assert!(!response.production_activation);
        assert!(!response.node_retirement_verified);
        let wire = serde_json::to_string(&response).unwrap();
        assert!(!wire.contains("local-writer-token"));
        assert!(!wire.contains(temp.state().to_str().unwrap()));
        match response.data {
            WorkflowInspectionDataV1::Events { page } => {
                assert_eq!(page.events.len(), 2);
                assert!(page.next_cursor.is_some());
            }
            WorkflowInspectionDataV1::Logs {
                entries,
                next_offset,
            } => {
                assert_eq!(entries.len(), 2);
                assert_eq!(next_offset, None);
                assert_eq!(entries[0].step_id, steps()[0].id);
                assert_eq!(entries[1].actual_cost_microusd, steps()[1].cost_microusd);
            }
            WorkflowInspectionDataV1::Slo { counters } => {
                assert_eq!(counters.committed_steps, 2);
                assert_eq!(counters.remaining_steps, 5);
                assert!(!counters.production_slo_qualified);
                assert_eq!(
                    counters.spent_microusd,
                    steps()[..2].iter().map(|s| s.cost_microusd).sum::<u64>()
                );
            }
        }
    }
    assert_eq!(
        before,
        fs::read(temp.state().join("campaign.sqlite")).unwrap()
    );
    assert_eq!(attempts, attempt_count(&temp));
}

#[test]
fn local_events_cursor_freezes_prefix_and_rejects_forged_anchors() {
    let (temp, hash) = fixture();
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 1 },
        1100,
    )
    .unwrap();
    let response = inspect_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowInspectionRequestV1::Events {
            cursor: None,
            limit: 1,
        },
    )
    .unwrap();
    let WorkflowInspectionDataV1::Events { page: first } = response.data else {
        panic!("event page")
    };
    let cursor = first.next_cursor.unwrap();
    operate_local_workflow_v1(
        &temp.state(),
        &hash,
        WorkflowActionV1::Advance { through_steps: 2 },
        1200,
    )
    .unwrap();
    let read = |c| {
        inspect_local_workflow_v1(
            &temp.state(),
            &hash,
            WorkflowInspectionRequestV1::Events {
                cursor: Some(c),
                limit: 256,
            },
        )
    };
    let next = read(cursor.clone()).unwrap();
    let WorkflowInspectionDataV1::Events { page } = next.data else {
        panic!("event page")
    };
    assert_eq!(page.snapshot_sequence, first.snapshot_sequence);
    assert!(
        page.events
            .iter()
            .all(|e| e.sequence <= first.snapshot_sequence)
    );
    assert!(page.next_cursor.is_none());
    let mut wrong = cursor.clone();
    wrong.campaign_id = "another-campaign".into();
    assert!(read(wrong).is_err());
    let mut wrong = cursor.clone();
    wrong.after_event_hash = format!("sha256:{}", "0".repeat(64)).parse().unwrap();
    assert!(read(wrong).is_err());
    let mut wrong = cursor.clone();
    wrong.snapshot_event_hash = format!("sha256:{}", "0".repeat(64)).parse().unwrap();
    assert!(read(wrong).is_err());
    let mut wrong = cursor;
    wrong.after_sequence = u64::MAX;
    assert!(read(wrong).is_err());
}

#[test]
fn local_inspection_bounds_unknown_fields_and_missing_state_fail_closed() {
    let (temp, hash) = fixture();
    for request in [
        WorkflowInspectionRequestV1::Events {
            cursor: None,
            limit: 0,
        },
        WorkflowInspectionRequestV1::Events {
            cursor: None,
            limit: 257,
        },
        WorkflowInspectionRequestV1::Logs {
            offset: 0,
            limit: 0,
        },
        WorkflowInspectionRequestV1::Logs {
            offset: usize::MAX,
            limit: 1,
        },
        WorkflowInspectionRequestV1::Logs {
            offset: 1,
            limit: 1,
        },
    ] {
        assert!(inspect_local_workflow_v1(&temp.state(), &hash, request).is_err());
    }
    assert!(
        serde_json::from_str::<WorkflowInspectionRequestV1>(
            r#"{"action":"slo","sql":"DELETE FROM campaigns"}"#
        )
        .is_err()
    );
    let missing = temp.0.join("missing");
    assert!(
        inspect_local_workflow_v1(&missing, &hash, WorkflowInspectionRequestV1::Slo {}).is_err()
    );
    assert!(!missing.exists());
}

#[test]
fn local_list_uses_explicit_roots_and_rejects_duplicates_and_stale_hashes() {
    let (temp, hash) = fixture();
    let reference = WorkflowReferenceV1 {
        state_directory: temp.state(),
        definition_hash: hash,
    };
    let result = list_local_workflows_v1(WorkflowListRequestV1 {
        version: 1,
        workflows: vec![reference.clone()],
    })
    .unwrap();
    assert_eq!(result.entries.len(), 1);
    assert!(!result.atomic_across_workflows);
    assert!(
        list_local_workflows_v1(WorkflowListRequestV1 {
            version: 1,
            workflows: vec![reference.clone(), reference.clone()]
        })
        .is_err()
    );
    let mut bad = reference;
    bad.definition_hash = format!("sha256:{}", "0".repeat(64)).parse().unwrap();
    assert!(
        list_local_workflows_v1(WorkflowListRequestV1 {
            version: 1,
            workflows: vec![bad]
        })
        .is_err()
    );
    assert!(
        list_local_workflows_v1(WorkflowListRequestV1 {
            version: 1,
            workflows: vec![]
        })
        .is_err()
    );
}

#[test]
fn local_read_commands_execute_actual_binary_and_reject_wrong_query() {
    let (temp, hash) = fixture();
    let binary = env!("CARGO_BIN_EXE_hepta-local-workflow");
    let request = temp.0.join("events.json");
    fs::write(&request, r#"{"action":"events","cursor":null,"limit":1}"#).unwrap();
    let run = |arguments: &[&str]| Command::new(binary).args(arguments).output().unwrap();
    let state = temp.state();
    let state = state.to_str().unwrap();
    for argv in [
        vec!["events", state, hash.as_str(), request.to_str().unwrap()],
        vec!["logs", state, hash.as_str(), "0", "1"],
        vec!["slo", state, hash.as_str()],
    ] {
        let output = run(&argv);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["productionActivation"], false);
    }
    let listing = temp.0.join("list.json");
    fs::write(
        &listing,
        serde_json::to_vec(&WorkflowListRequestV1 {
            version: 1,
            workflows: vec![WorkflowReferenceV1 {
                state_directory: temp.state(),
                definition_hash: hash.clone(),
            }],
        })
        .unwrap(),
    )
    .unwrap();
    assert!(run(&["list", listing.to_str().unwrap()]).status.success());
    fs::write(&request, r#"{"action":"slo"}"#).unwrap();
    let rejected = run(&["events", state, hash.as_str(), request.to_str().unwrap()]);
    assert!(!rejected.status.success());
    assert!(rejected.stdout.is_empty());
    assert!(
        !run(&["logs", state, hash.as_str(), "0", "257"])
            .status
            .success()
    );
}

fn assert_inspection_schema<T: serde::Serialize>(schema: &str, value: &T) {
    let validator = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/rust/tools/strict_json_schema.py");
    let input = serde_json::to_vec(&serde_json::json!([{
        "name": "actual-local-inspection-v1", "schema": schema,
        "instance": serde_json::to_string(value).unwrap(),
    }]))
    .unwrap();
    let mut child = Command::new("python3")
        .arg(validator)
        .arg("--batch-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), &input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "schema rejected real output: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
