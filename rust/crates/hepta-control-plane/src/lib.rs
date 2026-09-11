//! Deterministic Rust control-plane vertical slice.
//!
//! This crate composes immutable snapshots, module candidate frontiers, hard
//! policy, bounded planning, hierarchical resource admission, prepared-result
//! verification, an exclusive SQLite commit sequencer, and privacy-bounded
//! observability. Durable commits include prepared bodies, receipts, campaign
//! budgets and audit events in one transaction. It contains no production activation root,
//! provider credential loader, release authority, or automatic activation.

#![forbid(unsafe_code)]

mod calibration;
mod commit;
mod events;
mod execution;
mod execution_filesystem;
mod hierarchical_resource;
mod hierarchical_runtime;
mod migration_closure;
mod model;
mod model_selection;
mod observability;
mod performance;
mod performance_binding;
mod planner;
mod resource;
mod resource_governance;
mod runtime;
mod snapshot;

pub use calibration::{
    CalibrationError, CalibrationPolicyV1, CalibrationReportV1, CalibrationSampleV1,
    calibrate_predictions_v1 as calibrate_control_plane_predictions_v1,
};
pub use commit::{
    CommitReceiptV1, CommitRequestV1, CommitSequencerV1, FixtureCommitSequencerV1,
    SqliteCommitSequencerV1,
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
    HierarchicalAccountingReportV1, HierarchicalReservationRequestV1,
    HierarchicalResourceAllocatorV1, HierarchicalResourceError, PreparedHierarchicalReservationV1,
    ResourceLeaseV1 as HierarchicalResourceLeaseV1, ResourceScopeV1,
};
pub use hierarchical_runtime::{
    HierarchicalControlPlaneRunReceiptV1, HierarchicalControlPlaneV1, ModuleAdmissionBindingV1,
};
pub use migration_closure::{
    LegacyCapabilityInventoryEntryV1, LegacyCapabilityInventoryV1, LegacyShadowComparisonReceiptV1,
    LegacyShadowPolicyV1, LegacyShadowResultV1, MigrationClosureError,
    build_legacy_capability_inventory_v1, compare_legacy_shadow_v1,
};
pub use model::{ControlPlaneSnapshotV1, HardPolicyV1, PlanningFrontierV1, canonical_hash_v1};
pub use model_selection::{
    PredictorPromotionPolicyV1, PredictorSelectionDecisionV1, PredictorSelectionError,
    PredictorSelectionReasonV1, select_predictor_v1,
};
pub use observability::{
    ObservabilityError, ObservabilityLedgerV1, ObservabilityPolicyV1, TelemetryCorrelationV1,
    TelemetryExportV1, TelemetryRetentionClassV1, TelemetrySignalKindV1, TelemetrySignalV1,
};
pub use performance::{
    PerformanceBudgetV1, PerformanceError, PerformanceObservationV1,
    PerformanceQualificationReportV1, evaluate_performance_v1,
};
pub use performance_binding::{
    BoundPerformanceQualificationReportV1, PerformanceBindingError, PerformanceRegressionBudgetV1,
    PerformanceRegressionReportV1, PerformanceSubjectV1, compare_bound_performance_v1,
    evaluate_bound_performance_v1,
};
pub use planner::{PlanCertificateV1, PlanModeV1, PlannerPolicyV1, select_plan_v1};
pub use resource::{
    AdmissionRequestV1, ResourceAccountingReportV1, ResourceAllocatorV1, ResourceReservationV1,
};
pub use resource_governance::{
    PreemptionCandidateV1, PreemptionPlanV1, PriorityDependencyV1, ResourceLeasePolicyV1,
    ResourceLeaseRegistryV1, ResourceLeaseSnapshotV1, ResourceLeaseStateV1,
    ResourceLeaseV1 as FencedResourceLeaseV1, inherit_priorities_v1, plan_safe_preemption_v1,
};
pub use runtime::{ControlPlaneRunReceiptV1, ControlPlaneV1};
pub use snapshot::{
    SnapshotBuildReceiptV1, SnapshotMaterialV1, SnapshotStateComponentV1, build_snapshot_v1,
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
    /// Hierarchical resource preparation, fencing, or release failed.
    #[error("hierarchical resource admission rejected the run")]
    HierarchicalResourceRejected,
    /// Reservation identity already exists or is unknown.
    #[error("resource reservation identity is invalid")]
    ReservationInvalid,
    /// Actual use exceeds the admitted reservation.
    #[error("resource reconciliation exceeds reservation")]
    ReconciliationInvalid,
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
    /// Module-platform validation failed.
    #[error("module-platform contract rejected the subject")]
    ModulePlatformRejected,
}

#[cfg(test)]
mod tests;
