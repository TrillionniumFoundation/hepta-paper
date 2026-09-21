//! Additive deterministic Rust orchestration library contracts.
//!
//! The crate owns six repository-local responsibilities that must not be delegated
//! to the legacy Node runtime: consistent supplied planning observations,
//! deterministic candidate routing, hierarchical resource reservations,
//! privacy-bounded telemetry, canonical performance qualification, and bounded
//! deterministic planner calibration.
//!
//! The control-plane re-export does not select these contracts for an existing
//! command. Their supplied data is not a real read barrier, durable resource
//! journal or independently authenticated performance observation.

#![forbid(unsafe_code)]

pub mod calibration;
pub mod performance;
pub mod resource;
pub mod router;
pub mod snapshot;
pub mod telemetry;

pub use calibration::{
    CalibrationObservationV1, CalibrationPolicyV1, CalibrationReportV1, calibrate_predictions_v1,
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
