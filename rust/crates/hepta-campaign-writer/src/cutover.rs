use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    str::FromStr,
};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    CampaignWriterError, CampaignWriterPolicyV1, MAXIMUM_DATABASE_BYTES, digest, hash_path,
    inspect_parent,
};

const MAXIMUM_TRUSTED_CUTOVER_KEYS: usize = 32;
const HARD_MAXIMUM_CUTOVER_LIFETIME_MS: u64 = 10 * 60 * 1000;
const HARD_MAXIMUM_CUTOVER_FUTURE_SKEW_MS: u64 = 30 * 1000;

/// Time bounds for a separately signed writer cutover authorization.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WriterCutoverPolicyV1 {
    pub maximum_lifetime_ms: u64,
    pub maximum_future_skew_ms: u64,
}

impl Default for WriterCutoverPolicyV1 {
    fn default() -> Self {
        Self {
            maximum_lifetime_ms: 5 * 60 * 1000,
            maximum_future_skew_ms: 5 * 1000,
        }
    }
}

impl WriterCutoverPolicyV1 {
    fn validate(self) -> Result<Self, CampaignWriterError> {
        if self.maximum_lifetime_ms == 0
            || self.maximum_lifetime_ms > HARD_MAXIMUM_CUTOVER_LIFETIME_MS
            || self.maximum_future_skew_ms > HARD_MAXIMUM_CUTOVER_FUTURE_SKEW_MS
        {
            return Err(CampaignWriterError::InvalidCutoverPolicy);
        }
        Ok(self)
    }
}

/// Immutable map from independently controlled cutover key IDs to Ed25519 keys.
#[derive(Clone, Debug)]
pub struct WriterCutoverTrustStoreV1 {
    keys: BTreeMap<String, VerifyingKey>,
}

impl WriterCutoverTrustStoreV1 {
    pub fn new<I>(entries: I) -> Result<Self, CampaignWriterError>
    where
        I: IntoIterator<Item = (String, VerifyingKey)>,
    {
        let mut keys = BTreeMap::new();
        for (key_id, key) in entries {
            if !valid_identifier(&key_id) {
                return Err(CampaignWriterError::InvalidCutoverSignerKeyId);
            }
            if key.is_weak() {
                return Err(CampaignWriterError::WeakCutoverVerificationKey(key_id));
            }
            if keys.insert(key_id.clone(), key).is_some() {
                return Err(CampaignWriterError::DuplicateCutoverSignerKeyId(key_id));
            }
        }
        if keys.is_empty() || keys.len() > MAXIMUM_TRUSTED_CUTOVER_KEYS {
            return Err(CampaignWriterError::InvalidCutoverTrustStoreSize);
        }
        Ok(Self { keys })
    }

    fn get(&self, key_id: &str) -> Result<&VerifyingKey, CampaignWriterError> {
        self.keys
            .get(key_id)
            .ok_or_else(|| CampaignWriterError::UnknownCutoverSignerKey(key_id.to_owned()))
    }
}

/// Runtime identity that an external cutover authority explicitly reviewed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriterCutoverSubjectV1 {
    pub repository: String,
    pub commit_sha: String,
    pub tree_sha: String,
    pub binary_hash: Sha256Digest,
    pub configuration_hash: Sha256Digest,
    pub host_identity_hash: Sha256Digest,
    pub service_identity_hash: Sha256Digest,
}

