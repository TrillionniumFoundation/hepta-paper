//! Deterministic Codex external-operation state machine.
//!
//! Persistence is intentionally out of scope for this crate. The same state
//! machine is used by the future SQLite journal and by deterministic tests.

#![forbid(unsafe_code)]

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Crash-stable operation state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Reserved,
    RequestBound,
    ProcessSpawned,
    EventStreamStarted,
    TerminalEventObserved,
    FinalOutputCaptured,
    SchemaValidated,
    WorkspaceSnapshotted,
    MutationValidated,
    ResultPrepared,
    Acknowledged,
    RejectedPreflight,
    FailedBeforeSpawn,
    CancelledBeforeSpawn,
    FailedAfterSpawn,
    TimedOutAfterSpawn,
    TerminalFailure,
    EventStreamInvalid,
    OutputSchemaInvalid,
    MutationPolicyViolated,
    ResultAmbiguous,
}

impl OperationState {
    /// Whether no further state transition is legal.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Acknowledged
                | Self::RejectedPreflight
                | Self::FailedBeforeSpawn
                | Self::CancelledBeforeSpawn
                | Self::FailedAfterSpawn
                | Self::TimedOutAfterSpawn
                | Self::TerminalFailure
                | Self::EventStreamInvalid
                | Self::OutputSchemaInvalid
                | Self::MutationPolicyViolated
                | Self::ResultAmbiguous
        )
    }

    /// Whether this state represents an unsuccessful terminal operation.
    #[must_use]
    pub const fn is_failure_terminal(self) -> bool {
        self.is_terminal() && !matches!(self, Self::Acknowledged)
    }

    /// Whether entering this state requires bound evidence.
    #[must_use]
    pub const fn requires_evidence(self) -> bool {
        matches!(
            self,
            Self::ProcessSpawned
                | Self::TerminalEventObserved
                | Self::FinalOutputCaptured
                | Self::SchemaValidated
                | Self::WorkspaceSnapshotted
                | Self::MutationValidated
                | Self::ResultPrepared
                | Self::Acknowledged
        )
    }
}

/// Action an operator or reconciler may take after a crash or terminal state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryDisposition {
    /// Continue the same nonterminal journal operation without re-spawning.
    ResumeSameOperation,
    /// Allocate a new operation ID while retaining the current campaign attempt.
    StartNewOperationSameAttempt,
    /// Resume deterministic local processing after provider execution completed.
    ResumeLocalProcessing,
    /// Allocate a new campaign attempt because provider execution may have begun.
    StartNewAttempt,
    /// Integrate an already prepared result without invoking Codex again.
    IntegratePreparedResult,
    /// No recovery action remains.
    Complete,
}

/// One append-only state transition.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalTransitionV1 {
    pub sequence: u64,
    pub from: OperationState,
    pub to: OperationState,
    pub recorded_at_unix_ms: u64,
    pub evidence_hash: Option<Sha256Digest>,
    pub reason_code: Option<String>,
}

/// In-memory representation of one broker operation journal.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationJournalV1 {
    pub version: u16,
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub current_state: OperationState,
    pub transitions: Vec<JournalTransitionV1>,
}

impl OperationJournalV1 {
    /// Creates a journal before the request is bound or a process is spawned.
    pub fn new(
        operation_id: String,
        request_hash: Sha256Digest,
    ) -> Result<Self, JournalError> {
        if !valid_identifier(&operation_id) {
            return Err(JournalError::InvalidOperationId);
        }
        Ok(Self {
            version: 1,
            operation_id,
            request_hash,
            current_state: OperationState::Reserved,
            transitions: Vec::new(),
        })
    }

