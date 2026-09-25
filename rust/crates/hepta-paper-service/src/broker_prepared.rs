//! Existing broker result ingestion, plus an explicitly selected signed-request
//! dispatch backend. No private keys, second result store, or production grant.
use crate::ServiceError;
use hepta_codex_broker::{PeerPolicyV1, PeerPrincipalV1, query_prepared_result};
use hepta_codex_protocol::{AgentRole, CodexExecutionRequestV1, Sha256Digest};
use hepta_control_plane::{ExecutionRequestV1, canonical_hash_v1};
use nix::sys::socket::{AddressFamily, SockFlag, SockType, UnixAddr, connect, socket};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
            net::UnixStream,
        },
    },
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

/// Registry-bound local IPC endpoint and independently selected request owner.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerPreparedSourceV1 {
    pub socket_path: PathBuf,
    pub broker_uid: u32,
    pub broker_gid: u32,
    pub request_directory: PathBuf,
    pub request_owner_uid: u32,
    pub request_owner_gid: u32,
    pub role: AgentRole,
    pub runtime_identity_hash: Sha256Digest,
    pub timeout_ms: u64,
}

/// Exact desired input bytes and output contract; this is not a signed permit.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerPreparedInputV1 {
    pub version: u16,
    pub input_manifest: Value,
    pub task_kind: hepta_codex_protocol::TaskKind,
    pub prompt_envelope_hash: Sha256Digest,
    pub workspace_identity_hash: Sha256Digest,
    pub mutation_policy_hash: Sha256Digest,
    pub output_schema_hash: Sha256Digest,
}

#[derive(Clone, Debug)]
pub(crate) struct BrokerConsumerContextV1 {
    pub campaign_id: String,
    pub campaign_revision: u64,
    pub lease_generation: u64,
}

/// The authority publishes this filename after the real plan chooses its attempt.
/// Keeping request bytes out of the planner definition avoids a circular hash.
pub fn broker_prepared_request_filename_v1(attempt_id: &str) -> Result<String, ServiceError> {
    if attempt_id.is_empty() || attempt_id.len() > 256 {
        return Err(ServiceError::Configuration);
    }
    Ok(format!(
        "{}.json",
        hex::encode(Sha256::digest(attempt_id.as_bytes()))
    ))
}

pub fn broker_prepared_implementation_hash_v1(
    source: &BrokerPreparedSourceV1,
) -> Result<Sha256Digest, ServiceError> {
    source.validate()?;
    canonical_hash_v1(&(
        "hepta-broker-prepared-consumer-v1",
        include_str!("broker_prepared.rs"),
        source,
    ))
    .map_err(|_| ServiceError::Configuration)
}

impl BrokerPreparedSourceV1 {
    pub(crate) fn validate(&self) -> Result<(), ServiceError> {
        if self.timeout_ms == 0
            || self.timeout_ms > 30_000
            || !self.socket_path.is_absolute()
            || !self.request_directory.is_absolute()
            || [&self.socket_path, &self.request_directory]
                .iter()
                .any(|path| {
                    path.components()
                        .any(|p| matches!(p, std::path::Component::ParentDir))
                })
        {
            return Err(ServiceError::Configuration);
        }
        Ok(())
    }
    pub(crate) fn matches_capability(&self, capability: &str) -> bool {
        matches!(
            (self.role, capability),
            (AgentRole::Author | AgentRole::Repairer, "CAP-AUTHOR")
                | (AgentRole::Reviewer, "CAP-REVIEW")
                | (AgentRole::FormalReviewer, "CAP-FORMAL")
        )
    }
}

fn digest(bytes: &[u8]) -> Result<Sha256Digest, ServiceError> {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
        .parse()
        .map_err(|_| ServiceError::Artifact)
}
fn same_node(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.mode() == b.mode()
}
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    same_node(a, b)
        && a.len() == b.len()
        && a.nlink() == b.nlink()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

