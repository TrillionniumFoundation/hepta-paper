//! Hepta-core request-capability issuance for the existing broker path.
//!
//! The service principal is the documented campaign request signer. This module
//! loads only its short-lived capability key; provider credentials remain owned
//! by the role-specific Codex principal. A request is published before broker
//! intent persistence through an atomic, no-replace file transition. Recovery
//! never mints a replacement after an execution intent exists.

use super::{
    BrokerConsumerContextV1, BrokerPreparedInputV1, BrokerPreparedSourceV1,
    broker_prepared_request_filename_v1, digest, same_file,
};
use crate::ServiceError;
use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey, pkcs8::DecodePrivateKey};
use hepta_codex_broker::{
    CapabilityPolicyV1, CapabilityTrustStoreV1, PeerIdentityV1, capability_signing_bytes,
    verify_request_capability,
};
use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy, RequestCapabilityV1,
    SandboxPolicy, SessionPolicy, Transport,
};
use hepta_control_plane::{ExecutionRequestV1, canonical_hash_v1};
use nix::{
    fcntl::{Flock, FlockArg, OFlag, RenameFlags, openat, renameat2},
    sys::stat::Mode,
    unistd::{UnlinkatFlags, unlinkat},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
};
use zeroize::Zeroizing;

const MAXIMUM_PRIVATE_KEY_BYTES: u64 = 64 * 1024;
const MAXIMUM_CAPABILITY_LIFETIME_MS: u64 = 5 * 60 * 1000;
const MAXIMUM_EVENT_COUNT: u64 = 1_000_000;
const MAXIMUM_REQUEST_BYTES: u64 = 1024 * 1024;

/// Installed hepta-core capability key and closed request limits.
///
/// The JSON contains a key path and expected public key, never private key bytes.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerRequestSignerSourceV1 {
    pub private_key_path: PathBuf,
    pub private_key_owner_uid: u32,
    pub private_key_owner_gid: u32,
    pub signer_key_id: String,
    pub public_key_base64: String,
    pub model_selector: String,
    pub maximum_lifetime_ms: u64,
    pub maximum_output_bytes: u64,
    pub maximum_event_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_token_hint: Option<u64>,
}