    /// Applies one legal transition and appends its immutable evidence record.
    pub fn transition(
        &mut self,
        to: OperationState,
        recorded_at_unix_ms: u64,
        evidence_hash: Option<Sha256Digest>,
        reason_code: Option<String>,
    ) -> Result<&JournalTransitionV1, JournalError> {
        if self.current_state.is_terminal() {
            return Err(JournalError::TerminalState(self.current_state));
        }
        if !legal_transition(self.current_state, to) {
            return Err(JournalError::IllegalTransition {
                from: self.current_state,
                to,
            });
        }
        validate_transition_metadata(to, evidence_hash.as_ref(), reason_code.as_deref())?;
        if recorded_at_unix_ms == 0 {
            return Err(JournalError::InvalidRecordedTime);
        }
        if let Some(previous) = self.transitions.last()
            && recorded_at_unix_ms < previous.recorded_at_unix_ms
        {
            return Err(JournalError::NonMonotonicTime);
        }
        let sequence = u64::try_from(self.transitions.len())
            .map_err(|_| JournalError::SequenceOverflow)?
            .checked_add(1)
            .ok_or(JournalError::SequenceOverflow)?;
        let transition = JournalTransitionV1 {
            sequence,
            from: self.current_state,
            to,
            recorded_at_unix_ms,
            evidence_hash,
            reason_code,
        };
        self.current_state = to;
        self.transitions.push(transition);
        self.transitions.last().ok_or(JournalError::SequenceOverflow)
    }

    /// Re-validates a journal loaded from persistent storage.
    pub fn validate(&self) -> Result<(), JournalError> {
        if self.version != 1 {
            return Err(JournalError::UnsupportedVersion(self.version));
        }
        if !valid_identifier(&self.operation_id) {
            return Err(JournalError::InvalidOperationId);
        }
        let mut state = OperationState::Reserved;
        let mut previous_time = 0;
        for (index, transition) in self.transitions.iter().enumerate() {
            let expected_sequence = u64::try_from(index)
                .map_err(|_| JournalError::SequenceOverflow)?
                .checked_add(1)
                .ok_or(JournalError::SequenceOverflow)?;
            if transition.sequence != expected_sequence {
                return Err(JournalError::InvalidSequence {
                    expected: expected_sequence,
                    observed: transition.sequence,
                });
            }
            if transition.from != state || !legal_transition(state, transition.to) {
                return Err(JournalError::IllegalTransition {
                    from: transition.from,
                    to: transition.to,
                });
            }
            validate_transition_metadata(
                transition.to,
                transition.evidence_hash.as_ref(),
                transition.reason_code.as_deref(),
            )?;
            if transition.recorded_at_unix_ms == 0
                || transition.recorded_at_unix_ms < previous_time
            {
                return Err(JournalError::NonMonotonicTime);
            }
            previous_time = transition.recorded_at_unix_ms;
            state = transition.to;
        }
        if state != self.current_state {
            return Err(JournalError::CurrentStateMismatch {
                expected: state,
                observed: self.current_state,
            });
        }
        Ok(())
    }

    /// Conservative recovery action derived only from persisted state.
    #[must_use]
    pub const fn recovery_disposition(&self) -> RecoveryDisposition {
        match self.current_state {
            OperationState::Reserved | OperationState::RequestBound => {
                RecoveryDisposition::ResumeSameOperation
            }
            OperationState::RejectedPreflight
            | OperationState::FailedBeforeSpawn
            | OperationState::CancelledBeforeSpawn => {
                RecoveryDisposition::StartNewOperationSameAttempt
            }
            OperationState::TerminalEventObserved
            | OperationState::FinalOutputCaptured
            | OperationState::SchemaValidated
            | OperationState::WorkspaceSnapshotted
            | OperationState::MutationValidated => {
                RecoveryDisposition::ResumeLocalProcessing
            }
            OperationState::ResultPrepared => RecoveryDisposition::IntegratePreparedResult,
            OperationState::Acknowledged => RecoveryDisposition::Complete,
            OperationState::ProcessSpawned
            | OperationState::EventStreamStarted
            | OperationState::FailedAfterSpawn
            | OperationState::TimedOutAfterSpawn
            | OperationState::TerminalFailure
            | OperationState::EventStreamInvalid
            | OperationState::OutputSchemaInvalid
            | OperationState::MutationPolicyViolated
            | OperationState::ResultAmbiguous => RecoveryDisposition::StartNewAttempt,
        }
    }
}

