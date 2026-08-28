use std::{
    io::{self, Read, Write},
    str::FromStr,
};

use hepta_codex_protocol::Sha256Digest;
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use thiserror::Error;

const FRAME_MAGIC: [u8; 8] = *b"HEPTACX1";
const FRAME_VERSION: u16 = 1;
const FRAME_HEADER_BYTES: usize = 56;
const HARD_MAXIMUM_PAYLOAD_BYTES: u64 = 16 * 1024 * 1024;

/// Message class encoded in the fixed frame header.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum BrokerFrameKind {
    Request = 1,
    Response = 2,
    Error = 3,
}

impl TryFrom<u16> for BrokerFrameKind {
    type Error = FrameProtocolError;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Request),
            2 => Ok(Self::Response),
            3 => Ok(Self::Error),
            _ => Err(FrameProtocolError::UnknownFrameKind(value)),
        }
    }
}

/// Deployment-specific payload limit bounded by a protocol hard maximum.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FrameLimitsV1 {
    pub maximum_payload_bytes: u64,
}

impl Default for FrameLimitsV1 {
    fn default() -> Self {
        Self {
            maximum_payload_bytes: 2 * 1024 * 1024,
        }
    }
}

impl FrameLimitsV1 {
    fn validate(self) -> Result<Self, FrameProtocolError> {
        if self.maximum_payload_bytes == 0
            || self.maximum_payload_bytes > HARD_MAXIMUM_PAYLOAD_BYTES
        {
            return Err(FrameProtocolError::InvalidLimits);
        }
        Ok(self)
    }
}

/// A fully read and hash-verified frame.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerFrameV1 {
    pub kind: BrokerFrameKind,
    pub payload: Vec<u8>,
    pub payload_hash: Sha256Digest,
}

/// Encodes a frame after enforcing the payload limit.
pub fn encode_frame(
    kind: BrokerFrameKind,
    payload: &[u8],
    limits: FrameLimitsV1,
) -> Result<Vec<u8>, FrameProtocolError> {
    let limits = limits.validate()?;
    let payload_length = u64::try_from(payload.len())
        .map_err(|_| FrameProtocolError::PayloadLengthOverflow)?;
    validate_payload_length(payload_length, limits)?;
    let payload_digest = Sha256::digest(payload);
    let capacity = FRAME_HEADER_BYTES
        .checked_add(payload.len())
        .ok_or(FrameProtocolError::PayloadLengthOverflow)?;
    let mut frame = Vec::with_capacity(capacity);
    frame.extend_from_slice(&FRAME_MAGIC);
    frame.extend_from_slice(&FRAME_VERSION.to_be_bytes());
    frame.extend_from_slice(&(kind as u16).to_be_bytes());
    frame.extend_from_slice(&0_u32.to_be_bytes());
    frame.extend_from_slice(&payload_length.to_be_bytes());
    frame.extend_from_slice(&payload_digest);
    frame.extend_from_slice(payload);
    Ok(frame)
}

/// Serializes a JSON object and encodes it as one broker frame.
pub fn encode_json_frame<T: Serialize>(
    kind: BrokerFrameKind,
    value: &T,
    limits: FrameLimitsV1,
) -> Result<Vec<u8>, FrameProtocolError> {
    let payload = serde_json::to_vec(value).map_err(FrameProtocolError::JsonEncode)?;
    encode_frame(kind, &payload, limits)
}

/// Writes one complete frame and flushes the destination.
pub fn write_frame<W: Write>(
    writer: &mut W,
    kind: BrokerFrameKind,
    payload: &[u8],
    limits: FrameLimitsV1,
) -> Result<Sha256Digest, FrameProtocolError> {
    let frame = encode_frame(kind, payload, limits)?;
    writer.write_all(&frame).map_err(FrameProtocolError::Write)?;
    writer.flush().map_err(FrameProtocolError::Write)?;
    digest_for(payload)
}

