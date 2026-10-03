//! Read-only result transfer through the original authenticated broker endpoint.
use crate::{
    AuthenticatedBrokerRequestV1, BrokerClockV1, BrokerJournalError, BrokerJournalStoreV1,
    BrokerMachineCodeV1, BrokerOperationDispatcherV1, BrokerResponseFramePolicyV1,
    CapabilityPolicyV1, CapabilityTrustBundleManagerV1, load_persisted_request,
    verify_request_capability, write_prepared_delivery_frame, write_response_frame,
};
use hepta_codex_journal::OperationState;
use hepta_codex_protocol::Sha256Digest;
use std::{
    io::{self, Write},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

pub(super) enum ResultQueryError {
    Rejected(BrokerMachineCodeV1),
    DeliveryInterrupted,
}

pub(super) struct ResultQueryContext<'a> {
    pub journal: &'a BrokerJournalStoreV1,
    pub dispatcher: Option<&'a dyn BrokerOperationDispatcherV1>,
    pub trust_manager: &'a CapabilityTrustBundleManagerV1,
    pub startup_bundle_hash: &'a Sha256Digest,
    pub clock: &'a dyn BrokerClockV1,
    pub capability_policy: CapabilityPolicyV1,
    pub response_policy: BrokerResponseFramePolicyV1,
    pub write_timeout_ms: u64,
    pub admitted_at_unix_ms: u64,
}

impl ResultQueryContext<'_> {
    pub(super) fn respond(
        &self,
        admitted: &AuthenticatedBrokerRequestV1,
        stream: &mut UnixStream,
    ) -> Result<(), ResultQueryError> {
        let request = admitted.request();
        let journal = self
            .journal
            .load_journal(&request.operation_id)
            .map_err(|error| {
                ResultQueryError::Rejected(match error {
                    BrokerJournalError::OperationNotFound(_) => {
                        BrokerMachineCodeV1::OperationNotFound
                    }
                    _ => BrokerMachineCodeV1::JournalUnavailable,
                })
            })?;
        let persisted = load_persisted_request(self.journal, &request.operation_id)
            .map_err(|_| ResultQueryError::Rejected(BrokerMachineCodeV1::JournalUnavailable))?;
        if persisted != *request || journal.request_hash != *admitted.request_hash() {
            return Err(ResultQueryError::Rejected(
                BrokerMachineCodeV1::JournalConflict,
            ));
        }
        if !matches!(
            journal.current_state,
            OperationState::ResultPrepared | OperationState::Acknowledged
        ) {
            return Err(ResultQueryError::Rejected(
                BrokerMachineCodeV1::StateConflict,
            ));
        }
        let dispatcher = self.dispatcher.ok_or(ResultQueryError::Rejected(
            BrokerMachineCodeV1::PreparedResultMismatch,
        ))?;
        let delivery = dispatcher
            .prepared_delivery(self.journal, &request.operation_id)
            .map_err(|_| ResultQueryError::Rejected(BrokerMachineCodeV1::PreparedResultMismatch))?;
        let response = super::response_from_durable_journal(&journal, false)
            .map_err(|_| ResultQueryError::Rejected(BrokerMachineCodeV1::PreparedResultMismatch))?;
        if response.prepared_receipt_hash.as_ref()
            != Some(&delivery.receipt().prepared_receipt_hash)
            || delivery.receipt().request_hash != *admitted.request_hash()
            || delivery.receipt().operation_id != request.operation_id
        {
            return Err(ResultQueryError::Rejected(
                BrokerMachineCodeV1::PreparedResultMismatch,
            ));
        }
        // Sidecar I/O and verification may outlive admission. Check the current
        // trust and time again before exposing any prepared-response or output.
        let mut last_now = self.admitted_at_unix_ms;
        self.check_current(admitted, &mut last_now)
            .map_err(ResultQueryError::Rejected)?;
        let mut writer = AuthorizedWriter {
            stream,
            context: self,
            admitted,
            last_now,
            started: Instant::now(),
            timeout: Duration::from_millis(self.write_timeout_ms),
        };
        write_response_frame(&mut writer, &response, self.response_policy)
            .map_err(|_| ResultQueryError::DeliveryInterrupted)?;
        write_prepared_delivery_frame(&mut writer, &delivery)
            .map_err(|_| ResultQueryError::DeliveryInterrupted)
    }

    fn check_current(
        &self,
        admitted: &AuthenticatedBrokerRequestV1,
        last_now: &mut u64,
    ) -> Result<(), BrokerMachineCodeV1> {
        let now = self
            .clock
            .now_unix_ms()
            .map_err(|_| BrokerMachineCodeV1::CapabilityUnavailable)?;
        if now < *last_now {
            return Err(BrokerMachineCodeV1::CapabilityUnavailable);
        }
        let (trust, _, bundle_hash) = self
            .trust_manager
            .snapshot(now)
            .map_err(|_| BrokerMachineCodeV1::CapabilityUnavailable)?;
        if bundle_hash != *self.startup_bundle_hash {
            return Err(BrokerMachineCodeV1::TrustBundleChanged);
        }
        verify_request_capability(
            admitted.request(),
            admitted.peer(),
            now,
            self.capability_policy,
            &trust,
        )
        .map_err(|_| BrokerMachineCodeV1::AdmissionRejected)?;
        *last_now = now;
        Ok(())
    }
}

// A cumulative transfer budget, not a fresh timeout for each successful write.
// Current access is rechecked before every bounded chunk. Revocation during a
// syscall cannot retract bytes already sent; failure closes without an ACK.
struct AuthorizedWriter<'a, 'b> {
    stream: &'a mut UnixStream,
    context: &'a ResultQueryContext<'b>,
    admitted: &'a AuthenticatedBrokerRequestV1,
    last_now: u64,
    started: Instant,
    timeout: Duration,
}
impl AuthorizedWriter<'_, '_> {
    fn remaining(&self) -> io::Result<Duration> {
        self.timeout
            .checked_sub(self.started.elapsed())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))
    }
}
impl Write for AuthorizedWriter<'_, '_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.context
            .check_current(self.admitted, &mut self.last_now)
            .map_err(|_| io::Error::from(io::ErrorKind::PermissionDenied))?;
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        let result = self.stream.write(&bytes[..bytes.len().min(64 * 1024)]);
        self.remaining()?;
        result
    }
    fn flush(&mut self) -> io::Result<()> {
        self.context
            .check_current(self.admitted, &mut self.last_now)
            .map_err(|_| io::Error::from(io::ErrorKind::PermissionDenied))?;
        self.remaining()?;
        self.stream.flush()
    }
}
