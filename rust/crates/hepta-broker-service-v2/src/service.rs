use std::{
    os::unix::net::UnixStream,
    sync::{Arc, Mutex, mpsc::{self, Receiver, RecvTimeoutError, TryRecvError, TrySendError, sync_channel}},
    thread,
    time::Duration,
};

use crate::{
    BrokerMachineReasonV2, BrokerServiceErrorV2, BrokerTelemetrySnapshotV2, BrokerTelemetryV2,
    ListenerEventV2, PeerPrincipalV2, RoleListenerV2, ShutdownHandleV2,
};

const MAXIMUM_WORKERS: usize = 32;
const MAXIMUM_QUEUE: usize = 256;
const MAXIMUM_POLL_MS: u64 = 1_000;
const MAXIMUM_CONNECTIONS: u64 = 1_000_000;

pub trait ConnectionHandlerV2: Send + Sync + 'static {
    fn handle(
        &self,
        stream: UnixStream,
        peer: PeerPrincipalV2,
    ) -> Result<(), BrokerServiceErrorV2>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BrokerServicePolicyV2 {
    pub worker_threads: usize,
    pub queue_capacity: usize,
    pub poll_interval_ms: u64,
    pub maximum_connections: u64,
}

impl Default for BrokerServicePolicyV2 {
    fn default() -> Self {
        Self {
            worker_threads: 4,
            queue_capacity: 32,
            poll_interval_ms: 10,
            maximum_connections: MAXIMUM_CONNECTIONS,
        }
    }
}