impl BrokerRequestSignerSourceV1 {
    pub(super) fn validate(&self) -> Result<VerifyingKey, ServiceError> {
        if !absolute_normal_path(&self.private_key_path)
            || !valid_identifier(&self.signer_key_id)
            || self.model_selector.trim().is_empty()
            || self.model_selector.len() > 256
            || self.model_selector.chars().any(char::is_control)
            || self.maximum_lifetime_ms == 0
            || self.maximum_lifetime_ms > MAXIMUM_CAPABILITY_LIFETIME_MS
            || self.maximum_output_bytes == 0
            || self.maximum_output_bytes > 64 * 1024 * 1024
            || self.maximum_event_count == 0
            || self.maximum_event_count > MAXIMUM_EVENT_COUNT
            || self.remaining_token_hint == Some(0)
        {
            return Err(ServiceError::Configuration);
        }
        let bytes = Base64UrlUnpadded::decode_vec(&self.public_key_base64)
            .map_err(|_| ServiceError::Configuration)?;
        if Base64UrlUnpadded::encode_string(&bytes) != self.public_key_base64 {
            return Err(ServiceError::Configuration);
        }
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| ServiceError::Configuration)?;
        let key = VerifyingKey::from_bytes(&bytes).map_err(|_| ServiceError::Configuration)?;
        if key.is_weak() {
            return Err(ServiceError::Configuration);
        }
        Ok(key)
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn ensure_signed_request(
    source: &BrokerPreparedSourceV1,
    signer: &BrokerRequestSignerSourceV1,
    input: &BrokerPreparedInputV1,
    execution: &ExecutionRequestV1,
    context: &BrokerConsumerContextV1,
    maximum_output_bytes: u64,
    now_unix_ms: u64,
) -> Result<(), ServiceError> {
    signer.validate()?;
    let filename = broker_prepared_request_filename_v1(&execution.attempt_id)?;
    let euid = nix::unistd::geteuid().as_raw();
    let egid = nix::unistd::getegid().as_raw();
    if euid != source.request_owner_uid
        || signer.private_key_owner_uid != euid
        || now_unix_ms == 0
        || context.writer_lease_expires_at_unix_ms <= now_unix_ms
        || signer.maximum_output_bytes > maximum_output_bytes
        || signer
            .remaining_token_hint
            .is_some_and(|tokens| tokens > execution.candidate.resources.tokens)
        || execution.candidate.cost_microusd == 0
        || execution.candidate.resources.provider_calls != 1
        || execution.candidate.resources.external_actions != 0
    {
        return Err(ServiceError::Configuration);
    }
    let deadline = now_unix_ms
        .checked_add(signer.maximum_lifetime_ms)
        .map(|value| value.min(context.writer_lease_expires_at_unix_ms))
        .filter(|value| *value > now_unix_ms)
        .ok_or(ServiceError::Execution)?;
    let directory = open_request_directory(source)?;
    let directory_lock = Flock::lock(directory, FlockArg::LockExclusiveNonblock)
        .map_err(|_| ServiceError::Execution)?;
    if directory_entry_exists(&directory_lock, &filename)? {
        let request = read_published_request(source, &directory_lock, &filename)?;
        return validate_issued_request(
            &request,
            source,
            signer,
            input,
            execution,
            context,
            now_unix_ms,
            euid,
            egid,
        );
    }
    let signing_key = load_signing_key(signer)?;
    let verifying_key = signer.validate()?;
    if signing_key.verifying_key() != verifying_key {
        return Err(ServiceError::Configuration);
    }
    let manifest =
        serde_json::to_vec(&input.input_manifest).map_err(|_| ServiceError::Configuration)?;
    let sandbox_policy = match source.role {
        AgentRole::Author | AgentRole::Repairer => SandboxPolicy::WorkspaceWrite,
        AgentRole::Reviewer | AgentRole::FormalReviewer => SandboxPolicy::ReadOnly,
    };
    let nonce_hash = canonical_hash_v1(&(
        "hepta-core-broker-request-nonce-v1",
        &execution.attempt_id,
        &execution.plan_hash,
        &signer.signer_key_id,
    ))
    .map_err(|_| ServiceError::Configuration)?;
    let nonce = format!(
        "request-{}",
        nonce_hash.as_str().trim_start_matches("sha256:")
    );
    let mut request = CodexExecutionRequestV1 {
        version: 1,
        operation_id: execution.attempt_id.clone(),
        idempotency_key: execution.plan_hash.clone(),
        campaign_id: context.campaign_id.clone(),
        node_id: execution.candidate.candidate_id.clone(),
        attempt_id: execution.attempt_id.clone(),
        lease_generation: context.lease_generation,
        campaign_revision: context.campaign_revision,
        role: source.role,
        task_kind: input.task_kind,
        codex_runtime_identity_hash: source.runtime_identity_hash.clone(),
        model_selector: signer.model_selector.clone(),
        transport: Transport::ExecJsonlV1,
        session_policy: SessionPolicy::EphemeralNewThread,
        prompt_envelope_hash: input.prompt_envelope_hash.clone(),
        input_manifest_hash: digest(&manifest)?,
        workspace_identity_hash: input.workspace_identity_hash.clone(),
        output_schema_hash: input.output_schema_hash.clone(),
        mutation_policy_hash: input.mutation_policy_hash.clone(),
        sandbox_policy,
        network_policy: NetworkPolicy::None,
        approval_policy: ApprovalPolicy::Never,
        absolute_deadline_unix_ms: deadline,
        maximum_output_bytes: signer.maximum_output_bytes,
        maximum_event_count: signer.maximum_event_count,
        maximum_cost_microusd: execution.candidate.cost_microusd,
        remaining_token_hint: signer.remaining_token_hint,
        request_capability: RequestCapabilityV1 {
            nonce,
            issued_at_unix_ms: now_unix_ms,
            expires_at_unix_ms: deadline,
            signer_key_id: signer.signer_key_id.clone(),
            peer_uid: euid,
            peer_gid: egid,
            signature_base64: "A".repeat(86),
        },
    };
    request
        .validate()
        .map_err(|_| ServiceError::Configuration)?;
    let signature = signing_key
        .sign(&capability_signing_bytes(&request).map_err(|_| ServiceError::Configuration)?);
    request.request_capability.signature_base64 =
        Base64UrlUnpadded::encode_string(&signature.to_bytes());
    validate_issued_request(
        &request,
        source,
        signer,
        input,
        execution,
        context,
        now_unix_ms,
        euid,
        egid,
    )?;
    let bytes = serde_json::to_vec(&request).map_err(|_| ServiceError::Configuration)?;
    if bytes.is_empty() || bytes.len() as u64 > MAXIMUM_REQUEST_BYTES {
        return Err(ServiceError::Configuration);
    }
    publish_request(source, &directory_lock, &filename, &bytes)?;
    validate_published_request(source, &directory_lock, &filename, &bytes)
}

#[allow(clippy::too_many_arguments)]
fn validate_issued_request(
    request: &CodexExecutionRequestV1,
    source: &BrokerPreparedSourceV1,
    signer: &BrokerRequestSignerSourceV1,
    input: &BrokerPreparedInputV1,
    execution: &ExecutionRequestV1,
    context: &BrokerConsumerContextV1,
    now_unix_ms: u64,
    euid: u32,
    egid: u32,
) -> Result<(), ServiceError> {
    request
        .validate()
        .map_err(|_| ServiceError::Configuration)?;
    let manifest =
        serde_json::to_vec(&input.input_manifest).map_err(|_| ServiceError::Configuration)?;
    let sandbox_policy = match source.role {
        AgentRole::Author | AgentRole::Repairer => SandboxPolicy::WorkspaceWrite,
        AgentRole::Reviewer | AgentRole::FormalReviewer => SandboxPolicy::ReadOnly,
    };
    let nonce_hash = canonical_hash_v1(&(
        "hepta-core-broker-request-nonce-v1",
        &execution.attempt_id,
        &execution.plan_hash,
        &signer.signer_key_id,
    ))
    .map_err(|_| ServiceError::Configuration)?;
    let expected_nonce = format!(
        "request-{}",
        nonce_hash.as_str().trim_start_matches("sha256:")
    );
    if request.operation_id != execution.attempt_id
        || request.attempt_id != execution.attempt_id
        || request.idempotency_key != execution.plan_hash
        || request.campaign_id != context.campaign_id
        || request.node_id != execution.candidate.candidate_id
        || request.lease_generation != context.lease_generation
        || request.campaign_revision != context.campaign_revision
        || request.role != source.role
        || request.task_kind != input.task_kind
        || request.codex_runtime_identity_hash != source.runtime_identity_hash
        || request.model_selector != signer.model_selector
        || request.transport != Transport::ExecJsonlV1
        || request.session_policy != SessionPolicy::EphemeralNewThread
        || request.prompt_envelope_hash != input.prompt_envelope_hash
        || request.input_manifest_hash != digest(&manifest)?
        || request.workspace_identity_hash != input.workspace_identity_hash
        || request.output_schema_hash != input.output_schema_hash
        || request.mutation_policy_hash != input.mutation_policy_hash
        || request.sandbox_policy != sandbox_policy
        || request.network_policy != NetworkPolicy::None
        || request.approval_policy != ApprovalPolicy::Never
        || request.absolute_deadline_unix_ms <= now_unix_ms
        || request.absolute_deadline_unix_ms > context.writer_lease_expires_at_unix_ms
        || request.maximum_output_bytes != signer.maximum_output_bytes
        || request.maximum_event_count != signer.maximum_event_count
        || request.maximum_cost_microusd != execution.candidate.cost_microusd
        || request.remaining_token_hint != signer.remaining_token_hint
        || request.request_capability.nonce != expected_nonce
        || request.request_capability.signer_key_id != signer.signer_key_id
        || request.request_capability.peer_uid != euid
        || request.request_capability.peer_gid != egid
        || request.request_capability.expires_at_unix_ms != request.absolute_deadline_unix_ms
    {
        return Err(ServiceError::Configuration);
    }
    let verifying_key = signer.validate()?;
    verify_request_capability(
        request,
        PeerIdentityV1 {
            pid: i32::try_from(std::process::id()).map_err(|_| ServiceError::Configuration)?,
            uid: euid,
            gid: egid,
        },
        now_unix_ms,
        CapabilityPolicyV1 {
            maximum_lifetime_ms: signer.maximum_lifetime_ms,
            maximum_future_skew_ms: 0,
        },
        &CapabilityTrustStoreV1::new([(signer.signer_key_id.clone(), verifying_key)])
            .map_err(|_| ServiceError::Configuration)?,
    )
    .map_err(|_| ServiceError::Configuration)?;
    Ok(())
}

fn load_signing_key(source: &BrokerRequestSignerSourceV1) -> Result<SigningKey, ServiceError> {
    if fs::canonicalize(&source.private_key_path).ok().as_deref()
        != Some(source.private_key_path.as_path())
    {
        return Err(ServiceError::Configuration);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(&source.private_key_path)
        .map_err(|_| ServiceError::Filesystem)?;
    let before = file.metadata().map_err(|_| ServiceError::Filesystem)?;
    if !before.is_file()
        || before.uid() != source.private_key_owner_uid
        || before.gid() != source.private_key_owner_gid
        || before.mode() & 0o077 != 0
        || before.mode() & 0o400 == 0
        || before.mode() & 0o111 != 0
        || before.nlink() != 1
        || before.len() == 0
        || before.len() > MAXIMUM_PRIVATE_KEY_BYTES
    {
        return Err(ServiceError::Configuration);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    Read::by_ref(&mut file)
        .take(MAXIMUM_PRIVATE_KEY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ServiceError::Filesystem)?;
    let after = file.metadata().map_err(|_| ServiceError::Filesystem)?;
    let named =
        fs::symlink_metadata(&source.private_key_path).map_err(|_| ServiceError::Filesystem)?;
    if bytes.len() as u64 != before.len()
        || !same_file(&before, &after)
        || !same_file(&after, &named)
    {
        return Err(ServiceError::Artifact);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| ServiceError::Configuration)?;
    SigningKey::from_pkcs8_pem(text).map_err(|_| ServiceError::Configuration)
}

fn open_request_directory(source: &BrokerPreparedSourceV1) -> Result<File, ServiceError> {
    if fs::canonicalize(&source.request_directory).ok().as_deref()
        != Some(source.request_directory.as_path())
    {
        return Err(ServiceError::Configuration);
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(&source.request_directory)
        .map_err(|_| ServiceError::Filesystem)?;
    let metadata = directory.metadata().map_err(|_| ServiceError::Filesystem)?;
    if !metadata.is_dir()
        || metadata.uid() != source.request_owner_uid
        || metadata.gid() != source.request_owner_gid
        || metadata.mode() & 0o027 != 0
    {
        return Err(ServiceError::Configuration);
    }
    Ok(directory)
}

fn directory_entry_exists(directory: &Flock<File>, name: &str) -> Result<bool, ServiceError> {
    match openat(
        directory.as_fd(),
        name,
        OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
        Mode::empty(),
    ) {
        Ok(file) => {
            drop(file);
            Ok(true)
        }
        Err(nix::errno::Errno::ENOENT) => Ok(false),
        Err(_) => Err(ServiceError::Artifact),
    }
}

fn publish_request(
    source: &BrokerPreparedSourceV1,
    directory: &Flock<File>,
    filename: &str,
    bytes: &[u8],
) -> Result<(), ServiceError> {
    if directory_entry_exists(directory, filename)? {
        return Ok(());
    }
    let temporary = format!(".{filename}.pending");
    match openat(
        directory.as_fd(),
        temporary.as_str(),
        OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
        Mode::empty(),
    ) {
        Ok(file) => {
            let file = File::from(file);
            let metadata = file.metadata().map_err(|_| ServiceError::Filesystem)?;
            if !metadata.is_file()
                || metadata.uid() != source.request_owner_uid
                || metadata.gid() != source.request_owner_gid
                || metadata.nlink() != 1
            {
                return Err(ServiceError::Artifact);
            }
            drop(file);
            unlinkat(
                directory.as_fd(),
                temporary.as_str(),
                UnlinkatFlags::NoRemoveDir,
            )
            .map_err(|_| ServiceError::Filesystem)?;
            directory.sync_all().map_err(|_| ServiceError::Filesystem)?;
        }
        Err(nix::errno::Errno::ENOENT) => {}
        Err(_) => return Err(ServiceError::Artifact),
    }
    let mut file = File::from(
        openat(
            directory.as_fd(),
            temporary.as_str(),
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| ServiceError::Filesystem)?,
    );
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| ServiceError::Filesystem)?;
    file.set_permissions(fs::Permissions::from_mode(0o400))
        .and_then(|()| file.sync_all())
        .map_err(|_| ServiceError::Filesystem)?;
    let metadata = file.metadata().map_err(|_| ServiceError::Filesystem)?;
    if metadata.uid() != source.request_owner_uid
        || metadata.gid() != source.request_owner_gid
        || metadata.mode() & 0o7777 != 0o400
        || metadata.nlink() != 1
        || metadata.len() != bytes.len() as u64
    {
        return Err(ServiceError::Artifact);
    }
    drop(file);
    match renameat2(
        directory.as_fd(),
        temporary.as_str(),
        directory.as_fd(),
        filename,
        RenameFlags::RENAME_NOREPLACE,
    ) {
        Ok(()) => {}
        Err(nix::errno::Errno::EEXIST) => {
            unlinkat(
                directory.as_fd(),
                temporary.as_str(),
                UnlinkatFlags::NoRemoveDir,
            )
            .map_err(|_| ServiceError::Filesystem)?;
        }
        Err(_) => return Err(ServiceError::Filesystem),
    }
    directory.sync_all().map_err(|_| ServiceError::Filesystem)
}

fn read_published_request_bytes(
    source: &BrokerPreparedSourceV1,
    directory: &Flock<File>,
    filename: &str,
) -> Result<Vec<u8>, ServiceError> {
    let mut file = File::from(
        openat(
            directory.as_fd(),
            filename,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| ServiceError::Filesystem)?,
    );
    let before = file.metadata().map_err(|_| ServiceError::Filesystem)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAXIMUM_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ServiceError::Filesystem)?;
    let after = file.metadata().map_err(|_| ServiceError::Filesystem)?;
    if bytes.is_empty()
        || bytes.len() as u64 != before.len()
        || before.uid() != source.request_owner_uid
        || before.gid() != source.request_owner_gid
        || before.mode() & 0o7777 != 0o400
        || before.nlink() != 1
        || !same_file(&before, &after)
    {
        return Err(ServiceError::Artifact);
    }
    Ok(bytes)
}

fn read_published_request(
    source: &BrokerPreparedSourceV1,
    directory: &Flock<File>,
    filename: &str,
) -> Result<CodexExecutionRequestV1, ServiceError> {
    let bytes = read_published_request_bytes(source, directory, filename)?;
    let request: CodexExecutionRequestV1 =
        serde_json::from_slice(&bytes).map_err(|_| ServiceError::Configuration)?;
    if serde_json::to_vec(&request).map_err(|_| ServiceError::Configuration)? != bytes {
        return Err(ServiceError::Configuration);
    }
    Ok(request)
}

fn validate_published_request(
    source: &BrokerPreparedSourceV1,
    directory: &Flock<File>,
    filename: &str,
    expected: &[u8],
) -> Result<(), ServiceError> {
    if read_published_request_bytes(source, directory, filename)? != expected {
        return Err(ServiceError::Artifact);
    }
    Ok(())
}

fn absolute_normal_path(path: &Path) -> bool {
    path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::RootDir | Component::Normal(_)))
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hepta_codex_protocol::Sha256Digest;
    use std::str::FromStr;

    #[test]
    fn nonce_is_stable_for_the_same_attempt_and_plan() {
        let plan = Sha256Digest::from_str(&format!("sha256:{}", "1".repeat(64))).unwrap();
        let first = canonical_hash_v1(&(
            "hepta-core-broker-request-nonce-v1",
            "attempt",
            &plan,
            "key",
        ))
        .unwrap();
        let second = canonical_hash_v1(&(
            "hepta-core-broker-request-nonce-v1",
            "attempt",
            &plan,
            "key",
        ))
        .unwrap();
        assert_eq!(first, second);
    }
}
