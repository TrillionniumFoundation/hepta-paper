//! Core-owned operation publication for the installed product dispatcher.
//! A descriptor is published last; incomplete or foreign files are retained and
//! rejected. Recovery reads the same descriptor and never changes provider intent.
use super::*;
use nix::{
    fcntl::{Flock, FlockArg},
    unistd::{Gid, fchown},
};

/// Installed operation authority policy. It cannot be widened by a business job.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductCodexOperationPublisherV1 {
    pub version: u16,
    pub role: AgentRole,
    pub operation_directory: PathBuf,
    pub authority_uid: u32,
    pub broker_uid: u32,
    pub broker_gid: u32,
    pub workspace_path: PathBuf,
    pub prompt_prefix_path: PathBuf,
    pub prompt_prefix_hash: Sha256Digest,
    pub output_schema_path: PathBuf,
    pub output_schema_hash: Sha256Digest,
    pub mutation_policy: MutationPolicyV1,
}
impl ProductCodexOperationPublisherV1 {
    /// Structural validation only. Publication separately checks the real UID,
    /// installed directory, input owners, schema and current workspace inventory.
    pub fn validate(&self) -> Result<(), ProductCodexError> {
        if self.version != 1
            || self.authority_uid == self.broker_uid
            || self.broker_uid == 0
            || [
                &self.operation_directory,
                &self.workspace_path,
                &self.prompt_prefix_path,
                &self.output_schema_path,
            ]
            .iter()
            .any(|p| {
                !p.is_absolute()
                    || p.components().any(|c| {
                        matches!(
                            c,
                            std::path::Component::ParentDir | std::path::Component::CurDir
                        )
                    })
            })
            || self.mutation_policy.version != 1
            || self.mutation_policy.read_only
                != matches!(self.role, AgentRole::Reviewer | AgentRole::FormalReviewer)
            || mutation_policy_hash_v1(&self.mutation_policy).is_err()
        {
            return Err(ProductCodexError::Configuration);
        }
        Ok(())
    }
    /// Capture the installed role's exact workspace and mutation-policy subjects.
    pub fn bound_workspace_hashes(
        &self,
    ) -> Result<(Sha256Digest, Sha256Digest), ProductCodexError> {
        let identity = self.capture()?;
        let workspace = WorkspaceRootV1::open(&self.workspace_path, self.broker_uid)
            .map_err(|_| ProductCodexError::Configuration)?;
        let result = (
            workspace_identity_hash_v1(&workspace).map_err(|_| ProductCodexError::Configuration)?,
            mutation_policy_hash_v1(&self.mutation_policy)
                .map_err(|_| ProductCodexError::Configuration)?,
        );
        assert_operation_directory_current(&identity)?;
        Ok(result)
    }

