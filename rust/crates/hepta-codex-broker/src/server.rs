use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, RecvTimeoutError, TrySendError, sync_channel},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use hepta_codex_runtime::ProcessLimitsV1;
use thiserror::Error;

use crate::{
    AdmissionPolicyV1, BrokerJournalError, BrokerJournalPolicyV1, BrokerJournalStoreV1,
    BrokerListenerError, BrokerListenerQualificationV1, BrokerListenerV1, BrokerMachineCodeV1,
    BrokerProcessReconciliationV1, BrokerResponseError, BrokerResponseFramePolicyV1,
    BrokerResponseV1, BrokerStateError, BrokerTelemetrySnapshotV1, BrokerTelemetryV1,
    CapabilityTrustBundleManagerV1, FaultInjectionPointV1, PeerAuthorizationError, PeerPolicyV1,
    ProcessReconciliationDispositionV1, ReservationOutcomeV1, TrustBundleError,
    admit_and_reserve_unix_stream, write_response_frame,
};

const HARD_MAXIMUM_WORKERS: usize = 32;
const HARD_MAXIMUM_QUEUE_CAPACITY: usize = 256;
const HARD_MAXIMUM_ACCEPT_POLL_MS: u64 = 1_000;
const HARD_MAXIMUM_WRITE_TIMEOUT_MS: u64 = 30_000;
const HARD_MAXIMUM_CONNECTIONS_PER_RUN: u64 = 1_000_000;

