//! Hardened role-private broker service lifecycle and Linux cgroup-v2 containment.

mod cgroup;
mod listener;
mod service;
mod telemetry;

pub use cgroup::{
    CgroupAuthorityModeV2, CgroupContainmentV2, CgroupOperationV2, CgroupPolicyV2,
};
pub use listener::{
    ListenerAccessModeV2, ListenerIdentityV2, ListenerPolicyV2, PeerPrincipalV2,
    RoleListenerV2, ShutdownHandleV2,
};
pub use service::{
    BrokerServicePolicyV2, BrokerServiceSummaryV2, ConnectionHandlerV2, RoleBrokerServiceV2,
};
pub use telemetry::{BrokerMachineReasonV2, BrokerTelemetrySnapshotV2, BrokerTelemetryV2};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum BrokerServiceErrorV2 {
    #[error("broker service policy is invalid")]
    InvalidPolicy,
    #[error("listener parent authority is invalid")]
    ListenerParentInvalid,
    #[error("listener socket authority is invalid")]
    ListenerSocketInvalid,
    #[error("listener marker is invalid")]
    ListenerMarkerInvalid,
    #[error("a live listener already exists")]
    LiveListenerExists,
    #[error("an unrecorded stale listener exists")]
    UnrecordedStaleListener,
    #[error("listener generation rolled back")]
    ListenerGenerationRollback,
    #[error("listener identity changed")]
    ListenerIdentityChanged,
    #[error("peer is not authorized")]
    PeerUnauthorized,
    #[error("worker queue is poisoned")]
    WorkerQueuePoisoned,
    #[error("worker failed: {0}")]
    WorkerFailed(String),
    #[error("worker panicked")]
    WorkerPanicked,
    #[error("shutdown wakeup failed")]
    ShutdownWakeupFailed,
    #[error("cgroup-v2 authority is invalid")]
    CgroupAuthorityInvalid,
    #[error("cgroup-v2 controller is unavailable: {0}")]
    CgroupControllerUnavailable(String),
    #[error("cgroup-v2 operation already exists")]
    CgroupOperationExists,
    #[error("cgroup-v2 operation identity changed")]
    CgroupIdentityChanged,
    #[error("cgroup-v2 cleanup timed out")]
    CgroupCleanupTimeout,
    #[error("identifier is invalid")]
    InvalidIdentifier,
    #[error("numeric conversion overflowed")]
    NumericOverflow,
    #[error("serialization failed")]
    Serialization,
    #[error("filesystem operation failed at {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
    #[error("socket operation failed at {0}: {1:?}")]
    Socket(&'static str, std::io::ErrorKind),
}
