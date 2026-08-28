//! Local admission, durable state, and bounded service lifecycle for Codex brokers.
//!
//! This crate authenticates a peer and short-lived request capability before
//! reserving a crash-stable operation. The service slice adds role-specific
//! listeners, bounded backpressure, response framing, and public-key rotation.
//! It still does not hold provider credentials, launch real Codex, write the
//! campaign database, or grant release and submission authority.

#![forbid(unsafe_code)]

#[cfg(not(target_os = "linux"))]
compile_error!("hepta-codex-broker V1 requires Linux SO_PEERCRED semantics");

mod admission;
mod capability;
mod frame;
mod journal;
mod listener;
mod peer;
mod response;
mod server;
mod service;
mod trust_bundle;

pub use admission::{
    AdmissionError, AdmissionPolicyV1, AuthenticatedBrokerRequestV1, BrokerRolePolicyV1,
    admit_unix_stream,
};
pub use capability::{
    CapabilityPolicyV1, CapabilityTrustStoreV1, CapabilityVerificationError, VerifiedCapabilityV1,
    capability_signing_bytes, verify_request_capability,
};
pub use frame::{
    BrokerFrameError, BrokerFramePolicyV1, DecodedRequestFrameV1, read_request_frame,
    write_request_frame,
};
pub use journal::{
    BrokerJournalError, BrokerJournalPolicyV1, BrokerJournalStoreV1, FaultInjectionPointV1,
    ReservationOutcomeV1,
};
pub use listener::{
    BrokerListenerError, BrokerListenerPolicyV1, BrokerListenerQualificationV1, BrokerListenerV1,
    BrokerSocketIdentityV1,
};
pub use peer::{
    PeerAuthorizationError, PeerIdentityV1, PeerPolicyV1, PeerPrincipalV1, inspect_peer_identity,
};
pub use response::{
    BrokerMachineCodeV1, BrokerResponseError, BrokerResponseFramePolicyV1, BrokerResponseKindV1,
    BrokerResponseV1, read_response_frame, write_response_frame,
};
pub use server::{
    BrokerClockV1, BrokerServerError, BrokerServerPolicyV1, BrokerServerRunSummaryV1,
    BrokerServerV1, SystemBrokerClockV1,
};
pub use service::{BrokerReservationV1, BrokerStateError, admit_and_reserve_unix_stream};
pub use trust_bundle::{
    AcceptedCapabilityTrustCheckpointV1, CapabilityBundleAuthorityV1, CapabilityKeyRevocationV1,
    CapabilityTrustBundleManagerV1, CapabilityTrustBundleV1, CapabilityTrustKeyV1,
    SignedCapabilityTrustBundleV1, TrustBundleDisableReasonV1, TrustBundleError,
    VerifiedCapabilityTrustBundleV1, trust_bundle_signing_bytes, verify_capability_trust_bundle,
};
