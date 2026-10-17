use serde::{Deserialize, Serialize};

use crate::Sha256Digest;

use super::{
    CostClassification, MutationValidationStatus, OutcomeCertainty, OutputSchemaValidationStatus,
    ProtocolValidationError, RetryDisposition, TerminalEventKind, TokenUsage, UsageClassification,
};

const MAX_SIGNAL_BYTES: usize = 64;
const MAX_THREAD_ID_BYTES: usize = 256;
const MAX_EVENT_COUNT: u64 = 1_000_000;

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
    /// Validates cross-field process, provider, workspace, accounting and retry evidence.
    pub fn validate(&self) -> Result<(), ProtocolValidationError> {
        if self.version != 1 {
            return Err(ProtocolValidationError::UnsupportedVersion(self.version));
        }
        validate_identifier("operationId", &self.operation_id)?;
        validate_optional_text("signal", self.signal.as_deref(), MAX_SIGNAL_BYTES)?;
        validate_optional_text("threadId", self.thread_id.as_deref(), MAX_THREAD_ID_BYTES)?;
        if self.broker_generation == 0 {
            return Err(ProtocolValidationError::NonPositive("brokerGeneration"));
        }
        if self.started_at_unix_ms == 0 {
            return Err(ProtocolValidationError::NonPositive("startedAtUnixMs"));
        }
        if self.finished_at_unix_ms == 0 {
            return Err(ProtocolValidationError::NonPositive("finishedAtUnixMs"));
        }
        if self.finished_at_unix_ms < self.started_at_unix_ms {
            return Err(ProtocolValidationError::InvalidTimeOrder);
        }
        if self.exit_code.is_some() && self.signal.is_some() {
            return Err(ProtocolValidationError::ConflictingProcessOutcome);
        }
        if self.event_count > MAX_EVENT_COUNT {
            return Err(ProtocolValidationError::LimitOutOfRange {
                field: "eventCount",
                maximum: MAX_EVENT_COUNT,
            });
        }
        self.validate_process_evidence()?;
        self.validate_provider_evidence()?;
        self.validate_output_and_mutation()?;
        self.validate_accounting()?;
        self.validate_retry()?;
        Ok(())
    }

    fn validate_process_evidence(&self) -> Result<(), ProtocolValidationError> {
        if !self.process_spawned {
            if self.process_id.is_some()
                || self.process_start_identity_hash.is_some()
                || self.provider_action_may_have_started
                || self.exit_code.is_some()
                || self.signal.is_some()
                || self.event_stream_hash.is_some()
                || self.event_count != 0
                || self.thread_id.is_some()
                || self.terminal_event_kind.is_some()
                || self.final_output_hash.is_some()
                || self.output_schema_validation_status
                    != OutputSchemaValidationStatus::NotAttempted
                || self.workspace_before_hash.is_some()
                || self.workspace_after_hash.is_some()
                || self.mutation_manifest_hash.is_some()
                || self.mutation_validation_status != MutationValidationStatus::NotAttempted
                || self.usage.is_some()
                || self.usage_classification != UsageClassification::NotApplicable
                || self.cost_microusd.is_some()
                || self.cost_classification != CostClassification::NotIncurred
            {
                return Err(ProtocolValidationError::UnspawnedProcessHasEvidence);
            }
            return Ok(());
        }
        if self.process_id.is_none() || self.process_start_identity_hash.is_none() {
            return Err(ProtocolValidationError::SpawnedProcessMissingIdentity);
        }
        if self.process_id == Some(0) {
            return Err(ProtocolValidationError::ProcessIdZero);
        }
        if self.outcome_certainty == OutcomeCertainty::Certain
            && self.exit_code.is_none()
            && self.signal.is_none()
        {
            return Err(ProtocolValidationError::CertainProcessOutcomeMissing);
        }
        Ok(())
    }

    fn validate_provider_evidence(&self) -> Result<(), ProtocolValidationError> {
        if !self.provider_action_may_have_started
            && (self.event_stream_hash.is_some()
                || self.event_count != 0
                || self.thread_id.is_some()
                || self.terminal_event_kind.is_some()
                || self.final_output_hash.is_some()
                || self.output_schema_validation_status
                    != OutputSchemaValidationStatus::NotAttempted
                || self.usage.is_some())
        {
            return Err(ProtocolValidationError::ProviderEvidenceWithoutPossibleAction);
        }
        if (self.event_count == 0) != self.event_stream_hash.is_none() {
            return Err(ProtocolValidationError::EventEvidenceMismatch);
        }
        if self.terminal_event_kind.is_some()
            && (!self.process_spawned
                || !self.provider_action_may_have_started
                || self.event_count == 0
                || self.thread_id.is_none())
        {
            return Err(ProtocolValidationError::TerminalEvidenceIncomplete);
        }
        if self.usage.is_some() && self.terminal_event_kind.is_none() {
            return Err(ProtocolValidationError::UsageWithoutTerminalEvent);
        }
        Ok(())
    }

    fn validate_output_and_mutation(&self) -> Result<(), ProtocolValidationError> {
        if self.output_schema_validation_status == OutputSchemaValidationStatus::Valid {
            if self.final_output_hash.is_none() {
                return Err(ProtocolValidationError::ValidOutputMissingHash);
            }
            if self.terminal_event_kind != Some(TerminalEventKind::TurnCompleted) {
                return Err(ProtocolValidationError::ValidOutputWithoutSuccessfulTerminal);
            }
            if self.exit_code != Some(0) || self.signal.is_some() {
                return Err(ProtocolValidationError::ValidOutputWithoutSuccessfulProcess);
            }
        }
        if matches!(
            self.mutation_validation_status,
            MutationValidationStatus::Valid | MutationValidationStatus::Violated
        ) && (self.workspace_before_hash.is_none()
            || self.workspace_after_hash.is_none()
            || self.mutation_manifest_hash.is_none())
        {
            return Err(ProtocolValidationError::MutationEvidenceIncomplete);
        }
        Ok(())
    }

    fn validate_accounting(&self) -> Result<(), ProtocolValidationError> {
        let usage_valid = match self.usage_classification {
            UsageClassification::Measured => self.usage.is_some(),
            UsageClassification::NotReported => {
                self.usage.is_none() && self.terminal_event_kind.is_some()
            }
            UsageClassification::Unknown => {
                self.usage.is_none()
                    && self.provider_action_may_have_started
                    && self.terminal_event_kind.is_none()
            }
            UsageClassification::NotApplicable => {
                self.usage.is_none() && !self.provider_action_may_have_started
            }
        };
        if !usage_valid {
            return Err(ProtocolValidationError::UsageClassificationMismatch);
        }
        let cost_valid = match self.cost_classification {
            CostClassification::Measured | CostClassification::ConservativeUpperBound => {
                self.cost_microusd.is_some() && self.provider_action_may_have_started
            }
            CostClassification::Unknown => {
                self.cost_microusd.is_none() && self.provider_action_may_have_started
            }
            CostClassification::NotIncurred => {
                self.cost_microusd.is_none() && !self.provider_action_may_have_started
            }
        };
        if !cost_valid {
            return Err(ProtocolValidationError::CostClassificationMismatch);
        }
        Ok(())
    }

    fn validate_retry(&self) -> Result<(), ProtocolValidationError> {
        if self.outcome_certainty == OutcomeCertainty::Ambiguous
            && (!self.provider_action_may_have_started
                || self.retry_disposition != RetryDisposition::NewAttemptRequired)
        {
            return Err(ProtocolValidationError::AmbiguousOutcomeRetryUnsafe);
        }
        let same_attempt_workspace_safe = !self.process_spawned
            || (self.workspace_before_hash.is_some()
                && self.workspace_before_hash == self.workspace_after_hash
                && self.mutation_manifest_hash.is_some()
                && self.mutation_validation_status == MutationValidationStatus::Valid);
        if self.retry_disposition == RetryDisposition::NewOperationSameAttemptRequired
            && (self.provider_action_may_have_started
                || self.outcome_certainty != OutcomeCertainty::Certain
                || !same_attempt_workspace_safe)
        {
            return Err(ProtocolValidationError::NewOperationRetryUnsafe);
        }
        if self.retry_disposition == RetryDisposition::NewAttemptRequired
            && !self.provider_action_may_have_started
        {
            return Err(ProtocolValidationError::NewAttemptRetryUnnecessary);
        }
        Ok(())
    }
}

