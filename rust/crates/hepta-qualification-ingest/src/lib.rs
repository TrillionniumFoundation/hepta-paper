//! Canonical, independently signed external qualification evidence ingestion.

#[cfg(not(unix))]
compile_error!("hepta-qualification-ingest requires Unix file identity semantics");

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_EVIDENCE_BYTES: u64 = 8 * 1024 * 1024;

/// Closed package vocabulary accepted by the source verifier.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum QualificationPackageIdV1 {
    /// Protected-main ruleset and denial evidence.
    #[serde(rename = "EXT-GOV-MAIN-001")]
    ExtGovMain001,
    /// Linux cgroup and low-level review.
    #[serde(rename = "EXT-HOST-CGROUP-001")]
    ExtHostCgroup001,
    /// Journal/storage destructive failure matrix.
    #[serde(rename = "EXT-HOST-STORAGE-001")]
    ExtHostStorage001,
    /// Capability key-owner lifecycle.
    #[serde(rename = "EXT-KEY-OWNER-001")]
    ExtKeyOwner001,
    /// Authenticated separate-role Codex canaries.
    #[serde(rename = "EXT-CODEX-ROLE-001")]
    ExtCodexRole001,
    /// Production-shaped cutover and soak.
    #[serde(rename = "EXT-CUTOVER-SOAK-001")]
    ExtCutoverSoak001,
    /// Four-domain irreversible-action authority set.
    #[serde(rename = "EXT-AUTHORITY-SET-001")]
    ExtAuthoritySet001,
}

impl QualificationPackageIdV1 {
    /// Complete package vocabulary accepted by this source version.
    pub const ALL: [Self; 7] = [
        Self::ExtGovMain001,
        Self::ExtHostCgroup001,
        Self::ExtHostStorage001,
        Self::ExtKeyOwner001,
        Self::ExtCodexRole001,
        Self::ExtCutoverSoak001,
        Self::ExtAuthoritySet001,
    ];

    /// Canonical externally visible package identifier.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ExtGovMain001 => "EXT-GOV-MAIN-001",
            Self::ExtHostCgroup001 => "EXT-HOST-CGROUP-001",
            Self::ExtHostStorage001 => "EXT-HOST-STORAGE-001",
            Self::ExtKeyOwner001 => "EXT-KEY-OWNER-001",
            Self::ExtCodexRole001 => "EXT-CODEX-ROLE-001",
            Self::ExtCutoverSoak001 => "EXT-CUTOVER-SOAK-001",
            Self::ExtAuthoritySet001 => "EXT-AUTHORITY-SET-001",
        }
    }
}

/// Signed envelope around one schema-validated external payload hash.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalQualificationEnvelopeV1 {
    /// Contract version.
    pub version: u16,
    /// Qualification package.
    pub package_id: QualificationPackageIdV1,
    /// Exact repository.
    pub repository: String,
    /// Exact Git commit.
    pub commit: String,
    /// Exact Git tree.
    pub tree: String,
    /// Hash of the complete schema-validated external payload.
    pub payload_hash: String,
    /// Separately administered authority domain.
    pub authority_domain_id: String,
    /// Public verification key ID.
    pub signer_key_id: String,
    /// Single-use replay nonce.
    pub nonce: String,
    /// Issue time.
    pub issued_at_unix_ms: u64,
    /// Expiry time.
    pub expires_at_unix_ms: u64,
    /// Canonical URL-safe unpadded Ed25519 signature.
    pub signature_base64: String,
}

/// Qualified public keys administered outside the implementation domain.
#[derive(Clone, Debug)]
pub struct QualificationTrustStoreV1 {
    keys: BTreeMap<(String, String), VerifyingKey>,
    forbidden_authority_domains: BTreeSet<String>,
}