struct CapturedRequest {
    directory: File,
    directory_metadata: fs::Metadata,
    file: File,
    file_metadata: fs::Metadata,
    path: PathBuf,
    request: CodexExecutionRequestV1,
}
impl CapturedRequest {
    fn open(source: &BrokerPreparedSourceV1, attempt: &str) -> Result<Self, ServiceError> {
        source.validate()?;
        if fs::canonicalize(&source.request_directory).ok().as_ref()
            != Some(&source.request_directory)
        {
            return Err(ServiceError::Artifact);
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(&source.request_directory)
            .map_err(|_| ServiceError::Filesystem)?;
        let directory_metadata = directory.metadata().map_err(|_| ServiceError::Filesystem)?;
        if !directory_metadata.is_dir()
            || directory_metadata.uid() != source.request_owner_uid
            || directory_metadata.gid() != source.request_owner_gid
            || directory_metadata.mode() & 0o027 != 0
        {
            return Err(ServiceError::Artifact);
        }
        let name = broker_prepared_request_filename_v1(attempt)?;
        let path = source.request_directory.join(&name);
        let anchored = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd())).join(name);
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC | nix::libc::O_NONBLOCK)
            .open(anchored)
            .map_err(|_| ServiceError::Filesystem)?;
        let file_metadata = file.metadata().map_err(|_| ServiceError::Filesystem)?;
        if !file_metadata.is_file()
            || file_metadata.uid() != source.request_owner_uid
            || file_metadata.gid() != source.request_owner_gid
            || file_metadata.nlink() != 1
            || !matches!(file_metadata.mode() & 0o7777, 0o400 | 0o440)
            || file_metadata.len() == 0
            || file_metadata.len() > MAX_REQUEST_BYTES
        {
            return Err(ServiceError::Artifact);
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_REQUEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ServiceError::Filesystem)?;
        let request: CodexExecutionRequestV1 =
            serde_json::from_slice(&bytes).map_err(|_| ServiceError::Configuration)?;
        request
            .validate()
            .map_err(|_| ServiceError::Configuration)?;
        if bytes.len() as u64 != file_metadata.len()
            || serde_json::to_vec(&request).map_err(|_| ServiceError::Configuration)? != bytes
        {
            return Err(ServiceError::Configuration);
        }
        let captured = Self {
            directory,
            directory_metadata,
            file,
            file_metadata,
            path,
            request,
        };
        captured.revalidate(source)?;
        Ok(captured)
    }
    fn revalidate(&self, source: &BrokerPreparedSourceV1) -> Result<(), ServiceError> {
        let directory = self
            .directory
            .metadata()
            .map_err(|_| ServiceError::Filesystem)?;
        let named_directory = fs::symlink_metadata(&source.request_directory)
            .map_err(|_| ServiceError::Filesystem)?;
        let opened = self.file.metadata().map_err(|_| ServiceError::Filesystem)?;
        let named = fs::symlink_metadata(&self.path).map_err(|_| ServiceError::Filesystem)?;
        if !same_node(&self.directory_metadata, &directory)
            || !same_node(&directory, &named_directory)
            || fs::canonicalize(&source.request_directory).ok().as_ref()
                != Some(&source.request_directory)
            || !same_file(&self.file_metadata, &opened)
            || !same_file(&opened, &named)
        {
            return Err(ServiceError::Artifact);
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_binding(
    source: &BrokerPreparedSourceV1,
    input: &BrokerPreparedInputV1,
    execution: &ExecutionRequestV1,
    context: &BrokerConsumerContextV1,
    request: &CodexExecutionRequestV1,
    maximum_output_bytes: u64,
    execution_backend: bool,
) -> Result<(), ServiceError> {
    let manifest =
        serde_json::to_vec(&input.input_manifest).map_err(|_| ServiceError::Configuration)?;
    if input.version != 1
        || manifest.len() > MAX_MANIFEST_BYTES
        || !source.matches_capability(&execution.candidate.capability_id)
        || request.codex_runtime_identity_hash != source.runtime_identity_hash
        || request.task_kind != input.task_kind
        || request.prompt_envelope_hash != input.prompt_envelope_hash
        || request.workspace_identity_hash != input.workspace_identity_hash
        || request.mutation_policy_hash != input.mutation_policy_hash
        || request.role != source.role
        || request.operation_id != execution.attempt_id
        || request.attempt_id != execution.attempt_id
        || request.campaign_id != context.campaign_id
        || request.campaign_id != execution.reservation.tenant_id
        || request.node_id != execution.candidate.candidate_id
        || request.campaign_revision != context.campaign_revision
        || request.lease_generation != context.lease_generation
        || request.input_manifest_hash != digest(&manifest)?
        || request.output_schema_hash != input.output_schema_hash
        || request.maximum_output_bytes > maximum_output_bytes
        || request.maximum_cost_microusd > execution.candidate.cost_microusd
        || request
            .remaining_token_hint
            .is_some_and(|n| n > execution.candidate.resources.tokens)
        || execution.candidate.resources.provider_calls != u64::from(execution_backend)
        || execution.candidate.resources.external_actions != 0
    {
        return Err(ServiceError::Configuration);
    }
    Ok(())
}

fn connect_now(
    source: &BrokerPreparedSourceV1,
) -> Result<(UnixStream, fs::Metadata), ServiceError> {
    if fs::canonicalize(&source.socket_path).ok().as_ref() != Some(&source.socket_path) {
        return Err(ServiceError::Artifact);
    }
    let before = fs::symlink_metadata(&source.socket_path).map_err(|_| ServiceError::Filesystem)?;
    if !before.file_type().is_socket()
        || before.uid() != source.broker_uid
        || before.gid() != source.broker_gid
        || before.mode() & 0o007 != 0
    {
        return Err(ServiceError::Artifact);
    }
    let socket = socket(
        AddressFamily::Unix,
        SockType::Stream,
        SockFlag::SOCK_NONBLOCK | SockFlag::SOCK_CLOEXEC,
        None,
    )
    .map_err(|_| ServiceError::Execution)?;
    let address = UnixAddr::new(&source.socket_path).map_err(|_| ServiceError::Configuration)?;
    connect(socket.as_raw_fd(), &address).map_err(|_| ServiceError::Execution)?;
    let stream = UnixStream::from(socket);
    stream
        .set_nonblocking(false)
        .map_err(|_| ServiceError::Execution)?;
    let named = fs::symlink_metadata(&source.socket_path).map_err(|_| ServiceError::Filesystem)?;
    if !same_node(&before, &named) {
        return Err(ServiceError::Artifact);
    }
    Ok((stream, before))
}

/// The existing attempt journal selects this mode; request JSON cannot request
/// a replay of an execution. All recovery modes use only HEPTAQX1.
#[derive(Clone, Copy)]
pub(crate) enum BrokerConsumeModeV1 {
    PreparedOnly,
    ExecuteOnce,
    RecoverExecution,
}

/// Separate registry identity for a backend which may issue one signed request.
pub fn broker_execution_implementation_hash_v1(
    source: &BrokerPreparedSourceV1,
) -> Result<Sha256Digest, ServiceError> {
    source.validate()?;
    hepta_control_plane::canonical_hash_v1(&(
        "hepta-broker-execution-backend-v1",
        broker_prepared_implementation_hash_v1(source)?,
    ))
    .map_err(|_| ServiceError::Configuration)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn consume(
    source: &BrokerPreparedSourceV1,
    input: &BrokerPreparedInputV1,
    execution: &ExecutionRequestV1,
    context: &BrokerConsumerContextV1,
    maximum_output_bytes: u64,
    cancelled: &AtomicBool,
    mode: BrokerConsumeModeV1,
    record_started: impl FnOnce() -> Result<(), ServiceError>,
) -> Result<(Vec<u8>, Value), ServiceError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(ServiceError::Execution);
    }
    let started_at = std::time::Instant::now();
    let execution_backend = !matches!(mode, BrokerConsumeModeV1::PreparedOnly);
    let captured = CapturedRequest::open(source, &execution.attempt_id)?;
    validate_binding(
        source,
        input,
        execution,
        context,
        &captured.request,
        maximum_output_bytes,
        execution_backend,
    )?;
    let policy = PeerPolicyV1::new([PeerPrincipalV1 {
        uid: source.broker_uid,
        gid: source.broker_gid,
    }])
    .map_err(|_| ServiceError::Configuration)?;
    let (stream, before) = connect_now(source)?;
    let peer =
        hepta_codex_broker::inspect_peer_identity(&stream).map_err(|_| ServiceError::Execution)?;
    policy
        .authorize(peer)
        .map_err(|_| ServiceError::Execution)?;
    captured.revalidate(source)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(ServiceError::Execution);
    }
    let remaining = || -> Result<u64, ServiceError> {
        let elapsed =
            u64::try_from(started_at.elapsed().as_millis()).map_err(|_| ServiceError::Execution)?;
        source
            .timeout_ms
            .checked_sub(elapsed)
            .filter(|value| *value > 0)
            .ok_or(ServiceError::Execution)
    };
    // Local request, binding, connection and peer failures are not ambiguous
    // external results. Only now persist the intent, before any request frame.
    // A failure from here on keeps the intent and cannot authorize re-execution.
    remaining()?;
    record_started()?;
    captured.revalidate(source)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(ServiceError::Execution);
    }
    let expected_prepared = if matches!(mode, BrokerConsumeModeV1::ExecuteOnce) {
        let response = hepta_codex_broker::dispatch_signed_operation(
            &stream,
            &policy,
            &captured.request,
            remaining()?,
        )
        .map_err(|_| ServiceError::Execution)?;
        captured.revalidate(source)?;
        if cancelled.load(Ordering::Acquire) {
            return Err(ServiceError::Execution);
        }
        Some(
            response
                .prepared_receipt_hash
                .ok_or(ServiceError::Execution)?,
        )
    } else {
        None
    };
    // The execution response carries metadata only. Fetch the original bytes
    // through the existing read-only protocol and verify the same receipt.
    let stream = if expected_prepared.is_some() {
        drop(stream);
        let (next, named) = connect_now(source)?;
        if !same_node(&before, &named) {
            return Err(ServiceError::Artifact);
        }
        next
    } else {
        stream
    };
    let delivery = query_prepared_result(&stream, &policy, &captured.request, remaining()?)
        .map_err(|_| ServiceError::Execution)?;
    if expected_prepared
        .as_ref()
        .is_some_and(|expected| expected != &delivery.receipt().prepared_receipt_hash)
    {
        return Err(ServiceError::Execution);
    }
    remaining()?;
    captured.revalidate(source)?;
    let named = fs::symlink_metadata(&source.socket_path).map_err(|_| ServiceError::Filesystem)?;
    if !same_node(&before, &named) || cancelled.load(Ordering::Acquire) {
        return Err(ServiceError::Execution);
    }
    if let Some(usage) = delivery.receipt().token_usage {
        let total = usage
            .input_tokens
            .checked_add(usage.output_tokens)
            .ok_or(ServiceError::Execution)?;
        if usage.cached_input_tokens > usage.input_tokens
            || usage.reasoning_output_tokens > usage.output_tokens
            || total > execution.candidate.resources.tokens
        {
            return Err(ServiceError::Execution);
        }
    }
    let evidence = serde_json::json!({
        "version": 1,
        "brokerReceipt": delivery.receipt(),
        "brokerSource": source,
        "inputManifestHash": captured.request.input_manifest_hash,
        "providerExecutionRequestedByConsumer": execution_backend,
        "executionSentInThisInvocation": matches!(mode, BrokerConsumeModeV1::ExecuteOnce),
        "recoveryProtocol": "query_only_no_provider_reissue",
        "costClassification": "conservative_upper_bound",
        "costMicrousd": execution.candidate.cost_microusd,
        "scientificAcceptance": false,
        "scope": "authenticated_local_broker_result_not_production_activation"
    });
    if serde_json::to_vec(&evidence)
        .map_err(|_| ServiceError::Artifact)?
        .len() as u64
        > maximum_output_bytes
    {
        return Err(ServiceError::Artifact);
    }
    Ok((delivery.output().to_vec(), evidence))
}
