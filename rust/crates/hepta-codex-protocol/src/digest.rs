use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

/// A lowercase, algorithm-tagged SHA-256 digest (`sha256:<64 hex chars>`).
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(String);

impl Sha256Digest {
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
