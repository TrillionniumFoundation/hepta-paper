use std::{
    os::unix::net::UnixStream,
    time::Duration,
};

use hepta_codex_protocol::{
    AgentRole, CodexExecutionRequestV1, SandboxPolicy, Sha256Digest, TaskKind,
};
use thiserror::Error;

use crate::{
    BrokerFrameError, BrokerFramePolicyV1, CapabilityPolicyV1,
    CapabilityTrustStoreV1, CapabilityVerificationError, PeerAuthorizationError,
    PeerIdentityV1, PeerPolicyV1, VerifiedCapabilityV1, inspect_peer_identity,
    read_request_frame, verify_request_capability,
};

const HARD_MAXIMUM_READ_TIMEOUT_MS: u64 = 30_000;

/// Exact role and sandbox surface accepted by one role-specific broker instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerRolePolicyV1 {
    pub role: AgentRole,
    pub sandbox_policy: SandboxPolicy,
    pub runtime_identity_hash: Sha256Digest,
}

impl BrokerRolePolicyV1 {
    /// Author broker: draft/revision tasks with a writable attempt workspace.
    #[must_use]
    pub fn author(runtime_identity_hash: Sha256Digest) -> Self {
        Self {
            role: AgentRole::Author,
            sandbox_policy: SandboxPolicy::WorkspaceWrite,
            runtime_identity_hash,
        }
    }

    /// Reviewer broker: one-shot review tasks over a read-only bundle.
    #[must_use]
    pub fn reviewer(runtime_identity_hash: Sha256Digest) -> Self {
        Self {
            role: AgentRole::Reviewer,
            sandbox_policy: SandboxPolicy::ReadOnly,
            runtime_identity_hash,
        }
    }

    /// Formal-review broker: one-shot formal review over immutable evidence.
    #[must_use]
    pub fn formal_reviewer(runtime_identity_hash: Sha256Digest) -> Self {
        Self {
            role: AgentRole::FormalReviewer,
            sandbox_policy: SandboxPolicy::ReadOnly,
            runtime_identity_hash,
        }
    }

    /// Repair broker: bounded code/LaTeX repair with workspace write authority.
    #[must_use]
    pub fn repairer(runtime_identity_hash: Sha256Digest) -> Self {
        Self {
            role: AgentRole::Repairer,
            sandbox_policy: SandboxPolicy::WorkspaceWrite,
            runtime_identity_hash,
        }
    }

    fn authorize(&self, request: &CodexExecutionRequestV1) -> Result<(), AdmissionError> {
        if request.role != self.role || request.sandbox_policy != self.sandbox_policy {
            return Err(AdmissionError::RoleSurfaceMismatch);
        }
        if request.codex_runtime_identity_hash != self.runtime_identity_hash {
            return Err(AdmissionError::RuntimeSurfaceMismatch);
        }
        let task_allowed = matches!(
            (self.role, request.task_kind),
            (AgentRole::Author, TaskKind::Draft | TaskKind::Revise)
                | (AgentRole::Reviewer, TaskKind::Review)
                | (AgentRole::FormalReviewer, TaskKind::FormalReview)
                | (AgentRole::Repairer, TaskKind::CodeRepair | TaskKind::LatexRepair)
        );
        if !task_allowed {
            return Err(AdmissionError::RoleSurfaceMismatch);
        }
        Ok(())
    }
}

/// Bounded admission policy applied before any broker state is reserved.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdmissionPolicyV1 {
    pub read_timeout_ms: u64,
    pub frame: BrokerFramePolicyV1,
    pub capability: CapabilityPolicyV1,
    pub role: BrokerRolePolicyV1,
}

impl AdmissionPolicyV1 {
    /// Strict role-specific policy with bounded framing, time, and signature checks.
    #[must_use]
    pub fn for_role(role: BrokerRolePolicyV1) -> Self {
        Self {
            read_timeout_ms: 5_000,
            frame: BrokerFramePolicyV1 {
                maximum_payload_bytes: 1024 * 1024,
            },
            capability: CapabilityPolicyV1 {
                maximum_lifetime_ms: 60_000,
                maximum_future_skew_ms: 5_000,
            },
            role,
        }
    }

    fn validate(self) -> Result<Self, AdmissionError> {
        if self.read_timeout_ms == 0 || self.read_timeout_ms > HARD_MAXIMUM_READ_TIMEOUT_MS {
            return Err(AdmissionError::InvalidPolicy);
        }
        Ok(self)
    }
}

/// Kernel-authenticated, signature-verified request ready for durable reservation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthenticatedBrokerRequestV1 {
    pub(crate) request: CodexExecutionRequestV1,
    pub(crate) request_payload: Vec<u8>,
    pub(crate) request_hash: Sha256Digest,
    pub(crate) peer: PeerIdentityV1,
    pub(crate) capability: VerifiedCapabilityV1,
}

impl AuthenticatedBrokerRequestV1 {
    #[must_use]
    pub fn request(&self) -> &CodexExecutionRequestV1 {
        &self.request
    }

    #[must_use]
    pub fn request_hash(&self) -> &Sha256Digest {
        &self.request_hash
    }

    #[must_use]
    pub fn peer(&self) -> PeerIdentityV1 {
        self.peer
    }

    #[must_use]
    pub fn capability(&self) -> &VerifiedCapabilityV1 {
        &self.capability
    }
}

/// Authenticates a connected Unix-stream peer before accepting a framed request.
pub fn admit_unix_stream(
    stream: &UnixStream,
    peer_policy: &PeerPolicyV1,
    trust_store: &CapabilityTrustStoreV1,
    now_unix_ms: u64,
    policy: AdmissionPolicyV1,
) -> Result<AuthenticatedBrokerRequestV1, AdmissionError> {
    let policy = policy.validate()?;
    let peer = inspect_peer_identity(stream).map_err(AdmissionError::Peer)?;
    peer_policy.authorize(peer).map_err(AdmissionError::Peer)?;
    stream
        .set_read_timeout(Some(Duration::from_millis(policy.read_timeout_ms)))
        .map_err(|error| AdmissionError::SocketConfiguration(error.kind()))?;
    let mut reader = stream;
    let frame = read_request_frame(&mut reader, policy.frame).map_err(AdmissionError::Frame)?;
    policy.role.authorize(&frame.request)?;
    let capability = verify_request_capability(
        &frame.request,
        peer,
        now_unix_ms,
        policy.capability,
        trust_store,
    )
    .map_err(AdmissionError::Capability)?;
    Ok(AuthenticatedBrokerRequestV1 {
        request: frame.request,
        request_payload: frame.payload,
        request_hash: frame.payload_hash,
        peer,
        capability,
    })
}

/// Peer, frame, capability, or socket-policy rejection.
#[derive(Debug, Error)]
pub enum AdmissionError {
    #[error("admission policy is invalid")]
    InvalidPolicy,
    #[error("peer admission failed: {0}")]
    Peer(PeerAuthorizationError),
    #[error("frame admission failed: {0}")]
    Frame(BrokerFrameError),
    #[error("capability admission failed: {0}")]
    Capability(CapabilityVerificationError),
    #[error("request role/task/sandbox surface does not match this broker instance")]
    RoleSurfaceMismatch,
    #[error("request runtime identity does not match this broker instance")]
    RuntimeSurfaceMismatch,
    #[error("socket timeout configuration failed: {0:?}")]
    SocketConfiguration(std::io::ErrorKind),
}
