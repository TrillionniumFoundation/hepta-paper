//! Installed role-specific Codex broker composition.
//!
//! Product operation descriptors are written by a distinct authority principal.
//! The broker may read them but cannot create, replace, or widen them. Each
//! descriptor binds one signed request to exact local prompt, schema, workspace,
//! mutation, budget and lease facts before the provider can be released.

use crate::{
    BrokerClockV1, BrokerJournalStoreV1, BrokerOperationDispatcherV1, CodexDispatchAuthorityV1,
    CodexDispatchAuthorizationPointV1, CodexDispatchError, CodexDispatchPlanV1,
    finalize_codex_prepared_result, load_persisted_request, recover_codex_dispatch_containment,
    run_reserved_codex_operation,
};
use hepta_codex_journal::OperationState;
use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy, SessionPolicy, Sha256Digest,
    TaskKind, Transport,
};
use hepta_codex_runtime::{
    CgroupV2PolicyV1, CodexInvocationPolicyV1, CodexInvocationV1, CodexRuntimeIdentityV1,
    DurableGatePolicyV1, ProcessContainmentModeV1, ProcessLimitsV1, RestrictedEnvironmentV1,
    RuntimeIdentityPolicyV1, SchemaAuthorityModeV1, model_child_environment_policy_v1,
};
use hepta_workspace::{
    MutationPolicyV1, WorkspaceRootV1, mutation_policy_hash_v1, workspace_identity_hash_v1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, atomic::AtomicBool},
};
use thiserror::Error;

const MAXIMUM_DESCRIPTOR_BYTES: u64 = 1024 * 1024;
const MAXIMUM_PROMPT_BYTES: u64 = 8 * 1024 * 1024;
const MAXIMUM_INPUT_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const MAXIMUM_RECOVERY_OPERATIONS: usize = 1_000_000;

/// One authority-owned operation contract consumed by a role-specific broker.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductCodexOperationV1 {
    pub version: u16,
    pub operation_id: String,
    pub campaign_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub lease_generation: u64,
    pub campaign_revision: u64,
    pub role: AgentRole,
    pub task_kind: TaskKind,
    pub valid_from_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub workspace_path: PathBuf,
    pub prompt_path: PathBuf,
    pub prompt_hash: Sha256Digest,
    pub input_manifest_path: PathBuf,
    pub input_manifest_hash: Sha256Digest,
    pub workspace_initial_inventory_hash: Sha256Digest,
    pub output_schema_path: PathBuf,
    pub output_schema_hash: Sha256Digest,
    pub mutation_policy: MutationPolicyV1,
    pub network_policy: NetworkPolicy,
    pub approval_policy: ApprovalPolicy,
    pub maximum_output_bytes: u64,
    pub maximum_event_count: u64,
    pub maximum_cost_microusd: u64,
    pub remaining_token_hint: Option<u64>,
}
/// Exact descriptor object retained across all authority checks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductOperationSourceIdentityV1 {
    canonical_path: PathBuf,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub link_count: u64,
    pub size: u64,
    pub content_hash: Sha256Digest,
}

impl ProductOperationSourceIdentityV1 {
    #[must_use]
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }
}

