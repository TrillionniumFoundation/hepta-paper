use thiserror::Error;

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
    LimitOutOfRange { field: &'static str, maximum: u64 },
    #[error("request capability expiry exceeds the request deadline")]
    CapabilityOutlivesRequest,
    #[error("agent role is not authorized for the selected task kind")]
    RoleTaskMismatch,
    #[error("agent role is not authorized for the selected sandbox")]
    RoleSandboxMismatch,
    #[error("receipt finish time precedes start time")]
    InvalidTimeOrder,
    #[error("exit code and signal cannot both be present")]
    ConflictingProcessOutcome,
    #[error("an unspawned process cannot carry provider or process evidence")]
    UnspawnedProcessHasEvidence,
    #[error("a spawned process must carry a pid and process-start identity")]
    SpawnedProcessMissingIdentity,
    #[error("process id zero is invalid")]
    ProcessIdZero,
    #[error("a certain spawned-process outcome must carry an exit code or signal")]
    CertainProcessOutcomeMissing,
    #[error("provider-derived evidence cannot exist when provider action was ruled out")]
    ProviderEvidenceWithoutPossibleAction,
    #[error("event count and event-stream hash are inconsistent")]
    EventEvidenceMismatch,
    #[error("terminal evidence is incomplete")]
    TerminalEvidenceIncomplete,
    #[error("usage cannot be present without a terminal event")]
    UsageWithoutTerminalEvent,
    #[error("schema-valid output must carry a final-output hash")]
    ValidOutputMissingHash,
    #[error("schema-valid output requires a successful terminal event")]
    ValidOutputWithoutSuccessfulTerminal,
    #[error("schema-valid output requires a successful process exit")]
    ValidOutputWithoutSuccessfulProcess,
    #[error("usage value and usage classification are inconsistent")]
    UsageClassificationMismatch,
    #[error("cost value and cost classification are inconsistent")]
    CostClassificationMismatch,
    #[error("validated mutation status requires before, after, and manifest hashes")]
    MutationEvidenceIncomplete,
    #[error("an ambiguous provider outcome must require a new attempt")]
    AmbiguousOutcomeRetryUnsafe,
    #[error("a new operation in the same attempt is unsafe after a possible provider action")]
    NewOperationRetryUnsafe,
    #[error("a new campaign attempt is unnecessary when provider action was ruled out")]
    NewAttemptRetryUnnecessary,
}
