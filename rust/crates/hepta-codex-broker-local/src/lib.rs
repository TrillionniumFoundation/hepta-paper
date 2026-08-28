//! Local one-request-per-connection admission service for a role-specific
//! Codex broker.
//!
//! Admission authenticates the kernel peer and request capability and reserves
//! an idempotent journal operation. It does not inspect credentials, launch
//! Codex, mutate campaign state, or grant release/submission authority.

#![forbid(unsafe_code)]

#[cfg(not(target_os = "linux"))]
compile_error!("hepta-codex-broker-local V1 requires Linux Unix sockets");

mod service;

pub use service::{
    BrokerAdmissionError, BrokerAdmissionServiceV1, BrokerAdmissionServicePolicyV1,
};