impl QualificationTrustStoreV1 {
    /// Constructs a nonempty trust store and rejects duplicate or weak keys.
    pub fn new<I, J>(entries: I, forbidden_domains: J) -> Result<Self, QualificationIngestError>
    where
        I: IntoIterator<Item = (String, String, VerifyingKey)>,
        J: IntoIterator<Item = String>,
    {
        let mut keys = BTreeMap::new();
        let mut key_material = BTreeSet::new();
        for (domain, key_id, key) in entries {
            if !valid_identifier(&domain)
                || !valid_identifier(&key_id)
                || key.is_weak()
                || !key_material.insert(key.to_bytes())
            {
                return Err(QualificationIngestError::TrustStoreInvalid);
            }
            if keys.insert((domain, key_id), key).is_some() {
                return Err(QualificationIngestError::TrustStoreInvalid);
            }
        }
        if keys.is_empty() || keys.len() > 128 {
            return Err(QualificationIngestError::TrustStoreInvalid);
        }
        let mut forbidden_authority_domains = BTreeSet::new();
        for domain in forbidden_domains {
            if !valid_identifier(&domain)
                || forbidden_authority_domains.len() == 128
                || !forbidden_authority_domains.insert(domain)
            {
                return Err(QualificationIngestError::TrustStoreInvalid);
            }
        }
        Ok(Self {
            keys,
            forbidden_authority_domains,
        })
    }

    fn key(&self, domain: &str, key_id: &str) -> Result<&VerifyingKey, QualificationIngestError> {
        if self.forbidden_authority_domains.contains(domain) {
            return Err(QualificationIngestError::AuthorityDomainForbidden);
        }
        self.keys
            .get(&(domain.to_owned(), key_id.to_owned()))
            .ok_or(QualificationIngestError::UnknownSigner)
    }
}

/// Exact candidate identity expected by the ingestion operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QualificationSubjectV1 {
    /// Repository.
    pub repository: String,
    /// Git commit.
    pub commit: String,
    /// Git tree.
    pub tree: String,
    /// Package whose payload is being accepted.
    pub package_id: QualificationPackageIdV1,
}

/// Verified external evidence candidate. It grants no production activation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedExternalQualificationV1 {
    /// Package ID.
    pub package_id: QualificationPackageIdV1,
    /// Exact payload hash.
    pub payload_hash: String,
    /// External authority domain.
    pub authority_domain_id: String,
    /// External signer key.
    pub signer_key_id: String,
    /// Replay nonce.
    pub nonce: String,
    /// Signing-message hash.
    pub signing_message_hash: String,
}

/// Loads a canonical read-only evidence envelope owned outside the consuming principal.
pub fn load_external_qualification_file_v1(
    path: &Path,
    expected_owner_uid: u32,
    consumer_uid: u32,
) -> Result<ExternalQualificationEnvelopeV1, QualificationIngestError> {
    if expected_owner_uid == consumer_uid || !path.is_absolute() {
        return Err(QualificationIngestError::FileAuthorityInvalid);
    }
    let canonical =
        fs::canonicalize(path).map_err(|_| QualificationIngestError::FileAuthorityInvalid)?;
    if canonical != path {
        return Err(QualificationIngestError::FileAuthorityInvalid);
    }
    inspect_ancestors(path, consumer_uid)?;
    let before = fs::symlink_metadata(path)?;
    let mode = before.mode() & 0o7777;
    if before.file_type().is_symlink()
        || !before.is_file()
        || before.uid() != expected_owner_uid
        || before.nlink() != 1
        || !matches!(mode, 0o400 | 0o440)
        || before.size() == 0
        || before.size() > MAXIMUM_EVIDENCE_BYTES
    {
        return Err(QualificationIngestError::FileAuthorityInvalid);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix_no_follow_cloexec())
        .open(path)?;
    let opened = file.metadata()?;
    if !same_file(&before, &opened) {
        return Err(QualificationIngestError::FileChanged);
    }
    let capacity =
        usize::try_from(opened.size()).map_err(|_| QualificationIngestError::EvidenceTooLarge)?;
    let mut bytes = Vec::with_capacity(capacity);
    (&mut file)
        .take(MAXIMUM_EVIDENCE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len()).map_err(|_| QualificationIngestError::EvidenceTooLarge)?
        != opened.size()
    {
        return Err(QualificationIngestError::FileChanged);
    }
    let after_path = fs::symlink_metadata(path)?;
    let after_open = file.metadata()?;
    if !same_file(&opened, &after_open) || !same_file(&after_open, &after_path) {
        return Err(QualificationIngestError::FileChanged);
    }
    let envelope: ExternalQualificationEnvelopeV1 =
        serde_json::from_slice(&bytes).map_err(|_| QualificationIngestError::EncodingInvalid)?;
    let canonical_bytes =
        serde_json::to_vec(&envelope).map_err(|_| QualificationIngestError::EncodingInvalid)?;
    if canonical_bytes != bytes {
        return Err(QualificationIngestError::EncodingInvalid);
    }
    Ok(envelope)
}