impl BrokerServicePolicyV2 {
    fn validate(self) -> Result<Self, BrokerServiceErrorV2> {
        if self.worker_threads == 0
            || self.worker_threads > MAXIMUM_WORKERS
            || self.queue_capacity == 0
            || self.queue_capacity > MAXIMUM_QUEUE
            || self.poll_interval_ms == 0
            || self.poll_interval_ms > MAXIMUM_POLL_MS
            || self.maximum_connections == 0
            || self.maximum_connections > MAXIMUM_CONNECTIONS
        {
            return Err(BrokerServiceErrorV2::InvalidPolicy);
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerServiceSummaryV2 {
    pub accepted_connections: u64,
    pub graceful_shutdown: bool,
    pub telemetry: BrokerTelemetrySnapshotV2,
}

pub struct RoleBrokerServiceV2 {
    listener: RoleListenerV2,
    handler: Arc<dyn ConnectionHandlerV2>,
    policy: BrokerServicePolicyV2,
    telemetry: Arc<BrokerTelemetryV2>,
}

impl RoleBrokerServiceV2 {
    pub fn new(
        listener: RoleListenerV2,
        handler: Arc<dyn ConnectionHandlerV2>,
        policy: BrokerServicePolicyV2,
        telemetry: Arc<BrokerTelemetryV2>,
    ) -> Result<Self, BrokerServiceErrorV2> {
        Ok(Self {
            listener,
            handler,
            policy: policy.validate()?,
            telemetry,
        })
    }

    #[must_use]
    pub fn shutdown_handle(&self) -> ShutdownHandleV2 {
        self.listener.shutdown_handle()
    }

    pub fn run(self) -> Result<BrokerServiceSummaryV2, BrokerServiceErrorV2> {
        let (sender, receiver) = sync_channel::<(UnixStream, PeerPrincipalV2)>(self.policy.queue_capacity);
        let receiver = Arc::new(Mutex::new(receiver));
        let (error_sender, error_receiver) = mpsc::channel::<String>();
        let mut workers = Vec::with_capacity(self.policy.worker_threads);
        for _ in 0..self.policy.worker_threads {
            workers.push(spawn_worker(
                receiver.clone(),
                self.handler.clone(),
                error_sender.clone(),
                self.telemetry.clone(),
            ));
        }
        drop(error_sender);

        let mut accepted_connections = 0_u64;
        let mut graceful_shutdown = false;
        let mut fatal_error = None;
        while accepted_connections < self.policy.maximum_connections {
            match error_receiver.try_recv() {
                Ok(message) => {
                    fatal_error = Some(BrokerServiceErrorV2::WorkerFailed(message));
                    break;
                }
                Err(TryRecvError::Disconnected | TryRecvError::Empty) => {}
            }
            match self.listener.accept_or_shutdown() {
                Ok(ListenerEventV2::Connection(stream)) => {
                    accepted_connections = accepted_connections
                        .checked_add(1)
                        .ok_or(BrokerServiceErrorV2::NumericOverflow)?;
                    self.telemetry.record(BrokerMachineReasonV2::Accepted);
                    let peer = match self.listener.authorize_peer(&stream) {
                        Ok(peer) => peer,
                        Err(BrokerServiceErrorV2::PeerUnauthorized) => {
                            self.telemetry.record(BrokerMachineReasonV2::PeerUnauthorized);
                            continue;
                        }
                        Err(error) => {
                            self.telemetry.record(BrokerMachineReasonV2::ListenerFailure);
                            fatal_error = Some(error);
                            break;
                        }
                    };
                    match sender.try_send((stream, peer)) {
                        Ok(()) => self.telemetry.record(BrokerMachineReasonV2::Queued),
                        Err(TrySendError::Full(_)) => {
                            self.telemetry.record(BrokerMachineReasonV2::QueueFull);
                        }
                        Err(TrySendError::Disconnected(_)) => {
                            fatal_error = Some(BrokerServiceErrorV2::WorkerFailed(
                                "all workers disconnected".to_owned(),
                            ));
                            break;
                        }
                    }
                }
                Ok(ListenerEventV2::Shutdown) => {
                    graceful_shutdown = true;
                    self.telemetry.record(BrokerMachineReasonV2::GracefulShutdown);
                    break;
                }
                Ok(ListenerEventV2::Idle) => {
                    thread::sleep(Duration::from_millis(self.policy.poll_interval_ms));
                }
                Err(error) => {
                    self.telemetry.record(BrokerMachineReasonV2::ListenerFailure);
                    fatal_error = Some(error);
                    break;
                }
            }
        }
        drop(sender);
        for worker in workers {
            match worker.join() {
                Ok(()) => {}
                Err(_) => {
                    self.telemetry.record(BrokerMachineReasonV2::WorkerPanicked);
                    if fatal_error.is_none() {
                        fatal_error = Some(BrokerServiceErrorV2::WorkerPanicked);
                    }
                }
            }
        }
        self.listener.shutdown()?;
        if let Some(error) = fatal_error {
            return Err(error);
        }
        Ok(BrokerServiceSummaryV2 {
            accepted_connections,
            graceful_shutdown,
            telemetry: self.telemetry.snapshot(),
        })
    }
}

fn spawn_worker(
    receiver: Arc<Mutex<Receiver<(UnixStream, PeerPrincipalV2)>>>,
    handler: Arc<dyn ConnectionHandlerV2>,
    error_sender: mpsc::Sender<String>,
    telemetry: Arc<BrokerTelemetryV2>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || loop {
        let received = {
            let receiver = match receiver.lock() {
                Ok(receiver) => receiver,
                Err(_) => {
                    let _ = error_sender.send("worker queue poisoned".to_owned());
                    return;
                }
            };
            receiver.recv_timeout(Duration::from_millis(50))
        };
        let (stream, peer) = match received {
            Ok(value) => value,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        if let Err(error) = handler.handle(stream, peer) {
            telemetry.record(BrokerMachineReasonV2::HandlerFatal);
            let _ = error_sender.send(error.to_string());
            return;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ListenerAccessModeV2, ListenerPolicyV2, PeerPrincipalV2};
    use std::{
        collections::BTreeSet,
        fs,
        io::Read,
        os::unix::{fs::{MetadataExt, PermissionsExt}, net::UnixStream},
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
        time::{Instant, SystemTime, UNIX_EPOCH},
    };

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "hepta-service-v2-{}-{nonce}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).expect("root");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("mode");
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct CountingHandler(Arc<AtomicU64>);

    impl ConnectionHandlerV2 for CountingHandler {
        fn handle(
            &self,
            mut stream: UnixStream,
            _peer: PeerPrincipalV2,
        ) -> Result<(), BrokerServiceErrorV2> {
            let mut byte = [0_u8; 1];
            stream
                .read_exact(&mut byte)
                .map_err(|error| BrokerServiceErrorV2::Socket("handler_read", error.kind()))?;
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    fn listener(path: &Path) -> RoleListenerV2 {
        let metadata = fs::metadata(path.parent().expect("parent")).expect("metadata");
        let peer = PeerPrincipalV2 {
            uid: metadata.uid(),
            gid: metadata.gid(),
        };
        RoleListenerV2::bind(ListenerPolicyV2 {
            socket_path: path.to_path_buf(),
            service_uid: peer.uid,
            service_gid: peer.gid,
            parent_mode: 0o700,
            socket_mode: 0o600,
            generation: 1,
            access_mode: ListenerAccessModeV2::ServiceOnly,
            allowed_peers: BTreeSet::from([peer]),
        })
        .expect("listener")
    }

    #[test]
    fn idle_shutdown_is_bounded_and_worker_errors_are_not_discarded() {
        let root = TempRoot::new();
        let socket = root.0.join("broker.sock");
        let listener = listener(&socket);
        let telemetry = Arc::new(BrokerTelemetryV2::default());
        let handled = Arc::new(AtomicU64::new(0));
        let service = RoleBrokerServiceV2::new(
            listener,
            Arc::new(CountingHandler(handled.clone())),
            BrokerServicePolicyV2::default(),
            telemetry,
        )
        .expect("service");
        let shutdown = service.shutdown_handle();
        let handle = thread::spawn(move || service.run());
        let started = Instant::now();
        shutdown.request_shutdown().expect("shutdown");
        let summary = handle.join().expect("join").expect("summary");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(summary.graceful_shutdown);
        assert_eq!(handled.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn authorized_connection_reaches_fixed_worker_pool() {
        let root = TempRoot::new();
        let socket = root.0.join("broker.sock");
        let listener = listener(&socket);
        let telemetry = Arc::new(BrokerTelemetryV2::default());
        let handled = Arc::new(AtomicU64::new(0));
        let service = RoleBrokerServiceV2::new(
            listener,
            Arc::new(CountingHandler(handled.clone())),
            BrokerServicePolicyV2::default(),
            telemetry,
        )
        .expect("service");
        let shutdown = service.shutdown_handle();
        let handle = thread::spawn(move || service.run());
        let mut client = loop {
            match UnixStream::connect(&socket) {
                Ok(client) => break client,
                Err(_) => thread::yield_now(),
            }
        };
        use std::io::Write;
        client.write_all(b"x").expect("write");
        let deadline = Instant::now() + Duration::from_secs(2);
        while handled.load(Ordering::Relaxed) != 1 && Instant::now() < deadline {
            thread::yield_now();
        }
        shutdown.request_shutdown().expect("shutdown");
        let summary = handle.join().expect("join").expect("summary");
        assert_eq!(handled.load(Ordering::Relaxed), 1);
        assert_eq!(summary.telemetry.queued, 1);
    }
}