const fn legal_transition(from: OperationState, to: OperationState) -> bool {
    use OperationState::{
        Acknowledged, CancelledBeforeSpawn, EventStreamInvalid, EventStreamStarted,
        FailedAfterSpawn, FailedBeforeSpawn, FinalOutputCaptured, MutationPolicyViolated,
        MutationValidated, OutputSchemaInvalid, ProcessSpawned, RejectedPreflight, RequestBound,
        Reserved, ResultAmbiguous, ResultPrepared, SchemaValidated, TerminalEventObserved,
        TerminalFailure, TimedOutAfterSpawn, WorkspaceSnapshotted,
    };

    matches!(
        (from, to),
        (Reserved, RequestBound | RejectedPreflight | FailedBeforeSpawn | CancelledBeforeSpawn)
            | (
                RequestBound,
                ProcessSpawned | RejectedPreflight | FailedBeforeSpawn | CancelledBeforeSpawn
            )
            | (
                ProcessSpawned,
                EventStreamStarted | FailedAfterSpawn | TimedOutAfterSpawn | ResultAmbiguous
            )
            | (
                EventStreamStarted,
                TerminalEventObserved
                    | EventStreamInvalid
                    | FailedAfterSpawn
                    | TimedOutAfterSpawn
                    | ResultAmbiguous
            )
            | (
                TerminalEventObserved,
                FinalOutputCaptured | TerminalFailure | EventStreamInvalid
            )
            | (FinalOutputCaptured, SchemaValidated | OutputSchemaInvalid)
            | (SchemaValidated, WorkspaceSnapshotted)
            | (WorkspaceSnapshotted, MutationValidated | MutationPolicyViolated)
            | (MutationValidated, ResultPrepared)
            | (ResultPrepared, Acknowledged)
    )
}

fn validate_transition_metadata(
    state: OperationState,
    evidence_hash: Option<&Sha256Digest>,
    reason_code: Option<&str>,
) -> Result<(), JournalError> {
    if state.requires_evidence() && evidence_hash.is_none() {
        return Err(JournalError::EvidenceRequired(state));
    }
    if state.is_failure_terminal() && reason_code.is_none() {
        return Err(JournalError::FailureReasonRequired(state));
    }
    if !state.is_failure_terminal() && reason_code.is_some() {
        return Err(JournalError::UnexpectedReasonCode(state));
    }
    if let Some(reason) = reason_code
        && !valid_reason_code(reason)
    {
        return Err(JournalError::InvalidReasonCode);
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
        })
}

fn valid_reason_code(value: &str) -> bool {
    valid_identifier(value) && value.bytes().all(|byte| !byte.is_ascii_uppercase())
}

