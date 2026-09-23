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
    verify_request_capability, write_response_frame,
};
use crate::{admission::read_unix_request, service::reserve_authenticated_request_revalidated};

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

/// Optional trusted composition of request preparation and qualified execution.
/// Implementations must call the production dispatch API and preserve deployment authority.
/// Startup recovery must clean exact persisted cgroups before generic process reconciliation.
pub trait BrokerOperationDispatcherV1: Send + Sync {
    fn recover_before_ready(
        &self,
        journal: &mut BrokerJournalStoreV1,
    ) -> Result<(), crate::CodexDispatchError>;
    fn dispatch(
        &self,
        journal: &mut BrokerJournalStoreV1,
        operation_id: &str,
        cancelled: &AtomicBool,
    ) -> Result<(), crate::CodexDispatchError>;
}

/// Role-specific service; reservation-only by default, with explicit qualified dispatch opt-in.
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
    dispatcher: Option<Arc<dyn BrokerOperationDispatcherV1>>,
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
            dispatcher: None,
        })
    }

    /// Replaces the default in-memory telemetry sink with a caller-owned sink.
    #[must_use]
    pub fn with_telemetry(mut self, telemetry: Arc<BrokerTelemetryV1>) -> Self {
        self.telemetry = telemetry;
        self
    }

    /// Installs explicit production composition. Absence retains reservation-only behavior.
    #[must_use]
    pub fn with_dispatcher(mut self, dispatcher: Arc<dyn BrokerOperationDispatcherV1>) -> Self {
        self.dispatcher = Some(dispatcher);
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
        if let Some(dispatcher) = &self.dispatcher {
            dispatcher.recover_before_ready(&mut journal_probe)?;
        }
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
        let mut first_error = None;
        for _ in 0..self.server_policy.worker_threads {
            let journal = match BrokerJournalStoreV1::open(&self.journal_path, self.journal_policy)
            {
                Ok(journal) => journal,
                Err(error) => {
                    first_error = Some(error.into());
                    break;
                }
            };
            match spawn_worker(
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
                self.dispatcher.clone(),
            ) {
                Ok(handle) => worker_handles.push(handle),
                Err(error) => {
                    first_error = Some(error);
                    break;
                }
            }
        }
        // Only workers own receivers after startup. An exited worker must not
        // leave an unreachable queue artificially connected to the accept loop.
        drop(receiver);

        let mut accepted_connections = 0_u64;
        let mut queued_connections = 0_u64;
        let mut busy_connections = 0_u64;
        if first_error.is_none() {
            // Every error after the first worker starts returns to the common
            // cleanup below; no live JoinHandle is detached by an early `?`.
            let acceptance = (|| -> Result<(), BrokerServerError> {
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
                                    configure_write_timeout(
                                        &stream,
                                        self.server_policy.write_timeout_ms,
                                    )?;
                                    let response = BrokerResponseV1::busy(
                                        self.server_policy.busy_retry_after_ms,
                                    );
                                    if write_response_frame(
                                        &mut stream,
                                        &response,
                                        self.response_policy,
                                    )
                                    .is_err()
                                    {
                                        self.telemetry.response_write_failed();
                                    }
                                }
                                Err(TrySendError::Disconnected(mut stream)) => {
                                    self.shutdown.store(true, Ordering::Release);
                                    configure_write_timeout(
                                        &stream,
                                        self.server_policy.write_timeout_ms,
                                    )?;
                                    let response = BrokerResponseV1::rejected(
                                        BrokerMachineCodeV1::ServiceStopping,
                                        None,
                                    );
                                    if write_response_frame(
                                        &mut stream,
                                        &response,
                                        self.response_policy,
                                    )
                                    .is_err()
                                    {
                                        self.telemetry.response_write_failed();
                                    }
                                    break;
                                }
                            }
                        }
                        None => {
                            thread::sleep(Duration::from_millis(self.server_policy.accept_poll_ms));
                        }
                    }
                }
                Ok(())
            })();
            if let Err(error) = acceptance {
                first_error = Some(error);
            }
        }

        // Reaching the acceptance cap drains already admitted work. Only an explicit
        // shutdown or failure cancels a released operation; closing the queue wakes workers.
        if first_error.is_some() {
            self.shutdown.store(true, Ordering::Release);
        }
        drop(sender);
        join_workers(worker_handles, &self.telemetry, &mut first_error);
        if let Err(error) = self.listener.shutdown()
            && first_error.is_none()
        {
            first_error = Some(error.into());
        }
        if let Some(error) = first_error {
            return Err(error);
        }
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

