use serde::{Deserialize, Serialize};

use crate::Sha256Digest;

use super::{
    AgentRole, ApprovalPolicy, NetworkPolicy, ProtocolValidationError, SandboxPolicy,
    SessionPolicy, TaskKind, Transport,
};

const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_MODEL_SELECTOR_BYTES: usize = 256;
const MAX_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EVENT_COUNT: u64 = 1_000_000;

/// A short-lived local capability attached to a broker request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestCapabilityV1 {
    pub nonce: String,
    pub issued_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub signer_key_id: String,
    pub peer_uid: u32,
    pub peer_gid: u32,
    pub signature_base64: String,
}

/// Fully bound request sent from the Rust control plane to a Codex broker.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexExecutionRequestV1 {
    pub version: u16,
    pub operation_id: String,
    pub idempotency_key: Sha256Digest,
    pub campaign_id: String,
    pub node_id: String,
    pub attempt_id: String,
    pub lease_generation: u64,
    pub campaign_revision: u64,
    pub role: AgentRole,
    pub task_kind: TaskKind,
    pub codex_runtime_identity_hash: Sha256Digest,
    pub model_selector: String,
    pub transport: Transport,
    pub session_policy: SessionPolicy,
    pub prompt_envelope_hash: Sha256Digest,
    pub input_manifest_hash: Sha256Digest,
    pub workspace_identity_hash: Sha256Digest,
    pub output_schema_hash: Sha256Digest,
    pub mutation_policy_hash: Sha256Digest,
    pub sandbox_policy: SandboxPolicy,
    pub network_policy: NetworkPolicy,
    pub approval_policy: ApprovalPolicy,
    pub absolute_deadline_unix_ms: u64,
    pub maximum_output_bytes: u64,
    pub maximum_event_count: u64,
    pub maximum_cost_microusd: u64,
    pub remaining_token_hint: Option<u64>,
    pub request_capability: RequestCapabilityV1,
}

impl CodexExecutionRequestV1 {
    /// Validates semantic invariants not expressible through serde alone.
    pub fn validate(&self) -> Result<(), ProtocolValidationError> {
        if self.version != 1 {
            return Err(ProtocolValidationError::UnsupportedVersion(self.version));
        }
        validate_identifier("operationId", &self.operation_id)?;
        validate_identifier("campaignId", &self.campaign_id)?;
        validate_identifier("nodeId", &self.node_id)?;
        validate_identifier("attemptId", &self.attempt_id)?;
        validate_identifier("requestCapability.nonce", &self.request_capability.nonce)?;
        validate_identifier(
            "requestCapability.signerKeyId",
            &self.request_capability.signer_key_id,
        )?;
        validate_signature_text(&self.request_capability.signature_base64)?;
        validate_nonempty_bounded(
            "modelSelector",
            &self.model_selector,
            MAX_MODEL_SELECTOR_BYTES,
        )?;
        if self.lease_generation == 0 {
            return Err(ProtocolValidationError::NonPositive("leaseGeneration"));
        }
        if self.absolute_deadline_unix_ms == 0 {
            return Err(ProtocolValidationError::NonPositive("absoluteDeadlineUnixMs"));
        }
        if self.request_capability.issued_at_unix_ms == 0 {
            return Err(ProtocolValidationError::NonPositive(
                "requestCapability.issuedAtUnixMs",
            ));
        }
        if self.request_capability.expires_at_unix_ms == 0 {
            return Err(ProtocolValidationError::NonPositive(
                "requestCapability.expiresAtUnixMs",
            ));
        }
        if self.request_capability.expires_at_unix_ms
            <= self.request_capability.issued_at_unix_ms
        {
            return Err(ProtocolValidationError::InvalidCapabilityTimeOrder);
        }
        if self.request_capability.expires_at_unix_ms > self.absolute_deadline_unix_ms {
            return Err(ProtocolValidationError::CapabilityOutlivesRequest);
        }
        if self.maximum_output_bytes == 0 || self.maximum_output_bytes > MAX_OUTPUT_BYTES {
            return Err(ProtocolValidationError::LimitOutOfRange {
                field: "maximumOutputBytes",
                maximum: MAX_OUTPUT_BYTES,
            });
        }
        if self.maximum_event_count == 0 || self.maximum_event_count > MAX_EVENT_COUNT {
            return Err(ProtocolValidationError::LimitOutOfRange {
                field: "maximumEventCount",
                maximum: MAX_EVENT_COUNT,
            });
        }
        if self.maximum_cost_microusd == 0 {
            return Err(ProtocolValidationError::NonPositive("maximumCostMicrousd"));
        }
        if self.remaining_token_hint == Some(0) {
            return Err(ProtocolValidationError::NonPositive("remainingTokenHint"));
        }
        validate_role_task_and_sandbox(self.role, self.task_kind, self.sandbox_policy)
    }
}

fn validate_role_task_and_sandbox(
    role: AgentRole,
    task_kind: TaskKind,
    sandbox_policy: SandboxPolicy,
) -> Result<(), ProtocolValidationError> {
    let task_allowed = matches!(
        (role, task_kind),
        (AgentRole::Author, TaskKind::Draft | TaskKind::Revise)
            | (AgentRole::Reviewer, TaskKind::Review)
            | (AgentRole::FormalReviewer, TaskKind::FormalReview)
            | (AgentRole::Repairer, TaskKind::CodeRepair | TaskKind::LatexRepair)
    );
    if !task_allowed {
        return Err(ProtocolValidationError::RoleTaskMismatch);
    }
    let sandbox_allowed = matches!(
        (role, sandbox_policy),
        (AgentRole::Author | AgentRole::Repairer, SandboxPolicy::WorkspaceWrite)
            | (AgentRole::Reviewer | AgentRole::FormalReviewer, SandboxPolicy::ReadOnly)
    );
    if !sandbox_allowed {
        return Err(ProtocolValidationError::RoleSandboxMismatch);
    }
    Ok(())
}

