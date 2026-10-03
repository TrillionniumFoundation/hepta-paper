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