/// Reads exactly one frame. Payload length is checked before allocation.
pub fn read_frame<R: Read>(
    reader: &mut R,
    limits: FrameLimitsV1,
) -> Result<BrokerFrameV1, FrameProtocolError> {
    let limits = limits.validate()?;
    let mut header = [0_u8; FRAME_HEADER_BYTES];
    read_exact_classified(reader, &mut header, true)?;
    if header[..8] != FRAME_MAGIC {
        return Err(FrameProtocolError::InvalidMagic);
    }
    let version = u16::from_be_bytes([header[8], header[9]]);
    if version != FRAME_VERSION {
        return Err(FrameProtocolError::UnsupportedVersion(version));
    }
    let kind = BrokerFrameKind::try_from(u16::from_be_bytes([header[10], header[11]]))?;
    let flags = u32::from_be_bytes([header[12], header[13], header[14], header[15]]);
    if flags != 0 {
        return Err(FrameProtocolError::UnsupportedFlags(flags));
    }
    let payload_length = u64::from_be_bytes([
        header[16], header[17], header[18], header[19], header[20], header[21], header[22],
        header[23],
    ]);
    validate_payload_length(payload_length, limits)?;
    let payload_length_usize = usize::try_from(payload_length)
        .map_err(|_| FrameProtocolError::PayloadLengthOverflow)?;
    let mut expected_digest = [0_u8; 32];
    expected_digest.copy_from_slice(&header[24..56]);
    let mut payload = vec![0_u8; payload_length_usize];
    read_exact_classified(reader, &mut payload, false)?;
    let observed_digest: [u8; 32] = Sha256::digest(&payload).into();
    if !constant_time_equal(&expected_digest, &observed_digest) {
        return Err(FrameProtocolError::PayloadHashMismatch);
    }
    Ok(BrokerFrameV1 {
        kind,
        payload_hash: digest_from_bytes(observed_digest)?,
        payload,
    })
}

/// Deserializes a hash-verified JSON payload after checking the frame kind.
pub fn decode_json_payload<T: DeserializeOwned>(
    frame: &BrokerFrameV1,
    expected_kind: BrokerFrameKind,
) -> Result<T, FrameProtocolError> {
    if frame.kind != expected_kind {
        return Err(FrameProtocolError::UnexpectedFrameKind {
            expected: expected_kind,
            observed: frame.kind,
        });
    }
    serde_json::from_slice(&frame.payload).map_err(FrameProtocolError::JsonDecode)
}

fn validate_payload_length(
    payload_length: u64,
    limits: FrameLimitsV1,
) -> Result<(), FrameProtocolError> {
    if payload_length == 0 {
        return Err(FrameProtocolError::EmptyPayload);
    }
    if payload_length > limits.maximum_payload_bytes {
        return Err(FrameProtocolError::PayloadTooLarge {
            observed: payload_length,
            maximum: limits.maximum_payload_bytes,
        });
    }
    Ok(())
}

fn read_exact_classified<R: Read>(
    reader: &mut R,
    target: &mut [u8],
    header: bool,
) -> Result<(), FrameProtocolError> {
    match reader.read_exact(target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
            if header {
                Err(FrameProtocolError::TruncatedHeader)
            } else {
                Err(FrameProtocolError::TruncatedPayload)
            }
        }
        Err(error) => Err(FrameProtocolError::Read(error.kind())),
    }
}

fn digest_for(payload: &[u8]) -> Result<Sha256Digest, FrameProtocolError> {
    digest_from_bytes(Sha256::digest(payload).into())
}

fn digest_from_bytes(bytes: [u8; 32]) -> Result<Sha256Digest, FrameProtocolError> {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(bytes)))
        .map_err(|_| FrameProtocolError::DigestConstruction)
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