/// Verifies exact subject binding, freshness, external authority and Ed25519 signature.
pub fn verify_external_qualification_v1(
    envelope: &ExternalQualificationEnvelopeV1,
    subject: &QualificationSubjectV1,
    now_unix_ms: u64,
    trust_store: &QualificationTrustStoreV1,
) -> Result<VerifiedExternalQualificationV1, QualificationIngestError> {
    validate_envelope(envelope)?;
    if now_unix_ms == 0
        || envelope.issued_at_unix_ms > now_unix_ms
        || envelope.expires_at_unix_ms <= now_unix_ms
        || envelope.expires_at_unix_ms - envelope.issued_at_unix_ms > 30 * 24 * 60 * 60 * 1000
    {
        return Err(QualificationIngestError::EvidenceExpired);
    }
    if envelope.repository != subject.repository
        || envelope.commit != subject.commit
        || envelope.tree != subject.tree
        || envelope.package_id != subject.package_id
    {
        return Err(QualificationIngestError::SubjectMismatch);
    }
    let key = trust_store.key(&envelope.authority_domain_id, &envelope.signer_key_id)?;
    let signing_bytes = qualification_signing_bytes_v1(envelope)?;
    let signature_bytes = Base64UrlUnpadded::decode_vec(&envelope.signature_base64)
        .map_err(|_| QualificationIngestError::SignatureEncoding)?;
    let signature = Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| QualificationIngestError::SignatureEncoding)?;
    key.verify_strict(&signing_bytes, &signature)
        .map_err(|_| QualificationIngestError::SignatureRejected)?;
    Ok(VerifiedExternalQualificationV1 {
        package_id: envelope.package_id,
        payload_hash: envelope.payload_hash.clone(),
        authority_domain_id: envelope.authority_domain_id.clone(),
        signer_key_id: envelope.signer_key_id.clone(),
        nonce: envelope.nonce.clone(),
        signing_message_hash: hash_bytes(&signing_bytes),
    })
}

/// Canonical domain-separated signing message without the signature field.
pub fn qualification_signing_bytes_v1(
    envelope: &ExternalQualificationEnvelopeV1,
) -> Result<Vec<u8>, QualificationIngestError> {
    validate_envelope(envelope)?;
    let mut output = Vec::new();
    for value in [
        "HeptaExternalQualificationEnvelopeV1".as_bytes(),
        &envelope.version.to_be_bytes(),
        envelope.package_id.as_str().as_bytes(),
        envelope.repository.as_bytes(),
        envelope.commit.as_bytes(),
        envelope.tree.as_bytes(),
        envelope.payload_hash.as_bytes(),
        envelope.authority_domain_id.as_bytes(),
        envelope.signer_key_id.as_bytes(),
        envelope.nonce.as_bytes(),
        &envelope.issued_at_unix_ms.to_be_bytes(),
        &envelope.expires_at_unix_ms.to_be_bytes(),
    ] {
        let length =
            u64::try_from(value.len()).map_err(|_| QualificationIngestError::EncodingInvalid)?;
        output.extend_from_slice(&length.to_be_bytes());
        output.extend_from_slice(value);
    }
    Ok(output)
}

fn validate_envelope(
    value: &ExternalQualificationEnvelopeV1,
) -> Result<(), QualificationIngestError> {
    if value.version != 1
        || value.repository != "TrillionniumFoundation/hepta-paper"
        || !valid_git_hash(&value.commit)
        || !valid_git_hash(&value.tree)
        || !valid_sha256(&value.payload_hash)
        || !valid_identifier(&value.authority_domain_id)
        || !valid_identifier(&value.signer_key_id)
        || !valid_identifier(&value.nonce)
        || value.issued_at_unix_ms == 0
        || value.expires_at_unix_ms <= value.issued_at_unix_ms
        || value.signature_base64.is_empty()
    {
        return Err(QualificationIngestError::EnvelopeInvalid);
    }
    Ok(())
}

