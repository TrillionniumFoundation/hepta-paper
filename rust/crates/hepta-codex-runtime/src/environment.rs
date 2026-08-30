use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    str::FromStr,
};

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAX_ENVIRONMENT_ENTRIES: usize = 128;
const MAX_ENVIRONMENT_VALUE_BYTES: usize = 64 * 1024;
const MAX_ENVIRONMENT_TOTAL_BYTES: usize = 1024 * 1024;
const SAFE_SECRET_LIKE_KEYS: &[&str] = &["CODEX_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR"];
const FORBIDDEN_EXACT_KEYS: &[&str] = &[
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "GITHUB_TOKEN",
    "AWS_SESSION_TOKEN",
    "KMS_CREDENTIAL",
    "PORTAL_CREDENTIAL",
    "SUBMISSION_CREDENTIAL",
];
const FORBIDDEN_PREFIXES: &[&str] = &[
    "OPENAI_",
    "AWS_",
    "GITHUB_",
    "KMS_",
    "PORTAL_",
    "SUBMISSION_",
    "WORM_",
    "BACKUP_",
];
const FORBIDDEN_SUFFIXES: &[&str] = &[
    "_API_KEY",
    "_KEY",
    "_TOKEN",
    "_SECRET",
    "_PASSWORD",
    "_CREDENTIAL",
    "_PRIVATE_KEY",
];

/// Versioned default-deny environment contract.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentPolicyV1 {
    pub version: u16,
    pub policy_id: String,
    pub allowed_keys: BTreeSet<String>,
    pub required_keys: BTreeSet<String>,
}

impl EnvironmentPolicyV1 {
    /// Constructs and validates a policy before it can influence a child process.
    pub fn new<A, R, AK, RK>(
        policy_id: impl Into<String>,
        allowed_keys: A,
        required_keys: R,
    ) -> Result<Self, EnvironmentBuildError>
    where
        A: IntoIterator<Item = AK>,
        R: IntoIterator<Item = RK>,
        AK: Into<String>,
        RK: Into<String>,
    {
        let policy = Self {
            version: 1,
            policy_id: policy_id.into(),
            allowed_keys: allowed_keys.into_iter().map(Into::into).collect(),
            required_keys: required_keys.into_iter().map(Into::into).collect(),
        };
        policy.validate()?;
        Ok(policy)
    }

    /// Validates policy shape and rejects secret-bearing allowlist entries.
    pub fn validate(&self) -> Result<(), EnvironmentBuildError> {
        if self.version != 1 {
            return Err(EnvironmentBuildError::UnsupportedPolicyVersion(
                self.version,
            ));
        }
        if !valid_policy_id(&self.policy_id) {
            return Err(EnvironmentBuildError::InvalidPolicyId);
        }
        if self.allowed_keys.is_empty() || self.allowed_keys.len() > MAX_ENVIRONMENT_ENTRIES {
            return Err(EnvironmentBuildError::InvalidAllowedKeyCount);
        }
        if !self.required_keys.is_subset(&self.allowed_keys) {
            return Err(EnvironmentBuildError::RequiredKeyNotAllowed);
        }
        for key in &self.allowed_keys {
            validate_key(key)?;
            if secret_like_key(key) && !SAFE_SECRET_LIKE_KEYS.contains(&key.as_str()) {
                return Err(EnvironmentBuildError::SecretLikeAllowedKey(key.clone()));
            }
        }
        Ok(())
    }

