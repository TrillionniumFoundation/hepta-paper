use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerMachineReasonV2 {
    Accepted,
    Queued,
    QueueFull,
    PeerUnauthorized,
    HandlerRejected,
    HandlerFatal,
    WorkerPanicked,
    GracefulShutdown,
    ListenerFailure,
    ContainmentFailure,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerTelemetrySnapshotV2 {
    pub version: u16,
    pub accepted: u64,
    pub queued: u64,
    pub queue_full: u64,
    pub peer_unauthorized: u64,
    pub handler_rejected: u64,
    pub handler_fatal: u64,
    pub worker_panicked: u64,
    pub graceful_shutdown: u64,
    pub listener_failure: u64,
    pub containment_failure: u64,
}

#[derive(Default)]
pub struct BrokerTelemetryV2 {
    accepted: AtomicU64,
    queued: AtomicU64,
    queue_full: AtomicU64,
    peer_unauthorized: AtomicU64,
    handler_rejected: AtomicU64,
    handler_fatal: AtomicU64,
    worker_panicked: AtomicU64,
    graceful_shutdown: AtomicU64,
    listener_failure: AtomicU64,
    containment_failure: AtomicU64,
}

impl BrokerTelemetryV2 {
    pub fn record(&self, reason: BrokerMachineReasonV2) {
        let counter = match reason {
            BrokerMachineReasonV2::Accepted => &self.accepted,
            BrokerMachineReasonV2::Queued => &self.queued,
            BrokerMachineReasonV2::QueueFull => &self.queue_full,
            BrokerMachineReasonV2::PeerUnauthorized => &self.peer_unauthorized,
            BrokerMachineReasonV2::HandlerRejected => &self.handler_rejected,
            BrokerMachineReasonV2::HandlerFatal => &self.handler_fatal,
            BrokerMachineReasonV2::WorkerPanicked => &self.worker_panicked,
            BrokerMachineReasonV2::GracefulShutdown => &self.graceful_shutdown,
            BrokerMachineReasonV2::ListenerFailure => &self.listener_failure,
            BrokerMachineReasonV2::ContainmentFailure => &self.containment_failure,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    #[must_use]
    pub fn snapshot(&self) -> BrokerTelemetrySnapshotV2 {
        BrokerTelemetrySnapshotV2 {
            version: 2,
            accepted: self.accepted.load(Ordering::Relaxed),
            queued: self.queued.load(Ordering::Relaxed),
            queue_full: self.queue_full.load(Ordering::Relaxed),
            peer_unauthorized: self.peer_unauthorized.load(Ordering::Relaxed),
            handler_rejected: self.handler_rejected.load(Ordering::Relaxed),
            handler_fatal: self.handler_fatal.load(Ordering::Relaxed),
            worker_panicked: self.worker_panicked.load(Ordering::Relaxed),
            graceful_shutdown: self.graceful_shutdown.load(Ordering::Relaxed),
            listener_failure: self.listener_failure.load(Ordering::Relaxed),
            containment_failure: self.containment_failure.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_are_stable_and_contain_no_payload_fields() {
        let telemetry = BrokerTelemetryV2::default();
        telemetry.record(BrokerMachineReasonV2::Accepted);
        telemetry.record(BrokerMachineReasonV2::QueueFull);
        telemetry.record(BrokerMachineReasonV2::QueueFull);
        let snapshot = telemetry.snapshot();
        assert_eq!(snapshot.accepted, 1);
        assert_eq!(snapshot.queue_full, 2);
        let encoded = serde_json::to_string(&snapshot).expect("encode telemetry");
        assert!(!encoded.contains("prompt"));
        assert!(!encoded.contains("token"));
        assert!(!encoded.contains("path"));
    }
}
