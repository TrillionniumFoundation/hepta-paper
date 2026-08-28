//! Local, bounded and authenticated protocol between the Rust campaign core
//! and a role-specific Codex broker.
//!
//! This crate has no campaign, provider, release, submission or credential
//! authority. It only frames bytes, observes kernel peer credentials and
//! authenticates a request capability bound to an exact request and peer.

#![forbid(unsafe_code)]

#[cfg(not(target_os = "linux"))]
compile_error!("hepta-codex-broker-protocol V1 requires Linux SO_PEERCRED");

mod capability;
mod frame;
mod peer;
mod wire;

pub use capability::{
    CapabilityMacKeyV1, CapabilityPolicyV1, CapabilityVerificationV1,
    RequestCapabilityError, compute_request_capability_signature_v1,
    request_capability_subject_hash_v1, verify_request_capability_v1,
};
pub use frame::{
    BrokerFrameKind, BrokerFrameV1, FrameLimitsV1, FrameProtocolError,
    decode_json_payload, encode_frame, encode_json_frame, read_frame, write_frame,
};
pub use peer::{
    PeerAuthorizationError, PeerAuthorizationV1, PeerCredentialsV1, PeerPolicyV1,
    authorize_peer, observe_peer_credentials,
};
pub use wire::{
    BrokerAdmissionDisposition, BrokerAdmissionRequestV1, BrokerAdmissionResponseV1,
    BrokerErrorCodeV1, BrokerErrorResponseV1, WireContractError,
};
