use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use thiserror::Error;

use crate::{
    AdmissionPolicyV1, BrokerJournalError, BrokerJournalPolicyV1, BrokerJournalStoreV1,
    BrokerListenerError, BrokerListenerQualificationV1, BrokerListenerV1, BrokerMachineCodeV1,
    BrokerResponseError, BrokerResponseFramePolicyV1, BrokerResponseV1, BrokerStateError,
    CapabilityTrustBundleManagerV1, FaultInjectionPointV1, PeerPolicyV1, ReservationOutcomeV1,
    TrustBundleError, admit_and_reserve_unix_stream, write_response_frame,
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
    pub graceful_shutdown: bool,
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
        })
    }

    /// Runs until shutdown or the configured deterministic connection limit.
    pub fn run(mut self) -> Result<BrokerServerRunSummaryV1, BrokerServerError> {
        let now = self.clock.now_unix_ms()?;
        let (_, _, startup_bundle_hash) = self.trust_manager.snapshot(now)?;
        let journal_probe = BrokerJournalStoreV1::open(&self.journal_path, self.journal_policy)?;
        journal_probe.validate_integrity()?;
        drop(journal_probe);
        let qualification = self.listener.mark_ready()?;
        if startup_bundle_hash != qualification.trust_bundle_hash {
            return Err(BrokerServerError::TrustBundleBindingMismatch);
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
                    match sender.try_send(stream) {
                        Ok(()) => {
                            queued_connections = queued_connections.saturating_add(1);
                        }
                        Err(TrySendError::Full(mut stream)) => {
                            busy_connections = busy_connections.saturating_add(1);
                            configure_write_timeout(
                                &stream,
                                self.server_policy.write_timeout_ms,
                            )?;
                            let response =
                                BrokerResponseV1::busy(self.server_policy.busy_retry_after_ms);
                            let _ = write_response_frame(
                                &mut stream,
                                &response,
                                self.response_policy,
                            );
                        }
                        Err(TrySendError::Disconnected(mut stream)) => {
                            self.shutdown.store(true, Ordering::Release);
                            let response = BrokerResponseV1::rejected(
                                BrokerMachineCodeV1::ServiceStopping,
                                None,
                            );
                            let _ = write_response_frame(
                                &mut stream,
                                &response,
                                self.response_policy,
                            );
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
            handle.join().map_err(|_| BrokerServerError::WorkerPanicked)??;
        }
        self.listener.shutdown()?;
        Ok(BrokerServerRunSummaryV1 {
            listener_qualification: qualification,
            accepted_connections,
            queued_connections,
            busy_connections,
            graceful_shutdown: true,
        })
    }
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
            let (trust_store, _, bundle_hash) = match trust_manager.snapshot(now) {
                Ok(value) if value.2 == startup_bundle_hash => value,
                Ok(_) => {
                    shutdown.store(true, Ordering::Release);
                    write_rejection(
                        &mut stream,
                        BrokerMachineCodeV1::TrustBundleChanged,
                        response_policy,
                    );
                    continue;
                }
                Err(_) => {
                    shutdown.store(true, Ordering::Release);
                    write_rejection(
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
                        ReservationOutcomeV1::Reserved(journal) => {
                            (true, journal.current_state)
                        }
                        ReservationOutcomeV1::Existing(journal) => {
                            (false, journal.current_state)
                        }
                    };
                    let response = if kind {
                        BrokerResponseV1::reserved(
                            reservation.operation_id,
                            reservation.request_hash,
                            journal_state,
                        )
                    } else {
                        BrokerResponseV1::existing(
                            reservation.operation_id,
                            reservation.request_hash,
                            journal_state,
                        )
                    };
                    let _ = write_response_frame(&mut stream, &response, response_policy);
                }
                Err(error) => {
                    let (code, fatal) = classify_state_error(&error);
                    if fatal {
                        shutdown.store(true, Ordering::Release);
                    }
                    write_rejection(&mut stream, code, response_policy);
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
) {
    let response = BrokerResponseV1::rejected(code, None);
    let _ = write_response_frame(stream, &response, policy);
}

#[derive(Debug, Error)]
pub enum BrokerServerError {
    #[error("broker server policy is invalid")]
    InvalidPolicy,
    #[error("broker clock is unavailable")]
    ClockUnavailable,
    #[error("broker listener trust-bundle binding changed")]
    TrustBundleBindingMismatch,
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
        let mut policy = BrokerServerPolicyV1::default();
        policy.worker_threads = HARD_MAXIMUM_WORKERS + 1;
        assert!(matches!(policy.validate(), Err(BrokerServerError::InvalidPolicy)));
        let mut policy = BrokerServerPolicyV1::default();
        policy.queue_capacity = HARD_MAXIMUM_QUEUE_CAPACITY + 1;
        assert!(matches!(policy.validate(), Err(BrokerServerError::InvalidPolicy)));
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
        let (decoded, _) = read_response_frame(
            &mut client_two,
            BrokerResponseFramePolicyV1::default(),
        )
        .expect("read busy response");
        assert_eq!(decoded, response);
    }

    #[test]
    fn fixed_clock_is_deterministic() {
        assert_eq!(FixedClock(42).now_unix_ms().expect("clock"), 42);
    }
}