fn validate_identifier(field: &'static str, value: &str) -> Result<(), ProtocolValidationError> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES {
        return Err(ProtocolValidationError::InvalidIdentifier(field));
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return Err(ProtocolValidationError::InvalidIdentifier(field));
    };
    if !first.is_ascii_alphanumeric()
        || !bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
        })
    {
        return Err(ProtocolValidationError::InvalidIdentifier(field));
    }
    Ok(())
}

fn validate_nonempty_bounded(
    field: &'static str,
    value: &str,
    maximum: usize,
) -> Result<(), ProtocolValidationError> {
    if value.trim().is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(ProtocolValidationError::InvalidText(field));
    }
    Ok(())
}

fn validate_signature_text(value: &str) -> Result<(), ProtocolValidationError> {
    // Ed25519 signatures are exactly 64 bytes, encoded as 86 URL-safe,
    // unpadded Base64 characters. Shape validation is intentionally performed
    // before the broker allocates decoder state; cryptographic validation is
    // still mandatory at admission.
    if value.len() != 86
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ProtocolValidationError::InvalidText(
            "requestCapability.signatureBase64",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use crate::Sha256Digest;

    use super::*;

    fn digest(byte: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
            .expect("test digest")
    }

    fn request(
        role: AgentRole,
        task_kind: TaskKind,
        sandbox: SandboxPolicy,
    ) -> CodexExecutionRequestV1 {
        CodexExecutionRequestV1 {
            version: 1,
            operation_id: "operation-1".into(),
            idempotency_key: digest('1'),
            campaign_id: "campaign-1".into(),
            node_id: "node-1".into(),
            attempt_id: "attempt-1".into(),
            lease_generation: 1,
            campaign_revision: 0,
            role,
            task_kind,
            codex_runtime_identity_hash: digest('2'),
            model_selector: "qualified-model".into(),
            transport: Transport::ExecJsonlV1,
            session_policy: SessionPolicy::EphemeralNewThread,
            prompt_envelope_hash: digest('3'),
            input_manifest_hash: digest('4'),
            workspace_identity_hash: digest('5'),
            output_schema_hash: digest('6'),
            mutation_policy_hash: digest('7'),
            sandbox_policy: sandbox,
            network_policy: NetworkPolicy::None,
            approval_policy: ApprovalPolicy::Never,
            absolute_deadline_unix_ms: 10_000,
            maximum_output_bytes: 1024,
            maximum_event_count: 100,
            maximum_cost_microusd: 1_000_000,
            remaining_token_hint: Some(10_000),
            request_capability: RequestCapabilityV1 {
                nonce: "nonce-1".into(),
                issued_at_unix_ms: 8_000,
                expires_at_unix_ms: 9_000,
                signer_key_id: "broker-key-1".into(),
                peer_uid: 1000,
                peer_gid: 1000,
                signature_base64: "A".repeat(86),
            },
        }
    }

    #[test]
    fn capability_signature_and_time_shape_are_fail_closed() {
        let mut invalid_signature = request(
            AgentRole::Author,
            TaskKind::Draft,
            SandboxPolicy::WorkspaceWrite,
        );
        invalid_signature.request_capability.signature_base64 = "AA==".into();
        assert_eq!(
            invalid_signature.validate(),
            Err(ProtocolValidationError::InvalidText(
                "requestCapability.signatureBase64",
            )),
        );

        let mut invalid_time = request(
            AgentRole::Author,
            TaskKind::Draft,
            SandboxPolicy::WorkspaceWrite,
        );
        invalid_time.request_capability.expires_at_unix_ms =
            invalid_time.request_capability.issued_at_unix_ms;
        assert_eq!(
            invalid_time.validate(),
            Err(ProtocolValidationError::InvalidCapabilityTimeOrder),
        );
    }

    #[test]
    fn role_profiles_are_fail_closed() {
        assert!(
            request(
                AgentRole::Author,
                TaskKind::Draft,
                SandboxPolicy::WorkspaceWrite,
            )
            .validate()
            .is_ok()
        );
        assert!(
            request(
                AgentRole::Repairer,
                TaskKind::LatexRepair,
                SandboxPolicy::WorkspaceWrite,
            )
            .validate()
            .is_ok()
        );
        assert_eq!(
            request(
                AgentRole::Reviewer,
                TaskKind::Review,
                SandboxPolicy::WorkspaceWrite,
            )
            .validate(),
            Err(ProtocolValidationError::RoleSandboxMismatch),
        );
    }

    #[test]
    fn capability_times_must_be_strictly_ordered() {
        let mut value = request(
            AgentRole::Reviewer,
            TaskKind::Review,
            SandboxPolicy::ReadOnly,
        );
        value.request_capability.issued_at_unix_ms = 9_000;
        assert_eq!(
            value.validate(),
            Err(ProtocolValidationError::InvalidCapabilityTimeOrder),
        );
    }
}
