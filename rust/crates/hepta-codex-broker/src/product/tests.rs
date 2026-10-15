use super::*;
use hepta_codex_protocol::{RequestCapabilityV1, SandboxPolicy};
use std::{
    collections::BTreeSet,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    operations: PathBuf,
    workspace: PathBuf,
    prompt: PathBuf,
    input_manifest: PathBuf,
    schema: PathBuf,
    authority_uid: u32,
    authority_gid: u32,
    broker_uid: u32,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hepta-product-broker-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let root_metadata = fs::metadata(&root).unwrap();
        let authority_uid = root_metadata.uid();
        let authority_gid = root_metadata.gid();
        let broker_uid = authority_uid.checked_add(1).unwrap_or(1);

        let operations = root.join("operations");
        fs::create_dir(&operations).unwrap();
        fs::set_permissions(&operations, fs::Permissions::from_mode(0o750)).unwrap();
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).unwrap();
        fs::set_permissions(&workspace, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(workspace.join("input.txt"), b"exact source input").unwrap();
        fs::set_permissions(
            workspace.join("input.txt"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();

        let prompt = operations.join("prompt.txt");
        let input_manifest = operations.join("input-manifest.json");
        let schema = operations.join("schema.json");
        write_authority_file(&prompt, b"Produce the exact requested artifact.");
        write_authority_file(
            &input_manifest,
            br#"{"kind":"ProductInputManifestV1","version":1}"#,
        );
        write_authority_file(
            &schema,
            br#"{"additionalProperties":false,"properties":{"answer":{"type":"string"}},"required":["answer"],"type":"object"}"#,
        );
        Self {
            root,
            operations,
            workspace,
            prompt,
            input_manifest,
            schema,
            authority_uid,
            authority_gid,
            broker_uid,
        }
    }

    fn operation(&self) -> ProductCodexOperationV1 {
        let workspace = WorkspaceRootV1::open(&self.workspace, self.authority_uid).unwrap();
        ProductCodexOperationV1 {
            version: 1,
            operation_id: "operation-1".into(),
            campaign_id: "campaign-1".into(),
            node_id: "author-1".into(),
            attempt_id: "attempt-1".into(),
            lease_generation: 7,
            campaign_revision: 11,
            role: AgentRole::Author,
            task_kind: TaskKind::Draft,
            one_shot_canary: None,
            valid_from_unix_ms: 1_000,
            expires_at_unix_ms: 20_000,
            workspace_path: self.workspace.clone(),
            prompt_path: self.prompt.clone(),
            prompt_hash: digest(&fs::read(&self.prompt).unwrap()).unwrap(),
            input_manifest_path: self.input_manifest.clone(),
            input_manifest_hash: digest(&fs::read(&self.input_manifest).unwrap()).unwrap(),
            workspace_initial_inventory_hash: workspace.inventory().unwrap().inventory_hash,
            output_schema_path: self.schema.clone(),
            output_schema_hash: digest(&fs::read(&self.schema).unwrap()).unwrap(),
            mutation_policy: MutationPolicyV1 {
                version: 1,
                read_only: false,
                allowed_path_prefixes: vec!["draft.md".into()],
                allowed_extensions: BTreeSet::from(["md".into()]),
                maximum_changed_entries: 4,
                maximum_changed_file_bytes: 1024 * 1024,
            },
            network_policy: NetworkPolicy::None,
            approval_policy: ApprovalPolicy::Never,
            maximum_output_bytes: 1024 * 1024,
            maximum_event_count: 10_000,
            maximum_cost_microusd: 5_000_000,
            remaining_token_hint: Some(50_000),
        }
    }

    fn request(&self, operation: &ProductCodexOperationV1) -> CodexExecutionRequestV1 {
        let workspace = WorkspaceRootV1::open(&self.workspace, self.authority_uid).unwrap();
        CodexExecutionRequestV1 {
            version: 1,
            operation_id: operation.operation_id.clone(),
            idempotency_key: hash_test(b"idempotency"),
            campaign_id: operation.campaign_id.clone(),
            node_id: operation.node_id.clone(),
            attempt_id: operation.attempt_id.clone(),
            lease_generation: operation.lease_generation,
            campaign_revision: operation.campaign_revision,
            role: operation.role,
            task_kind: operation.task_kind,
            one_shot_canary: operation.one_shot_canary.clone(),
            codex_runtime_identity_hash: hash_test(b"runtime"),
            model_selector: "qualified-model".into(),
            transport: Transport::ExecJsonlV1,
            session_policy: SessionPolicy::EphemeralNewThread,
            prompt_envelope_hash: operation.prompt_hash.clone(),
            input_manifest_hash: operation.input_manifest_hash.clone(),
            workspace_identity_hash: workspace_identity_hash_v1(&workspace).unwrap(),
            output_schema_hash: operation.output_schema_hash.clone(),
            mutation_policy_hash: mutation_policy_hash_v1(&operation.mutation_policy).unwrap(),
            sandbox_policy: SandboxPolicy::WorkspaceWrite,
            network_policy: operation.network_policy,
            approval_policy: operation.approval_policy,
            absolute_deadline_unix_ms: 18_000,
            maximum_output_bytes: operation.maximum_output_bytes,
            maximum_event_count: operation.maximum_event_count,
            maximum_cost_microusd: operation.maximum_cost_microusd,
            remaining_token_hint: operation.remaining_token_hint,
            request_capability: RequestCapabilityV1 {
                nonce: "nonce-1".into(),
                issued_at_unix_ms: 1_000,
                expires_at_unix_ms: 18_000,
                signer_key_id: "capability-key".into(),
                peer_uid: self.broker_uid,
                peer_gid: self.authority_gid,
                signature_base64: "A".repeat(86),
            },
        }
    }
    fn write_operation(&self, operation: &ProductCodexOperationV1) -> PathBuf {
        let path = self.operations.join("operation-1.json");
        write_authority_file(&path, &serde_json::to_vec(operation).unwrap());
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.prompt, fs::Permissions::from_mode(0o600));
        let _ = fs::set_permissions(&self.input_manifest, fs::Permissions::from_mode(0o600));
        let _ = fs::set_permissions(&self.schema, fs::Permissions::from_mode(0o600));
        let descriptor = self.operations.join("operation-1.json");
        let _ = fs::set_permissions(&descriptor, fs::Permissions::from_mode(0o600));
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn write_authority_file(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o440)).unwrap();
}