#[derive(Clone, Debug)]
struct LoadedProductOperationV1 {
    operation: ProductCodexOperationV1,
    source: ProductOperationSourceIdentityV1,
    canonical_bytes: Vec<u8>,
}
/// Fully resolved installed dispatcher inputs. Construction is deliberately
/// separate from JSON parsing so the daemon can verify installation metadata
/// before any provider request is admitted.
#[derive(Clone)]
pub struct ProductCodexDispatcherConfigurationV1 {
    pub role: AgentRole,
    pub broker_uid: u32,
    pub broker_gid: u32,
    pub operation_authority_uid: u32,
    pub operation_directory: PathBuf,
    pub runtime: CodexRuntimeIdentityV1,
    pub runtime_identity_policy: RuntimeIdentityPolicyV1,
    pub parent_environment: RestrictedEnvironmentV1,
    pub model_child_environment_base: BTreeMap<String, String>,
    pub invocation_policy: CodexInvocationPolicyV1,
    pub process_limits: ProcessLimitsV1,
    pub gate_policy: DurableGatePolicyV1,
    pub cgroup_policy: CgroupV2PolicyV1,
    pub clock: Arc<dyn BrokerClockV1>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProductOperationDirectoryIdentityV1 {
    canonical_path: PathBuf,
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    gid: u32,
}

/// Installed dispatcher used by the real broker server.
pub struct ProductCodexDispatcherV1 {
    configuration: ProductCodexDispatcherConfigurationV1,
    operation_directory_identity: ProductOperationDirectoryIdentityV1,
}

impl ProductCodexDispatcherV1 {
    pub fn new(
        configuration: ProductCodexDispatcherConfigurationV1,
    ) -> Result<Self, ProductCodexError> {
        let operation_directory_identity = capture_operation_directory_identity(
            &configuration.operation_directory,
            configuration.operation_authority_uid,
            configuration.broker_gid,
        )?;
        validate_product_configuration(&configuration)?;
        Ok(Self {
            configuration,
            operation_directory_identity,
        })
    }
    #[must_use]
    pub fn role(&self) -> AgentRole {
        self.configuration.role
    }

    #[must_use]
    pub fn runtime_identity_hash(&self) -> &Sha256Digest {
        &self.configuration.runtime.identity_hash
    }

    fn load_operation(
        &self,
        operation_id: &str,
    ) -> Result<LoadedProductOperationV1, ProductCodexError> {
        assert_operation_directory_current(&self.operation_directory_identity)?;
        load_product_operation(
            &self.configuration.operation_directory,
            operation_id,
            self.configuration.operation_authority_uid,
            self.configuration.broker_uid,
            self.configuration.broker_gid,
        )
    }

    fn output_path(&self, operation_id: &str) -> PathBuf {
        self.configuration
            .gate_policy
            .state_directory
            .join(format!("codex-output-{operation_id}.json"))
    }

    fn build_child_environment(
        &self,
        workspace: &Path,
    ) -> Result<RestrictedEnvironmentV1, ProductCodexError> {
        let workspace = workspace.to_str().ok_or(ProductCodexError::Environment)?;
        let overrides = BTreeMap::from([
            ("HOME".to_owned(), workspace.to_owned()),
            ("TMPDIR".to_owned(), workspace.to_owned()),
        ]);
        let source = self
            .configuration
            .model_child_environment_base
            .iter()
            .map(|(key, value)| (OsString::from(key), OsString::from(value)))
            .collect::<Vec<_>>();
        model_child_environment_policy_v1()
            .build(source, &overrides)
            .map_err(|_| ProductCodexError::Environment)
    }

