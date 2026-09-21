//! In-process transport with one retained socket-origin lifetime. This removes
//! a command subprocess from the RPC path without claiming native deployment,
//! service-manager membership, principal qualification or receipt authenticity.
use super::*;
use crate::sqlite_mutation_coordinator::{
    Result as CoordinatorResult, SqliteMutationCoordinatorError,
    authority::MutationAuthorityTransportV1, error,
};
use peer::SocketPeer;

/// Concrete untrusted transport accepted by `PinnedMutationAuthorityV1::load`.
/// The original connected peer is observed from the kernel, not from expected
/// caller-supplied UIDs or a JSON ready flag. Receipt verification is separate.
///
/// The constructor makes an empty probe connection and sends no request. Every
/// actual invocation opens its own protocol connection and requires the same
/// still-live original socket creator. A daemon restart requires a fresh
/// transport and all owning evidence must be re-established independently.
#[derive(Debug)]
pub struct LocalStateAuthoritySocketTransportV1 {
    options: LocalStateAuthorityClientOptionsV1,
    origin: SocketPeer,
}

fn annotated(cause: LocalStateAuthorityClientError, sent: usize) -> SqliteMutationCoordinatorError {
    let mut failure = error(cause.to_string());
    failure.details = json!({
        "transport":"local-state-authority-socket-v1",
        "requestBytesSent":sent,
        "requestDelivery":if sent == 0 { "not_sent" } else { "sent" },
        "authorityOutcome":if sent == 0 { "not_invoked" } else { "unknown" },
        "inspectionRequired":sent > 0,
    });
    // In particular, even a complete untrusted error envelope after sending
    // cannot establish that the authority did not commit. Never auto retry.
    failure
}

impl LocalStateAuthoritySocketTransportV1 {
    /// Observe this socket origin's actual system-manager association before
    /// opening any SQLite owner. The bus and its reader are destroyed before
    /// return. This static observation does not establish installed authority,
    /// native provenance, continued currentness, or permission to mutate.
    pub fn observe_system_manager_v1(
        &self,
    ) -> CoordinatorResult<ObservedSocketPeerManagerAssociationV1> {
        manager::observe(&self.origin, self.options.timeout_ms).map_err(|cause| annotated(cause, 0))
    }

    pub fn connect(options: &LocalStateAuthorityClientOptionsV1) -> CoordinatorResult<Self> {
        let observe = || -> Result<Self> {
            configuration(options)?;
            let deadline = Instant::now() + Duration::from_millis(options.timeout_ms);
            let stream = open_socket(options, deadline)?;
            let origin = SocketPeer::observe(&stream, deadline)?;
            origin.assert_alive(deadline)?;
            Ok(Self {
                options: options.clone(),
                origin,
            })
        };
        observe().map_err(|cause| annotated(cause, 0))
    }
}

impl MutationAuthorityTransportV1 for LocalStateAuthoritySocketTransportV1 {
    fn invoke(&mut self, request: &Value) -> CoordinatorResult<Value> {
        let mut sent = 0;
        let mut invoke = || -> Result<Value> {
            configuration(&self.options)?;
            if !request.is_object() {
                return Err(fail("local_state_authority_client_configuration_invalid"));
            }
            let bytes = serde_json::to_vec(request)
                .map_err(|_| fail("local_state_authority_client_request_invalid"))?;
            let payload = request_payload(&bytes, &self.options)?;
            let deadline = Instant::now() + Duration::from_millis(self.options.timeout_ms);
            self.origin.assert_alive(deadline)?;
            let mut stream = open_socket(&self.options, deadline)?;
            let peer = SocketPeer::observe(&stream, deadline)?;
            peer.assert_same_origin(&self.origin, &stream, deadline)?;
            let response = exchange(
                &mut stream,
                &payload,
                &self.options,
                deadline,
                &mut sent,
                |stream| peer.assert_same_origin(&self.origin, stream, deadline),
            );
            // Check also on read/parse/authority rejection, but retain the
            // original cause when both fail. Either result remains unknown
            // after the first successful byte write.
            let current = peer.assert_same_origin(&self.origin, &stream, deadline);
            let response = response?;
            current?;
            let receipt = parse(
                response.get().as_bytes(),
                "local_state_authority_client_response_invalid",
            )
            .map_err(|_| fail("local_state_authority_client_response_invalid"))?;
            peer.assert_same_origin(&self.origin, &stream, deadline)?;
            deadline_current(deadline)?;
            Ok(receipt)
        };
        invoke().map_err(|cause| annotated(cause, sent))
    }
}

// The same bounded untrusted socket wire protocol serves both receipt families.
// Authentication and configuration/scope binding remain in the backup verifier.
impl crate::state_backup_authority::StateBackupAuthorityTransportV1
    for LocalStateAuthoritySocketTransportV1
{
    fn invoke(&mut self, request: &Value) -> CoordinatorResult<Value> {
        <Self as MutationAuthorityTransportV1>::invoke(self, request)
    }
}

#[cfg(test)]
mod tests;