impl WriterCutoverSubjectV1 {
    fn validate(&self) -> Result<(), CampaignWriterError> {
        if !valid_repository(&self.repository)
            || !valid_git_sha(&self.commit_sha)
            || !valid_git_sha(&self.tree_sha)
        {
            return Err(CampaignWriterError::InvalidCutoverSubject);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WriterDatabaseStateV1 {
    Absent,
    Existing,
}

/// Exact, sidecar-free database preimage observed before writer activation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriterDatabasePreimageV1 {
    pub version: u16,
    pub path_hash: Sha256Digest,
    pub state: WriterDatabaseStateV1,
    pub content_hash: Option<Sha256Digest>,
    pub byte_count: Option<u64>,
}

impl WriterDatabasePreimageV1 {
    fn validate(&self) -> Result<(), CampaignWriterError> {
        let valid_shape = match self.state {
            WriterDatabaseStateV1::Absent => {
                self.content_hash.is_none() && self.byte_count.is_none()
            }
            WriterDatabaseStateV1::Existing => {
                self.content_hash.is_some() && self.byte_count.is_some_and(|value| value > 0)
            }
        };
        if self.version != 1 || !valid_shape {
            return Err(CampaignWriterError::InvalidDatabasePreimage);
        }
        Ok(())
    }
}

/// Short-lived authorization signed by an authority outside the writer process.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriterCutoverAuthorizationV1 {
    pub version: u16,
    pub cutover_id: String,
    pub subject: WriterCutoverSubjectV1,
    pub database_preimage_hash: Sha256Digest,
    pub initial_writer_lease_hash: Sha256Digest,
    pub node_writer_disabled: bool,
    pub issued_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub nonce: String,
    pub signer_key_id: String,
    pub signature_base64: String,
}

/// Unforgeable-in-type result of signature, subject, database and time verification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedWriterCutoverV1 {
    subject: WriterCutoverSubjectV1,
    database_preimage_hash: Sha256Digest,
    initial_writer_lease_hash: Sha256Digest,
    authorization_hash: Sha256Digest,
    cutover_id: String,
    nonce: String,
    signer_key_id: String,
    issued_at_unix_ms: u64,
    expires_at_unix_ms: u64,
}

impl VerifiedWriterCutoverV1 {
    pub(crate) fn assert_current(&self, now_unix_ms: u64) -> Result<(), CampaignWriterError> {
        if now_unix_ms == 0 || now_unix_ms < self.issued_at_unix_ms {
            return Err(CampaignWriterError::CutoverNotYetValid);
        }
        if now_unix_ms >= self.expires_at_unix_ms {
            return Err(CampaignWriterError::CutoverExpired);
        }
        Ok(())
    }

    pub(crate) fn database_preimage_hash(&self) -> &Sha256Digest {
        &self.database_preimage_hash
    }

    pub(crate) fn initial_writer_lease_hash(&self) -> &Sha256Digest {
        &self.initial_writer_lease_hash
    }

    #[must_use]
    pub fn subject(&self) -> &WriterCutoverSubjectV1 {
        &self.subject
    }

    #[must_use]
    pub fn authorization_hash(&self) -> &Sha256Digest {
        &self.authorization_hash
    }

    #[must_use]
    pub fn cutover_id(&self) -> &str {
        &self.cutover_id
    }

    #[must_use]
    pub fn nonce(&self) -> &str {
        &self.nonce
    }

    #[must_use]
    pub fn signer_key_id(&self) -> &str {
        &self.signer_key_id
    }
}

/// Observes the exact database bytes or an exact absent path without creating it.
pub fn inspect_writer_database_preimage_v1(
    path: impl AsRef<Path>,
    policy: CampaignWriterPolicyV1,
) -> Result<WriterDatabasePreimageV1, CampaignWriterError> {
    let policy = policy.validate()?;
    let path = normalize_database_path(path.as_ref(), policy.owner_uid)?;
    reject_sqlite_sidecars(&path)?;
    let path_hash = hash_path(&path)?;
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            let (content_hash, byte_count) = hash_stable_database(&path, policy)?;
            let preimage = WriterDatabasePreimageV1 {
                version: 1,
                path_hash,
                state: WriterDatabaseStateV1::Existing,
                content_hash: Some(content_hash),
                byte_count: Some(byte_count),
            };
            preimage.validate()?;
            Ok(preimage)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let preimage = WriterDatabasePreimageV1 {
                version: 1,
                path_hash,
                state: WriterDatabaseStateV1::Absent,
                content_hash: None,
                byte_count: None,
            };
            preimage.validate()?;
            Ok(preimage)
        }
        Err(error) => Err(CampaignWriterError::Filesystem(
            "database_preimage",
            error.kind(),
        )),
    }
}