fn join_workers(
    handles: Vec<thread::JoinHandle<Result<(), BrokerServerError>>>,
    telemetry: &BrokerTelemetryV1,
    first_error: &mut Option<BrokerServerError>,
) {
    for handle in handles {
        let failure = match handle.join() {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some(BrokerServerError::WorkerPanicked),
        };
        if let Some(error) = failure {
            telemetry.worker_failed();
            if first_error.is_none() {
                *first_error = Some(error);
            }
        }
    }
}

/// A worker failure, including unwinding, must stop acceptance even before join.
/// Normal queue draining must not cancel another worker's in-flight operation.
struct WorkerExitGuard {
    shutdown: Arc<AtomicBool>,
    completed: bool,
}

impl Drop for WorkerExitGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.shutdown.store(true, Ordering::Release);
        }
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
    dispatcher: Option<Arc<dyn BrokerOperationDispatcherV1>>,
) -> Result<thread::JoinHandle<Result<(), BrokerServerError>>, BrokerServerError> {
    let builder = thread::Builder::new().name("hepta-broker-worker".to_owned());
    let handle = builder.spawn(move || {
        let mut exit_guard = WorkerExitGuard {
            shutdown: shutdown.clone(),
            completed: false,
        };
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
            let pending = match read_unix_request(&stream, &peer_policy, admission_policy.clone()) {
                Ok(pending) => pending,
                Err(_) => {
                    telemetry.admission_rejected();
                    if !write_rejection(
                        &mut stream,
                        BrokerMachineCodeV1::AdmissionRejected,
                        response_policy,
                    ) {
                        telemetry.response_write_failed();
                    }
                    continue;
                }
            };
            // Socket I/O has finished. Use the actual current clock and trust
            // state, never the time observed before a potentially slow frame.
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
            let reservation = pending
                .authenticate(&trust_store, now)
                .map_err(|error| ServerReservationError::State(BrokerStateError::Admission(error)))
                .and_then(|admitted| {
                    reserve_authenticated_request_revalidated(
                        admitted,
                        &mut journal,
                        now,
                        FaultInjectionPointV1::None,
                        |admitted| {
                            let current_now =
                                clock.now_unix_ms().map_err(ServerReservationError::Clock)?;
                            if current_now < now {
                                return Err(ServerReservationError::Clock(
                                    BrokerServerError::ClockUnavailable,
                                ));
                            }
                            let (current_trust, _, current_bundle_hash) = trust_manager
                                .snapshot(current_now)
                                .map_err(|_| ServerReservationError::TrustUnavailable)?;
                            if current_bundle_hash != startup_bundle_hash {
                                return Err(ServerReservationError::TrustChanged);
                            }
                            verify_request_capability(
                                admitted.request(),
                                admitted.peer(),
                                current_now,
                                admission_policy.capability,
                                &current_trust,
                            )
                            .map_err(|error| {
                                ServerReservationError::State(BrokerStateError::Admission(
                                    crate::AdmissionError::Capability(error),
                                ))
                            })?;
                            Ok(current_now)
                        },
                    )
                });
            match reservation {
                Ok(reservation) => {
                    let (kind, mut journal_state) = match reservation.outcome {
                        ReservationOutcomeV1::Reserved(journal) => (true, journal.current_state),
                        ReservationOutcomeV1::Existing(journal) => (false, journal.current_state),
                    };
                    if kind && let Some(dispatcher) = &dispatcher {
                        if dispatcher
                            .dispatch(&mut journal, &reservation.operation_id, &shutdown)
                            .is_err()
                        {
                            // The durable state carries failure/ambiguity; never resubmit this operation.
                            // An error before a state transition is an internal dispatch rejection.
                            let state = journal
                                .load_journal(&reservation.operation_id)?
                                .current_state;
                            if state == hepta_codex_journal::OperationState::Reserved {
                                journal.append_transition(
                                    &reservation.operation_id,
                                    state,
                                    hepta_codex_journal::OperationState::RejectedPreflight,
                                    clock.now_unix_ms()?,
                                    None,
                                    Some("codex_dispatch_rejected".to_owned()),
                                    FaultInjectionPointV1::None,
                                )?;
                            }
                        }
                        journal_state = journal
                            .load_journal(&reservation.operation_id)?
                            .current_state;
                    }
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
                    let (code, fatal) = match error {
                        ServerReservationError::State(error) => classify_state_error(&error),
                        ServerReservationError::TrustChanged => {
                            (BrokerMachineCodeV1::TrustBundleChanged, true)
                        }
                        ServerReservationError::TrustUnavailable => {
                            (BrokerMachineCodeV1::CapabilityUnavailable, true)
                        }
                        ServerReservationError::Clock(error) => return Err(error),
                    };
                    match code {
                        BrokerMachineCodeV1::AdmissionRejected => telemetry.admission_rejected(),
                        BrokerMachineCodeV1::JournalConflict => telemetry.journal_conflict(),
                        BrokerMachineCodeV1::JournalUnavailable => telemetry.journal_failure(),
                        BrokerMachineCodeV1::TrustBundleChanged => telemetry.trust_bundle_changed(),
                        BrokerMachineCodeV1::CapabilityUnavailable => {
                            telemetry.capability_unavailable()
                        }
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
        exit_guard.completed = true;
        Ok(())
    });
    handle.map_err(|error| BrokerServerError::WorkerSpawn(error.kind()))
}

enum ServerReservationError {
    State(BrokerStateError),
    Clock(BrokerServerError),
    TrustChanged,
    TrustUnavailable,
}

impl From<BrokerJournalError> for ServerReservationError {
    fn from(error: BrokerJournalError) -> Self {
        Self::State(BrokerStateError::Journal(error))
    }
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
    #[error("broker worker creation failed: {0:?}")]
    WorkerSpawn(std::io::ErrorKind),
    #[error("socket configuration failed: {0:?}")]
    SocketConfiguration(std::io::ErrorKind),
    #[error(transparent)]
    Dispatch(#[from] crate::CodexDispatchError),
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

    #[test]
    fn join_workers_waits_for_every_worker_after_first_failure() {
        use std::sync::mpsc::{RecvTimeoutError, channel};

        let (first_ready_tx, first_ready_rx) = channel();
        let first = thread::spawn(move || {
            first_ready_tx.send(()).expect("first worker ready");
            Err(BrokerServerError::ClockUnavailable)
        });
        first_ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first failure is ready before joining");

        let (second_ready_tx, second_ready_rx) = channel();
        let (release_tx, release_rx) = channel();
        let completed = Arc::new(AtomicBool::new(false));
        let second_completed = completed.clone();
        let second = thread::spawn(move || {
            second_ready_tx.send(()).expect("second worker ready");
            release_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("owned second worker release");
            second_completed.store(true, Ordering::Release);
            Ok(())
        });
        second_ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("second worker is still active");

        let (joining_tx, joining_rx) = channel();
        let (done_tx, done_rx) = channel();
        let owner = thread::spawn(move || {
            let telemetry = BrokerTelemetryV1::default();
            let mut first_error = None;
            joining_tx.send(()).expect("join owner ready");
            // This is the same helper consumed by the public server, with a
            // deterministic failing-first order and an actually blocked worker.
            join_workers(vec![first, second], &telemetry, &mut first_error);
            done_tx
                .send((first_error, telemetry.snapshot()))
                .expect("joined worker result");
        });
        joining_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("join owner started");
        let premature = done_rx.recv_timeout(Duration::from_millis(50));
        // Release before asserting so even a regressed early-return helper does
        // not leave this owned test worker waiting indefinitely.
        release_tx.send(()).expect("release second worker");
        let returned_early = premature.is_ok();
        let (error, telemetry) = match premature {
            Ok(value) => value,
            Err(RecvTimeoutError::Timeout) => done_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("all workers joined after release"),
            Err(RecvTimeoutError::Disconnected) => panic!("join owner disconnected"),
        };
        owner.join().expect("join owner does not panic");
        assert!(
            !returned_early,
            "first failure must not detach later workers"
        );
        assert!(completed.load(Ordering::Acquire));
        assert!(matches!(error, Some(BrokerServerError::ClockUnavailable)));
        assert_eq!(telemetry.worker_failures, 1);
    }
}