    fn prepare_plan<'a>(
        &'a self,
        loaded: &'a LoadedProductOperationV1,
        prompt: Vec<u8>,
        output_path: PathBuf,
        child_environment: &'a RestrictedEnvironmentV1,
        authority: &'a ProductOperationAuthorityV1,
        cancelled: &'a AtomicBool,
    ) -> CodexDispatchPlanV1<'a> {
        CodexDispatchPlanV1 {
            operation_id: loaded.operation.operation_id.clone(),
            role: self.configuration.role,
            runtime: &self.configuration.runtime,
            runtime_identity_policy: &self.configuration.runtime_identity_policy,
            workspace: loaded.operation.workspace_path.clone(),
            output_schema_path: loaded.operation.output_schema_path.clone(),
            output_last_message_path: output_path,
            parent_environment: self.configuration.parent_environment.clone(),
            model_child_environment: child_environment,
            prompt,
            mutation_policy: &loaded.operation.mutation_policy,
            invocation_policy: self.configuration.invocation_policy,
            process_limits: self.configuration.process_limits,
            gate_policy: self.configuration.gate_policy.clone(),
            containment: ProcessContainmentModeV1::CgroupV2(
                self.configuration.cgroup_policy.clone(),
            ),
            authority,
            clock: self.configuration.clock.as_ref(),
            cancelled,
            authority_evidence_hash: loaded.source.content_hash.clone(),
        }
    }
}
impl BrokerOperationDispatcherV1 for ProductCodexDispatcherV1 {
    fn recover_before_ready(
        &self,
        journal: &mut BrokerJournalStoreV1,
    ) -> Result<(), CodexDispatchError> {
        recover_codex_dispatch_containment(
            journal,
            &self.configuration.gate_policy.state_directory,
            &self.configuration.cgroup_policy,
        )?;
        for operation in journal.list_operation_journals(MAXIMUM_RECOVERY_OPERATIONS)? {
            if !matches!(
                operation.current_state,
                OperationState::SchemaValidated
                    | OperationState::WorkspaceSnapshotted
                    | OperationState::MutationValidated
                    | OperationState::ResultPrepared
            ) {
                continue;
            }
            let loaded = self.load_operation(&operation.operation_id)?;
            validate_operation_against_request(
                &loaded.operation,
                &load_persisted_request(journal, &operation.operation_id)?,
                self.configuration.role,
                self.configuration.broker_uid,
                None,
                false,
            )?;
            finalize_codex_prepared_result(
                journal,
                &self.configuration.gate_policy.state_directory,
                &operation.operation_id,
                &loaded.operation.workspace_path,
                self.configuration.broker_uid,
                &loaded.operation.mutation_policy,
                self.configuration
                    .clock
                    .now_unix_ms()
                    .map_err(|_| CodexDispatchError::Clock)?,
            )?;
        }
        Ok(())
    }
    fn dispatch(
        &self,
        journal: &mut BrokerJournalStoreV1,
        operation_id: &str,
        cancelled: &AtomicBool,
    ) -> Result<(), CodexDispatchError> {
        let loaded = self.load_operation(operation_id)?;
        let request = load_persisted_request(journal, operation_id)?;
        let now = self
            .configuration
            .clock
            .now_unix_ms()
            .map_err(|_| CodexDispatchError::Clock)?;
        validate_operation_against_request(
            &loaded.operation,
            &request,
            self.configuration.role,
            self.configuration.broker_uid,
            Some(now),
            true,
        )?;
        let prompt = read_live_authority_inputs(
            &loaded.operation,
            self.configuration.operation_authority_uid,
            self.configuration.broker_gid,
            self.configuration
                .invocation_policy
                .maximum_output_schema_bytes,
        )?;
        let output_path = self.output_path(operation_id);
        prepare_output_file(
            &output_path,
            &self.configuration.gate_policy.state_directory,
            self.configuration.broker_uid,
            self.configuration.broker_gid,
        )?;
        let child_environment = self.build_child_environment(&loaded.operation.workspace_path)?;
        let authority = ProductOperationAuthorityV1 {
            loaded: loaded.clone(),
            expected_role: self.configuration.role,
            runtime_identity_hash: self.configuration.runtime.identity_hash.clone(),
            broker_uid: self.configuration.broker_uid,
            broker_gid: self.configuration.broker_gid,
            operation_authority_uid: self.configuration.operation_authority_uid,
            maximum_output_schema_bytes: self
                .configuration
                .invocation_policy
                .maximum_output_schema_bytes,
        };
        let plan = self.prepare_plan(
            &loaded,
            prompt,
            output_path,
            &child_environment,
            &authority,
            cancelled,
        );
        run_reserved_codex_operation(journal, plan)?;
        finalize_codex_prepared_result(
            journal,
            &self.configuration.gate_policy.state_directory,
            operation_id,
            &loaded.operation.workspace_path,
            self.configuration.broker_uid,
            &loaded.operation.mutation_policy,
            self.configuration
                .clock
                .now_unix_ms()
                .map_err(|_| CodexDispatchError::Clock)?,
        )?;
        Ok(())
    }
}
struct ProductOperationAuthorityV1 {
    loaded: LoadedProductOperationV1,
    expected_role: AgentRole,
    runtime_identity_hash: Sha256Digest,
    broker_uid: u32,
    broker_gid: u32,
    operation_authority_uid: u32,
    maximum_output_schema_bytes: u64,
}

