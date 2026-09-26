//! Consumer-side read of an existing prepared operation on an already-connected
//! role broker socket. No model launch, credential loading or automatic retry.
use crate::{
    BrokerFrameError, BrokerFramePolicyV1, BrokerMachineCodeV1, BrokerPreparedDeliveryV1,
    BrokerResponseError, BrokerResponseFramePolicyV1, BrokerResponseKindV1, CodexDispatchError,
    PeerAuthorizationError, PeerPolicyV1, inspect_peer_identity, read_prepared_delivery_frame,
    read_response_frame, write_result_query_frame,
};
use hepta_codex_protocol::CodexExecutionRequestV1;
use std::{
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};
use thiserror::Error;

/// Queries the original exact request, under an explicit expected broker peer
/// policy and a cumulative request/response deadline. The caller owns bounded
/// connection establishment. Output is returned only after full byte checking.
pub fn query_prepared_result(
    stream: &UnixStream,
    expected_broker: &PeerPolicyV1,
    request: &CodexExecutionRequestV1,
    timeout_ms: u64,
) -> Result<BrokerPreparedDeliveryV1, BrokerResultClientError> {
    if timeout_ms == 0 || timeout_ms > 30_000 {
        return Err(BrokerResultClientError::InvalidTimeout);
    }
    let peer = inspect_peer_identity(stream)?;
    expected_broker.authorize(peer)?;
    let mut io = DeadlineIo {
        stream,
        started: Instant::now(),
        timeout: Duration::from_millis(timeout_ms),
    };
    let request_hash = write_result_query_frame(&mut io, request, BrokerFramePolicyV1::default())?;
    let (response, _) = read_response_frame(&mut io, BrokerResponseFramePolicyV1::default())?;
    if matches!(
        response.kind,
        BrokerResponseKindV1::Rejected | BrokerResponseKindV1::Busy
    ) {
        return Err(BrokerResultClientError::Rejected(response.error_code));
    }
    if !matches!(
        response.kind,
        BrokerResponseKindV1::Prepared | BrokerResponseKindV1::Acknowledged
    ) || response.operation_id.as_deref() != Some(request.operation_id.as_str())
        || response.request_hash.as_ref() != Some(&request_hash)
    {
        return Err(BrokerResultClientError::ResponseBinding);
    }
    let expected = response
        .prepared_receipt_hash
        .ok_or(BrokerResultClientError::ResponseBinding)?;
    let result = read_prepared_delivery_frame(&mut io, request, &expected)?;
    if inspect_peer_identity(stream)? != peer {
        return Err(BrokerResultClientError::ResponseBinding);
    }
    Ok(result)
}

/// Sends one original signed operation to the selected role broker. A transport
/// error is indeterminate: the caller must retain the operation and recover by
/// querying it, never by calling this function again. This does not sign a
/// request, grant provider authority, or acknowledge a campaign commit.
pub fn dispatch_signed_operation(
    stream: &UnixStream,
    expected_broker: &PeerPolicyV1,
    request: &CodexExecutionRequestV1,
    timeout_ms: u64,
) -> Result<crate::BrokerResponseV1, BrokerResultClientError> {
    if timeout_ms == 0 || timeout_ms > 30_000 {
        return Err(BrokerResultClientError::InvalidTimeout);
    }
    let peer = inspect_peer_identity(stream)?;
    expected_broker.authorize(peer)?;
    let mut io = DeadlineIo {
        stream,
        started: Instant::now(),
        timeout: Duration::from_millis(timeout_ms),
    };
    let request_hash =
        crate::write_request_frame(&mut io, request, BrokerFramePolicyV1::default())?;
    let (response, _) = read_response_frame(&mut io, BrokerResponseFramePolicyV1::default())?;
    if matches!(
        response.kind,
        BrokerResponseKindV1::Rejected | BrokerResponseKindV1::Busy
    ) {
        return Err(BrokerResultClientError::Rejected(response.error_code));
    }
    if response.operation_id.as_deref() != Some(request.operation_id.as_str())
        || response.request_hash.as_ref() != Some(&request_hash)
        || inspect_peer_identity(stream)? != peer
    {
        return Err(BrokerResultClientError::ResponseBinding);
    }
    // A reservation, existing running process or failed operation is not output.
    if !matches!(
        response.kind,
        BrokerResponseKindV1::Prepared | BrokerResponseKindV1::Acknowledged
    ) {
        return Err(BrokerResultClientError::NotPrepared);
    }
    Ok(response)
}

struct DeadlineIo<'a> {
    stream: &'a UnixStream,
    started: Instant,
    timeout: Duration,
}
impl DeadlineIo<'_> {
    fn remaining(&self) -> io::Result<Duration> {
        self.timeout
            .checked_sub(self.started.elapsed())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))
    }
}
impl Read for DeadlineIo<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        self.stream.set_read_timeout(Some(self.remaining()?))?;
        let result = self.stream.read(bytes);
        self.remaining()?;
        result
    }
}
impl Write for DeadlineIo<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        let result = self.stream.write(&bytes[..bytes.len().min(64 * 1024)]);
        self.remaining()?;
        result
    }
    fn flush(&mut self) -> io::Result<()> {
        self.remaining()?;
        self.stream.flush()
    }
}

#[derive(Debug, Error)]
pub enum BrokerResultClientError {
    #[error("result client timeout must be within 1..=30000 milliseconds")]
    InvalidTimeout,
    #[error(
        "broker operation has no completed prepared result; retain its identity for query-only recovery"
    )]
    NotPrepared,
    #[error("broker result response does not bind the original operation")]
    ResponseBinding,
    #[error("broker result query was rejected: {0:?}")]
    Rejected(Option<BrokerMachineCodeV1>),
    #[error(transparent)]
    Peer(#[from] PeerAuthorizationError),
    #[error(transparent)]
    Request(#[from] BrokerFrameError),
    #[error(transparent)]
    Response(#[from] BrokerResponseError),
    #[error(transparent)]
    Delivery(#[from] CodexDispatchError),
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_cumulative_budget_rejects_even_when_bytes_are_immediately_available() {
        let (client, mut server) = UnixStream::pair().unwrap();
        server.write_all(b"ready").unwrap();
        let mut io = DeadlineIo {
            stream: &client,
            started: Instant::now() - Duration::from_secs(1),
            timeout: Duration::from_millis(10),
        };
        assert_eq!(
            io.read(&mut [0_u8; 1]).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            io.write(b"query").unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }
}
