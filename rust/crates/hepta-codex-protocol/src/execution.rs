use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::Sha256Digest;

const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_MODEL_SELECTOR_BYTES: usize = 256;
const MAX_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EVENT_COUNT: u64 = 1_000_000;

/// Runtime role authorized for an execution.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Author,
    Reviewer,
    FormalReviewer,
    Repairer,
}

/// Business task authorized for an execution.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Draft,
    Revise,
    Review,
    FormalReview,
    CodeRepair,
}

/// Codex transport qualified by protocol version 1.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Transport {
    ExecJsonlV1,
}

/// Conversation persistence policy qualified by protocol version 1.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionPolicy {
    EphemeralNewThread,
}

/// Filesystem authority delegated to the Codex process.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxPolicy {
    ReadOnly,
    WorkspaceWrite,
}

/// Provider-visible network authority. V1 intentionally has no enabled mode.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkPolicy {
    None,
}

/// Interactive approval authority. V1 forbids interactive elevation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalPolicy {
    Never,
}

/// A short-lived local capability attached to a broker request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestCapabilityV1 {
    pub nonce: String,
    pub expires_at_unix_ms: u64,
    pub signer_key_id: String,
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
        validate_nonempty_bounded(
            "requestCapability.signatureBase64",
            &self.request_capability.signature_base64,
            4096,
        )?;
        validate_nonempty_bounded(
            "modelSelector",
            &self.model_selector,
            MAX_MODEL_SELECTOR_BYTES,
        )?;
        if self.lease_generation == 0 {
            return Err(ProtocolValidationError::NonPositive("leaseGeneration"));
        }
        if self.absolute_deadline_unix_ms == 0 {
            return Err(ProtocolValidationError::NonPositive(
                "absoluteDeadlineUnixMs",
            ));
        }
        if self.request_capability.expires_at_unix_ms == 0 {
            return Err(ProtocolValidationError::NonPositive(
                "requestCapability.expiresAtUnixMs",
            ));
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
            return Err(ProtocolValidationError::NonPositive(
                "maximumCostMicrousd",
            ));
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
            | (AgentRole::Repairer, TaskKind::CodeRepair)
    );
    if !task_allowed {
        return Err(ProtocolValidationError::RoleTaskMismatch);
    }
    let sandbox_allowed = matches!(
        (role, sandbox_policy),
        (AgentRole::Author | AgentRole::Repairer, SandboxPolicy::WorkspaceWrite)
            | (
                AgentRole::Reviewer | AgentRole::FormalReviewer,
                SandboxPolicy::ReadOnly
            )
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
    if value.trim().is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(ProtocolValidationError::InvalidText(field));
    }
    Ok(())
}

/// Provider token usage reported by a terminal event.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
}

/// Terminal event observed in the JSONL stream.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalEventKind {
    TurnCompleted,
    TurnFailed,
}

/// Final-output schema verification result.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputSchemaValidationStatus {
    NotAttempted,
    Valid,
    Invalid,
}

/// Workspace mutation verification result.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationValidationStatus {
    NotAttempted,
    NotApplicable,
    Valid,
    Violated,
}

/// Confidence in whether the provider operation occurred and how it ended.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeCertainty {
    Certain,
    Ambiguous,
}

/// Safe retry treatment after this receipt.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryDisposition {
    SameOperationSafe,
    NewAttemptRequired,
    Never,
}

/// How token usage was established.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageClassification {
    Measured,
    Unknown,
    NotReported,
}

/// How provider cost was established.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CostClassification {
    Measured,
    ConservativeUpperBound,
    Unknown,
}

/// Broker evidence returned to the control plane after execution.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexExecutionReceiptV1 {
    pub version: u16,
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub broker_generation: u64,
    pub runtime_identity_hash: Sha256Digest,
    pub process_spawned: bool,
    pub process_id: Option<u32>,
    pub process_start_identity_hash: Option<Sha256Digest>,
    pub started_at_unix_ms: u64,
    pub finished_at_unix_ms: u64,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub event_stream_hash: Option<Sha256Digest>,
    pub event_count: u64,
    pub thread_id: Option<String>,
    pub terminal_event_kind: Option<TerminalEventKind>,
    pub final_output_hash: Option<Sha256Digest>,
    pub output_schema_validation_status: OutputSchemaValidationStatus,
    pub workspace_before_hash: Option<Sha256Digest>,
    pub workspace_after_hash: Option<Sha256Digest>,
    pub mutation_manifest_hash: Option<Sha256Digest>,
    pub mutation_validation_status: MutationValidationStatus,
    pub usage: Option<TokenUsage>,
    pub usage_classification: UsageClassification,
    pub cost_microusd: Option<u64>,
    pub cost_classification: CostClassification,
    pub provider_action_may_have_started: bool,
    pub outcome_certainty: OutcomeCertainty,
    pub retry_disposition: RetryDisposition,
}