fn replace_authority_file(path: &Path, bytes: &[u8]) {
    fs::set_permissions(path, fs::Permissions::from_mode(0o640)).unwrap();
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o440)).unwrap();
}

fn hash_test(bytes: &[u8]) -> Sha256Digest {
    digest(bytes).unwrap()
}
#[test]
fn operation_directory_replacement_is_not_adopted() {
    let fixture = Fixture::new();
    let identity = capture_operation_directory_identity(
        &fixture.operations,
        fixture.authority_uid,
        fixture.authority_gid,
    )
    .expect("capture operation directory");
    assert_operation_directory_current(&identity).expect("original directory current");

    let displaced = fixture.root.join("operations.displaced");
    fs::rename(&fixture.operations, &displaced).unwrap();
    fs::create_dir(&fixture.operations).unwrap();
    fs::set_permissions(&fixture.operations, fs::Permissions::from_mode(0o750)).unwrap();
    assert_eq!(
        assert_operation_directory_current(&identity),
        Err(ProductCodexError::OperationDirectoryChanged)
    );
}

#[test]
fn canonical_descriptor_and_authority_inputs_are_identity_bound() {
    let fixture = Fixture::new();
    let mut operation = fixture.operation();
    fixture.write_operation(&operation);
    let loaded = load_product_operation(
        &fixture.operations,
        "operation-1",
        fixture.authority_uid,
        fixture.broker_uid,
        fixture.authority_gid,
    )
    .unwrap();
    assert_eq!(loaded.operation, operation);
    assert_operation_source_current(&loaded, fixture.broker_uid, fixture.authority_gid).unwrap();
    assert_eq!(
        read_authority_file(
            &fixture.prompt,
            fixture.authority_uid,
            fixture.authority_gid,
            MAXIMUM_PROMPT_BYTES,
            &operation.prompt_hash,
        )
        .unwrap(),
        b"Produce the exact requested artifact."
    );

    operation.maximum_cost_microusd += 1;
    replace_authority_file(
        &fixture.operations.join("operation-1.json"),
        &serde_json::to_vec(&operation).unwrap(),
    );
    assert_eq!(
        assert_operation_source_current(&loaded, fixture.broker_uid, fixture.authority_gid,),
        Err(ProductCodexError::DescriptorChanged),
    );

    replace_authority_file(&fixture.prompt, b"Substituted prompt bytes");
    assert_eq!(
        read_authority_file(
            &fixture.prompt,
            fixture.authority_uid,
            fixture.authority_gid,
            MAXIMUM_PROMPT_BYTES,
            &loaded.operation.prompt_hash,
        ),
        Err(ProductCodexError::AuthorityFile),
    );
}

