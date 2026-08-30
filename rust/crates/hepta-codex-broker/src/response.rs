use std::{
    io::{self, Read, Write},
    str::FromStr,
};

use hepta_codex_journal::OperationState;
use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const RESPONSE_MAGIC: [u8; 8] = *b"HEPTARX1";
const RESPONSE_HEADER_BYTES: usize = 16;
const HARD_MAXIMUM_RESPONSE_BYTES: usize = 64 * 1024;
const MAXIMUM_ERROR_DETAIL_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BrokerResponseFramePolicyV1 {
    pub maximum_payload_bytes: usize,
}

impl Default for BrokerResponseFramePolicyV1 {
    fn default() -> Self {
        Self {
            maximum_payload_bytes: HARD_MAXIMUM_RESPONSE_BYTES,
        }
    }
}

impl BrokerResponseFramePolicyV1 {
    fn validate(self) -> Result<Self, BrokerResponseError> {
        if self.maximum_payload_bytes == 0
            || self.maximum_payload_bytes > HARD_MAXIMUM_RESPONSE_BYTES
        {
            return Err(BrokerResponseError::InvalidPolicy);
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerResponseKindV1 {
    Reserved,
    Existing,
    Busy,
    Rejected,
    Prepared,
    Acknowledged,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerMachineCodeV1 {
    AdmissionRejected,
    CapabilityUnavailable,
    TrustBundleChanged,
    JournalUnavailable,
    JournalConflict,
    QueueFull,
    ServiceStopping,
    OperationNotFound,
    StateConflict,
    PreparedResultMismatch,
    InternalFailure,
}

impl BrokerMachineCodeV1 {
    pub const ALL: [Self; 11] = [
        Self::AdmissionRejected,
        Self::CapabilityUnavailable,
        Self::TrustBundleChanged,
        Self::JournalUnavailable,
        Self::JournalConflict,
        Self::QueueFull,
        Self::ServiceStopping,
        Self::OperationNotFound,
        Self::StateConflict,
        Self::PreparedResultMismatch,
        Self::InternalFailure,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AdmissionRejected => "admission_rejected",
            Self::CapabilityUnavailable => "capability_unavailable",
            Self::TrustBundleChanged => "trust_bundle_changed",
            Self::JournalUnavailable => "journal_unavailable",
            Self::JournalConflict => "journal_conflict",
            Self::QueueFull => "queue_full",
            Self::ServiceStopping => "service_stopping",
            Self::OperationNotFound => "operation_not_found",
            Self::StateConflict => "state_conflict",
            Self::PreparedResultMismatch => "prepared_result_mismatch",
            Self::InternalFailure => "internal_failure",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerResponseV1 {
    pub version: u16,
    pub kind: BrokerResponseKindV1,
    pub operation_id: Option<String>,
    pub request_hash: Option<Sha256Digest>,
    pub current_state: Option<OperationState>,
    pub prepared_receipt_hash: Option<Sha256Digest>,
    pub acknowledgement_hash: Option<Sha256Digest>,
    pub retry_after_ms: Option<u64>,
    pub error_code: Option<BrokerMachineCodeV1>,
    pub error_detail: Option<String>,
}

impl BrokerResponseV1 {
    #[must_use]
    pub fn reserved(
        operation_id: String,
        request_hash: Sha256Digest,
        current_state: OperationState,
    ) -> Self {
        Self::operation(
            BrokerResponseKindV1::Reserved,
            operation_id,
            request_hash,
            current_state,
        )
    }

    #[must_use]
    pub fn existing(
        operation_id: String,
        request_hash: Sha256Digest,
        current_state: OperationState,
    ) -> Self {
        Self::operation(
            BrokerResponseKindV1::Existing,
            operation_id,
            request_hash,
            current_state,
        )
    }

    #[must_use]
    pub fn busy(retry_after_ms: u64) -> Self {
        Self {
            version: 1,
            kind: BrokerResponseKindV1::Busy,
            operation_id: None,
            request_hash: None,
            current_state: None,
            prepared_receipt_hash: None,
            acknowledgement_hash: None,
            retry_after_ms: Some(retry_after_ms),
            error_code: Some(BrokerMachineCodeV1::QueueFull),
            error_detail: None,
        }
    }

    #[must_use]
    pub fn rejected(code: BrokerMachineCodeV1, detail: Option<String>) -> Self {
        Self {
            version: 1,
            kind: BrokerResponseKindV1::Rejected,
            operation_id: None,
            request_hash: None,
            current_state: None,
            prepared_receipt_hash: None,
            acknowledgement_hash: None,
            retry_after_ms: None,
            error_code: Some(code),
            error_detail: detail,
        }
    }

    #[must_use]
    pub fn prepared(
        operation_id: String,
        request_hash: Sha256Digest,
        prepared_receipt_hash: Sha256Digest,
    ) -> Self {
        Self {
            version: 1,
            kind: BrokerResponseKindV1::Prepared,
            operation_id: Some(operation_id),
            request_hash: Some(request_hash),
            current_state: Some(OperationState::ResultPrepared),
            prepared_receipt_hash: Some(prepared_receipt_hash),
            acknowledgement_hash: None,
            retry_after_ms: None,
            error_code: None,
            error_detail: None,
        }
    }

    #[must_use]
    pub fn acknowledged(
        operation_id: String,
        request_hash: Sha256Digest,
        prepared_receipt_hash: Sha256Digest,
        acknowledgement_hash: Sha256Digest,
    ) -> Self {
        Self {
            version: 1,
            kind: BrokerResponseKindV1::Acknowledged,
            operation_id: Some(operation_id),
            request_hash: Some(request_hash),
            current_state: Some(OperationState::Acknowledged),
            prepared_receipt_hash: Some(prepared_receipt_hash),
            acknowledgement_hash: Some(acknowledgement_hash),
            retry_after_ms: None,
            error_code: None,
            error_detail: None,
        }
    }

    fn operation(
        kind: BrokerResponseKindV1,
        operation_id: String,
        request_hash: Sha256Digest,
        current_state: OperationState,
    ) -> Self {
        Self {
            version: 1,
            kind,
            operation_id: Some(operation_id),
            request_hash: Some(request_hash),
            current_state: Some(current_state),
            prepared_receipt_hash: None,
            acknowledgement_hash: None,
            retry_after_ms: None,
            error_code: None,
            error_detail: None,
        }
    }

    pub fn validate(&self) -> Result<(), BrokerResponseError> {
        if self.version != 1 {
            return Err(BrokerResponseError::UnsupportedVersion(self.version));
        }
        if let Some(operation_id) = self.operation_id.as_deref()
            && !valid_identifier(operation_id)
        {
            return Err(BrokerResponseError::InvalidOperationId);
        }
        if let Some(detail) = self.error_detail.as_deref()
            && (detail.is_empty()
                || detail.len() > MAXIMUM_ERROR_DETAIL_BYTES
                || detail.chars().any(char::is_control))
        {
            return Err(BrokerResponseError::InvalidErrorDetail);
        }
        let valid = match self.kind {
            BrokerResponseKindV1::Reserved | BrokerResponseKindV1::Existing => {
                self.operation_id.is_some()
                    && self.request_hash.is_some()
                    && self.current_state.is_some()
                    && self.prepared_receipt_hash.is_none()
                    && self.acknowledgement_hash.is_none()
                    && self.retry_after_ms.is_none()
                    && self.error_code.is_none()
                    && self.error_detail.is_none()
            }
            BrokerResponseKindV1::Busy => {
                self.operation_id.is_none()
                    && self.request_hash.is_none()
                    && self.current_state.is_none()
                    && self.prepared_receipt_hash.is_none()
                    && self.acknowledgement_hash.is_none()
                    && self.retry_after_ms.is_some_and(|value| value > 0)
                    && self.error_code == Some(BrokerMachineCodeV1::QueueFull)
                    && self.error_detail.is_none()
            }
            BrokerResponseKindV1::Rejected => {
                self.operation_id.is_none()
                    && self.request_hash.is_none()
                    && self.current_state.is_none()
                    && self.prepared_receipt_hash.is_none()
                    && self.acknowledgement_hash.is_none()
                    && self.retry_after_ms.is_none()
                    && self.error_code.is_some()
            }
            BrokerResponseKindV1::Prepared => {
                self.operation_id.is_some()
                    && self.request_hash.is_some()
                    && self.current_state == Some(OperationState::ResultPrepared)
                    && self.prepared_receipt_hash.is_some()
                    && self.acknowledgement_hash.is_none()
                    && self.retry_after_ms.is_none()
                    && self.error_code.is_none()
                    && self.error_detail.is_none()
            }
            BrokerResponseKindV1::Acknowledged => {
                self.operation_id.is_some()
                    && self.request_hash.is_some()
                    && self.current_state == Some(OperationState::Acknowledged)
                    && self.prepared_receipt_hash.is_some()
                    && self.acknowledgement_hash.is_some()
                    && self.retry_after_ms.is_none()
                    && self.error_code.is_none()
                    && self.error_detail.is_none()
            }
        };
        if valid {
            Ok(())
        } else {
            Err(BrokerResponseError::InvalidFieldCombination)
        }
    }
}

pub fn write_response_frame<W: Write>(
    writer: &mut W,
    response: &BrokerResponseV1,
    policy: BrokerResponseFramePolicyV1,
) -> Result<Sha256Digest, BrokerResponseError> {
    let policy = policy.validate()?;
    response.validate()?;
    let payload = serde_json::to_vec(response)
        .map_err(|error| BrokerResponseError::InvalidJson(error.to_string()))?;
    if payload.is_empty() || payload.len() > policy.maximum_payload_bytes {
        return Err(BrokerResponseError::PayloadTooLarge);
    }
    let length = u64::try_from(payload.len()).map_err(|_| BrokerResponseError::PayloadTooLarge)?;
    writer
        .write_all(&RESPONSE_MAGIC)
        .and_then(|()| writer.write_all(&length.to_be_bytes()))
        .and_then(|()| writer.write_all(&payload))
        .and_then(|()| writer.flush())
        .map_err(|error| BrokerResponseError::Write(error.kind()))?;
    sha256_digest(&payload)
}

pub fn read_response_frame<R: Read>(
    reader: &mut R,
    policy: BrokerResponseFramePolicyV1,
) -> Result<(BrokerResponseV1, Sha256Digest), BrokerResponseError> {
    let policy = policy.validate()?;
    let mut header = [0_u8; RESPONSE_HEADER_BYTES];
    reader
        .read_exact(&mut header)
        .map_err(|error| BrokerResponseError::Read(error.kind()))?;
    if header[..8] != RESPONSE_MAGIC {
        return Err(BrokerResponseError::InvalidMagic);
    }
    let raw_length: [u8; 8] = header[8..]
        .try_into()
        .map_err(|_| BrokerResponseError::InvalidLength)?;
    let length = usize::try_from(u64::from_be_bytes(raw_length))
        .map_err(|_| BrokerResponseError::PayloadTooLarge)?;
    if length == 0 || length > policy.maximum_payload_bytes {
        return Err(BrokerResponseError::PayloadTooLarge);
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| BrokerResponseError::Read(error.kind()))?;
    let response: BrokerResponseV1 = serde_json::from_slice(&payload)
        .map_err(|error| BrokerResponseError::InvalidJson(error.to_string()))?;
    response.validate()?;
    let canonical = serde_json::to_vec(&response)
        .map_err(|error| BrokerResponseError::InvalidJson(error.to_string()))?;
    if canonical != payload {
        return Err(BrokerResponseError::NonCanonicalJson);
    }
    Ok((response, sha256_digest(&payload)?))
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
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-'))
}

fn sha256_digest(bytes: &[u8]) -> Result<Sha256Digest, BrokerResponseError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value).map_err(|_| BrokerResponseError::DigestConstruction)
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum BrokerResponseError {
    #[error("broker response policy is invalid")]
    InvalidPolicy,
    #[error("unsupported broker response version: {0}")]
    UnsupportedVersion(u16),
    #[error("broker response operation id is invalid")]
    InvalidOperationId,
    #[error("broker response error detail is invalid")]
    InvalidErrorDetail,
    #[error("broker response field combination is invalid")]
    InvalidFieldCombination,
    #[error("broker response magic is invalid")]
    InvalidMagic,
    #[error("broker response length is invalid")]
    InvalidLength,
    #[error("broker response payload is empty or too large")]
    PayloadTooLarge,
    #[error("broker response JSON is invalid: {0}")]
    InvalidJson(String),
    #[error("broker response JSON is not canonical")]
    NonCanonicalJson,
    #[error("broker response read failed: {0:?}")]
    Read(io::ErrorKind),
    #[error("broker response write failed: {0:?}")]
    Write(io::ErrorKind),
    #[error("failed to construct response digest")]
    DigestConstruction,
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn digest(byte: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
            .expect("test digest")
    }

    #[test]
    fn machine_code_registry_is_stable_and_unique() {
        let mut values = BrokerMachineCodeV1::ALL
            .into_iter()
            .map(BrokerMachineCodeV1::as_str)
            .collect::<Vec<_>>();
        let original = values.len();
        values.sort_unstable();
        values.dedup();
        assert_eq!(values.len(), original);
        assert_eq!(BrokerMachineCodeV1::QueueFull.as_str(), "queue_full");
    }

    #[test]
    fn response_round_trip_is_canonical_and_hashed() {
        let response = BrokerResponseV1::reserved(
            "operation-1".to_owned(),
            digest('1'),
            OperationState::Reserved,
        );
        let mut encoded = Vec::new();
        let written = write_response_frame(
            &mut encoded,
            &response,
            BrokerResponseFramePolicyV1::default(),
        )
        .expect("write response");
        let (decoded, observed) = read_response_frame(
            &mut Cursor::new(encoded),
            BrokerResponseFramePolicyV1::default(),
        )
        .expect("read response");
        assert_eq!(decoded, response);
        assert_eq!(observed, written);
    }

    #[test]
    fn rejects_cross_kind_field_confusion() {
        let mut response = BrokerResponseV1::busy(50);
        response.operation_id = Some("operation-1".to_owned());
        assert_eq!(
            response.validate(),
            Err(BrokerResponseError::InvalidFieldCombination),
        );
    }
}
