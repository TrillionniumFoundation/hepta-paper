use super::*;
use hepta_codex_broker::{BrokerOperationDispatcherV1, CodexDispatchError};

fn policy(workers: usize, maximum_connections: u64) -> BrokerServerPolicyV1 {
    BrokerServerPolicyV1 {
        worker_threads: workers,
        queue_capacity: 4,
        accept_poll_ms: 1,
        write_timeout_ms: 1_000,
        maximum_connections,
        ..BrokerServerPolicyV1::default()
    }
}

fn assert_stopped(fixture: &Fixture) {
    assert!(!fixture.root.join("broker.sock").exists());
    let marker: serde_json::Value = serde_json::from_slice(
        &fs::read(fixture.root.join("broker.sock.listener.json")).expect("retained marker"),
    )
    .expect("actual listener marker");
    assert_eq!(marker["phase"], "stopped");
}

#[test]
fn worker_clock_failure_stops_acceptance_without_reaching_the_connection_cap() {
    let fixture = Fixture::new();
    let mut server = fixture.server_with_policy(
        fixture.manager(),
        Arc::new(FailingAfterStartupClock {
            calls: AtomicU64::new(0),
        }),
        policy(1, 1_000_000),
        None,
    );
    let (bytes, _) = encoded(&fixture.request(now() + 20_000));
    server.client().write_all(&bytes).expect("actual request");
    server
        .done
        .recv_timeout(Duration::from_secs(5))
        .expect("worker failure must stop the actual accept loop");
    // Check before RunningServer::drop could set the caller's shutdown flag.
    assert!(server.shutdown.load(Ordering::Acquire));
    let result = server
        .handle
        .take()
        .expect("server handle")
        .join()
        .expect("server");
    assert!(matches!(result, Err(BrokerServerError::ClockUnavailable)));
    drop(server);
    assert_stopped(&fixture);
    fixture.assert_rows(0);
}

struct FailWhileDispatchingClock {
    active: Arc<AtomicBool>,
}

impl BrokerClockV1 for FailWhileDispatchingClock {
    fn now_unix_ms(&self) -> Result<u64, BrokerServerError> {
        if self.active.load(Ordering::Acquire) {
            Err(BrokerServerError::ClockUnavailable)
        } else {
            SystemBrokerClockV1.now_unix_ms()
        }
    }
}

// This fixture exercises ownership and cancellation of the actual server
// workers. It neither launches Codex nor represents qualified dispatch.
struct LifecycleDispatcher {
    entered: mpsc::SyncSender<()>,
    active: Arc<AtomicBool>,
    completed: Arc<AtomicBool>,
    observed_cancellation: Arc<AtomicBool>,
    release: Arc<AtomicBool>,
    delay_after_cancellation: bool,
}

impl BrokerOperationDispatcherV1 for LifecycleDispatcher {
    fn recover_before_ready(
        &self,
        _journal: &mut BrokerJournalStoreV1,
    ) -> Result<(), CodexDispatchError> {
        Ok(())
    }

    fn dispatch(
        &self,
        _journal: &mut BrokerJournalStoreV1,
        _operation_id: &str,
        cancelled: &AtomicBool,
    ) -> Result<(), CodexDispatchError> {
        self.active.store(true, Ordering::Release);
        let _ = self.entered.send(());
        while !self.release.load(Ordering::Acquire) {
            if cancelled.load(Ordering::Acquire) {
                self.observed_cancellation.store(true, Ordering::Release);
                if self.delay_after_cancellation {
                    thread::sleep(Duration::from_millis(150));
                }
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        self.completed.store(true, Ordering::Release);
        Ok(())
    }
}

fn dispatcher() -> (Arc<LifecycleDispatcher>, mpsc::Receiver<()>) {
    let (entered, receiver) = mpsc::sync_channel(1);
    (
        Arc::new(LifecycleDispatcher {
            entered,
            active: Arc::new(AtomicBool::new(false)),
            completed: Arc::new(AtomicBool::new(false)),
            observed_cancellation: Arc::new(AtomicBool::new(false)),
            release: Arc::new(AtomicBool::new(false)),
            delay_after_cancellation: true,
        }),
        receiver,
    )
}

#[test]
fn one_worker_failure_cancels_and_joins_another_active_dispatcher() {
    let fixture = Fixture::new();
    let (dispatcher, entered) = dispatcher();
    let mut server = fixture.server_with_policy(
        fixture.manager(),
        Arc::new(FailWhileDispatchingClock {
            active: dispatcher.active.clone(),
        }),
        policy(2, 1_000_000),
        Some(dispatcher.clone()),
    );
    let (bytes, _) = encoded(&fixture.request(now() + 20_000));
    server
        .client()
        .write_all(&bytes)
        .expect("first actual request");
    entered
        .recv_timeout(Duration::from_secs(3))
        .expect("active dispatcher");
    let mut other =
        UnixStream::connect(fixture.root.join("broker.sock")).expect("second actual connection");
    other
        .set_write_timeout(Some(Duration::from_secs(2)))
        .expect("bounded write");
    other.write_all(&bytes).expect("second signed frame");
    server
        .done
        .recv_timeout(Duration::from_secs(5))
        .expect("failure must stop acceptance and join both workers");
    assert!(server.shutdown.load(Ordering::Acquire));
    assert!(dispatcher.observed_cancellation.load(Ordering::Acquire));
    assert!(dispatcher.completed.load(Ordering::Acquire));
    let result = server
        .handle
        .take()
        .expect("server handle")
        .join()
        .expect("server");
    assert!(matches!(result, Err(BrokerServerError::ClockUnavailable)));
    drop(other);
    drop(server);
    assert_stopped(&fixture);
    fixture.assert_rows(1);
}

#[test]
fn normal_connection_cap_drains_active_dispatch_without_cancellation() {
    let fixture = Fixture::new();
    let (dispatcher, entered) = dispatcher();
    let mut server = fixture.server_with_policy(
        fixture.manager(),
        Arc::new(SystemBrokerClockV1),
        policy(2, 1),
        Some(dispatcher.clone()),
    );
    let (bytes, hash) = encoded(&fixture.request(now() + 20_000));
    server.client().write_all(&bytes).expect("actual request");
    entered
        .recv_timeout(Duration::from_secs(3))
        .expect("active dispatcher");
    // The second worker observes the closed, empty queue while its peer is
    // dispatching. Its normal exit must not cancel that accepted operation.
    assert!(matches!(
        server.done.recv_timeout(Duration::from_millis(150)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    assert!(!server.shutdown.load(Ordering::Acquire));
    assert!(!dispatcher.completed.load(Ordering::Acquire));
    dispatcher.release.store(true, Ordering::Release);
    let (response, _) =
        read_response_frame(server.client(), BrokerResponseFramePolicyV1::default())
            .expect("response after dispatch fixture released");
    assert_eq!(response.kind, BrokerResponseKindV1::Reserved);
    assert_eq!(response.request_hash, Some(hash));
    let summary = server.finish().expect("normal cap drains successfully");
    assert_eq!(summary.accepted_connections, 1);
    assert_eq!(summary.telemetry.reserved_operations, 1);
    assert!(dispatcher.completed.load(Ordering::Acquire));
    assert!(!dispatcher.observed_cancellation.load(Ordering::Acquire));
    assert_stopped(&fixture);
    fixture.assert_rows(1);
}
