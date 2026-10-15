//! Core-owned operation publication for the installed product dispatcher.
//! A descriptor is published last. Each file crosses an atomic no-replace
//! transition; a crash leaves only a private staging file which the same owner
//! may discard before dispatch. Published or foreign files are never replaced.
//! Recovery reads the same descriptor and never changes provider intent.
use super::*;
use nix::{
    fcntl::{Flock, FlockArg, OFlag, RenameFlags, openat, renameat2},
    sys::stat::{Mode, fstatat},
    unistd::{Gid, UnlinkatFlags, fchown, unlinkat},
};
use std::os::fd::AsFd;

/// Installed operation authority policy. It cannot be widened by a business job.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductCodexOperationPublisherV1 {
    pub version: u16,
    pub role: AgentRole,
    #[serde(
        default,
        skip_serializing_if = "ProductCodexOperationPurposeV1::is_business"
    )]
    pub purpose: ProductCodexOperationPurposeV1,
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
            || !self.purpose.permits_role(self.role)
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
            || if self.purpose == ProductCodexOperationPurposeV1::OneShotReadOnlyCanary {
                self.mutation_policy != MutationPolicyV1::reviewer_read_only()
            } else {
                self.mutation_policy.read_only
                    != matches!(self.role, AgentRole::Reviewer | AgentRole::FormalReviewer)
            }
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
    if !source.purpose.permits_task(operation.task_kind)
        || operation.role != source.role
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
    directory: &Flock<File>,
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
    let filename = path.file_name().ok_or(ProductCodexError::AuthorityFile)?;
    let temporary = format!(
        ".{}.publication-pending",
        filename.to_str().ok_or(ProductCodexError::AuthorityFile)?
    );
    discard_staging_file(source, directory, &temporary, max)?;
    let mut file = File::from(
        openat(
            directory.as_fd(),
            temporary.as_str(),
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| ProductCodexError::AuthorityFile)?,
    );
    #[cfg(test)]
    publication_test_boundary("created", path);
    // Only the private stage is writable. The broker sees the fixed final name
    // after fchown/fchmod/fsync and RENAME_NOREPLACE have all succeeded.
    fchown(&file, None, Some(Gid::from_raw(source.broker_gid)))
        .map_err(|_| ProductCodexError::FileMetadata)?;
    file.write_all(bytes)
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    file.set_permissions(fs::Permissions::from_mode(0o440))
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    file.sync_all()
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    #[cfg(test)]
    publication_test_boundary("staged", path);
    let metadata = file
        .metadata()
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    validate_regular_metadata(
        &metadata,
        source.authority_uid,
        source.broker_gid,
        0o440,
        max,
    )?;
    if metadata.len() != bytes.len() as u64 {
        return Err(ProductCodexError::DescriptorChanged);
    }
    match renameat2(
        directory.as_fd(),
        temporary.as_str(),
        directory.as_fd(),
        filename,
        RenameFlags::RENAME_NOREPLACE,
    ) {
        Ok(()) => {}
        Err(nix::errno::Errno::EEXIST) => {
            discard_staging_file(source, directory, &temporary, max)?;
        }
        Err(_) => return Err(ProductCodexError::AuthorityFile),
    }
    directory
        .sync_all()
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    #[cfg(test)]
    publication_test_boundary("published", path);
    let (actual, _) =
        read_stable_regular_file(path, source.authority_uid, source.broker_gid, 0o440, max)?;
    if actual != bytes {
        return Err(ProductCodexError::DescriptorChanged);
    }
    Ok(())
}