pub fn writer_database_preimage_hash_v1(
    preimage: &WriterDatabasePreimageV1,
) -> Result<Sha256Digest, CampaignWriterError> {
    preimage.validate()?;
    let mut writer = SigningMessageWriter::new("HeptaWriterDatabasePreimageV1")?;
    writer.u64("version", u64::from(preimage.version))?;
    writer.digest("pathHash", &preimage.path_hash)?;
    writer.text(
        "state",
        match preimage.state {
            WriterDatabaseStateV1::Absent => "absent",
            WriterDatabaseStateV1::Existing => "existing",
        },
    )?;
    writer.optional_digest("contentHash", preimage.content_hash.as_ref())?;
    writer.optional_u64("byteCount", preimage.byte_count)?;
    sha256_digest(&writer.finish())
}

/// Domain-separated hash of the first writer lease authorized by a cutover permit.
pub fn writer_lease_activation_hash_v1(
    lease: &super::WriterLeaseV1,
) -> Result<Sha256Digest, CampaignWriterError> {
    if lease.generation == 0 || !valid_identifier(&lease.token) || lease.expires_at_unix_ms == 0 {
        return Err(CampaignWriterError::InvalidWriterLease);
    }
    let mut writer = SigningMessageWriter::new("HeptaWriterActivationLeaseV1")?;
    writer.u64("generation", lease.generation)?;
    writer.text("token", &lease.token)?;
    writer.u64("expiresAtUnixMs", lease.expires_at_unix_ms)?;
    sha256_digest(&writer.finish())
}

/// Canonical bytes signed by the external cutover authority.
pub fn writer_cutover_signing_bytes_v1(
    authorization: &WriterCutoverAuthorizationV1,
) -> Result<Vec<u8>, CampaignWriterError> {
    authorization.subject.validate()?;
    if authorization.version != 1
        || !valid_identifier(&authorization.cutover_id)
        || !valid_identifier(&authorization.nonce)
        || !valid_identifier(&authorization.signer_key_id)
        || !authorization.node_writer_disabled
    {
        return Err(CampaignWriterError::CutoverNotAuthorized);
    }
    let mut writer = SigningMessageWriter::new("HeptaWriterCutoverAuthorizationV1")?;
    writer.u64("version", u64::from(authorization.version))?;
    writer.text("cutoverId", &authorization.cutover_id)?;
    write_subject(&mut writer, &authorization.subject)?;
    writer.digest(
        "databasePreimageHash",
        &authorization.database_preimage_hash,
    )?;
    writer.digest(
        "initialWriterLeaseHash",
        &authorization.initial_writer_lease_hash,
    )?;
    writer.boolean("nodeWriterDisabled", authorization.node_writer_disabled)?;
    writer.u64("issuedAtUnixMs", authorization.issued_at_unix_ms)?;
    writer.u64("expiresAtUnixMs", authorization.expires_at_unix_ms)?;
    writer.text("nonce", &authorization.nonce)?;
    writer.text("signerKeyId", &authorization.signer_key_id)?;
    Ok(writer.finish())
}