impl CodexDispatchAuthorityV1 for ProductOperationAuthorityV1 {
    fn authorize(
        &self,
        request: &CodexExecutionRequestV1,
        runtime: &CodexRuntimeIdentityV1,
        invocation: &CodexInvocationV1,
        point: CodexDispatchAuthorizationPointV1,
        now_unix_ms: u64,
    ) -> Result<(), CodexDispatchError> {
        assert_operation_source_current(&self.loaded, self.broker_uid, self.broker_gid)?;
        let _prompt = read_live_authority_inputs(
            &self.loaded.operation,
            self.operation_authority_uid,
            self.broker_gid,
            self.maximum_output_schema_bytes,
        )?;
        validate_operation_against_request(
            &self.loaded.operation,
            request,
            self.expected_role,
            self.broker_uid,
            Some(now_unix_ms),
            point != CodexDispatchAuthorizationPointV1::Postflight,
        )?;
        if runtime.identity_hash != self.runtime_identity_hash
            || request.codex_runtime_identity_hash != self.runtime_identity_hash
            || invocation.prompt_hash != self.loaded.operation.prompt_hash
            || invocation.output_schema_hash != self.loaded.operation.output_schema_hash
        {
            return Err(CodexDispatchError::AuthorityDenied);
        }
        Ok(())
    }
}

fn capture_operation_directory_identity(
    path: &Path,
    authority_uid: u32,
    broker_gid: u32,
) -> Result<ProductOperationDirectoryIdentityV1, ProductCodexError> {
    if !path.is_absolute() || fs::canonicalize(path).ok().as_deref() != Some(path) {
        return Err(ProductCodexError::OperationDirectory);
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|error| ProductCodexError::Filesystem(error.kind()))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != authority_uid
        || metadata.gid() != broker_gid
        || metadata.permissions().mode() & 0o7777 != 0o750
    {
        return Err(ProductCodexError::OperationDirectory);
    }
    Ok(ProductOperationDirectoryIdentityV1 {
        canonical_path: path.to_path_buf(),
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode() & 0o7777,
        uid: metadata.uid(),
        gid: metadata.gid(),
    })
}

fn assert_operation_directory_current(
    expected: &ProductOperationDirectoryIdentityV1,
) -> Result<(), ProductCodexError> {
    let metadata = fs::symlink_metadata(&expected.canonical_path)
        .map_err(|error| ProductCodexError::Filesystem(error.kind()))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || fs::canonicalize(&expected.canonical_path).ok().as_deref()
            != Some(expected.canonical_path.as_path())
        || metadata.dev() != expected.device
        || metadata.ino() != expected.inode
        || metadata.mode() & 0o7777 != expected.mode
        || metadata.uid() != expected.uid
        || metadata.gid() != expected.gid
    {
        return Err(ProductCodexError::OperationDirectoryChanged);
    }
    Ok(())
}

fn validate_product_configuration(
    configuration: &ProductCodexDispatcherConfigurationV1,
) -> Result<(), ProductCodexError> {
    if configuration.operation_authority_uid == configuration.broker_uid {
        return Err(ProductCodexError::AuthoritySeparation);
    }
    if configuration.runtime.model_selector.trim().is_empty()
        || configuration.invocation_policy.execution_uid != configuration.broker_uid
        || configuration.invocation_policy.execution_gid != Some(configuration.broker_gid)
        || configuration.invocation_policy.schema_owner_uid != configuration.operation_authority_uid
        || configuration.invocation_policy.schema_owner_gid != Some(configuration.broker_gid)
        || configuration.invocation_policy.output_owner_uid != configuration.broker_uid
        || configuration.invocation_policy.output_owner_gid != Some(configuration.broker_gid)
        || configuration.invocation_policy.schema_authority_mode
            != SchemaAuthorityModeV1::SeparateOwner
        || configuration.gate_policy.owner_uid != configuration.broker_uid
        || configuration.cgroup_policy.owner_uid != configuration.broker_uid
    {
        return Err(ProductCodexError::Configuration);
    }
    Ok(())
}

