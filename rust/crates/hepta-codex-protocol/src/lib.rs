//! Versioned, fail-closed contracts at the Rust control-plane/Codex boundary.
//!
//! These types are deliberately narrower than the Codex CLI protocol. They
//! describe what hepta-paper authorizes, not every feature the provider offers.

#![forbid(unsafe_code)]

mod digest;
mod execution;

pub use digest::{DigestParseError, Sha256Digest};
pub use execution::{
    AgentRole, ApprovalPolicy, CodexExecutionReceiptV1, CodexExecutionRequestV1,
    CostClassification, MutationValidationStatus, NetworkPolicy, OutcomeCertainty,
    OutputSchemaValidationStatus, ProtocolValidationError, RequestCapabilityV1, RetryDisposition,
    SandboxPolicy, SessionPolicy, TaskKind, TerminalEventKind, TokenUsage, Transport,
    UsageClassification,
};