/// Verifies signature, exact runtime subject, clock window and independently owned key.
pub fn verify_writer_cutover_authorization_v1(
    authorization: &WriterCutoverAuthorizationV1,
    expected_subject: &WriterCutoverSubjectV1,
    now_unix_ms: u64,
    policy: WriterCutoverPolicyV1,
    trust_store: &WriterCutoverTrustStoreV1,
) -> Result<VerifiedWriterCutoverV1, CampaignWriterError> {
    let policy = policy.validate()?;
    expected_subject.validate()?;
    if authorization.subject != *expected_subject {
        return Err(CampaignWriterError::CutoverSubjectMismatch);
    }
    if now_unix_ms == 0 {
        return Err(CampaignWriterError::CutoverNotYetValid);
    }
    let latest_issue = now_unix_ms
        .checked_add(policy.maximum_future_skew_ms)
        .ok_or(CampaignWriterError::NumericOverflow)?;
    if authorization.issued_at_unix_ms == 0 || authorization.issued_at_unix_ms > latest_issue {
        return Err(CampaignWriterError::CutoverNotYetValid);
    }
    if authorization.expires_at_unix_ms <= now_unix_ms {
        return Err(CampaignWriterError::CutoverExpired);
    }
    let lifetime = authorization
        .expires_at_unix_ms
        .checked_sub(authorization.issued_at_unix_ms)
        .ok_or(CampaignWriterError::CutoverNotAuthorized)?;
    if lifetime == 0 || lifetime > policy.maximum_lifetime_ms {
        return Err(CampaignWriterError::CutoverNotAuthorized);
    }
    let signing_bytes = writer_cutover_signing_bytes_v1(authorization)?;
    let signature_bytes = Base64UrlUnpadded::decode_vec(&authorization.signature_base64)
        .map_err(|_| CampaignWriterError::InvalidCutoverSignatureEncoding)?;
    if Base64UrlUnpadded::encode_string(&signature_bytes) != authorization.signature_base64 {
        return Err(CampaignWriterError::InvalidCutoverSignatureEncoding);
    }
    let signature = Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| CampaignWriterError::InvalidCutoverSignatureEncoding)?;
    trust_store
        .get(&authorization.signer_key_id)?
        .verify_strict(&signing_bytes, &signature)
        .map_err(|_| CampaignWriterError::CutoverSignatureRejected)?;
    Ok(VerifiedWriterCutoverV1 {
        subject: authorization.subject.clone(),
        database_preimage_hash: authorization.database_preimage_hash.clone(),
        initial_writer_lease_hash: authorization.initial_writer_lease_hash.clone(),
        authorization_hash: sha256_digest(&signing_bytes)?,
        cutover_id: authorization.cutover_id.clone(),
        nonce: authorization.nonce.clone(),
        signer_key_id: authorization.signer_key_id.clone(),
        issued_at_unix_ms: authorization.issued_at_unix_ms,
        expires_at_unix_ms: authorization.expires_at_unix_ms,
    })
}

fn normalize_database_path(path: &Path, owner_uid: u32) -> Result<PathBuf, CampaignWriterError> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(CampaignWriterError::DatabasePathInvalid);
    }
    let parent = path
        .parent()
        .ok_or(CampaignWriterError::DatabasePathInvalid)?;
    inspect_parent(parent, owner_uid)?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| CampaignWriterError::Filesystem("database_parent", error.kind()))?;
    let normalized = canonical_parent.join(
        path.file_name()
            .ok_or(CampaignWriterError::DatabasePathInvalid)?,
    );
    if normalized != path {
        return Err(CampaignWriterError::DatabasePathInvalid);
    }
    Ok(normalized)
}

fn reject_sqlite_sidecars(path: &Path) -> Result<(), CampaignWriterError> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(CampaignWriterError::DatabasePathInvalid)?;
    let parent = path
        .parent()
        .ok_or(CampaignWriterError::DatabasePathInvalid)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = parent.join(format!("{name}{suffix}"));
        match fs::symlink_metadata(&sidecar) {
            Ok(_) => return Err(CampaignWriterError::DatabaseSidecarPresent),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(CampaignWriterError::Filesystem(
                    "database_sidecar",
                    error.kind(),
                ));
            }
        }
    }
    Ok(())
}