fn operation_descriptor_path(
    root: &Path,
    operation_id: &str,
) -> Result<PathBuf, ProductCodexError> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
    {
        return Err(ProductCodexError::OperationId);
    }
    Ok(root.join(format!("{operation_id}.json")))
}
fn load_product_operation(
    root: &Path,
    operation_id: &str,
    authority_uid: u32,
    broker_uid: u32,
    broker_gid: u32,
) -> Result<LoadedProductOperationV1, ProductCodexError> {
    if authority_uid == broker_uid {
        return Err(ProductCodexError::AuthoritySeparation);
    }
    let path = operation_descriptor_path(root, operation_id)?;
    let canonical =
        fs::canonicalize(&path).map_err(|error| ProductCodexError::Filesystem(error.kind()))?;
    if canonical != path || canonical.parent() != Some(root) {
        return Err(ProductCodexError::DescriptorPath);
    }
    let (bytes, metadata) = read_stable_regular_file(
        &canonical,
        authority_uid,
        broker_gid,
        0o440,
        MAXIMUM_DESCRIPTOR_BYTES,
    )?;
    let operation: ProductCodexOperationV1 =
        serde_json::from_slice(&bytes).map_err(|_| ProductCodexError::DescriptorJson)?;
    let canonical_bytes =
        serde_json::to_vec(&operation).map_err(|_| ProductCodexError::DescriptorJson)?;
    if canonical_bytes != bytes || operation.operation_id != operation_id {
        return Err(ProductCodexError::DescriptorJson);
    }
    let content_hash = digest(&bytes)?;
    Ok(LoadedProductOperationV1 {
        operation,
        source: ProductOperationSourceIdentityV1 {
            canonical_path: canonical,
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode() & 0o7777,
            uid: metadata.uid(),
            gid: metadata.gid(),
            link_count: metadata.nlink(),
            size: metadata.size(),
            content_hash,
        },
        canonical_bytes,
    })
}
fn assert_operation_source_current(
    loaded: &LoadedProductOperationV1,
    broker_uid: u32,
    broker_gid: u32,
) -> Result<(), ProductCodexError> {
    let (bytes, metadata) = read_stable_regular_file(
        loaded.source.canonical_path(),
        loaded.source.uid,
        broker_gid,
        0o440,
        MAXIMUM_DESCRIPTOR_BYTES,
    )?;
    if loaded.source.uid == broker_uid
        || bytes != loaded.canonical_bytes
        || metadata.dev() != loaded.source.device
        || metadata.ino() != loaded.source.inode
        || metadata.mode() & 0o7777 != loaded.source.mode
        || metadata.uid() != loaded.source.uid
        || metadata.gid() != loaded.source.gid
        || metadata.nlink() != loaded.source.link_count
        || metadata.size() != loaded.source.size
        || digest(&bytes)? != loaded.source.content_hash
    {
        return Err(ProductCodexError::DescriptorChanged);
    }
    Ok(())
}

fn read_stable_regular_file(
    path: &Path,
    expected_uid: u32,
    expected_gid: u32,
    expected_mode: u32,
    maximum_bytes: u64,
) -> Result<(Vec<u8>, fs::Metadata), ProductCodexError> {
    let before =
        fs::symlink_metadata(path).map_err(|error| ProductCodexError::Filesystem(error.kind()))?;
    validate_regular_metadata(
        &before,
        expected_uid,
        expected_gid,
        expected_mode,
        maximum_bytes,
    )?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| ProductCodexError::Filesystem(error.kind()))?;
    let opened = file
        .metadata()
        .map_err(|error| ProductCodexError::Filesystem(error.kind()))?;
    if !same_file(&before, &opened) {
        return Err(ProductCodexError::FileChanged);
    }
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| ProductCodexError::Filesystem(error.kind()))?;
    if bytes.is_empty() || bytes.len() as u64 > maximum_bytes {
        return Err(ProductCodexError::FileSize);
    }
    let after_descriptor = file
        .metadata()
        .map_err(|error| ProductCodexError::Filesystem(error.kind()))?;
    let after_path =
        fs::symlink_metadata(path).map_err(|error| ProductCodexError::Filesystem(error.kind()))?;
    if !same_file(&opened, &after_descriptor)
        || !same_file(&after_descriptor, &after_path)
        || after_path.size() != bytes.len() as u64
    {
        return Err(ProductCodexError::FileChanged);
    }
    Ok((bytes, after_path))
}

fn validate_regular_metadata(
    metadata: &fs::Metadata,
    expected_uid: u32,
    expected_gid: u32,
    expected_mode: u32,
    maximum_bytes: u64,
) -> Result<(), ProductCodexError> {
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != expected_uid
        || metadata.gid() != expected_gid
        || metadata.mode() & 0o7777 != expected_mode
        || metadata.nlink() != 1
        || metadata.size() == 0
        || metadata.size() > maximum_bytes
    {
        return Err(ProductCodexError::FileMetadata);
    }
    Ok(())
}

fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
        && left.size() == right.size()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn read_authority_file(
    path: &Path,
    expected_uid: u32,
    expected_gid: u32,
    maximum_bytes: u64,
    expected_hash: &Sha256Digest,
) -> Result<Vec<u8>, ProductCodexError> {
    if !path.is_absolute() || fs::canonicalize(path).ok().as_deref() != Some(path) {
        return Err(ProductCodexError::AuthorityFile);
    }
    let (bytes, _) =
        read_stable_regular_file(path, expected_uid, expected_gid, 0o440, maximum_bytes)?;
    if digest(&bytes)? != *expected_hash {
        return Err(ProductCodexError::AuthorityFile);
    }
    Ok(bytes)
}

fn read_live_authority_inputs(
    operation: &ProductCodexOperationV1,
    authority_uid: u32,
    broker_gid: u32,
    maximum_output_schema_bytes: u64,
) -> Result<Vec<u8>, ProductCodexError> {
    let prompt = read_authority_file(
        &operation.prompt_path,
        authority_uid,
        broker_gid,
        MAXIMUM_PROMPT_BYTES,
        &operation.prompt_hash,
    )?;
    read_authority_file(
        &operation.input_manifest_path,
        authority_uid,
        broker_gid,
        MAXIMUM_INPUT_MANIFEST_BYTES,
        &operation.input_manifest_hash,
    )?;
    read_authority_file(
        &operation.output_schema_path,
        authority_uid,
        broker_gid,
        maximum_output_schema_bytes,
        &operation.output_schema_hash,
    )?;
    Ok(prompt)
}

fn prepare_output_file(
    path: &Path,
    state_directory: &Path,
    broker_uid: u32,
    broker_gid: u32,
) -> Result<(), ProductCodexError> {
    if path.parent() != Some(state_directory) || !path.is_absolute() {
        return Err(ProductCodexError::OutputFile);
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.uid() != broker_uid
                || metadata.gid() != broker_gid
                || metadata.permissions().mode() & 0o7777 != 0o600
                || metadata.nlink() != 1
                || metadata.size() != 0
            {
                return Err(ProductCodexError::OutputFile);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
                .open(path)
                .map_err(|cause| ProductCodexError::Filesystem(cause.kind()))?;
            file.write_all(&[])
                .map_err(|cause| ProductCodexError::Filesystem(cause.kind()))?;
            file.sync_all()
                .map_err(|cause| ProductCodexError::Filesystem(cause.kind()))?;
            let metadata = file
                .metadata()
                .map_err(|cause| ProductCodexError::Filesystem(cause.kind()))?;
            if metadata.uid() != broker_uid
                || metadata.gid() != broker_gid
                || metadata.permissions().mode() & 0o7777 != 0o600
                || metadata.nlink() != 1
            {
                return Err(ProductCodexError::OutputFile);
            }
            sync_parent(state_directory)?;
        }
        Err(error) => return Err(ProductCodexError::Filesystem(error.kind())),
    }
    Ok(())
}

fn sync_parent(path: &Path) -> Result<(), ProductCodexError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| ProductCodexError::Filesystem(error.kind()))
}