    /// Bind the exact publisher implementation in the caller's module registry.
    pub fn implementation_hash(&self) -> Result<Sha256Digest, ProductCodexError> {
        self.validate()?;
        digest(
            &serde_json::to_vec(&(
                "product-codex-operation-publisher-v1",
                include_str!("publisher.rs"),
                include_str!("../product.rs"),
                self,
            ))
            .map_err(|_| ProductCodexError::DescriptorJson)?,
        )
    }
    fn capture(&self) -> Result<ProductOperationDirectoryIdentityV1, ProductCodexError> {
        self.validate()?;
        if nix::unistd::geteuid().as_raw() != self.authority_uid {
            return Err(ProductCodexError::AuthoritySeparation);
        }
        capture_operation_directory_identity(
            &self.operation_directory,
            self.authority_uid,
            self.broker_gid,
        )
    }
}
fn manifest_bytes(manifest: &serde_json::Value) -> Result<Vec<u8>, ProductCodexError> {
    let bytes = serde_json::to_vec(manifest).map_err(|_| ProductCodexError::DescriptorJson)?;
    if bytes.len() as u64 > MAXIMUM_INPUT_MANIFEST_BYTES {
        return Err(ProductCodexError::FileSize);
    }
    Ok(bytes)
}
fn suffix(manifest: &[u8]) -> Vec<u8> {
    let mut bytes = b"\n\nHepta exact bound input manifest (JSON):\n".to_vec();
    bytes.extend_from_slice(manifest);
    bytes.extend_from_slice(b"\n");
    bytes
}
fn prompt(
    source: &ProductCodexOperationPublisherV1,
    manifest: &[u8],
) -> Result<Vec<u8>, ProductCodexError> {
    let mut bytes = read_authority_file(
        &source.prompt_prefix_path,
        source.authority_uid,
        source.broker_gid,
        MAXIMUM_PROMPT_BYTES,
        &source.prompt_prefix_hash,
    )?;
    bytes.extend_from_slice(&suffix(manifest));
    if bytes.len() as u64 > MAXIMUM_PROMPT_BYTES {
        return Err(ProductCodexError::FileSize);
    }
    Ok(bytes)
}
/// Hash the actual provider prompt before the core signs its execution request.
/// The business manifest is included in the prompt, not merely named by a hash.
pub fn product_codex_prompt_hash_v1(
    source: &ProductCodexOperationPublisherV1,
    manifest: &serde_json::Value,
) -> Result<Sha256Digest, ProductCodexError> {
    let identity = source.capture()?;
    let bytes = prompt(source, &manifest_bytes(manifest)?)?;
    read_authority_file(
        &source.output_schema_path,
        source.authority_uid,
        source.broker_gid,
        MAXIMUM_DESCRIPTOR_BYTES,
        &source.output_schema_hash,
    )?;
    assert_operation_directory_current(&identity)?;
    digest(&bytes)
}
fn validate_source(
    source: &ProductCodexOperationPublisherV1,
    operation: &ProductCodexOperationV1,
) -> Result<(), ProductCodexError> {
    if operation.role != source.role
        || operation.workspace_path != source.workspace_path
        || operation.output_schema_path != source.output_schema_path
        || operation.output_schema_hash != source.output_schema_hash
        || operation.mutation_policy != source.mutation_policy
        || operation.input_manifest_path
            != source
                .operation_directory
                .join(format!("{}.input.json", operation.operation_id))
        || operation.prompt_path
            != source
                .operation_directory
                .join(format!("{}.prompt.txt", operation.operation_id))
    {
        return Err(ProductCodexError::DescriptorChanged);
    }
    Ok(())
}
fn published_request_path(
    source: &ProductCodexOperationPublisherV1,
    operation_id: &str,
) -> PathBuf {
    source
        .operation_directory
        .join(format!("{operation_id}.signed-request.v1"))
}
fn request_bytes(request: &CodexExecutionRequestV1) -> Result<Vec<u8>, ProductCodexError> {
    serde_json::to_vec(request).map_err(|_| ProductCodexError::DescriptorJson)
}
fn validate_published_request(
    source: &ProductCodexOperationPublisherV1,
    operation: &ProductCodexOperationV1,
    request: &CodexExecutionRequestV1,
) -> Result<(), ProductCodexError> {
    // The existing descriptor permits narrowed budgets as an authority contract.
    // Publication additionally retains this exact signed dispatch, including its
    // runtime/model/capability/nonce, so recovery cannot reseal another request.
    let expected = request_bytes(request)?;
    let actual = read_authority_file(
        &published_request_path(source, &operation.operation_id),
        source.authority_uid,
        source.broker_gid,
        MAXIMUM_DESCRIPTOR_BYTES,
        &digest(&expected)?,
    )?;
    if actual != expected || operation.prompt_hash != request.prompt_envelope_hash {
        return Err(ProductCodexError::DescriptorChanged);
    }
    Ok(())
}
fn recover_inputs(
    source: &ProductCodexOperationPublisherV1,
    operation: &ProductCodexOperationV1,
    manifest: &[u8],
) -> Result<Vec<u8>, ProductCodexError> {
    validate_source(source, operation)?;
    if digest(manifest)? != operation.input_manifest_hash {
        return Err(ProductCodexError::AuthorityFile);
    }
    let actual = read_authority_file(
        &operation.input_manifest_path,
        source.authority_uid,
        source.broker_gid,
        MAXIMUM_INPUT_MANIFEST_BYTES,
        &operation.input_manifest_hash,
    )?;
    if actual != manifest {
        return Err(ProductCodexError::AuthorityFile);
    }
    let actual_prompt = read_live_authority_inputs(
        operation,
        source.authority_uid,
        source.broker_gid,
        MAXIMUM_DESCRIPTOR_BYTES,
    )?;
    let ending = suffix(manifest);
    let prefix = actual_prompt
        .strip_suffix(ending.as_slice())
        .ok_or(ProductCodexError::AuthorityFile)?;
    if digest(prefix)? != source.prompt_prefix_hash {
        return Err(ProductCodexError::AuthorityFile);
    }
    Ok(actual_prompt)
}
/// Unknown execution uses only the retained operation and input files. The live
/// prefix and current workspace may have changed; neither can mint a new request.
pub fn recover_product_codex_prompt_hash_v1(
    source: &ProductCodexOperationPublisherV1,
    request: &CodexExecutionRequestV1,
    manifest: &serde_json::Value,
) -> Result<Sha256Digest, ProductCodexError> {
    let identity = source.capture()?;
    let loaded = load_product_operation(
        &source.operation_directory,
        &request.operation_id,
        source.authority_uid,
        source.broker_uid,
        source.broker_gid,
    )?;
    validate_published_request(source, &loaded.operation, request)?;
    let bytes = recover_inputs(source, &loaded.operation, &manifest_bytes(manifest)?)?;
    validate_operation_against_request(
        &loaded.operation,
        request,
        source.role,
        source.broker_uid,
        None,
        false,
    )
    .map_err(|_| ProductCodexError::Configuration)?;
    assert_operation_source_current(&loaded, source.broker_uid, source.broker_gid)?;
    assert_operation_directory_current(&identity)?;
    digest(&bytes)
}
fn retain_file(
    source: &ProductCodexOperationPublisherV1,
    path: &Path,
    bytes: &[u8],
    max: u64,
) -> Result<(), ProductCodexError> {
    if path.parent() != Some(source.operation_directory.as_path())
        || bytes.is_empty()
        || bytes.len() as u64 > max
    {
        return Err(ProductCodexError::AuthorityFile);
    }
    match fs::symlink_metadata(path) {
        Ok(_) => {
            let (existing, _) = read_stable_regular_file(
                path,
                source.authority_uid,
                source.broker_gid,
                0o440,
                max,
            )?;
            if existing != bytes {
                return Err(ProductCodexError::DescriptorChanged);
            }
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(ProductCodexError::Filesystem(error.kind())),
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    // fchown/fchmod operate on the created FD. A crash before the immutable mode
    // or final descriptor leaves a rejected object, never an implicit overwrite.
    fchown(&file, None, Some(Gid::from_raw(source.broker_gid)))
        .map_err(|_| ProductCodexError::FileMetadata)?;
    file.write_all(bytes)
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    file.set_permissions(fs::Permissions::from_mode(0o440))
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    file.sync_all()
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    sync_parent(&source.operation_directory)?;
    let (actual, _) =
        read_stable_regular_file(path, source.authority_uid, source.broker_gid, 0o440, max)?;
    if actual != bytes {
        return Err(ProductCodexError::DescriptorChanged);
    }
    Ok(())
}
/// Publish the existing V1 operation contract and exact prompt/manifest before
/// IPC dispatch. An exact retry retains inode and bytes; any partial or changed
/// object is rejected. This function never starts a provider or writes its journal.
pub fn publish_product_codex_operation_v1(
    source: &ProductCodexOperationPublisherV1,
    request: &CodexExecutionRequestV1,
    manifest: &serde_json::Value,
    now: u64,
) -> Result<(), ProductCodexError> {
    let identity = source.capture()?;
    request
        .validate()
        .map_err(|_| ProductCodexError::Configuration)?;
    let descriptor = operation_descriptor_path(&source.operation_directory, &request.operation_id)?;
    let directory = File::open(&source.operation_directory)
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    let _lock = Flock::lock(directory, FlockArg::LockExclusiveNonblock)
        .map_err(|_| ProductCodexError::OperationDirectory)?;
    assert_operation_directory_current(&identity)?;
    let manifest = manifest_bytes(manifest)?;
    match fs::symlink_metadata(&descriptor) {
        Ok(_) => {
            let loaded = load_product_operation(
                &source.operation_directory,
                &request.operation_id,
                source.authority_uid,
                source.broker_uid,
                source.broker_gid,
            )?;
            validate_published_request(source, &loaded.operation, request)?;
            recover_inputs(source, &loaded.operation, &manifest)?;
            validate_operation_against_request(
                &loaded.operation,
                request,
                source.role,
                source.broker_uid,
                Some(now),
                false,
            )
            .map_err(|_| ProductCodexError::Configuration)?;
            assert_operation_source_current(&loaded, source.broker_uid, source.broker_gid)?;
            return assert_operation_directory_current(&identity);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(ProductCodexError::Filesystem(e.kind())),
    }
    let prompt = prompt(source, &manifest)?;
    let workspace = WorkspaceRootV1::open(&source.workspace_path, source.broker_uid)
        .map_err(|_| ProductCodexError::Configuration)?;
    let operation = ProductCodexOperationV1 {
        version: 1,
        operation_id: request.operation_id.clone(),
        campaign_id: request.campaign_id.clone(),
        node_id: request.node_id.clone(),
        attempt_id: request.attempt_id.clone(),
        lease_generation: request.lease_generation,
        campaign_revision: request.campaign_revision,
        role: request.role,
        task_kind: request.task_kind,
        valid_from_unix_ms: request.request_capability.issued_at_unix_ms,
        expires_at_unix_ms: request.absolute_deadline_unix_ms,
        workspace_path: source.workspace_path.clone(),
        prompt_path: source
            .operation_directory
            .join(format!("{}.prompt.txt", request.operation_id)),
        prompt_hash: digest(&prompt)?,
        input_manifest_path: source
            .operation_directory
            .join(format!("{}.input.json", request.operation_id)),
        input_manifest_hash: digest(&manifest)?,
        workspace_initial_inventory_hash: workspace
            .inventory()
            .map_err(|_| ProductCodexError::Configuration)?
            .inventory_hash,
        output_schema_path: source.output_schema_path.clone(),
        output_schema_hash: source.output_schema_hash.clone(),
        mutation_policy: source.mutation_policy.clone(),
        network_policy: request.network_policy,
        approval_policy: request.approval_policy,
        maximum_output_bytes: request.maximum_output_bytes,
        maximum_event_count: request.maximum_event_count,
        maximum_cost_microusd: request.maximum_cost_microusd,
        remaining_token_hint: request.remaining_token_hint,
    };
    if operation.prompt_hash != request.prompt_envelope_hash
        || operation.input_manifest_hash != request.input_manifest_hash
    {
        return Err(ProductCodexError::AuthorityFile);
    }
    read_authority_file(
        &source.output_schema_path,
        source.authority_uid,
        source.broker_gid,
        MAXIMUM_DESCRIPTOR_BYTES,
        &source.output_schema_hash,
    )?;
    validate_operation_against_request(
        &operation,
        request,
        source.role,
        source.broker_uid,
        Some(now),
        true,
    )
    .map_err(|_| ProductCodexError::Configuration)?;
    retain_file(
        source,
        &operation.input_manifest_path,
        &manifest,
        MAXIMUM_INPUT_MANIFEST_BYTES,
    )?;
    retain_file(
        source,
        &operation.prompt_path,
        &prompt,
        MAXIMUM_PROMPT_BYTES,
    )?;
    retain_file(
        source,
        &published_request_path(source, &request.operation_id),
        &request_bytes(request)?,
        MAXIMUM_DESCRIPTOR_BYTES,
    )?;
    retain_file(
        source,
        &descriptor,
        &serde_json::to_vec(&operation).map_err(|_| ProductCodexError::DescriptorJson)?,
        MAXIMUM_DESCRIPTOR_BYTES,
    )?;
    let loaded = load_product_operation(
        &source.operation_directory,
        &request.operation_id,
        source.authority_uid,
        source.broker_uid,
        source.broker_gid,
    )?;
    validate_published_request(source, &loaded.operation, request)?;
    recover_inputs(source, &loaded.operation, &manifest)?;
    assert_operation_source_current(&loaded, source.broker_uid, source.broker_gid)?;
    assert_operation_directory_current(&identity)
}

/// Read-only broker-side inspection of the exact provider prompt. The real role
/// UID/GID and ordinary installed-operation guards are required; this is no
/// capability, reservation, provider launch or alternative result store.
pub fn inspect_product_codex_operation_prompt_v1(
    source: &ProductCodexOperationPublisherV1,
    request: &CodexExecutionRequestV1,
    now: u64,
) -> Result<Vec<u8>, ProductCodexError> {
    source.validate()?;
    if nix::unistd::geteuid().as_raw() != source.broker_uid
        || nix::unistd::getegid().as_raw() != source.broker_gid
    {
        return Err(ProductCodexError::AuthoritySeparation);
    }
    let identity = capture_operation_directory_identity(
        &source.operation_directory,
        source.authority_uid,
        source.broker_gid,
    )?;
    let loaded = load_product_operation(
        &source.operation_directory,
        &request.operation_id,
        source.authority_uid,
        source.broker_uid,
        source.broker_gid,
    )?;
    validate_source(source, &loaded.operation)?;
    validate_published_request(source, &loaded.operation, request)?;
    validate_operation_against_request(
        &loaded.operation,
        request,
        source.role,
        source.broker_uid,
        Some(now),
        true,
    )
    .map_err(|_| ProductCodexError::Configuration)?;
    let prompt = read_live_authority_inputs(
        &loaded.operation,
        source.authority_uid,
        source.broker_gid,
        MAXIMUM_DESCRIPTOR_BYTES,
    )?;
    assert_operation_source_current(&loaded, source.broker_uid, source.broker_gid)?;
    assert_operation_directory_current(&identity)?;
    Ok(prompt)
}