fn hash_stable_database(
    path: &Path,
    policy: CampaignWriterPolicyV1,
) -> Result<(Sha256Digest, u64), CampaignWriterError> {
    let before = fs::symlink_metadata(path)
        .map_err(|error| CampaignWriterError::Filesystem("database_preimage", error.kind()))?;
    if before.file_type().is_symlink()
        || !before.is_file()
        || before.uid() != policy.owner_uid
        || before.mode() & 0o7777 != 0o600
        || before.nlink() != 1
        || before.size() == 0
        || before.size() > policy.maximum_database_bytes
        || before.size() > MAXIMUM_DATABASE_BYTES
    {
        return Err(CampaignWriterError::DatabasePathInvalid);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| CampaignWriterError::Filesystem("database_preimage", error.kind()))?;
    let opened = file
        .metadata()
        .map_err(|error| CampaignWriterError::Filesystem("database_preimage", error.kind()))?;
    if !same_stable_file(&before, &opened) {
        return Err(CampaignWriterError::DatabasePreimageChanged);
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| CampaignWriterError::Filesystem("database_preimage", error.kind()))?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(count).map_err(|_| CampaignWriterError::NumericOverflow)?)
            .ok_or(CampaignWriterError::NumericOverflow)?;
        if total > policy.maximum_database_bytes || total > MAXIMUM_DATABASE_BYTES {
            return Err(CampaignWriterError::DatabaseTooLarge);
        }
        hasher.update(&buffer[..count]);
    }
    let after_read = file
        .metadata()
        .map_err(|error| CampaignWriterError::Filesystem("database_preimage", error.kind()))?;
    let after_path = fs::symlink_metadata(path)
        .map_err(|error| CampaignWriterError::Filesystem("database_preimage", error.kind()))?;
    if total != before.size()
        || !same_stable_file(&before, &after_read)
        || !same_stable_file(&after_read, &after_path)
    {
        return Err(CampaignWriterError::DatabasePreimageChanged);
    }
    Ok((digest(hasher)?, total))
}

fn same_stable_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
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

fn write_subject(
    writer: &mut SigningMessageWriter,
    subject: &WriterCutoverSubjectV1,
) -> Result<(), CampaignWriterError> {
    writer.text("repository", &subject.repository)?;
    writer.text("commitSha", &subject.commit_sha)?;
    writer.text("treeSha", &subject.tree_sha)?;
    writer.digest("binaryHash", &subject.binary_hash)?;
    writer.digest("configurationHash", &subject.configuration_hash)?;
    writer.digest("hostIdentityHash", &subject.host_identity_hash)?;
    writer.digest("serviceIdentityHash", &subject.service_identity_hash)
}

struct SigningMessageWriter {
    bytes: Vec<u8>,
}

impl SigningMessageWriter {
    fn new(domain: &str) -> Result<Self, CampaignWriterError> {
        let mut writer = Self { bytes: Vec::new() };
        writer.raw(domain.as_bytes())?;
        Ok(writer)
    }

    fn text(&mut self, key: &str, value: &str) -> Result<(), CampaignWriterError> {
        self.raw(key.as_bytes())?;
        self.raw(value.as_bytes())
    }

    fn digest(&mut self, key: &str, value: &Sha256Digest) -> Result<(), CampaignWriterError> {
        self.text(key, value.as_str())
    }

    fn u64(&mut self, key: &str, value: u64) -> Result<(), CampaignWriterError> {
        self.raw(key.as_bytes())?;
        self.raw(&value.to_be_bytes())
    }

    fn boolean(&mut self, key: &str, value: bool) -> Result<(), CampaignWriterError> {
        self.raw(key.as_bytes())?;
        self.raw(&[u8::from(value)])
    }

    fn optional_digest(
        &mut self,
        key: &str,
        value: Option<&Sha256Digest>,
    ) -> Result<(), CampaignWriterError> {
        self.raw(key.as_bytes())?;
        match value {
            Some(value) => {
                self.raw(&[1])?;
                self.raw(value.as_str().as_bytes())
            }
            None => self.raw(&[0]),
        }
    }

    fn optional_u64(&mut self, key: &str, value: Option<u64>) -> Result<(), CampaignWriterError> {
        self.raw(key.as_bytes())?;
        match value {
            Some(value) => {
                self.raw(&[1])?;
                self.raw(&value.to_be_bytes())
            }
            None => self.raw(&[0]),
        }
    }