/// Invalid journal structure or transition.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum JournalError {
    #[error("unsupported journal version: {0}")]
    UnsupportedVersion(u16),
    #[error("operation id is invalid")]
    InvalidOperationId,
    #[error("state {0:?} is terminal")]
    TerminalState(OperationState),
    #[error("illegal transition from {from:?} to {to:?}")]
    IllegalTransition {
        from: OperationState,
        to: OperationState,
    },
    #[error("transition time must be positive")]
    InvalidRecordedTime,
    #[error("transition times must be monotonic")]
    NonMonotonicTime,
    #[error("state {0:?} requires a bound evidence hash")]
    EvidenceRequired(OperationState),
    #[error("failure state {0:?} requires a reason code")]
    FailureReasonRequired(OperationState),
    #[error("non-failure state {0:?} cannot carry a reason code")]
    UnexpectedReasonCode(OperationState),
    #[error("reason code must be a lowercase bounded identifier")]
    InvalidReasonCode,
    #[error("journal transition sequence overflowed")]
    SequenceOverflow,
    #[error("invalid sequence: expected {expected}, observed {observed}")]
    InvalidSequence { expected: u64, observed: u64 },
    #[error("current state mismatch: expected {expected:?}, observed {observed:?}")]
    CurrentStateMismatch {
        expected: OperationState,
        observed: OperationState,
    },
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use hepta_codex_protocol::Sha256Digest;

    use super::{JournalError, OperationJournalV1, OperationState, RecoveryDisposition};

    fn digest(byte: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
            .expect("test digest")
    }

    fn evidence_for(state: OperationState) -> Option<Sha256Digest> {
        if state.requires_evidence() {
            Some(digest('e'))
        } else {
            None
        }
    }

    #[test]
    fn executes_complete_success_path() {
        let mut journal = OperationJournalV1::new("operation-1".to_owned(), digest('1'))
            .expect("valid journal");
        let states = [
            OperationState::RequestBound,
            OperationState::ProcessSpawned,
            OperationState::EventStreamStarted,
            OperationState::TerminalEventObserved,
            OperationState::FinalOutputCaptured,
            OperationState::SchemaValidated,
            OperationState::WorkspaceSnapshotted,
            OperationState::MutationValidated,
            OperationState::ResultPrepared,
            OperationState::Acknowledged,
        ];
        for (index, state) in states.into_iter().enumerate() {
            let offset = u64::try_from(index).expect("small state sequence");
            journal
                .transition(state, 100 + offset, evidence_for(state), None)
                .expect("legal transition");
        }
        assert!(journal.validate().is_ok());
        assert_eq!(journal.recovery_disposition(), RecoveryDisposition::Complete);
    }

    #[test]
    fn process_spawned_crash_requires_new_attempt() {
        let mut journal = OperationJournalV1::new("operation-1".to_owned(), digest('1'))
            .expect("valid journal");
        journal
            .transition(OperationState::RequestBound, 100, None, None)
            .expect("bound");
        journal
            .transition(OperationState::ProcessSpawned, 101, Some(digest('2')), None)
            .expect("spawned");
        assert_eq!(
            journal.recovery_disposition(),
            RecoveryDisposition::StartNewAttempt
        );
    }

    #[test]
    fn prepared_result_is_integrated_without_provider_reexecution() {
        let mut journal = OperationJournalV1::new("operation-1".to_owned(), digest('1'))
            .expect("valid journal");
        for (index, state) in [
            OperationState::RequestBound,
            OperationState::ProcessSpawned,
            OperationState::EventStreamStarted,
            OperationState::TerminalEventObserved,
            OperationState::FinalOutputCaptured,
            OperationState::SchemaValidated,
            OperationState::WorkspaceSnapshotted,
            OperationState::MutationValidated,
            OperationState::ResultPrepared,
        ]
        .into_iter()
        .enumerate()
        {
            let offset = u64::try_from(index).expect("small state sequence");
            journal
                .transition(state, 100 + offset, evidence_for(state), None)
                .expect("legal transition");
        }
        assert_eq!(
            journal.recovery_disposition(),
            RecoveryDisposition::IntegratePreparedResult
        );
    }

    #[test]
    fn pre_spawn_terminal_failure_requires_a_new_operation_not_a_new_attempt() {
        let mut journal = OperationJournalV1::new("operation-1".to_owned(), digest('1'))
            .expect("valid journal");
        journal
            .transition(OperationState::RequestBound, 100, None, None)
            .expect("bound");
        journal
            .transition(
                OperationState::RejectedPreflight,
                101,
                None,
                Some("runtime_identity_unqualified".to_owned()),
            )
            .expect("terminal preflight rejection");
        assert_eq!(
            journal.recovery_disposition(),
            RecoveryDisposition::StartNewOperationSameAttempt
        );
    }

    #[test]
    fn nonterminal_pre_spawn_state_resumes_the_same_operation() {
        let mut journal = OperationJournalV1::new("operation-1".to_owned(), digest('1'))
            .expect("valid journal");
        journal
            .transition(OperationState::RequestBound, 100, None, None)
            .expect("bound");
        assert_eq!(
            journal.recovery_disposition(),
            RecoveryDisposition::ResumeSameOperation
        );
    }

    #[test]
    fn rejects_impossible_skip() {
        let mut journal = OperationJournalV1::new("operation-1".to_owned(), digest('1'))
            .expect("valid journal");
        assert_eq!(
            journal.transition(
                OperationState::ProcessSpawned,
                100,
                Some(digest('2')),
                None,
            ),
            Err(JournalError::IllegalTransition {
                from: OperationState::Reserved,
                to: OperationState::ProcessSpawned,
            })
        );
    }

    #[test]
    fn rejects_missing_success_evidence_and_failure_reason() {
        let mut journal = OperationJournalV1::new("operation-1".to_owned(), digest('1'))
            .expect("valid journal");
        journal
            .transition(OperationState::RequestBound, 100, None, None)
            .expect("bound");
        assert_eq!(
            journal.transition(OperationState::ProcessSpawned, 101, None, None),
            Err(JournalError::EvidenceRequired(
                OperationState::ProcessSpawned
            ))
        );
        assert_eq!(
            journal.transition(OperationState::RejectedPreflight, 101, None, None),
            Err(JournalError::FailureReasonRequired(
                OperationState::RejectedPreflight
            ))
        );
    }

    #[test]
    fn rejects_invalid_operation_id_at_construction() {
        assert_eq!(
            OperationJournalV1::new("../escape".to_owned(), digest('1')),
            Err(JournalError::InvalidOperationId)
        );
    }
}
