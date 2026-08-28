use hepta_codex_protocol::{CodexExecutionRequestV1, Sha256Digest};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::PeerCredentialsV1;

/// Versioned request payload carried by a `Request` frame.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerAdmissionRequestV1 {
    pub version: u16,
    pub request: CodexExecutionRequestV1,
}

impl BrokerAdmissionRequestV1 {
    pub fn validate(&self) -> Result<(), WireContractError> {
        if self.version != 1 {
            return Err(WireContractError::UnsupportedVersion(self.version));
        }
        self.request
            .validate()
            .map_err(WireContractError::RequestInvalid)
    }
}

/// Whether admission created a new journal operation or returned the existing one.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerAdmissionDisposition {
    Created,
    Existing,
}

/// Successful bounded admission response. It does not authorize provider execution.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerAdmissionResponseV1 {
    pub version: u16,
    pub disposition: BrokerAdmissionDisposition,
    pub operation_id: String,
    pub request_subject_hash: Sha256Digest,
    pub current_state: String,
    pub journal_revision: u64,
    pub peer: PeerCredentialsV1,
    pub peer_policy_hash: Sha256Digest,
    pub capability_policy_hash: Sha256Digest,
}

impl BrokerAdmissionResponseV1 {
    pub fn validate(&self) -> Result<(), WireContractError> {
        if self.version != 1 {
            return Err(WireContractError::UnsupportedVersion(self.version));
        }
        if !valid_identifier(&self.operation_id) {
            return Err(WireContractError::InvalidOperationId);
        }
        if self.current_state != "reserved" {
            return Err(WireContractError::InvalidAdmissionState);
        }
        if self.peer.process_id <= 0 {
            return Err(WireContractError::InvalidPeerProcessId);
        }
        Ok(())
    }
}

/// Stable machine code returned without exposing internal error details.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerErrorCodeV1 {
    InvalidFrame,
    InvalidRequest,
    PeerUnauthorized,
    CapabilityRejected,
    ReplayOrConflict,
    JournalUnavailable,
    InternalFailure,
}

/// Bounded error response safe for an untrusted socket peer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerErrorResponseV1 {
    pub version: u16,
    pub code: BrokerErrorCodeV1,
    pub operation_id: Option<String>,
    pub retryable: bool,
}

impl BrokerErrorResponseV1 {
    pub fn validate(&self) -> Result<(), WireContractError> {
        if self.version != 1 {
            return Err(WireContractError::UnsupportedVersion(self.version));
        }
        if let Some(operation_id) = &self.operation_id
            && !valid_identifier(operation_id)
        {
            return Err(WireContractError::InvalidOperationId);
        }
        Ok(())
    }
}

fn valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
        })
}

/// Invalid versioned wire object.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum WireContractError {
    #[error("unsupported wire-contract version: {0}")]
    UnsupportedVersion(u16),
    #[error("embedded execution request is invalid: {0}")]
    RequestInvalid(hepta_codex_protocol::ProtocolValidationError),
    #[error("operation id is invalid")]
    InvalidOperationId,
    #[error("admission response must represent reserved state")]
    InvalidAdmissionState,
    #[error("peer process id is invalid")]
    InvalidPeerProcessId,
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use hepta_codex_protocol::Sha256Digest;

    use super::*;

    fn digest(byte: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
            .expect("test digest")
    }

    #[test]
    fn response_cannot_claim_a_post_admission_state() {
        let mut response = BrokerAdmissionResponseV1 {
            version: 1,
            disposition: BrokerAdmissionDisposition::Created,
            operation_id: "operation-1".into(),
            request_subject_hash: digest('1'),
            current_state: "reserved".into(),
            journal_revision: 0,
            peer: PeerCredentialsV1 {
                process_id: 42,
                user_id: 1000,
                group_id: 1000,
            },
            peer_policy_hash: digest('2'),
            capability_policy_hash: digest('3'),
        };
        assert!(response.validate().is_ok());
        response.current_state = "process_spawned".into();
        assert_eq!(
            response.validate(),
            Err(WireContractError::InvalidAdmissionState),
        );
    }
}