/// Injectable monotonic-enough wall-clock source for capability/deadline checks.
pub trait BrokerClockV1: Send + Sync {
    fn now_unix_ms(&self) -> Result<u64, BrokerServerError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemBrokerClockV1;

impl BrokerClockV1 for SystemBrokerClockV1 {
    fn now_unix_ms(&self) -> Result<u64, BrokerServerError> {
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| BrokerServerError::ClockUnavailable)?;
        u64::try_from(elapsed.as_millis()).map_err(|_| BrokerServerError::ClockUnavailable)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BrokerServerPolicyV1 {
    pub version: u16,
    pub worker_threads: usize,
    pub queue_capacity: usize,
    pub accept_poll_ms: u64,
    pub write_timeout_ms: u64,
    pub busy_retry_after_ms: u64,
    pub maximum_connections: u64,
    pub startup_process_limits: ProcessLimitsV1,
}

impl Default for BrokerServerPolicyV1 {
    fn default() -> Self {
        Self {
            version: 1,
            worker_threads: 4,
            queue_capacity: 32,
            accept_poll_ms: 20,
            write_timeout_ms: 5_000,
            busy_retry_after_ms: 100,
            maximum_connections: HARD_MAXIMUM_CONNECTIONS_PER_RUN,
            startup_process_limits: ProcessLimitsV1::default(),
        }
    }
}

impl BrokerServerPolicyV1 {
    fn validate(self) -> Result<Self, BrokerServerError> {
        if self.version != 1
            || self.worker_threads == 0
            || self.worker_threads > HARD_MAXIMUM_WORKERS
            || self.queue_capacity == 0
            || self.queue_capacity > HARD_MAXIMUM_QUEUE_CAPACITY
            || self.accept_poll_ms == 0
            || self.accept_poll_ms > HARD_MAXIMUM_ACCEPT_POLL_MS
            || self.write_timeout_ms == 0
            || self.write_timeout_ms > HARD_MAXIMUM_WRITE_TIMEOUT_MS
            || self.busy_retry_after_ms == 0
            || self.maximum_connections == 0
            || self.maximum_connections > HARD_MAXIMUM_CONNECTIONS_PER_RUN
        {
            return Err(BrokerServerError::InvalidPolicy);
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerServerRunSummaryV1 {
    pub listener_qualification: BrokerListenerQualificationV1,
    pub accepted_connections: u64,
    pub queued_connections: u64,
    pub busy_connections: u64,
    pub reconciled_processes: u64,
    pub graceful_shutdown: bool,
    pub telemetry: BrokerTelemetrySnapshotV1,
}

/// Fake-only role service. It admits and durably reserves requests but does not launch Codex.
pub struct BrokerServerV1 {
    listener: BrokerListenerV1,
    peer_policy: PeerPolicyV1,
    trust_manager: Arc<CapabilityTrustBundleManagerV1>,
    admission_policy: AdmissionPolicyV1,
    journal_path: PathBuf,
    journal_policy: BrokerJournalPolicyV1,
    server_policy: BrokerServerPolicyV1,
    response_policy: BrokerResponseFramePolicyV1,
    clock: Arc<dyn BrokerClockV1>,
    shutdown: Arc<AtomicBool>,
    telemetry: Arc<BrokerTelemetryV1>,
}

impl BrokerServerV1 {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        listener: BrokerListenerV1,
        peer_policy: PeerPolicyV1,
        trust_manager: Arc<CapabilityTrustBundleManagerV1>,
        admission_policy: AdmissionPolicyV1,
        journal_path: PathBuf,
        journal_policy: BrokerJournalPolicyV1,
        server_policy: BrokerServerPolicyV1,
        response_policy: BrokerResponseFramePolicyV1,
        clock: Arc<dyn BrokerClockV1>,
        shutdown: Arc<AtomicBool>,
    ) -> Result<Self, BrokerServerError> {
        let server_policy = server_policy.validate()?;
        if journal_path.as_os_str().is_empty() {
            return Err(BrokerServerError::InvalidPolicy);
        }
        Ok(Self {
            listener,
            peer_policy,
            trust_manager,
            admission_policy,
            journal_path,
            journal_policy,
            server_policy,
            response_policy,
            clock,
            shutdown,
            telemetry: Arc::new(BrokerTelemetryV1::default()),
        })
    }

    /// Replaces the default in-memory telemetry sink with a caller-owned sink.
    #[must_use]
    pub fn with_telemetry(mut self, telemetry: Arc<BrokerTelemetryV1>) -> Self {
        self.telemetry = telemetry;
        self
    }

    /// Runs until shutdown or the configured deterministic connection limit.
    pub fn run(self) -> Result<BrokerServerRunSummaryV1, BrokerServerError> {
        let now = self.clock.now_unix_ms()?;
        let (_, _, startup_bundle_hash) = self.trust_manager.snapshot(now)?;
        let startup_peer_policy_hash = self.peer_policy.policy_hash()?;
        let mut journal_probe =
            BrokerJournalStoreV1::open(&self.journal_path, self.journal_policy)?;
        journal_probe.validate_integrity()?;
        let reconciled_processes = reconcile_before_listener_ready(
            &mut journal_probe,
            now,
            self.server_policy.startup_process_limits,
        )?;
        self.telemetry.reconciled(reconciled_processes);
        journal_probe.validate_integrity()?;
        drop(journal_probe);
        let qualification = self.listener.mark_ready()?;
        if startup_bundle_hash != qualification.trust_bundle_hash {
            return Err(BrokerServerError::TrustBundleBindingMismatch);
        }
        if startup_peer_policy_hash != qualification.peer_policy_hash {
            return Err(BrokerServerError::PeerPolicyBindingMismatch);
        }

        let (sender, receiver) = sync_channel(self.server_policy.queue_capacity);
        let receiver = Arc::new(Mutex::new(receiver));
        let mut worker_handles = Vec::with_capacity(self.server_policy.worker_threads);
        for _ in 0..self.server_policy.worker_threads {
            let journal = BrokerJournalStoreV1::open(&self.journal_path, self.journal_policy)?;
            worker_handles.push(spawn_worker(
                receiver.clone(),
                journal,
                self.peer_policy.clone(),
                self.trust_manager.clone(),
                self.admission_policy.clone(),
                self.response_policy,
                self.clock.clone(),
                self.shutdown.clone(),
                qualification.trust_bundle_hash.clone(),
                self.server_policy.write_timeout_ms,
                self.telemetry.clone(),
            ));
        }

        let mut accepted_connections = 0_u64;
        let mut queued_connections = 0_u64;
        let mut busy_connections = 0_u64;
        while !self.shutdown.load(Ordering::Acquire)
            && accepted_connections < self.server_policy.maximum_connections
        {
            match self.listener.accept()? {
                Some(stream) => {
                    accepted_connections = accepted_connections.saturating_add(1);
                    self.telemetry.accepted();
                    match sender.try_send(stream) {
                        Ok(()) => {
                            queued_connections = queued_connections.saturating_add(1);
                            self.telemetry.queued();
                        }
                        Err(TrySendError::Full(mut stream)) => {
                            busy_connections = busy_connections.saturating_add(1);
                            self.telemetry.busy();
                            configure_write_timeout(&stream, self.server_policy.write_timeout_ms)?;
                            let response =
                                BrokerResponseV1::busy(self.server_policy.busy_retry_after_ms);
                            if write_response_frame(&mut stream, &response, self.response_policy)
                                .is_err()
                            {
                                self.telemetry.response_write_failed();
                            }
                        }
                        Err(TrySendError::Disconnected(mut stream)) => {
                            self.shutdown.store(true, Ordering::Release);
                            let response = BrokerResponseV1::rejected(
                                BrokerMachineCodeV1::ServiceStopping,
                                None,
                            );
                            if write_response_frame(&mut stream, &response, self.response_policy)
                                .is_err()
                            {
                                self.telemetry.response_write_failed();
                            }
                            break;
                        }
                    }
                }
                None => thread::sleep(Duration::from_millis(self.server_policy.accept_poll_ms)),
            }
        }

        self.shutdown.store(true, Ordering::Release);
        drop(sender);
        for handle in worker_handles {
            match handle.join() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    self.telemetry.worker_failed();
                    return Err(error);
                }
                Err(_) => {
                    self.telemetry.worker_failed();
                    return Err(BrokerServerError::WorkerPanicked);
                }
            }
        }
        self.listener.shutdown()?;
        let telemetry = self.telemetry.snapshot();
        Ok(BrokerServerRunSummaryV1 {
            listener_qualification: qualification,
            accepted_connections,
            queued_connections,
            busy_connections,
            reconciled_processes,
            graceful_shutdown: true,
            telemetry,
        })
    }
}

fn reconcile_before_listener_ready(
    journal: &mut BrokerJournalStoreV1,
    now_unix_ms: u64,
    limits: ProcessLimitsV1,
) -> Result<u64, BrokerServerError> {
    let records = journal.reconcile_pending_processes(now_unix_ms, limits)?;
    validate_startup_reconciliation(&records)
}

fn validate_startup_reconciliation(
    records: &[BrokerProcessReconciliationV1],
) -> Result<u64, BrokerServerError> {
    if let Some(record) = records.iter().find(|record| {
        record.disposition == ProcessReconciliationDispositionV1::ManualIdentityMismatch
    }) {
        return Err(BrokerServerError::StartupProcessIdentityMismatch(
            record.operation_id.clone(),
        ));
    }
    u64::try_from(records.len()).map_err(|_| BrokerServerError::NumericOverflow)
}

#[allow(clippy::too_many_arguments)]
fn spawn_worker(
    receiver: Arc<Mutex<Receiver<std::os::unix::net::UnixStream>>>,
    mut journal: BrokerJournalStoreV1,
    peer_policy: PeerPolicyV1,
    trust_manager: Arc<CapabilityTrustBundleManagerV1>,
    admission_policy: AdmissionPolicyV1,
    response_policy: BrokerResponseFramePolicyV1,
    clock: Arc<dyn BrokerClockV1>,
    shutdown: Arc<AtomicBool>,
    startup_bundle_hash: hepta_codex_protocol::Sha256Digest,
    write_timeout_ms: u64,
    telemetry: Arc<BrokerTelemetryV1>,
) -> thread::JoinHandle<Result<(), BrokerServerError>> {
    thread::spawn(move || {
        loop {
            let received = {
                let receiver = receiver
                    .lock()
                    .map_err(|_| BrokerServerError::WorkerQueuePoisoned)?;
                receiver.recv_timeout(Duration::from_millis(20))
            };
            let mut stream = match received {
                Ok(stream) => stream,
                Err(RecvTimeoutError::Timeout) if shutdown.load(Ordering::Acquire) => break,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            configure_write_timeout(&stream, write_timeout_ms)?;
            let now = clock.now_unix_ms()?;
            let (trust_store, _, _) = match trust_manager.snapshot(now) {
                Ok(value) if value.2 == startup_bundle_hash => value,
                Ok(_) => {
                    telemetry.trust_bundle_changed();
                    shutdown.store(true, Ordering::Release);
                    let _ = write_rejection(
                        &mut stream,
                        BrokerMachineCodeV1::TrustBundleChanged,
                        response_policy,
                    );
                    continue;
                }
                Err(_) => {
                    telemetry.capability_unavailable();
                    shutdown.store(true, Ordering::Release);
                    let _ = write_rejection(
                        &mut stream,
                        BrokerMachineCodeV1::CapabilityUnavailable,
                        response_policy,
                    );
                    continue;
                }
            };
            match admit_and_reserve_unix_stream(
                &stream,
                &peer_policy,
                &trust_store,
                &mut journal,
                now,
                admission_policy.clone(),
                FaultInjectionPointV1::None,
            ) {
                Ok(reservation) => {
                    let (kind, journal_state) = match reservation.outcome {
                        ReservationOutcomeV1::Reserved(journal) => (true, journal.current_state),
                        ReservationOutcomeV1::Existing(journal) => (false, journal.current_state),
                    };
                    let response = if kind {
                        telemetry.reserved();
                        BrokerResponseV1::reserved(
                            reservation.operation_id,
                            reservation.request_hash,
                            journal_state,
                        )
                    } else {
                        telemetry.existing();
                        BrokerResponseV1::existing(
                            reservation.operation_id,
                            reservation.request_hash,
                            journal_state,
                        )
                    };
                    if write_response_frame(&mut stream, &response, response_policy).is_err() {
                        telemetry.response_write_failed();
                    }
                }
                Err(error) => {
                    let (code, fatal) = classify_state_error(&error);
                    match code {
                        BrokerMachineCodeV1::AdmissionRejected => telemetry.admission_rejected(),
                        BrokerMachineCodeV1::JournalConflict => telemetry.journal_conflict(),
                        BrokerMachineCodeV1::JournalUnavailable => telemetry.journal_failure(),
                        _ => {}
                    }
                    if fatal {
                        shutdown.store(true, Ordering::Release);
                    }
                    if !write_rejection(&mut stream, code, response_policy) {
                        telemetry.response_write_failed();
                    }
                }
            }
        }
        Ok(())
    })
}

fn classify_state_error(error: &BrokerStateError) -> (BrokerMachineCodeV1, bool) {
    match error {
        BrokerStateError::Admission(_) => (BrokerMachineCodeV1::AdmissionRejected, false),
        BrokerStateError::Journal(
            BrokerJournalError::IdempotencyConflict
            | BrokerJournalError::OperationIdentityConflict
            | BrokerJournalError::CapabilityNonceReplay
            | BrokerJournalError::StateConflict { .. }
            | BrokerJournalError::ConcurrentStateChange,
        ) => (BrokerMachineCodeV1::JournalConflict, false),
        BrokerStateError::Journal(_) => (BrokerMachineCodeV1::JournalUnavailable, true),
    }
}

fn configure_write_timeout(
    stream: &std::os::unix::net::UnixStream,
    write_timeout_ms: u64,
) -> Result<(), BrokerServerError> {
    stream
        .set_write_timeout(Some(Duration::from_millis(write_timeout_ms)))
        .map_err(|error| BrokerServerError::SocketConfiguration(error.kind()))
}

fn write_rejection(
    stream: &mut std::os::unix::net::UnixStream,
    code: BrokerMachineCodeV1,
    policy: BrokerResponseFramePolicyV1,
) -> bool {
    let response = BrokerResponseV1::rejected(code, None);
    write_response_frame(stream, &response, policy).is_ok()
}

#[derive(Debug, Error)]
pub enum BrokerServerError {
    #[error("broker server policy is invalid")]
    InvalidPolicy,
    #[error("broker clock is unavailable")]
    ClockUnavailable,
    #[error("broker listener trust-bundle binding changed")]
    TrustBundleBindingMismatch,
    #[error("broker listener peer-policy binding changed")]
    PeerPolicyBindingMismatch,
    #[error("startup process identity mismatch requires manual recovery: {0}")]
    StartupProcessIdentityMismatch(String),
    #[error("broker numeric conversion overflowed")]
    NumericOverflow,
    #[error("broker worker queue lock was poisoned")]
    WorkerQueuePoisoned,
    #[error("broker worker panicked")]
    WorkerPanicked,
    #[error("socket configuration failed: {0:?}")]
    SocketConfiguration(std::io::ErrorKind),
    #[error(transparent)]
    Listener(#[from] BrokerListenerError),
    #[error(transparent)]
    TrustBundle(#[from] TrustBundleError),
    #[error(transparent)]
    Peer(#[from] PeerAuthorizationError),
    #[error(transparent)]
    Journal(#[from] BrokerJournalError),
    #[error(transparent)]
    Response(#[from] BrokerResponseError),
}

#[cfg(test)]
mod tests {
    use std::{
        os::unix::net::UnixStream,
        sync::mpsc::{TrySendError, sync_channel},
    };

    use super::*;
    use crate::read_response_frame;

    #[derive(Clone, Copy)]
    struct FixedClock(u64);

    impl BrokerClockV1 for FixedClock {
        fn now_unix_ms(&self) -> Result<u64, BrokerServerError> {
            Ok(self.0)
        }
    }

    #[test]
    fn policy_rejects_unbounded_worker_or_queue_configuration() {
        let policy = BrokerServerPolicyV1 {
            worker_threads: HARD_MAXIMUM_WORKERS + 1,
            ..BrokerServerPolicyV1::default()
        };
        assert!(matches!(
            policy.validate(),
            Err(BrokerServerError::InvalidPolicy)
        ));
        let policy = BrokerServerPolicyV1 {
            queue_capacity: HARD_MAXIMUM_QUEUE_CAPACITY + 1,
            ..BrokerServerPolicyV1::default()
        };
        assert!(matches!(
            policy.validate(),
            Err(BrokerServerError::InvalidPolicy)
        ));
    }

    #[test]
    fn queue_full_response_is_machine_readable() {
        let (sender, _receiver) = sync_channel(1);
        let (_client_one, server_one) = UnixStream::pair().expect("first pair");
        sender.try_send(server_one).expect("fill queue");
        let (mut client_two, mut server_two) = UnixStream::pair().expect("second pair");
        match sender.try_send(server_two) {
            Err(TrySendError::Full(returned)) => server_two = returned,
            _ => panic!("queue must be full"),
        }
        let response = BrokerResponseV1::busy(50);
        write_response_frame(
            &mut server_two,
            &response,
            BrokerResponseFramePolicyV1::default(),
        )
        .expect("busy response");
        let (decoded, _) =
            read_response_frame(&mut client_two, BrokerResponseFramePolicyV1::default())
                .expect("read busy response");
        assert_eq!(decoded, response);
    }

    #[test]
    fn fixed_clock_is_deterministic() {
        assert_eq!(FixedClock(42).now_unix_ms().expect("clock"), 42);
    }

    #[test]
    fn startup_identity_mismatch_blocks_listener_readiness() {
        use hepta_codex_journal::OperationState;
        use hepta_codex_runtime::GateProcessObservationV1;

        let records = [BrokerProcessReconciliationV1 {
            operation_id: "operation-mismatch".to_owned(),
            prior_state: OperationState::ProcessSpawned,
            observation: GateProcessObservationV1::IdentityMismatch,
            disposition: ProcessReconciliationDispositionV1::ManualIdentityMismatch,
        }];
        assert!(matches!(
            validate_startup_reconciliation(&records),
            Err(BrokerServerError::StartupProcessIdentityMismatch(operation_id))
                if operation_id == "operation-mismatch"
        ));
    }

    #[test]
    fn successful_startup_reconciliation_is_counted() {
        use hepta_codex_journal::OperationState;
        use hepta_codex_runtime::GateProcessObservationV1;

        let records = [BrokerProcessReconciliationV1 {
            operation_id: "operation-recovered".to_owned(),
            prior_state: OperationState::ProcessSpawned,
            observation: GateProcessObservationV1::Blocked,
            disposition: ProcessReconciliationDispositionV1::BlockedGateTerminated,
        }];
        assert_eq!(validate_startup_reconciliation(&records).expect("count"), 1);
    }
}