#[test]
fn request_binding_rejects_budget_role_time_and_workspace_drift() {
    let fixture = Fixture::new();
    let operation = fixture.operation();
    let request = fixture.request(&operation);
    validate_operation_against_request(
        &operation,
        &request,
        AgentRole::Author,
        fixture.authority_uid,
        Some(10_000),
        true,
    )
    .unwrap();

    let mut deadline_widened = request.clone();
    deadline_widened.absolute_deadline_unix_ms = operation.expires_at_unix_ms + 1;
    assert!(matches!(
        validate_operation_against_request(
            &operation,
            &deadline_widened,
            AgentRole::Author,
            fixture.authority_uid,
            Some(10_000),
            true,
        ),
        Err(CodexDispatchError::AuthorityDenied)
    ));

    let mut widened = request.clone();
    widened.maximum_cost_microusd += 1;
    assert!(matches!(
        validate_operation_against_request(
            &operation,
            &widened,
            AgentRole::Author,
            fixture.authority_uid,
            Some(10_000),
            true,
        ),
        Err(CodexDispatchError::AuthorityDenied)
    ));
    assert!(matches!(
        validate_operation_against_request(
            &operation,
            &request,
            AgentRole::Reviewer,
            fixture.authority_uid,
            Some(10_000),
            true,
        ),
        Err(CodexDispatchError::AuthorityDenied)
    ));
    assert!(matches!(
        validate_operation_against_request(
            &operation,
            &request,
            AgentRole::Author,
            fixture.authority_uid,
            Some(operation.expires_at_unix_ms),
            true,
        ),
        Err(CodexDispatchError::AuthorityDenied)
    ));

    fs::write(fixture.workspace.join("late-input.txt"), b"drift").unwrap();
    assert!(matches!(
        validate_operation_against_request(
            &operation,
            &request,
            AgentRole::Author,
            fixture.authority_uid,
            Some(10_000),
            true,
        ),
        Err(CodexDispatchError::AuthorityDenied)
    ));
    validate_operation_against_request(
        &operation,
        &request,
        AgentRole::Author,
        fixture.authority_uid,
        Some(10_000),
        false,
    )
    .expect("postflight permits a policy-validated workspace mutation");
}