    fn raw(&mut self, value: &[u8]) -> Result<(), CampaignWriterError> {
        let length = u64::try_from(value.len())
            .map_err(|_| CampaignWriterError::CutoverSigningMessageTooLarge)?;
        self.bytes.extend_from_slice(&length.to_be_bytes());
        self.bytes.extend_from_slice(value);
        Ok(())
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
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
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn valid_repository(value: &str) -> bool {
    let Some((owner, repository)) = value.split_once('/') else {
        return false;
    };
    !repository.contains('/') && valid_identifier(owner) && valid_identifier(repository)
}

fn valid_git_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256_digest(bytes: &[u8]) -> Result<Sha256Digest, CampaignWriterError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .map_err(|_| CampaignWriterError::DigestConstruction)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{MetadataExt, PermissionsExt},
        sync::atomic::{AtomicU64, Ordering},
    };

    use base64ct::{Base64UrlUnpadded, Encoding};
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn digest_value(marker: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
            .expect("digest")
    }

    fn subject() -> WriterCutoverSubjectV1 {
        WriterCutoverSubjectV1 {
            repository: "TrillionniumFoundation/hepta-paper".to_owned(),
            commit_sha: "1".repeat(40),
            tree_sha: "2".repeat(40),
            binary_hash: digest_value('3'),
            configuration_hash: digest_value('4'),
            host_identity_hash: digest_value('5'),
            service_identity_hash: digest_value('6'),
        }
    }

    fn signed_authorization(
        database_preimage_hash: Sha256Digest,
        signing_key: &SigningKey,
    ) -> WriterCutoverAuthorizationV1 {
        let mut authorization = WriterCutoverAuthorizationV1 {
            version: 1,
            cutover_id: "cutover-1".to_owned(),
            subject: subject(),
            database_preimage_hash,
            initial_writer_lease_hash: digest_value('8'),
            node_writer_disabled: true,
            issued_at_unix_ms: 10_000,
            expires_at_unix_ms: 20_000,
            nonce: "nonce-1".to_owned(),
            signer_key_id: "cutover-key-1".to_owned(),
            signature_base64: "AA".to_owned(),
        };
        let message = writer_cutover_signing_bytes_v1(&authorization).expect("message");
        authorization.signature_base64 =
            Base64UrlUnpadded::encode_string(&signing_key.sign(&message).to_bytes());
        authorization
    }

    #[test]
    fn signed_exact_subject_verifies_and_tampering_fails() {
        let signing_key = SigningKey::from_bytes(&[31_u8; 32]);
        let authorization = signed_authorization(digest_value('7'), &signing_key);
        let trust = WriterCutoverTrustStoreV1::new([(
            "cutover-key-1".to_owned(),
            signing_key.verifying_key(),
        )])
        .expect("trust");
        let verified = verify_writer_cutover_authorization_v1(
            &authorization,
            &subject(),
            15_000,
            WriterCutoverPolicyV1::default(),
            &trust,
        )
        .expect("verified");
        assert_eq!(verified.cutover_id(), "cutover-1");

        let mut tampered = authorization.clone();
        tampered.node_writer_disabled = false;
        assert!(matches!(
            verify_writer_cutover_authorization_v1(
                &tampered,
                &subject(),
                15_000,
                WriterCutoverPolicyV1::default(),
                &trust,
            ),
            Err(CampaignWriterError::CutoverNotAuthorized)
        ));
    }

    #[test]
    fn database_preimage_distinguishes_absent_existing_and_sidecar_state() {
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "hepta-writer-preimage-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
        let uid = fs::metadata(&root).expect("metadata").uid();
        let path = root.join("campaign.sqlite");
        let policy = CampaignWriterPolicyV1::strict(uid);
        let absent = inspect_writer_database_preimage_v1(&path, policy).expect("absent");
        assert_eq!(absent.state, WriterDatabaseStateV1::Absent);
        fs::write(&path, b"database").expect("database");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("database mode");
        let existing = inspect_writer_database_preimage_v1(&path, policy).expect("existing");
        assert_eq!(existing.state, WriterDatabaseStateV1::Existing);
        fs::write(root.join("campaign.sqlite-wal"), b"wal").expect("wal");
        assert!(matches!(
            inspect_writer_database_preimage_v1(&path, policy),
            Err(CampaignWriterError::DatabaseSidecarPresent)
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }
}