fn validate_operation_against_request(
    operation: &ProductCodexOperationV1,
    request: &CodexExecutionRequestV1,
    expected_role: AgentRole,
    workspace_owner_uid: u32,
    now_unix_ms: Option<u64>,
    require_initial_inventory: bool,
) -> Result<(), CodexDispatchError> {
    if operation.version != 1
        || operation.role != expected_role
        || request.role != expected_role
        || operation.operation_id != request.operation_id
        || operation.campaign_id != request.campaign_id
        || operation.node_id != request.node_id
        || operation.attempt_id != request.attempt_id
        || operation.lease_generation != request.lease_generation
        || operation.campaign_revision != request.campaign_revision
        || operation.task_kind != request.task_kind
    {
        return Err(CodexDispatchError::AuthorityDenied);
    }
    if operation.valid_from_unix_ms == 0
        || operation.expires_at_unix_ms <= operation.valid_from_unix_ms
        || request.request_capability.expires_at_unix_ms > operation.expires_at_unix_ms
        || request.absolute_deadline_unix_ms > operation.expires_at_unix_ms
        || request.transport != Transport::ExecJsonlV1
        || request.session_policy != SessionPolicy::EphemeralNewThread
        || operation.input_manifest_hash != request.input_manifest_hash
        || operation.output_schema_hash != request.output_schema_hash
        || operation.network_policy != request.network_policy
        || operation.approval_policy != request.approval_policy
        || request.maximum_output_bytes > operation.maximum_output_bytes
        || request.maximum_event_count > operation.maximum_event_count
        || request.maximum_cost_microusd > operation.maximum_cost_microusd
        || request.remaining_token_hint != operation.remaining_token_hint
    {
        return Err(CodexDispatchError::AuthorityDenied);
    }
    if let Some(now) = now_unix_ms
        && (now < operation.valid_from_unix_ms || now >= operation.expires_at_unix_ms)
    {
        return Err(CodexDispatchError::AuthorityDenied);
    }
    let expected_sandbox = match expected_role {
        AgentRole::Author | AgentRole::Repairer => {
            if operation.mutation_policy.read_only {
                return Err(CodexDispatchError::AuthorityDenied);
            }
            hepta_codex_protocol::SandboxPolicy::WorkspaceWrite
        }
        AgentRole::Reviewer | AgentRole::FormalReviewer => {
            if !operation.mutation_policy.read_only {
                return Err(CodexDispatchError::AuthorityDenied);
            }
            hepta_codex_protocol::SandboxPolicy::ReadOnly
        }
    };
    if request.sandbox_policy != expected_sandbox
        || mutation_policy_hash_v1(&operation.mutation_policy)
            .map_err(|_| CodexDispatchError::InvalidBinding("mutation_policy"))?
            != request.mutation_policy_hash
    {
        return Err(CodexDispatchError::AuthorityDenied);
    }
    let workspace = WorkspaceRootV1::open(&operation.workspace_path, workspace_owner_uid)
        .map_err(|_| CodexDispatchError::InvalidBinding("workspace_identity"))?;
    if workspace_identity_hash_v1(&workspace)
        .map_err(|_| CodexDispatchError::InvalidBinding("workspace_identity"))?
        != request.workspace_identity_hash
    {
        return Err(CodexDispatchError::AuthorityDenied);
    }
    if require_initial_inventory
        && workspace
            .inventory()
            .map_err(|_| CodexDispatchError::InvalidBinding("workspace_inventory"))?
            .inventory_hash
            != operation.workspace_initial_inventory_hash
    {
        return Err(CodexDispatchError::AuthorityDenied);
    }
    Ok(())
}
fn digest(bytes: &[u8]) -> Result<Sha256Digest, ProductCodexError> {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
        .map_err(|_| ProductCodexError::Digest)
}

/// Installed operation-descriptor or local composition rejection.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ProductCodexError {
    #[error("product Codex broker configuration is invalid")]
    Configuration,
    #[error("operation authority must be distinct from the broker principal")]
    AuthoritySeparation,
    #[error("operation authority directory is invalid")]
    OperationDirectory,
    #[error("operation authority directory changed after dispatcher construction")]
    OperationDirectoryChanged,
    #[error("operation identifier is invalid")]
    OperationId,
    #[error("operation descriptor path is invalid")]
    DescriptorPath,
    #[error("operation descriptor JSON is noncanonical or invalid")]
    DescriptorJson,
    #[error("operation descriptor changed after admission")]
    DescriptorChanged,
    #[error("authority-owned input file is invalid")]
    AuthorityFile,
    #[error("broker output file is invalid or already contains unknown bytes")]
    OutputFile,
    #[error("restricted environment construction failed")]
    Environment,
    #[error("regular file metadata is invalid")]
    FileMetadata,
    #[error("regular file changed while being read")]
    FileChanged,
    #[error("regular file size is invalid")]
    FileSize,
    #[error("digest construction failed")]
    Digest,
    #[error("filesystem operation failed: {0:?}")]
    Filesystem(std::io::ErrorKind),
}

#[cfg(test)]
mod tests;