fn validate_identifier(field: &'static str, value: &str) -> Result<(), ProtocolValidationError> {
    if value.is_empty() || value.len() > 128 {
        return Err(ProtocolValidationError::InvalidIdentifier(field));
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return Err(ProtocolValidationError::InvalidIdentifier(field));
    };
    if !first.is_ascii_alphanumeric()
        || !bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
    {
        return Err(ProtocolValidationError::InvalidIdentifier(field));
    }
    Ok(())
}

fn validate_optional_text(
    field: &'static str,
    value: Option<&str>,
    maximum: usize,
) -> Result<(), ProtocolValidationError> {
    if let Some(value) = value
        && (value.trim().is_empty() || value.len() > maximum || value.chars().any(char::is_control))
    {
        return Err(ProtocolValidationError::InvalidText(field));
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

    fn pre_spawn() -> CodexExecutionReceiptV1 {
        CodexExecutionReceiptV1 {
            version: 1,
            operation_id: "operation-1".into(),
            request_hash: digest('1'),
            broker_generation: 1,
            runtime_identity_hash: digest('2'),
            process_spawned: false,
            process_id: None,
            process_start_identity_hash: None,
            started_at_unix_ms: 100,
            finished_at_unix_ms: 101,
            exit_code: None,
            signal: None,
            event_stream_hash: None,
            event_count: 0,
            thread_id: None,
            terminal_event_kind: None,
            final_output_hash: None,
            output_schema_validation_status: OutputSchemaValidationStatus::NotAttempted,
            workspace_before_hash: None,
            workspace_after_hash: None,
            mutation_manifest_hash: None,
            mutation_validation_status: MutationValidationStatus::NotAttempted,
            usage: None,
            usage_classification: UsageClassification::NotApplicable,
            cost_microusd: None,
            cost_classification: CostClassification::NotIncurred,
            provider_action_may_have_started: false,
            outcome_certainty: OutcomeCertainty::Certain,
            retry_disposition: RetryDisposition::NewOperationSameAttemptRequired,
        }
    }

    #[test]
    fn pre_spawn_terminal_uses_new_operation_same_attempt() {
        assert!(pre_spawn().validate().is_ok());
    }

    #[test]
    fn ambiguous_provider_outcome_requires_new_attempt() {
        let mut receipt = pre_spawn();
        receipt.process_spawned = true;
        receipt.process_id = Some(42);
        receipt.process_start_identity_hash = Some(digest('3'));
        receipt.provider_action_may_have_started = true;
        receipt.outcome_certainty = OutcomeCertainty::Ambiguous;
        receipt.usage_classification = UsageClassification::Unknown;
        receipt.cost_classification = CostClassification::Unknown;
        assert_eq!(
            receipt.validate(),
            Err(ProtocolValidationError::AmbiguousOutcomeRetryUnsafe),
        );
    }
}
