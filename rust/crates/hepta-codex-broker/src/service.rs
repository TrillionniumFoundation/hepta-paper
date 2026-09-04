use std::os::unix::net::UnixStream;

use hepta_codex_protocol::Sha256Digest;
use thiserror::Error;

use crate::{
    AdmissionError, AdmissionPolicyV1, BrokerJournalError, BrokerJournalStoreV1,
    CapabilityTrustStoreV1, FaultInjectionPointV1, PeerIdentityV1, PeerPolicyV1,
    ReservationOutcomeV1, admit_unix_stream,
};

/// Durable result of one peer-authenticated broker admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerReservationV1 {
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub peer: PeerIdentityV1,
    pub signer_key_id: String,
    pub capability_nonce: String,
    pub outcome: ReservationOutcomeV1,
}

/// Authenticates a one-request Unix connection and atomically reserves its operation.
///
/// Admission always completes before the SQLite transaction begins. Consequently,
/// malformed frames, denied peers, expired capabilities, and invalid signatures
/// cannot consume a nonce or create an operation row.
#[allow(clippy::too_many_arguments)]
pub fn admit_and_reserve_unix_stream(
    stream: &UnixStream,
    peer_policy: &PeerPolicyV1,
    trust_store: &CapabilityTrustStoreV1,
    journal: &mut BrokerJournalStoreV1,
    now_unix_ms: u64,
    admission_policy: AdmissionPolicyV1,
    fault: FaultInjectionPointV1,
) -> Result<BrokerReservationV1, BrokerStateError> {
    let admitted = admit_unix_stream(
        stream,
        peer_policy,
        trust_store,
        now_unix_ms,
        admission_policy,
    )?;
    let operation_id = admitted.request().operation_id.clone();
    let request_hash = admitted.request_hash().clone();
    let peer = admitted.peer();
    let signer_key_id = admitted.capability().signer_key_id.clone();
    let capability_nonce = admitted.capability().nonce.clone();
    let outcome = journal.reserve_operation(&admitted, now_unix_ms, fault)?;
    Ok(BrokerReservationV1 {
        operation_id,
        request_hash,
        peer,
        signer_key_id,
        capability_nonce,
        outcome,
    })
}

/// Admission or durable reservation failure.
#[derive(Debug, Error)]
pub enum BrokerStateError {
    #[error("broker admission failed: {0}")]
    Admission(#[from] AdmissionError),
    #[error("broker journal reservation failed: {0}")]
    Journal(#[from] BrokerJournalError),
}
