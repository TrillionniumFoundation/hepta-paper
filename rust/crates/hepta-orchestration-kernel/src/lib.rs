//! Deterministic Rust orchestration primitives used by the production control plane.
//!
//! The crate owns repository-local responsibilities that must not be delegated
//! to the legacy Node runtime: transaction-consistent planning snapshots,
//! deterministic candidate routing, hierarchical resource reservations,
//! privacy-bounded telemetry, canonical performance qualification, and
//! version-scoped prediction/planner calibration.

#![forbid(unsafe_code)]

pub mod calibration;
pub mod performance;
pub mod resource;
pub mod router;
pub mod snapshot;
pub mod telemetry;

pub use calibration::{
    CalibrationError, CalibrationReceiptV1, ChampionChallengerPolicyV1,
    ChampionChallengerReceiptV1, ModuleCalibrationSummaryV1, PlannerVariantObservationV1,
    PredictionObservationV1, calibrate_predictions_v1, compare_planner_variants_v1,
};
pub use performance::{
    CanonicalWorkloadV1, PerformanceObservationV1, PerformanceQualificationReceiptV1,
    PerformanceSubjectV1, qualify_performance_v1,
};
pub use resource::{
    RecoveryDispositionV1, ReservationReceiptV1, ReservationStateV1, ResourceLedgerV1,
    ResourceScopeV1, ResourceVectorV1,
};
pub use router::{
    CandidateRouteReceiptV1, CandidateRouterPolicyV1, CandidateV1, route_candidate_v1,
};
pub use snapshot::{
    PlanningComponentObservationV1, PlanningSnapshotRequestV1, PlanningSnapshotV1,
    build_planning_snapshot_v1,
};
pub use telemetry::{
    EventCodeV1, ModuleClassV1, ObservationInputV1, OutcomeClassV1, SeverityV1,
    TelemetryAggregatorV1, TelemetrySnapshotV1,
};
