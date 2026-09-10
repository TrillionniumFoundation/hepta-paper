use serde::{Deserialize, Serialize};

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
    LatexRepair,
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

/// Required retry treatment after this terminal receipt.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryDisposition {
    /// Allocate a new broker operation while retaining the campaign attempt.
    NewOperationSameAttemptRequired,
    /// Allocate a new campaign attempt because provider work may have begun.
    NewAttemptRequired,
    /// Do not automatically retry this result.
    Never,
}

/// How token usage was established.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageClassification {
    Measured,
    NotReported,
    Unknown,
    NotApplicable,
}

/// How provider cost was established.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CostClassification {
    Measured,
    ConservativeUpperBound,
    Unknown,
    NotIncurred,
}