#[test]
fn every_live_authority_input_is_revalidated() {
    let fixture = Fixture::new();
    let operation = fixture.operation();
    read_live_authority_inputs(
        &operation,
        fixture.authority_uid,
        fixture.authority_gid,
        1024 * 1024,
    )
    .expect("initial inputs");

    replace_authority_file(&fixture.input_manifest, br#"{"kind":"changed"}"#);
    assert!(matches!(
        read_live_authority_inputs(
            &operation,
            fixture.authority_uid,
            fixture.authority_gid,
            1024 * 1024,
        ),
        Err(ProductCodexError::AuthorityFile)
    ));

    replace_authority_file(
        &fixture.input_manifest,
        br#"{"kind":"ProductInputManifestV1","version":1}"#,
    );
    replace_authority_file(&fixture.schema, br#"{"type":"array"}"#);
    assert!(matches!(
        read_live_authority_inputs(
            &operation,
            fixture.authority_uid,
            fixture.authority_gid,
            1024 * 1024,
        ),
        Err(ProductCodexError::AuthorityFile)
    ));
}

#[test]
fn reviewer_descriptor_must_be_read_only_and_authority_separated() {
    let fixture = Fixture::new();
    let mut operation = fixture.operation();
    operation.role = AgentRole::Reviewer;
    operation.task_kind = TaskKind::Review;
    let mut request = fixture.request(&operation);
    request.role = AgentRole::Reviewer;
    request.task_kind = TaskKind::Review;
    request.sandbox_policy = SandboxPolicy::ReadOnly;
    assert!(matches!(
        validate_operation_against_request(
            &operation,
            &request,
            AgentRole::Reviewer,
            fixture.authority_uid,
            Some(10_000),
            true,
        ),
        Err(CodexDispatchError::AuthorityDenied)
    ));

    operation.mutation_policy = MutationPolicyV1::reviewer_read_only();
    request.mutation_policy_hash = mutation_policy_hash_v1(&operation.mutation_policy).unwrap();
    validate_operation_against_request(
        &operation,
        &request,
        AgentRole::Reviewer,
        fixture.authority_uid,
        Some(10_000),
        true,
    )
    .unwrap();

    fixture.write_operation(&operation);
    assert!(matches!(
        load_product_operation(
            &fixture.operations,
            "operation-1",
            fixture.authority_uid,
            fixture.authority_uid,
            fixture.authority_gid,
        ),
        Err(ProductCodexError::AuthoritySeparation)
    ));
}

#[test]
fn one_shot_canary_descriptor_is_read_only_empty_and_exact_subject_bound() {
    use hepta_codex_protocol::{OneShotProviderCanaryPhaseV1, OneShotProviderCanarySubjectV1};
    let fixture = Fixture::new();
    let mut operation = fixture.operation();
    operation.task_kind = TaskKind::ReadOnlyCanary;
    operation.one_shot_canary = Some(Box::new(OneShotProviderCanarySubjectV1 {
        version: 1,
        attempt_id: "one-shot-attempt".into(),
        phase: OneShotProviderCanaryPhaseV1::ProviderStarted,
        reservation_hash: hash_test(b"reservation"),
        marker_event_hash: hash_test(b"provider-started"),
    }));
    operation.mutation_policy = MutationPolicyV1::reviewer_read_only();
    let mut request = fixture.request(&operation);
    request.sandbox_policy = SandboxPolicy::ReadOnly;
    let check = |operation: &ProductCodexOperationV1, request: &CodexExecutionRequestV1| {
        validate_operation_against_request(
            operation,
            request,
            operation.role,
            fixture.authority_uid,
            Some(10_000),
            true,
        )
    };
    assert!(
        check(&operation, &request).is_err(),
        "canary workspace must be empty"
    );
    fs::remove_file(fixture.workspace.join("input.txt")).unwrap();
    operation.workspace_initial_inventory_hash =
        WorkspaceRootV1::open(&fixture.workspace, fixture.authority_uid)
            .unwrap()
            .inventory()
            .unwrap()
            .inventory_hash;
    request = fixture.request(&operation);
    request.sandbox_policy = SandboxPolicy::ReadOnly;
    check(&operation, &request).unwrap();
    for case in 0..5 {
        let mut op = operation.clone();
        let mut req = request.clone();
        match case {
            0 => op
                .one_shot_canary
                .as_mut()
                .unwrap()
                .attempt_id
                .push_str("-other"),
            1 => {
                op.one_shot_canary.as_mut().unwrap().marker_event_hash = hash_test(b"other-marker")
            }
            2 => op.mutation_policy.read_only = false,
            3 => req.sandbox_policy = SandboxPolicy::WorkspaceWrite,
            _ => req.lease_generation += 1,
        }
        assert!(check(&op, &req).is_err(), "case {case}");
    }
    operation.role = AgentRole::FormalReviewer;
    request.role = AgentRole::FormalReviewer;
    check(&operation, &request).unwrap();
    assert!(
        validate_operation_against_request(
            &operation,
            &request,
            operation.role,
            fixture.authority_uid,
            Some(20_000),
            true
        )
        .is_err()
    );
    fs::write(fixture.workspace.join("unexpected"), b"changed source").unwrap();
    assert!(check(&operation, &request).is_err());
}

fn inspected_dispatcher_configuration(fixture: &Fixture) -> ProductCodexDispatcherConfigurationV1 {
    use hepta_codex_runtime::{codex_parent_environment_policy_v1, inspect_codex_runtime_identity};
    let executable = fixture.root.join("inspected-only-codex");
    fs::write(&executable, b"#!/bin/sh\nexit 9\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let home = fixture.root.join("home");
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(home.join("config.toml"), b"model = 'qualified-model'\n").unwrap();
    fs::set_permissions(home.join("config.toml"), fs::Permissions::from_mode(0o600)).unwrap();
    let parent_environment = codex_parent_environment_policy_v1()
        .build(
            [
                (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
                (OsString::from("HOME"), home.clone().into_os_string()),
                (OsString::from("CODEX_HOME"), home.clone().into_os_string()),
                (
                    OsString::from("TMPDIR"),
                    fixture.root.clone().into_os_string(),
                ),
            ],
            &BTreeMap::new(),
        )
        .unwrap();
    let runtime_identity_policy =
        RuntimeIdentityPolicyV1::strict(fixture.authority_uid, fixture.authority_uid);
    let runtime = inspect_codex_runtime_identity(
        executable.as_os_str(),
        &home,
        "qualified-model",
        parent_environment.policy_hash.clone(),
        hash_test(b"transport"),
        &BTreeMap::new(),
        &runtime_identity_policy,
    )
    .unwrap();
    ProductCodexDispatcherConfigurationV1 {
        role: AgentRole::Author,
        purpose: ProductCodexOperationPurposeV1::Business,
        broker_uid: fixture.broker_uid,
        broker_gid: fixture.authority_gid,
        operation_authority_uid: fixture.authority_uid,
        operation_directory: fixture.operations.clone(),
        runtime,
        runtime_identity_policy,
        parent_environment,
        model_child_environment_base: BTreeMap::new(),
        invocation_policy: CodexInvocationPolicyV1::separate_schema_authority(
            fixture.broker_uid,
            fixture.authority_gid,
            fixture.authority_uid,
        ),
        process_limits: ProcessLimitsV1::default(),
        gate_policy: DurableGatePolicyV1::separate_gate_authority(
            fixture.root.join("unused-gate"),
            fixture.root.join("unused-state"),
            fixture.broker_uid,
            fixture.authority_uid,
        ),
        cgroup_policy: CgroupV2PolicyV1::production(
            fixture.root.join("unused-cgroup"),
            fixture.broker_uid,
        ),
        clock: Arc::new(crate::SystemBrokerClockV1),
    }
}

#[test]
fn raw_canary_constructor_refuses_before_filesystem_while_business_stays_available() {
    let fixture = Fixture::new();
    let configuration = inspected_dispatcher_configuration(&fixture);
    ProductCodexDispatcherV1::new(configuration.clone())
        .unwrap()
        .assert_current_authority()
        .unwrap();
    let mut canary = configuration;
    canary.purpose = ProductCodexOperationPurposeV1::OneShotReadOnlyCanary;
    canary.operation_directory = fixture.root.join("must-not-be-opened");
    assert!(matches!(
        ProductCodexDispatcherV1::new(canary),
        Err(ProductCodexError::InstalledCanaryConfigurationRequired)
    ));
    assert!(!fixture.root.join("must-not-be-opened").exists());
}

#[test]
fn revoked_configuration_denies_each_actual_authority_boundary_before_source_reads() {
    use hepta_codex_runtime::{CodexInvocationRequestV1, build_codex_invocation};
    let fixture = Fixture::new();
    let configuration = inspected_dispatcher_configuration(&fixture);
    let operation = fixture.operation();
    let request = fixture.request(&operation);
    fixture.write_operation(&operation);
    let loaded = load_product_operation(
        &fixture.operations,
        "operation-1",
        fixture.authority_uid,
        fixture.broker_uid,
        fixture.authority_gid,
    )
    .unwrap();
    let schema = fixture.root.join("local-fixture-schema.json");
    fs::write(&schema, b"{\"type\":\"object\"}").unwrap();
    fs::set_permissions(&schema, fs::Permissions::from_mode(0o400)).unwrap();
    let output = fixture.root.join("local-fixture-output.json");
    fs::write(&output, b"").unwrap();
    fs::set_permissions(&output, fs::Permissions::from_mode(0o600)).unwrap();
    let child = model_child_environment_policy_v1()
        .build(
            [
                (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
                (
                    OsString::from("HOME"),
                    fixture.workspace.clone().into_os_string(),
                ),
                (
                    OsString::from("TMPDIR"),
                    fixture.workspace.clone().into_os_string(),
                ),
            ],
            &BTreeMap::new(),
        )
        .unwrap();
    let invocation = build_codex_invocation(CodexInvocationRequestV1 {
        runtime: &configuration.runtime,
        workspace: &fixture.workspace,
        sandbox_policy: SandboxPolicy::ReadOnly,
        output_schema_path: &schema,
        expected_output_schema_hash: &hash_test(&fs::read(&schema).unwrap()),
        output_last_message_path: &output,
        parent_environment: configuration.parent_environment.clone(),
        model_child_environment: &child,
        prompt: b"denial fixture only".to_vec(),
        policy: CodexInvocationPolicyV1::local_fixture(fixture.authority_uid),
    })
    .unwrap();
    let binding = crate::product_daemon::InstalledCanaryDispatcherBindingV1::revoked_for_test(
        configuration.clone(),
        &fixture.root,
    );
    let authority = ProductOperationAuthorityV1 {
        installed_canary: Some(binding),
        loaded,
        expected_role: AgentRole::Author,
        runtime_identity_hash: configuration.runtime.identity_hash.clone(),
        broker_uid: fixture.broker_uid,
        broker_gid: fixture.authority_gid,
        operation_authority_uid: fixture.authority_uid,
        maximum_output_schema_bytes: 1024 * 1024,
    };
    // If the binding check is omitted, missing descriptor I/O produces a different
    // error. No fixture can create a successful installed binding or release.
    fs::remove_file(fixture.operations.join("operation-1.json")).unwrap();
    for point in [
        CodexDispatchAuthorizationPointV1::Preflight,
        CodexDispatchAuthorizationPointV1::PhysicalRelease,
        CodexDispatchAuthorizationPointV1::Postflight,
    ] {
        assert!(
            matches!(
                authority.authorize(&request, &configuration.runtime, &invocation, point, 12_000),
                Err(CodexDispatchError::Product(
                    ProductCodexError::ConfigurationChanged
                ))
            ),
            "{point:?}"
        );
    }
}

#[test]
fn revoked_configuration_denies_delivery_and_empty_recovery_after_containment_scan() {
    let fixture = Fixture::new();
    let mut configuration = inspected_dispatcher_configuration(&fixture);
    configuration.purpose = ProductCodexOperationPurposeV1::OneShotReadOnlyCanary;
    configuration.broker_uid = fixture.authority_uid;
    configuration.cgroup_policy.owner_uid = fixture.authority_uid;
    let state = configuration.gate_policy.state_directory.clone();
    fs::create_dir(&state).unwrap();
    fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
    let binding = crate::product_daemon::InstalledCanaryDispatcherBindingV1::revoked_for_test(
        configuration.clone(),
        &fixture.root,
    );
    // Direct private construction is confined to this denial fixture; its binding
    // is already permanently revoked and cannot admit any provider operation.
    let dispatcher = ProductCodexDispatcherV1 {
        configuration,
        operation_directory_identity: capture_operation_directory_identity(
            &fixture.operations,
            fixture.authority_uid,
            fixture.authority_gid,
        )
        .unwrap(),
        installed_canary: Some(binding),
    };
    assert!(matches!(
        dispatcher.assert_current_authority(),
        Err(CodexDispatchError::Product(
            ProductCodexError::ConfigurationChanged
        ))
    ));
    let mut journal = BrokerJournalStoreV1::open(
        fixture.root.join("journal.sqlite"),
        crate::BrokerJournalPolicyV1::strict(fixture.authority_uid),
    )
    .unwrap();
    assert!(matches!(
        dispatcher.prepared_delivery(&journal, "no-such-operation"),
        Err(CodexDispatchError::Product(
            ProductCodexError::ConfigurationChanged
        ))
    ));
    assert!(matches!(
        dispatcher.recover_before_ready(&mut journal),
        Err(CodexDispatchError::Product(
            ProductCodexError::ConfigurationChanged
        ))
    ));
    assert!(
        state.join("codex-dispatch.lock").is_file(),
        "real no-op containment scan ran first"
    );
    assert!(journal.list_operation_journals(1).unwrap().is_empty());
}
