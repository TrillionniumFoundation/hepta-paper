//! Local admission, durable state, and bounded service lifecycle for Codex brokers.
//!
//! This crate authenticates a peer and short-lived request capability before
//! reserving a crash-stable operation. The service slice adds role-specific
//! listeners, bounded backpressure, response framing, public-key rotation,
//! fake-process journal linkage, signed prepared-result acknowledgement, and
//! journal recovery/backup APIs. It still does not hold provider credentials,
//! launch real Codex, write the campaign database, or grant release and
//! submission authority.

#![forbid(unsafe_code)]

#[cfg(not(target_os = "linux"))]
compile_error!("hepta-codex-broker V1 requires Linux SO_PEERCRED semantics");

mod acknowledgement;
mod admission;
mod capability;
mod fake_execution;
mod frame;
mod journal;
mod listener;
mod peer;
mod response;
mod server;
mod service;
mod trust_bundle;
pub mod trust_bundle_file;
mod trust_source;

pub use acknowledgement::{
    PreparedResultAcknowledgementError, PreparedResultAcknowledgementPolicyV1,
    PreparedResultAcknowledgementTrustStoreV1, PreparedResultAcknowledgementV1,
    VerifiedPreparedResultAcknowledgementV1, apply_prepared_result_acknowledgement,
    prepared_result_acknowledgement_signing_bytes,
    verify_persisted_prepared_result_acknowledgement, verify_prepared_result_acknowledgement,
};
pub use admission::{
    AdmissionError, AdmissionPolicyV1, AuthenticatedBrokerRequestV1, BrokerRolePolicyV1,
    admit_unix_stream,
};
pub use capability::{
    CapabilityPolicyV1, CapabilityTrustStoreV1, CapabilityVerificationError, VerifiedCapabilityV1,
    capability_signing_bytes, verify_request_capability,
};
pub use fake_execution::{
    FakeBrokerExecutionError, FakeBrokerExecutionPlanV1, FakeBrokerPreparedResultV1,
    FakeExecutionEvidenceV1, FakeExecutionFaultV1, FakeExecutionTimelineV1,
    run_reserved_fake_operation,
};
pub use frame::{
    BrokerFrameError, BrokerFramePolicyV1, DecodedRequestFrameV1, read_request_frame,
    write_request_frame,
};
pub use journal::{
    BrokerBackupPolicyV1, BrokerBackupReceiptV1, BrokerJournalError, BrokerJournalPolicyV1,
    BrokerJournalStoreV1, BrokerProcessLaunchV1, BrokerProcessReconciliationV1,
    BrokerRecoveryCandidateV1, FaultInjectionPointV1, ProcessReconciliationDispositionV1,
    ProcessReleaseStateV1, ReservationOutcomeV1, create_broker_backup, list_recovery_candidates,
    load_persisted_request, restore_broker_backup,
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
pub use trust_source::{
    CapabilityTrustBundleSourceIdentityV1, CapabilityTrustBundleSourceInstallError,
    CapabilityTrustBundleSourcePolicyV1, LoadedSignedCapabilityTrustBundleV1,
    TrustBundleSourceError, install_signed_capability_trust_bundle_from_source,
    load_signed_capability_trust_bundle,
};