fn discard_staging_file(
    source: &ProductCodexOperationPublisherV1,
    directory: &Flock<File>,
    name: &str,
    maximum_bytes: u64,
) -> Result<(), ProductCodexError> {
    let file = match openat(
        directory.as_fd(),
        name,
        OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
        Mode::empty(),
    ) {
        Ok(file) => File::from(file),
        Err(nix::errno::Errno::ENOENT) => return Ok(()),
        Err(_) => return Err(ProductCodexError::AuthorityFile),
    };
    let metadata = file
        .metadata()
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    let named = fstatat(
        directory.as_fd(),
        name,
        nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW,
    )
    .map_err(|_| ProductCodexError::AuthorityFile)?;
    if !metadata.is_file()
        || metadata.uid() != source.authority_uid
        || ![source.broker_gid, nix::unistd::getegid().as_raw()].contains(&metadata.gid())
        || ![0o600, 0o440].contains(&(metadata.mode() & 0o7777))
        || metadata.nlink() != 1
        || metadata.len() > maximum_bytes
        || named.st_dev != metadata.dev()
        || named.st_ino != metadata.ino()
        || named.st_mode != metadata.mode()
        || named.st_nlink != 1
        || named.st_uid != metadata.uid()
        || named.st_gid != metadata.gid()
        || u64::try_from(named.st_size).ok() != Some(metadata.len())
        || named.st_mtime != metadata.mtime()
        || named.st_mtime_nsec != metadata.mtime_nsec()
        || named.st_ctime != metadata.ctime()
        || named.st_ctime_nsec != metadata.ctime_nsec()
    {
        return Err(ProductCodexError::AuthorityFile);
    }
    unlinkat(directory.as_fd(), name, UnlinkatFlags::NoRemoveDir)
        .map_err(|_| ProductCodexError::AuthorityFile)?;
    directory
        .sync_all()
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))
}
/// Publish the existing V1 operation contract and exact prompt/manifest before
/// IPC dispatch. An exact retry retains published inode and bytes. A private
/// staging file may be removed under the owner lock; a changed final object is
/// rejected. This function never starts a provider or writes its journal.
pub fn publish_product_codex_operation_v1(
    source: &ProductCodexOperationPublisherV1,
    request: &CodexExecutionRequestV1,
    manifest: &serde_json::Value,
    now: u64,
) -> Result<(), ProductCodexError> {
    request
        .validate()
        .map_err(|_| ProductCodexError::Configuration)?;
    if !source.purpose.permits_task(request.task_kind) || request.role != source.role {
        return Err(ProductCodexError::Configuration);
    }
    let identity = source.capture()?;
    let descriptor = operation_descriptor_path(&source.operation_directory, &request.operation_id)?;
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(&source.operation_directory)
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    let _lock = Flock::lock(directory, FlockArg::LockExclusiveNonblock)
        .map_err(|_| ProductCodexError::OperationDirectory)?;
    let opened = _lock
        .metadata()
        .map_err(|e| ProductCodexError::Filesystem(e.kind()))?;
    if opened.dev() != identity.device
        || opened.ino() != identity.inode
        || !opened.is_dir()
        || opened.mode() & 0o7777 != identity.mode
        || opened.uid() != identity.uid
        || opened.gid() != identity.gid
    {
        return Err(ProductCodexError::OperationDirectory);
    }
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
        one_shot_canary: request.one_shot_canary.clone(),
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
        &_lock,
        &operation.input_manifest_path,
        &manifest,
        MAXIMUM_INPUT_MANIFEST_BYTES,
    )?;
    retain_file(
        source,
        &_lock,
        &operation.prompt_path,
        &prompt,
        MAXIMUM_PROMPT_BYTES,
    )?;
    retain_file(
        source,
        &_lock,
        &published_request_path(source, &request.operation_id),
        &request_bytes(request)?,
        MAXIMUM_DESCRIPTOR_BYTES,
    )?;
    retain_file(
        source,
        &_lock,
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

#[cfg(test)]
fn publication_test_boundary(point: &str, path: &Path) {
    if std::env::var("HEPTA_PUBLICATION_TEST_BOUNDARY")
        .ok()
        .as_deref()
        == Some(point)
    {
        fs::write(path.with_extension("test-boundary"), point).unwrap();
        loop {
            std::thread::park();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeSet,
        process::{Command, Stdio},
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    struct Fixture {
        root: PathBuf,
        source: ProductCodexOperationPublisherV1,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "hepta-publication-crash-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let operations = root.join("operations");
            fs::create_dir(&operations).unwrap();
            fs::set_permissions(&operations, fs::Permissions::from_mode(0o750)).unwrap();
            let source = ProductCodexOperationPublisherV1 {
                version: 1,
                role: AgentRole::Author,
                purpose: ProductCodexOperationPurposeV1::Business,
                operation_directory: operations,
                authority_uid: nix::unistd::geteuid().as_raw(),
                broker_uid: nix::unistd::geteuid().as_raw().checked_add(1).unwrap(),
                broker_gid: nix::unistd::getegid().as_raw(),
                workspace_path: root.join("workspace"),
                prompt_prefix_path: root.join("prefix"),
                prompt_prefix_hash: digest(b"prefix").unwrap(),
                output_schema_path: root.join("schema"),
                output_schema_hash: digest(b"schema").unwrap(),
                mutation_policy: MutationPolicyV1 {
                    version: 1,
                    read_only: false,
                    allowed_path_prefixes: vec!["draft.md".into()],
                    allowed_extensions: BTreeSet::from(["md".into()]),
                    maximum_changed_entries: 1,
                    maximum_changed_file_bytes: 1024,
                },
            };
            fs::write(
                root.join("source.json"),
                serde_json::to_vec(&source).unwrap(),
            )
            .unwrap();
            Self { root, source }
        }
        fn retain(&self, path: &Path, bytes: &[u8]) -> Result<(), ProductCodexError> {
            let directory = Flock::lock(
                File::open(&self.source.operation_directory).unwrap(),
                FlockArg::LockExclusiveNonblock,
            )
            .unwrap();
            retain_file(
                &self.source,
                &directory,
                path,
                bytes,
                MAXIMUM_DESCRIPTOR_BYTES,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    #[ignore = "private subprocess crash fixture; the parent kills it at a selected actual publication boundary"]
    fn publication_child() {
        let config = std::env::var_os("HEPTA_PUBLICATION_TEST_SOURCE").unwrap();
        let source: ProductCodexOperationPublisherV1 =
            serde_json::from_slice(&fs::read(config).unwrap()).unwrap();
        let path = source
            .operation_directory
            .join(std::env::var_os("HEPTA_PUBLICATION_TEST_NAME").unwrap());
        let directory = Flock::lock(
            File::open(&source.operation_directory).unwrap(),
            FlockArg::LockExclusiveNonblock,
        )
        .unwrap();
        retain_file(
            &source,
            &directory,
            &path,
            b"exact original signed operation bytes",
            MAXIMUM_DESCRIPTOR_BYTES,
        )
        .unwrap();
        panic!("child must be killed at the actual selected publication boundary");
    }

    #[test]
    fn publication_crashes_recover_private_stages_and_preserve_published_inode() {
        for name in [
            "operation.input.json",
            "operation.prompt.txt",
            "operation.signed-request.v1",
            "operation.json",
        ] {
            for boundary in ["created", "staged", "published"] {
                let fixture = Fixture::new();
                let path = fixture.source.operation_directory.join(name);
                let marker = path.with_extension("test-boundary");
                let temporary = fixture
                    .source
                    .operation_directory
                    .join(format!(".{name}.publication-pending"));
                let mut child = Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "product::publisher::tests::publication_child",
                        "--ignored",
                        "--nocapture",
                    ])
                    .env(
                        "HEPTA_PUBLICATION_TEST_SOURCE",
                        fixture.root.join("source.json"),
                    )
                    .env("HEPTA_PUBLICATION_TEST_NAME", name)
                    .env("HEPTA_PUBLICATION_TEST_BOUNDARY", boundary)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap();
                let deadline = Instant::now() + Duration::from_secs(10);
                while !marker.exists() && Instant::now() < deadline {
                    if child.try_wait().unwrap().is_some() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                if !marker.exists() {
                    let _ = child.kill();
                    let output = child.wait_with_output().unwrap();
                    panic!(
                        "actual boundary {name}/{boundary} was not reached: {}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                child.kill().unwrap();
                let status = child.wait().unwrap();
                assert!(!status.success());
                assert_eq!(path.exists(), boundary == "published");
                assert_eq!(temporary.exists(), boundary != "published");
                let published_inode = path.exists().then(|| fs::metadata(&path).unwrap().ino());
                fixture
                    .retain(&path, b"exact original signed operation bytes")
                    .unwrap();
                assert!(!temporary.exists());
                assert_eq!(
                    fs::read(&path).unwrap(),
                    b"exact original signed operation bytes"
                );
                let inode = fs::metadata(&path).unwrap().ino();
                if let Some(previous) = published_inode {
                    assert_eq!(inode, previous);
                }
                fixture
                    .retain(&path, b"exact original signed operation bytes")
                    .unwrap();
                assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
                assert!(
                    fixture
                        .retain(&path, b"replacement request must be rejected")
                        .is_err()
                );
                assert_eq!(
                    fs::read(&path).unwrap(),
                    b"exact original signed operation bytes"
                );
            }
        }
    }

    #[test]
    fn publication_rejects_foreign_stages_and_torn_final_objects() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let path = fixture.source.operation_directory.join("operation.json");
        let temporary = fixture
            .source
            .operation_directory
            .join(".operation.json.publication-pending");
        let foreign = fixture.root.join("foreign");
        fs::write(&foreign, b"foreign").unwrap();
        symlink(&foreign, &temporary).unwrap();
        assert!(fixture.retain(&path, b"original").is_err());
        assert!(
            fs::symlink_metadata(&temporary)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read(&foreign).unwrap(), b"foreign");
        fs::remove_file(&temporary).unwrap();
        fs::hard_link(&foreign, &temporary).unwrap();
        assert!(fixture.retain(&path, b"original").is_err());
        assert_eq!(fs::metadata(&foreign).unwrap().nlink(), 2);
        fs::remove_file(&temporary).unwrap();
        fs::write(&temporary, b"unexpected writable object").unwrap();
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(fixture.retain(&path, b"original").is_err());
        assert_eq!(fs::read(&temporary).unwrap(), b"unexpected writable object");
        fs::remove_file(&temporary).unwrap();
        fs::write(&path, b"old torn final").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(fixture.retain(&path, b"original").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old torn final");
    }
    #[test]
    fn canary_publisher_purpose_is_opt_in_and_never_widens_business_defaults() {
        let fixture = Fixture::new();
        let original = serde_json::to_vec(&fixture.source).unwrap();
        let value = serde_json::to_value(&fixture.source).unwrap();
        assert!(value.get("purpose").is_none());
        let roundtrip: ProductCodexOperationPublisherV1 = serde_json::from_value(value).unwrap();
        assert_eq!(serde_json::to_vec(&roundtrip).unwrap(), original);
        fixture.source.validate().unwrap();
        let mut canary = fixture.source.clone();
        canary.mutation_policy = MutationPolicyV1::reviewer_read_only();
        assert!(
            canary.validate().is_err(),
            "legacy author remains writable-only"
        );
        canary.purpose = ProductCodexOperationPurposeV1::OneShotReadOnlyCanary;
        canary.validate().unwrap();
        assert!(!canary.purpose.permits_task(TaskKind::Draft));
        assert!(canary.purpose.permits_task(TaskKind::ReadOnlyCanary));
        assert!(
            !fixture
                .source
                .purpose
                .permits_task(TaskKind::ReadOnlyCanary)
        );
        for role in [AgentRole::Reviewer, AgentRole::Repairer] {
            canary.role = role;
            assert!(canary.validate().is_err());
        }
        canary.role = AgentRole::FormalReviewer;
        canary.validate().unwrap();
        canary
            .mutation_policy
            .allowed_path_prefixes
            .push("unexpected".into());
        assert!(canary.validate().is_err());
    }
}