    /// Builds an immutable environment from an explicit source and explicit overrides.
    pub fn build<I>(
        &self,
        source: I,
        overrides: &BTreeMap<String, String>,
    ) -> Result<RestrictedEnvironmentV1, EnvironmentBuildError>
    where
        I: IntoIterator<Item = (OsString, OsString)>,
    {
        self.validate()?;
        let mut source_values = BTreeMap::<String, OsString>::new();
        for (raw_key, value) in source {
            let Some(key) = raw_key.to_str() else {
                continue;
            };
            if self.allowed_keys.contains(key) {
                source_values.insert(key.to_owned(), value);
            }
        }

        let mut values = BTreeMap::<String, String>::new();
        for key in &self.allowed_keys {
            if let Some(value) = source_values.get(key) {
                values.insert(key.clone(), environment_value(key, value.as_os_str())?);
            }
        }
        for (key, value) in overrides {
            if !self.allowed_keys.contains(key) {
                return Err(EnvironmentBuildError::OverrideKeyNotAllowed(key.clone()));
            }
            validate_key(key)?;
            if secret_like_key(key) && !SAFE_SECRET_LIKE_KEYS.contains(&key.as_str()) {
                return Err(EnvironmentBuildError::SecretLikeOverrideKey(key.clone()));
            }
            validate_value(key, value)?;
            values.insert(key.clone(), value.clone());
        }
        for key in &self.required_keys {
            if !values.contains_key(key) {
                return Err(EnvironmentBuildError::RequiredKeyMissing(key.clone()));
            }
        }
        if values.len() > MAX_ENVIRONMENT_ENTRIES {
            return Err(EnvironmentBuildError::EnvironmentTooManyEntries);
        }
        let total_bytes = values.iter().try_fold(0usize, |total, (key, value)| {
            total
                .checked_add(key.len())
                .and_then(|next| next.checked_add(value.len()))
                .ok_or(EnvironmentBuildError::EnvironmentTooLarge)
        })?;
        if total_bytes > MAX_ENVIRONMENT_TOTAL_BYTES {
            return Err(EnvironmentBuildError::EnvironmentTooLarge);
        }

        let policy_hash = hash_environment_policy(self)?;
        let environment_hash = hash_environment_values(&values)?;
        Ok(RestrictedEnvironmentV1 {
            values,
            policy_hash,
            environment_hash,
        })
    }
}

/// Immutable environment plus hashes bound into a runtime request or receipt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestrictedEnvironmentV1 {
    values: BTreeMap<String, String>,
    pub policy_hash: Sha256Digest,
    pub environment_hash: Sha256Digest,
}

impl RestrictedEnvironmentV1 {
    /// Returns the selected value for an allowed key.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    /// Iterates over the exact environment passed after `Command::env_clear`.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.values
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }

    /// Returns the immutable environment map.
    #[must_use]
    pub fn as_map(&self) -> &BTreeMap<String, String> {
        &self.values
    }
}

/// Production-shaped parent environment for the qualified Codex CLI process.
pub fn codex_parent_environment_policy_v1() -> EnvironmentPolicyV1 {
    EnvironmentPolicyV1::new(
        "codex-parent-v1",
        [
            "PATH",
            "HOME",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "TZ",
            "TMPDIR",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "CODEX_HOME",
        ],
        ["PATH", "HOME", "TMPDIR", "CODEX_HOME"],
    )
    .expect("static Codex parent environment policy must be valid")
}

/// Environment visible to commands launched by the model inside the workspace.
pub fn model_child_environment_policy_v1() -> EnvironmentPolicyV1 {
    EnvironmentPolicyV1::new(
        "codex-model-child-v1",
        [
            "PATH",
            "HOME",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "TZ",
            "TMPDIR",
            "SOURCE_DATE_EPOCH",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ],
        ["PATH", "HOME", "TMPDIR"],
    )
    .expect("static Codex model child environment policy must be valid")
}

fn valid_policy_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
}

fn validate_key(key: &str) -> Result<(), EnvironmentBuildError> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        || key.as_bytes()[0].is_ascii_digit()
    {
        return Err(EnvironmentBuildError::InvalidEnvironmentKey(key.to_owned()));
    }
    Ok(())
}

fn secret_like_key(key: &str) -> bool {
    FORBIDDEN_EXACT_KEYS.contains(&key)
        || FORBIDDEN_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
        || FORBIDDEN_SUFFIXES
            .iter()
            .any(|suffix| key.ends_with(suffix))
}

fn environment_value(key: &str, value: &OsStr) -> Result<String, EnvironmentBuildError> {
    let value = value
        .to_str()
        .ok_or_else(|| EnvironmentBuildError::NonUtf8AllowedValue(key.to_owned()))?;
    validate_value(key, value)?;
    Ok(value.to_owned())
}

fn validate_value(key: &str, value: &str) -> Result<(), EnvironmentBuildError> {
    if value.len() > MAX_ENVIRONMENT_VALUE_BYTES || value.contains('\0') {
        return Err(EnvironmentBuildError::InvalidEnvironmentValue(
            key.to_owned(),
        ));
    }
    Ok(())
}

fn hash_environment_policy(
    policy: &EnvironmentPolicyV1,
) -> Result<Sha256Digest, EnvironmentBuildError> {
    let mut hasher = DomainHasher::new("HeptaEnvironmentPolicyV1");
    hasher.field("version", &policy.version.to_string());
    hasher.field("policyId", &policy.policy_id);
    for key in &policy.allowed_keys {
        hasher.field("allowedKey", key);
    }
    for key in &policy.required_keys {
        hasher.field("requiredKey", key);
    }
    hasher.finish()
}

