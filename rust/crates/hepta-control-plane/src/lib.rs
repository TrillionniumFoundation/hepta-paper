//! Deterministic Rust control-plane vertical slice.
//!
//! This crate composes immutable snapshots, module candidate frontiers, hard
//! policy, bounded planning, hierarchical resource admission, prepared-result
//! verification, an exclusive SQLite commit sequencer, and privacy-bounded
//! observability. Durable commits include prepared bodies, receipts, campaign
//! budgets and audit events in one transaction. It contains no production activation root,
//! provider credential loader, release authority, or automatic activation.

#![forbid(unsafe_code)]

mod commit;
#[allow(clippy::type_complexity)]
mod durable_resource;
mod events;
mod execution;
mod execution_filesystem;
mod hierarchical_resource;
mod model;
mod model_selection;
mod observability;
mod optimizer_v2;
mod pareto;
mod performance_qualification;
mod planner;
mod resource;
mod runtime;
mod source_closure;

pub use commit::{
    CommitReceiptV1, CommitRequestV1, CommitSequencerV1, FixtureCommitSequencerV1,
    SqliteCommitSequencerV1, replay_control_log_v1,
};
pub use durable_resource::{
    DurableResourceLeaseLedgerV1, DurableResourceLeaseStateV1, DurableResourceLeaseV1,
    DurableResourcePrepareV1, ResourceRecoveryReportV1,
};
pub use events::{BoundedEventLogV1, ControlPlaneEventKindV1, ControlPlaneEventV1};
pub(crate) use execution::verification_receipt_hash_v1;
pub use execution::{
    DeterministicPreparedResultVerifierV1, ExecutionRequestV1, ModuleExecutorV1,
    PreparedResultVerifierV1, VerifiedPreparedResultV1,
};
pub use execution_filesystem::FilesystemPreparedResultVerifierV1;
pub use hepta_orchestration_kernel as orchestration_kernel;
pub use hierarchical_resource::{
    HierarchicalAdmissionOutcomeV1, HierarchicalAdmissionRequestV1,
    HierarchicalResourceAllocatorV1, HierarchicalResourceReservationV1,
};
pub use model::{ControlPlaneSnapshotV1, HardPolicyV1, PlanningFrontierV1, canonical_hash_v1};
pub use model_selection::{
    PlannerEvaluationV1, PlannerPromotionPolicyV1, PlannerSelectionDecisionV1,
    PlannerSelectionError, PlannerSelectionReasonV1, select_planner_champion_v1,
};
pub use observability::{
    ObservabilityExportV1, ObservabilityJournalV1, ObservabilityPolicyV1, TelemetryPrivacyClassV1,
    TelemetryRetentionClassV1, TelemetrySignalKindV1, TelemetrySignalV1,
};
pub use optimizer_v2::{
    CalibrationObservationV1, CalibrationPolicyV1, CalibrationReportV1, OptimizerReceiptV2,
    OptimizerWorkBudgetV2, assess_calibration_v1, optimize_v2,
};
pub use pareto::contextual_pareto_frontier_preserving_dependencies_v2;
pub use performance_qualification::{
    MAXIMUM_QUALIFICATION_REQUEST_BYTES_V1, PerformanceQualificationReceiptV1,
    PerformanceQualificationRequestV1, PerformanceQualificationSubjectV1, qualify_performance_v1,
};
pub use planner::{PlanCertificateV1, PlanModeV1, PlannerPolicyV1, select_plan_v1};
pub use resource::{
    AdmissionRequestV1, ResourceAccountingReportV1, ResourceAllocatorV1, ResourceReservationV1,
};
pub use runtime::{ControlPlaneRunReceiptV1, ControlPlaneV1};
pub use source_closure::{
    HierarchicalResourcePolicyV1, PerformanceAssessmentV1, PerformanceBudgetV1,
    PerformanceSampleV1, ResourceEntitlementV1, SnapshotBuildRequestV1, assess_performance_v1,
    build_snapshot_v1, contextual_pareto_frontier_v1, route_candidates_v1,
};

use thiserror::Error;

/// Control-plane validation or execution failure.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ControlPlaneError {
    /// Canonical serialization or hashing failed.
    #[error("control-plane canonical encoding failed")]
    EncodingInvalid,
    /// Snapshot identity or static shape is invalid.
    #[error("control-plane snapshot is invalid")]
    SnapshotInvalid,
    /// Candidate frontier is malformed, cyclic, or does not bind the snapshot.
    #[error("candidate frontier is invalid")]
    FrontierInvalid,
    /// Hard planner policy is invalid.
    #[error("planner policy is invalid")]
    PlannerPolicyInvalid,
    /// No candidate subset satisfies all hard constraints.
    #[error("no feasible plan exists")]
    NoFeasiblePlan,
    /// Candidate objective arithmetic overflowed.
    #[error("planner objective arithmetic overflow")]
    ObjectiveOverflow,
    /// A plan certificate failed recomputation.
    #[error("plan certificate is invalid")]
    PlanInvalid,
    /// Resource policy or capacity is invalid.
    #[error("resource allocator policy is invalid")]
    ResourcePolicyInvalid,
    /// Admission time moved backward relative to the allocator clock floor.
    #[error("resource admission clock rollback")]
    ResourceClockRollback,
    /// Requested resources cannot be admitted.
    #[error("resource admission denied")]
    ResourceDenied,
    /// Reservation identity already exists or is unknown.
    #[error("resource reservation identity is invalid")]
    ReservationInvalid,
    /// Actual use exceeds the admitted reservation.
    #[error("resource reconciliation exceeds reservation")]
    ReconciliationInvalid,
    /// Durable resource lease persistence, integrity, or recovery failed.
    #[error("durable resource ledger is invalid")]
    ResourcePersistenceInvalid,
    /// Module execution returned an incomplete or mismatched batch.
    #[error("module execution batch is invalid")]
    ExecutionInvalid,
    /// Prepared-result verification failed.
    #[error("prepared-result verification failed")]
    VerificationInvalid,
    /// Commit sequencing or idempotency failed.
    #[error("commit sequencing failed")]
    CommitInvalid,
    /// The durable writer rejected persistence, fencing, budget or integrity.
    #[error("durable campaign persistence failed")]
    PersistenceInvalid,
    /// Event cardinality or event-count budget was exceeded.
    #[error("observability budget exceeded")]
    ObservabilityBudgetExceeded,
    /// A telemetry signal violates schema, privacy, label, or replay policy.
    #[error("observability signal is invalid")]
    ObservabilitySignalInvalid,
    /// Performance/SLO evidence is malformed or cannot be evaluated deterministically.
    #[error("performance qualification evidence is invalid")]
    PerformanceQualificationInvalid,
    /// Module-platform validation failed.
    #[error("module-platform contract rejected the subject")]
    ModulePlatformRejected,
}

#[cfg(test)]
mod tests;
