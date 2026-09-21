use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

/// A lowercase, algorithm-tagged SHA-256 digest (`sha256:<64 hex chars>`).
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(String);

impl Sha256Digest {
    /// Encodes an already-computed, 32-byte SHA-256 digest in canonical form.
    ///
    /// These bytes are the digest itself, not input to be hashed. This method
    /// performs no hashing and accepts every possible SHA-256 output.
    #[must_use]
    pub fn from_digest_bytes(bytes: [u8; 32]) -> Self {
        fn digit(nibble: u8) -> char {
            char::from(if nibble < 10 {
                b'0' + nibble
            } else {
                b'a' + nibble - 10
            })
        }
        let mut encoded = String::with_capacity(71);
        encoded.push_str("sha256:");
        for byte in bytes {
            encoded.push(digit(byte >> 4));
            encoded.push(digit(byte & 0x0f));
        }
        Self(encoded)
    }

    /// Returns the canonical string representation.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<Sha256Digest> for String {
    fn from(value: Sha256Digest) -> Self {
        value.0
    }
}

impl FromStr for Sha256Digest {
    type Err = DigestParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() != 71 || !value.starts_with("sha256:") {
            return Err(DigestParseError::InvalidShape);
        }
        let hexadecimal = &value.as_bytes()[7..];
        if !hexadecimal
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return Err(DigestParseError::InvalidHexadecimal);
        }
        Ok(Self(value.to_owned()))
    }
}

impl TryFrom<String> for Sha256Digest {
    type Error = DigestParseError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::from_str(&value)
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::try_from(value).map_err(serde::de::Error::custom)
    }
}

/// Why a digest string was rejected.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum DigestParseError {
    /// The algorithm prefix or length was not canonical.
    #[error("digest must use the canonical sha256:<64 lowercase hex> shape")]
    InvalidShape,
    /// The payload contained uppercase or non-hexadecimal bytes.
    #[error("digest payload must contain lowercase hexadecimal characters only")]
    InvalidHexadecimal,
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::{DigestParseError, Sha256Digest};

    #[test]
    fn encodes_existing_digest_bytes_without_hashing() {
        let bytes = std::array::from_fn(|index| index as u8);
        let digest = Sha256Digest::from_digest_bytes(bytes);
        let expected = "sha256:000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        assert_eq!(digest.as_str(), expected);
        assert_eq!(Sha256Digest::from_str(expected).unwrap(), digest);
        assert_eq!(
            Sha256Digest::from_digest_bytes([0xff; 32]).as_str(),
            format!("sha256:{}", "ff".repeat(32))
        );
        assert_eq!(
            Sha256Digest::from_digest_bytes([0; 32]).as_str(),
            format!("sha256:{}", "00".repeat(32))
        );
    }

    #[test]
    fn accepts_canonical_digest() {
        let value = format!("sha256:{}", "a".repeat(64));
        let digest = Sha256Digest::from_str(&value).expect("canonical digest");
        assert_eq!(digest.as_str(), value);
    }

    #[test]
    fn rejects_uppercase_and_bad_length() {
        assert_eq!(
            Sha256Digest::from_str(&format!("sha256:{}", "A".repeat(64))),
            Err(DigestParseError::InvalidHexadecimal)
        );
        assert_eq!(
            Sha256Digest::from_str("sha256:abc"),
            Err(DigestParseError::InvalidShape)
        );
    }
}
