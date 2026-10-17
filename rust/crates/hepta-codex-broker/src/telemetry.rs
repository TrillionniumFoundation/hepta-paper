use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

/// Stable, non-sensitive broker lifecycle counters.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerTelemetrySnapshotV1 {
    pub version: u16,
    pub accepted_connections: u64,
    pub queued_connections: u64,
    pub busy_connections: u64,
    pub reserved_operations: u64,
    pub existing_operations: u64,
    pub admission_rejections: u64,
    pub capability_unavailable: u64,
    pub trust_bundle_changes: u64,
    pub journal_conflicts: u64,
    pub journal_failures: u64,
    pub response_write_failures: u64,
    pub worker_failures: u64,
    pub reconciled_processes: u64,
}

/// Atomic telemetry sink shared by the accept loop and fixed worker pool.
#[derive(Debug, Default)]
pub struct BrokerTelemetryV1 {
    accepted_connections: AtomicU64,
    queued_connections: AtomicU64,
    busy_connections: AtomicU64,
    reserved_operations: AtomicU64,
    existing_operations: AtomicU64,
    admission_rejections: AtomicU64,
    capability_unavailable: AtomicU64,
    trust_bundle_changes: AtomicU64,
    journal_conflicts: AtomicU64,
    journal_failures: AtomicU64,
    response_write_failures: AtomicU64,
    worker_failures: AtomicU64,
    reconciled_processes: AtomicU64,
}

impl BrokerTelemetryV1 {
    pub(crate) fn accepted(&self) {
        self.accepted_connections.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn queued(&self) {
        self.queued_connections.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn busy(&self) {
        self.busy_connections.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn reserved(&self) {
        self.reserved_operations.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn existing(&self) {
        self.existing_operations.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn admission_rejected(&self) {
        self.admission_rejections.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn capability_unavailable(&self) {
        self.capability_unavailable.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn trust_bundle_changed(&self) {
        self.trust_bundle_changes.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn journal_conflict(&self) {
        self.journal_conflicts.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn journal_failure(&self) {
        self.journal_failures.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn response_write_failed(&self) {
        self.response_write_failures.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn worker_failed(&self) {
        self.worker_failures.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn reconciled(&self, count: u64) {
        self.reconciled_processes
            .fetch_add(count, Ordering::Relaxed);
    }

    #[must_use]
    pub fn snapshot(&self) -> BrokerTelemetrySnapshotV1 {
        BrokerTelemetrySnapshotV1 {
            version: 1,
            accepted_connections: self.accepted_connections.load(Ordering::Relaxed),
            queued_connections: self.queued_connections.load(Ordering::Relaxed),
            busy_connections: self.busy_connections.load(Ordering::Relaxed),
            reserved_operations: self.reserved_operations.load(Ordering::Relaxed),
            existing_operations: self.existing_operations.load(Ordering::Relaxed),
            admission_rejections: self.admission_rejections.load(Ordering::Relaxed),
            capability_unavailable: self.capability_unavailable.load(Ordering::Relaxed),
            trust_bundle_changes: self.trust_bundle_changes.load(Ordering::Relaxed),
            journal_conflicts: self.journal_conflicts.load(Ordering::Relaxed),
            journal_failures: self.journal_failures.load(Ordering::Relaxed),
            response_write_failures: self.response_write_failures.load(Ordering::Relaxed),
            worker_failures: self.worker_failures.load(Ordering::Relaxed),
            reconciled_processes: self.reconciled_processes.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_contains_only_stable_bounded_counters() {
        let telemetry = BrokerTelemetryV1::default();
        telemetry.accepted();
        telemetry.queued();
        telemetry.reserved();
        telemetry.reconciled(2);
        let snapshot = telemetry.snapshot();
        assert_eq!(snapshot.version, 1);
        assert_eq!(snapshot.accepted_connections, 1);
        assert_eq!(snapshot.queued_connections, 1);
        assert_eq!(snapshot.reserved_operations, 1);
        assert_eq!(snapshot.reconciled_processes, 2);
        let encoded = serde_json::to_string(&snapshot).expect("telemetry JSON");
        for forbidden in ["prompt", "token", "secret", "path", "manuscript"] {
            assert!(!encoded.contains(forbidden));
        }
    }
}
