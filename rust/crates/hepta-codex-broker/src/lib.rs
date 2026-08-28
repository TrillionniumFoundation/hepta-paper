//! Local admission and durable operation state for the role-specific Codex broker.
//!
//! This crate authenticates a peer and a short-lived request capability before
//! reserving a crash-stable provider operation. It does not launch Codex, read
//! provider credentials, write the campaign database, or grant release and
//! submission authority.

#![forbid(unsafe_code)]

#[cfg(not(target_os = "linux"))]
compile_error!("hepta-codex-broker V1 requires Linux SO_PEERCRED semantics");

mod admission;
mod capability;
mod frame;
mod journal;
mod peer;
mod service;

pub use admission::{
    AdmissionError, AdmissionPolicyV1, AuthenticatedBrokerRequestV1, BrokerRolePolicyV1,
    admit_unix_stream,
};
pub use capability::{
    CapabilityPolicyV1, CapabilityTrustStoreV1, CapabilityVerificationError,
    VerifiedCapabilityV1, capability_signing_bytes, verify_request_capability,
};
pub use frame::{
    BrokerFrameError, BrokerFramePolicyV1, DecodedRequestFrameV1,
    read_request_frame, write_request_frame,
};
pub use journal::{
    BrokerJournalError, BrokerJournalPolicyV1, BrokerJournalStoreV1,
    FaultInjectionPointV1, ReservationOutcomeV1,
};
pub use peer::{
    PeerAuthorizationError, PeerIdentityV1, PeerPolicyV1, PeerPrincipalV1,
    inspect_peer_identity,
};
pub use service::{
    BrokerReservationV1, BrokerStateError, admit_and_reserve_unix_stream,
};