impl CodexExecutionReceiptV1 {
    /// Validates cross-field evidence invariants.
    pub fn validate(&self) -> Result<(), ProtocolValidationError> {
        if self.version != 1 {
            return Err(ProtocolValidationError::UnsupportedVersion(self.version));
        }
        validate_identifier("operationId", &self.operation_id)?;
        if self.broker_generation == 0 {
            return Err(ProtocolValidationError::NonPositive("brokerGeneration"));
        }
        if self.finished_at_unix_ms < self.started_at_unix_ms {
            return Err(ProtocolValidationError::InvalidTimeOrder);
        }
        if !self.process_spawned {
            if self.process_id.is_some()
                || self.process_start_identity_hash.is_some()
                || self.provider_action_may_have_started
                || self.event_stream_hash.is_some()
                || self.event_count != 0
                || self.terminal_event_kind.is_some()
            {
                return Err(ProtocolValidationError::UnspawnedProcessHasEvidence);
            }
        } else if self.process_id.is_none() || self.process_start_identity_hash.is_none() {
            return Err(ProtocolValidationError::SpawnedProcessMissingIdentity);
        }
        if self.event_count == 0 && self.event_stream_hash.is_some() {
            return Err(ProtocolValidationError::EventEvidenceMismatch);
        }
        if self.event_count > 0 && self.event_stream_hash.is_none() {
            return Err(ProtocolValidationError::EventEvidenceMismatch);
        }
        if self.terminal_event_kind.is_some()
            && (!self.process_spawned || self.event_count == 0 || self.thread_id.is_none())
        {
            return Err(ProtocolValidationError::TerminalEvidenceIncomplete);
        }
        if self.output_schema_validation_status == OutputSchemaValidationStatus::Valid
            && self.final_output_hash.is_none()
        {
            return Err(ProtocolValidationError::ValidOutputMissingHash);
        }
        if self.usage_classification == UsageClassification::Measured && self.usage.is_none() {
            return Err(ProtocolValidationError::MeasuredUsageMissing);
        }
        if self.cost_classification == CostClassification::Measured && self.cost_microusd.is_none() {
            return Err(ProtocolValidationError::MeasuredCostMissing);
        }
        if self.outcome_certainty == OutcomeCertainty::Ambiguous {
            if !self.provider_action_may_have_started
                || self.retry_disposition != RetryDisposition::NewAttemptRequired
            {
                return Err(ProtocolValidationError::AmbiguousOutcomeRetryUnsafe);
            }
        }
        Ok(())
    }
}

/// Semantic request or receipt validation failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ProtocolValidationError {
    #[error("unsupported protocol version: {0}")]
    UnsupportedVersion(u16),
    #[error("invalid bounded identifier: {0}")]
    InvalidIdentifier(&'static str),
    #[error("invalid bounded text field: {0}")]
    InvalidText(&'static str),
    #[error("field must be positive: {0}")]
    NonPositive(&'static str),
    #[error("limit {field} is outside 1..={maximum}")]
    LimitOutOfRange {
        field: &'static str,
        maximum: u64,
    },
    #[error("request capability expiry exceeds the request deadline")]
    CapabilityOutlivesRequest,
    #[error("agent role is not authorized for the selected task kind")]
    RoleTaskMismatch,
    #[error("agent role is not authorized for the selected sandbox")]
    RoleSandboxMismatch,
    #[error("receipt finish time precedes start time")]
    InvalidTimeOrder,
    #[error("an unspawned process cannot carry provider or event evidence")]
    UnspawnedProcessHasEvidence,
    #[error("a spawned process must carry a pid and process-start identity")]
    SpawnedProcessMissingIdentity,
    #[error("event count and event-stream hash are inconsistent")]
    EventEvidenceMismatch,
    #[error("terminal evidence is incomplete")]
    TerminalEvidenceIncomplete,
    #[error("schema-valid output must carry a final-output hash")]
    ValidOutputMissingHash,
    #[error("measured usage classification requires token usage")]
    MeasuredUsageMissing,
    #[error("measured cost classification requires a cost value")]
    MeasuredCostMissing,
    #[error("an ambiguous provider outcome must require a new attempt")]
    AmbiguousOutcomeRetryUnsafe,
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::*;

    fn digest(byte: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
            .expect("test digest")
    }

    fn request(role: AgentRole, task_kind: TaskKind, sandbox: SandboxPolicy) -> CodexExecutionRequestV1 {
        CodexExecutionRequestV1 {
            version: 1,
            operation_id: "operation-1".to_owned(),
            idempotency_key: digest('1'),
            campaign_id: "campaign-1".to_owned(),
            node_id: "node-1".to_owned(),
            attempt_id: "attempt-1".to_owned(),
            lease_generation: 1,
            campaign_revision: 0,
            role,
            task_kind,
            codex_runtime_identity_hash: digest('2'),
            model_selector: "qualified-model".to_owned(),
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
                nonce: "nonce-1".to_owned(),
                expires_at_unix_ms: 9_000,
                signer_key_id: "broker-key-1".to_owned(),
                signature_base64: "AA==".to_owned(),
            },
        }
    }

    #[test]
    fn accepts_author_and_reviewer_profiles() {
        assert!(request(AgentRole::Author, TaskKind::Draft, SandboxPolicy::WorkspaceWrite)
            .validate()
            .is_ok());
        assert!(request(AgentRole::Reviewer, TaskKind::Review, SandboxPolicy::ReadOnly)
            .validate()
            .is_ok());
    }

    #[test]
    fn rejects_reviewer_write_authority() {
        assert_eq!(
            request(
                AgentRole::Reviewer,
                TaskKind::Review,
                SandboxPolicy::WorkspaceWrite,
            )
            .validate(),
            Err(ProtocolValidationError::RoleSandboxMismatch)
        );
    }

    #[test]
    fn rejects_role_task_confusion() {
        assert_eq!(
            request(AgentRole::Author, TaskKind::Review, SandboxPolicy::WorkspaceWrite)
                .validate(),
            Err(ProtocolValidationError::RoleTaskMismatch)
        );
    }
}