fn inspect_ancestors(path: &Path, consumer_uid: u32) -> Result<(), QualificationIngestError> {
    let mut current = path
        .parent()
        .ok_or(QualificationIngestError::FileAuthorityInvalid)?;
    loop {
        let metadata = fs::symlink_metadata(current)?;
        let canonical = fs::canonicalize(current)?;
        let mode = metadata.mode() & 0o7777;
        if canonical != current
            || metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || mode & 0o022 != 0
            || (metadata.uid() == consumer_uid && mode & 0o200 != 0)
        {
            return Err(QualificationIngestError::FileAuthorityInvalid);
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    Ok(())
}

fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
        && left.size() == right.size()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn nix_no_follow_cloexec() -> i32 {
    nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC
}

fn valid_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= 128
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn valid_git_hash(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn hash_bytes(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

/// External evidence file, contract, trust, time or signature failure.
#[derive(Debug, Error)]
pub enum QualificationIngestError {
    /// Envelope fields are invalid.
    #[error("external qualification envelope is invalid")]
    EnvelopeInvalid,
    /// Trust-store entry or forbidden-domain policy is invalid.
    #[error("qualification trust store is invalid")]
    TrustStoreInvalid,
    /// Evidence authority or path ownership is invalid.
    #[error("qualification evidence file authority is invalid")]
    FileAuthorityInvalid,
    /// File object changed during loading.
    #[error("qualification evidence file changed during loading")]
    FileChanged,
    /// Evidence exceeds the hard size limit.
    #[error("qualification evidence is too large")]
    EvidenceTooLarge,
    /// JSON is invalid or noncanonical.
    #[error("qualification evidence encoding is invalid")]
    EncodingInvalid,
    /// Evidence is stale, future-dated or overlong.
    #[error("qualification evidence is expired")]
    EvidenceExpired,
    /// Repository, commit, tree or package differs.
    #[error("qualification subject binding mismatch")]
    SubjectMismatch,
    /// Implementation/local authority domain is forbidden.
    #[error("qualification authority domain is forbidden")]
    AuthorityDomainForbidden,
    /// Signer is absent from the external trust store.
    #[error("qualification signer is unknown")]
    UnknownSigner,
    /// Signature bytes are noncanonical.
    #[error("qualification signature encoding is invalid")]
    SignatureEncoding,
    /// Ed25519 signature was rejected.
    #[error("qualification signature was rejected")]
    SignatureRejected,
    /// Filesystem operation failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use base64ct::{Base64UrlUnpadded, Encoding};
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    fn envelope() -> ExternalQualificationEnvelopeV1 {
        ExternalQualificationEnvelopeV1 {
            version: 1,
            package_id: QualificationPackageIdV1::ExtHostCgroup001,
            repository: "TrillionniumFoundation/hepta-paper".into(),
            commit: "1".repeat(40),
            tree: "2".repeat(40),
            payload_hash: format!("sha256:{}", "3".repeat(64)),
            authority_domain_id: "independent-linux-review".into(),
            signer_key_id: "review-key-1".into(),
            nonce: "review-nonce-1".into(),
            issued_at_unix_ms: 10_000,
            expires_at_unix_ms: 20_000,
            signature_base64: "AA".into(),
        }
    }

    #[test]
    fn exact_external_signature_and_subject_are_required() {
        let signing = SigningKey::from_bytes(&[21_u8; 32]);
        let mut value = envelope();
        let bytes = qualification_signing_bytes_v1(&value).expect("signing bytes");
        value.signature_base64 = Base64UrlUnpadded::encode_string(&signing.sign(&bytes).to_bytes());
        let trust = QualificationTrustStoreV1::new(
            [(
                value.authority_domain_id.clone(),
                value.signer_key_id.clone(),
                signing.verifying_key(),
            )],
            [
                "repository-admin".to_owned(),
                "implementation-author".to_owned(),
            ],
        )
        .expect("trust store");
        let subject = QualificationSubjectV1 {
            repository: value.repository.clone(),
            commit: value.commit.clone(),
            tree: value.tree.clone(),
            package_id: value.package_id,
        };
        let verified = verify_external_qualification_v1(&value, &subject, 15_000, &trust)
            .expect("verified evidence");
        assert_eq!(verified.payload_hash, value.payload_hash);
        let mut tampered = value;
        tampered.tree = "4".repeat(40);
        assert!(matches!(
            verify_external_qualification_v1(&tampered, &subject, 15_000, &trust),
            Err(QualificationIngestError::SubjectMismatch)
                | Err(QualificationIngestError::SignatureRejected)
        ));
    }

    #[test]
    fn implementation_authority_domain_cannot_substitute_for_external_review() {
        let signing = SigningKey::from_bytes(&[22_u8; 32]);
        let mut value = envelope();
        value.authority_domain_id = "implementation-author".into();
        let bytes = qualification_signing_bytes_v1(&value).expect("signing bytes");
        value.signature_base64 = Base64UrlUnpadded::encode_string(&signing.sign(&bytes).to_bytes());
        let trust = QualificationTrustStoreV1::new(
            [(
                value.authority_domain_id.clone(),
                value.signer_key_id.clone(),
                signing.verifying_key(),
            )],
            ["implementation-author".to_owned()],
        )
        .expect("trust store");
        let subject = QualificationSubjectV1 {
            repository: value.repository.clone(),
            commit: value.commit.clone(),
            tree: value.tree.clone(),
            package_id: value.package_id,
        };
        assert!(matches!(
            verify_external_qualification_v1(&value, &subject, 15_000, &trust),
            Err(QualificationIngestError::AuthorityDomainForbidden)
        ));
    }
    #[test]
    fn one_public_key_cannot_alias_multiple_authority_domains() {
        let signing = SigningKey::from_bytes(&[23_u8; 32]);
        let verifying = signing.verifying_key();
        let result = QualificationTrustStoreV1::new(
            [
                (
                    "governance-review".to_owned(),
                    "governance-key".to_owned(),
                    verifying,
                ),
                ("linux-review".to_owned(), "linux-key".to_owned(), verifying),
            ],
            std::iter::empty::<String>(),
        );
        assert!(matches!(
            result,
            Err(QualificationIngestError::TrustStoreInvalid)
        ));
    }

    #[test]
    fn identifiers_match_schema_and_forbidden_domains_are_unique() {
        for valid in ["a", "A0", "review:key-1", "authority_domain.v1"] {
            assert!(valid_identifier(valid), "{valid}");
        }
        for invalid in ["", "-leading", "_leading", ".leading", ":leading", "é"] {
            assert!(!valid_identifier(invalid), "{invalid}");
        }
        assert!(!valid_identifier(&"a".repeat(129)));

        let signing = SigningKey::from_bytes(&[24_u8; 32]);
        let duplicate_forbidden = QualificationTrustStoreV1::new(
            [(
                "independent-review".to_owned(),
                "review-key".to_owned(),
                signing.verifying_key(),
            )],
            ["repository-admin".to_owned(), "repository-admin".to_owned()],
        );
        assert!(matches!(
            duplicate_forbidden,
            Err(QualificationIngestError::TrustStoreInvalid)
        ));
    }

    #[test]
    fn closed_package_vocabulary_round_trips_canonical_external_ids() {
        let expected = [
            (QualificationPackageIdV1::ExtGovMain001, "EXT-GOV-MAIN-001"),
            (
                QualificationPackageIdV1::ExtHostCgroup001,
                "EXT-HOST-CGROUP-001",
            ),
            (
                QualificationPackageIdV1::ExtHostStorage001,
                "EXT-HOST-STORAGE-001",
            ),
            (
                QualificationPackageIdV1::ExtKeyOwner001,
                "EXT-KEY-OWNER-001",
            ),
            (
                QualificationPackageIdV1::ExtCodexRole001,
                "EXT-CODEX-ROLE-001",
            ),
            (
                QualificationPackageIdV1::ExtCutoverSoak001,
                "EXT-CUTOVER-SOAK-001",
            ),
            (
                QualificationPackageIdV1::ExtAuthoritySet001,
                "EXT-AUTHORITY-SET-001",
            ),
        ];
        assert_eq!(QualificationPackageIdV1::ALL.len(), expected.len());
        for (package, name) in expected {
            assert!(QualificationPackageIdV1::ALL.contains(&package));
            assert_eq!(package.as_str(), name);
            let encoded = serde_json::to_string(&package).expect("serialize package");
            assert_eq!(encoded, format!("\"{name}\""));
            assert_eq!(
                serde_json::from_str::<QualificationPackageIdV1>(&encoded)
                    .expect("deserialize package"),
                package
            );
        }
    }

    #[test]
    fn every_package_changes_the_signed_domain() {
        let base = envelope();
        let messages = QualificationPackageIdV1::ALL
            .into_iter()
            .map(|package_id| {
                let mut value = base.clone();
                value.package_id = package_id;
                qualification_signing_bytes_v1(&value).expect("signing bytes")
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(messages.len(), QualificationPackageIdV1::ALL.len());
    }
}