fn hash_environment_values(
    values: &BTreeMap<String, String>,
) -> Result<Sha256Digest, EnvironmentBuildError> {
    let mut hasher = DomainHasher::new("HeptaRestrictedEnvironmentV1");
    for (key, value) in values {
        hasher.field(key, value);
    }
    hasher.finish()
}

struct DomainHasher(Sha256);

impl DomainHasher {
    fn new(domain: &str) -> Self {
        let mut hasher = Sha256::new();
        update_length_prefixed(&mut hasher, domain.as_bytes());
        Self(hasher)
    }

    fn field(&mut self, key: &str, value: &str) {
        update_length_prefixed(&mut self.0, key.as_bytes());
        update_length_prefixed(&mut self.0, value.as_bytes());
    }

    fn finish(self) -> Result<Sha256Digest, EnvironmentBuildError> {
        let digest = format!("sha256:{}", hex::encode(self.0.finalize()));
        Sha256Digest::from_str(&digest).map_err(|_| EnvironmentBuildError::DigestConstruction)
    }
}

fn update_length_prefixed(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(bytes);
}

/// Invalid environment policy or environment construction.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum EnvironmentBuildError {
    #[error("unsupported environment policy version: {0}")]
    UnsupportedPolicyVersion(u16),
    #[error("environment policy id is invalid")]
    InvalidPolicyId,
    #[error("environment policy allowed-key count is invalid")]
    InvalidAllowedKeyCount,
    #[error("environment policy requires a key that is not allowed")]
    RequiredKeyNotAllowed,
    #[error("environment key is invalid: {0}")]
    InvalidEnvironmentKey(String),
    #[error("secret-like key cannot be allowlisted: {0}")]
    SecretLikeAllowedKey(String),
    #[error("override key is not allowed: {0}")]
    OverrideKeyNotAllowed(String),
    #[error("secret-like override key is forbidden: {0}")]
    SecretLikeOverrideKey(String),
    #[error("required environment key is missing: {0}")]
    RequiredKeyMissing(String),
    #[error("allowed environment value is not UTF-8: {0}")]
    NonUtf8AllowedValue(String),
    #[error("environment value is invalid or too large: {0}")]
    InvalidEnvironmentValue(String),
    #[error("environment contains too many entries")]
    EnvironmentTooManyEntries,
    #[error("environment exceeds the aggregate byte limit")]
    EnvironmentTooLarge,
    #[error("failed to construct canonical environment digest")]
    DigestConstruction,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> Vec<(OsString, OsString)> {
        [
            ("PATH", "/usr/bin"),
            ("HOME", "/private/codex"),
            ("TMPDIR", "/private/tmp"),
            ("CODEX_HOME", "/private/codex"),
            ("OPENAI_API_KEY", "must-not-leak"),
            ("AWS_SECRET_ACCESS_KEY", "must-not-leak"),
        ]
        .into_iter()
        .map(|(key, value)| (OsString::from(key), OsString::from(value)))
        .collect()
    }

    #[test]
    fn parent_policy_selects_only_explicit_nonsecret_keys() {
        let environment = codex_parent_environment_policy_v1()
            .build(source(), &BTreeMap::new())
            .expect("restricted parent environment");
        assert_eq!(environment.get("CODEX_HOME"), Some("/private/codex"));
        assert_eq!(environment.get("OPENAI_API_KEY"), None);
        assert_eq!(environment.get("AWS_SECRET_ACCESS_KEY"), None);
    }

    #[test]
    fn model_child_policy_cannot_receive_codex_home_or_provider_keys() {
        let environment = model_child_environment_policy_v1()
            .build(source(), &BTreeMap::new())
            .expect("restricted model child environment");
        assert_eq!(environment.get("CODEX_HOME"), None);
        assert_eq!(environment.get("OPENAI_API_KEY"), None);
    }

    #[test]
    fn secret_like_allowlist_extensions_fail_closed() {
        let result = EnvironmentPolicyV1::new("invalid-v1", ["PATH", "MY_SERVICE_TOKEN"], ["PATH"]);
        assert_eq!(
            result,
            Err(EnvironmentBuildError::SecretLikeAllowedKey(
                "MY_SERVICE_TOKEN".to_owned(),
            )),
        );
    }

    #[test]
    fn unallowed_override_is_rejected() {
        let overrides = BTreeMap::from([("OPENAI_API_KEY".to_owned(), "secret".to_owned())]);
        assert_eq!(
            codex_parent_environment_policy_v1().build(source(), &overrides),
            Err(EnvironmentBuildError::OverrideKeyNotAllowed(
                "OPENAI_API_KEY".to_owned(),
            )),
        );
    }
}