/// Framing, allocation-bound, hash or JSON error.
#[derive(Debug, Error)]
pub enum FrameProtocolError {
    #[error("frame limits are invalid")]
    InvalidLimits,
    #[error("frame magic is invalid")]
    InvalidMagic,
    #[error("unsupported frame version: {0}")]
    UnsupportedVersion(u16),
    #[error("unknown frame kind: {0}")]
    UnknownFrameKind(u16),
    #[error("unsupported frame flags: {0}")]
    UnsupportedFlags(u32),
    #[error("frame payload cannot be empty")]
    EmptyPayload,
    #[error("frame payload is too large: observed {observed}, maximum {maximum}")]
    PayloadTooLarge { observed: u64, maximum: u64 },
    #[error("frame payload length overflowed")]
    PayloadLengthOverflow,
    #[error("frame header is truncated")]
    TruncatedHeader,
    #[error("frame payload is truncated")]
    TruncatedPayload,
    #[error("frame payload hash does not match the header")]
    PayloadHashMismatch,
    #[error("unexpected frame kind: expected {expected:?}, observed {observed:?}")]
    UnexpectedFrameKind {
        expected: BrokerFrameKind,
        observed: BrokerFrameKind,
    },
    #[error("frame read failed: {0:?}")]
    Read(io::ErrorKind),
    #[error("frame write failed: {0}")]
    Write(io::Error),
    #[error("JSON encoding failed: {0}")]
    JsonEncode(serde_json::Error),
    #[error("JSON decoding failed: {0}")]
    JsonDecode(serde_json::Error),
    #[error("failed to construct canonical frame digest")]
    DigestConstruction,
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use serde::{Deserialize, Serialize};

    use super::*;

    #[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Fixture {
        value: u64,
    }

    #[test]
    fn frame_round_trip_preserves_exact_payload() {
        let payload = br#"{"value":7}"#;
        let encoded = encode_frame(BrokerFrameKind::Request, payload, FrameLimitsV1::default())
            .expect("encode frame");
        let decoded = read_frame(&mut Cursor::new(encoded), FrameLimitsV1::default())
            .expect("decode frame");
        assert_eq!(decoded.kind, BrokerFrameKind::Request);
        assert_eq!(decoded.payload, payload);
        assert_eq!(
            decode_json_payload::<Fixture>(&decoded, BrokerFrameKind::Request)
                .expect("decode payload"),
            Fixture { value: 7 },
        );
    }

    #[test]
    fn oversized_length_is_rejected_before_payload_read() {
        let mut header = [0_u8; FRAME_HEADER_BYTES];
        header[..8].copy_from_slice(&FRAME_MAGIC);
        header[8..10].copy_from_slice(&FRAME_VERSION.to_be_bytes());
        header[10..12].copy_from_slice(&(BrokerFrameKind::Request as u16).to_be_bytes());
        header[16..24].copy_from_slice(&(3 * 1024 * 1024_u64).to_be_bytes());
        assert!(matches!(
            read_frame(&mut Cursor::new(header), FrameLimitsV1::default()),
            Err(FrameProtocolError::PayloadTooLarge { .. }),
        ));
    }

    #[test]
    fn truncated_and_tampered_frames_fail_closed() {
        assert!(matches!(
            read_frame(&mut Cursor::new([1_u8; 12]), FrameLimitsV1::default()),
            Err(FrameProtocolError::TruncatedHeader),
        ));
        let mut frame = encode_frame(
            BrokerFrameKind::Request,
            b"payload",
            FrameLimitsV1::default(),
        )
        .expect("encode frame");
        frame.pop();
        assert!(matches!(
            read_frame(&mut Cursor::new(frame), FrameLimitsV1::default()),
            Err(FrameProtocolError::TruncatedPayload),
        ));
        let mut frame = encode_frame(
            BrokerFrameKind::Request,
            b"payload",
            FrameLimitsV1::default(),
        )
        .expect("encode frame");
        let last = frame.last_mut().expect("payload byte");
        *last ^= 1;
        assert!(matches!(
            read_frame(&mut Cursor::new(frame), FrameLimitsV1::default()),
            Err(FrameProtocolError::PayloadHashMismatch),
        ));
    }

    #[test]
    fn unknown_json_fields_are_rejected_by_wire_types() {
        let frame = BrokerFrameV1 {
            kind: BrokerFrameKind::Request,
            payload: br#"{"value":7,"extra":1}"#.to_vec(),
            payload_hash: digest_for(br#"{"value":7,"extra":1}"#).expect("digest"),
        };
        assert!(matches!(
            decode_json_payload::<Fixture>(&frame, BrokerFrameKind::Request),
            Err(FrameProtocolError::JsonDecode(_)),
        ));
    }
}
