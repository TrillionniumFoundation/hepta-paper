use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    str::FromStr,
};

use hepta_codex_protocol::Sha256Digest;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    CapabilityBundleAuthorityV1, CapabilityTrustBundleManagerV1, SignedCapabilityTrustBundleV1,
    TrustBundleError, VerifiedCapabilityTrustBundleV1,
};

const HARD_MAXIMUM_TRUST_BUNDLE_BYTES: u64 = 1024 * 1024;

/// Separately owned, read-only source policy for one signed capability bundle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapabilityTrustBundleSourcePolicyV1 {
    pub version: u16,
    pub authority_owner_uid: u32,
    pub reader_gid: u32,
    pub broker_uid: u32,
    pub maximum_bytes: u64,
}

impl CapabilityTrustBundleSourcePolicyV1 {
    #[must_use]
    pub const fn strict(authority_owner_uid: u32, reader_gid: u32, broker_uid: u32) -> Self {
        Self {
            version: 1,
            authority_owner_uid,
            reader_gid,
            broker_uid,
            maximum_bytes: 256 * 1024,
        }
    }

    fn validate(self) -> Result<Self, TrustBundleSourceError> {
        if self.version != 1
            || self.authority_owner_uid == self.broker_uid
            || self.maximum_bytes == 0
            || self.maximum_bytes > HARD_MAXIMUM_TRUST_BUNDLE_BYTES
        {
            return Err(TrustBundleSourceError::InvalidPolicy);
        }
        Ok(self)
    }
}

/// Exact path, object and content identity of an authority-owned bundle file.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityTrustBundleSourceIdentityV1 {
    canonical_path: PathBuf,
    pub path_hash: Sha256Digest,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub link_count: u64,
    pub size: u64,
    pub content_hash: Sha256Digest,
    pub identity_hash: Sha256Digest,
}

impl CapabilityTrustBundleSourceIdentityV1 {
    #[must_use]
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }
}

/// Canonical signed envelope plus the independently verified source identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoadedSignedCapabilityTrustBundleV1 {
    pub envelope: SignedCapabilityTrustBundleV1,
    pub source: CapabilityTrustBundleSourceIdentityV1,
}

/// Loads a canonical signed trust bundle without granting the broker write authority.
pub fn load_signed_capability_trust_bundle(
    requested: &Path,
    policy: CapabilityTrustBundleSourcePolicyV1,
) -> Result<LoadedSignedCapabilityTrustBundleV1, TrustBundleSourceError> {
    let policy = policy.validate()?;
    if !requested.is_absolute() || requested.file_name().is_none() {
        return Err(TrustBundleSourceError::InvalidPath);
    }
    let canonical_path = fs::canonicalize(requested)
        .map_err(|error| TrustBundleSourceError::Filesystem("trust_bundle", error.kind()))?;
    if canonical_path != requested {
        return Err(TrustBundleSourceError::NonCanonicalPath);
    }
    let parent = canonical_path
        .parent()
        .ok_or(TrustBundleSourceError::InvalidPath)?;
    inspect_parent(parent, policy)?;

    let before = fs::symlink_metadata(&canonical_path)
        .map_err(|error| TrustBundleSourceError::Filesystem("trust_bundle", error.kind()))?;
    inspect_file_metadata(&before, policy)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
        .open(&canonical_path)
        .map_err(|error| TrustBundleSourceError::Filesystem("trust_bundle", error.kind()))?;
    let opened = file
        .metadata()
        .map_err(|error| TrustBundleSourceError::Filesystem("trust_bundle", error.kind()))?;
    if !same_file_identity(&before, &opened) {
        return Err(TrustBundleSourceError::SourceChanged);
    }

    let capacity =
        usize::try_from(opened.size()).map_err(|_| TrustBundleSourceError::SourceSizeInvalid {
            observed: opened.size(),
            maximum: policy.maximum_bytes,
        })?;
    let mut bytes = Vec::with_capacity(capacity);
    file.by_ref()
        .take(policy.maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| TrustBundleSourceError::Filesystem("trust_bundle", error.kind()))?;
    let byte_count =
        u64::try_from(bytes.len()).map_err(|_| TrustBundleSourceError::SourceSizeInvalid {
            observed: u64::MAX,
            maximum: policy.maximum_bytes,
        })?;
    if byte_count == 0 || byte_count > policy.maximum_bytes {
        return Err(TrustBundleSourceError::SourceSizeInvalid {
            observed: byte_count,
            maximum: policy.maximum_bytes,
        });
    }

    let after = fs::symlink_metadata(&canonical_path)
        .map_err(|error| TrustBundleSourceError::Filesystem("trust_bundle", error.kind()))?;
    if !same_file_identity(&opened, &after) || after.size() != byte_count {
        return Err(TrustBundleSourceError::SourceChanged);
    }
    let envelope: SignedCapabilityTrustBundleV1 =
        serde_json::from_slice(&bytes).map_err(|_| TrustBundleSourceError::InvalidJson)?;
    let canonical =
        serde_json::to_vec(&envelope).map_err(|_| TrustBundleSourceError::InvalidJson)?;
    if canonical != bytes {
        return Err(TrustBundleSourceError::NonCanonicalJson);
    }

    let path_hash = sha256_digest(canonical_path.as_os_str().as_encoded_bytes())?;
    let content_hash = sha256_digest(&bytes)?;
    let identity_hash = hash_identity(&path_hash, &opened, &content_hash)?;
    Ok(LoadedSignedCapabilityTrustBundleV1 {
        envelope,
        source: CapabilityTrustBundleSourceIdentityV1 {
            canonical_path,
            path_hash,
            device: opened.dev(),
            inode: opened.ino(),
            mode: opened.mode() & 0o7777,
            uid: opened.uid(),
            gid: opened.gid(),
            link_count: opened.nlink(),
            size: opened.size(),
            content_hash,
            identity_hash,
        },
    })
}

/// Loads and installs one authority-owned bundle; any load rejection disables admission.
pub fn install_signed_capability_trust_bundle_from_source(
    manager: &CapabilityTrustBundleManagerV1,
    requested: &Path,
    source_policy: CapabilityTrustBundleSourcePolicyV1,
    now_unix_ms: u64,
    authority: &CapabilityBundleAuthorityV1,
) -> Result<
    (
        VerifiedCapabilityTrustBundleV1,
        CapabilityTrustBundleSourceIdentityV1,
    ),
    CapabilityTrustBundleSourceInstallError,
> {
    let loaded = match load_signed_capability_trust_bundle(requested, source_policy) {
        Ok(loaded) => loaded,
        Err(error) => {
            manager
                .reject_refresh()
                .map_err(CapabilityTrustBundleSourceInstallError::Manager)?;
            return Err(CapabilityTrustBundleSourceInstallError::Source(error));
        }
    };
    let verified = manager
        .install(&loaded.envelope, now_unix_ms, authority)
        .map_err(CapabilityTrustBundleSourceInstallError::Bundle)?;
    Ok((verified, loaded.source))
}

fn inspect_parent(
    parent: &Path,
    policy: CapabilityTrustBundleSourcePolicyV1,
) -> Result<(), TrustBundleSourceError> {
    let canonical = fs::canonicalize(parent)
        .map_err(|error| TrustBundleSourceError::Filesystem("trust_bundle_parent", error.kind()))?;
    if canonical != parent {
        return Err(TrustBundleSourceError::NonCanonicalPath);
    }
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| TrustBundleSourceError::Filesystem("trust_bundle_parent", error.kind()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(TrustBundleSourceError::ParentInvalid);
    }
    if metadata.uid() != policy.authority_owner_uid || metadata.gid() != policy.reader_gid {
        return Err(TrustBundleSourceError::ParentOwnerMismatch);
    }
    let mode = metadata.mode() & 0o7777;
    if mode != 0o750 {
        return Err(TrustBundleSourceError::ParentPermissionsInvalid(mode));
    }
    Ok(())
}

fn inspect_file_metadata(
    metadata: &fs::Metadata,
    policy: CapabilityTrustBundleSourcePolicyV1,
) -> Result<(), TrustBundleSourceError> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(TrustBundleSourceError::SourceInvalid);
    }
    if metadata.uid() != policy.authority_owner_uid || metadata.gid() != policy.reader_gid {
        return Err(TrustBundleSourceError::SourceOwnerMismatch);
    }
    let mode = metadata.mode() & 0o7777;
    if mode != 0o440 {
        return Err(TrustBundleSourceError::SourcePermissionsInvalid(mode));
    }
    if metadata.nlink() != 1 {
        return Err(TrustBundleSourceError::SourceLinkCountInvalid(
            metadata.nlink(),
        ));
    }
    if metadata.size() == 0 || metadata.size() > policy.maximum_bytes {
        return Err(TrustBundleSourceError::SourceSizeInvalid {
            observed: metadata.size(),
            maximum: policy.maximum_bytes,
        });
    }
    Ok(())
}

fn same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
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

fn hash_identity(
    path_hash: &Sha256Digest,
    metadata: &fs::Metadata,
    content_hash: &Sha256Digest,
) -> Result<Sha256Digest, TrustBundleSourceError> {
    let mut hasher = Sha256::new();
    update_field(&mut hasher, b"CapabilityTrustBundleSourceIdentityV1")?;
    update_field(&mut hasher, path_hash.as_str().as_bytes())?;
    update_field(&mut hasher, &metadata.dev().to_be_bytes())?;
    update_field(&mut hasher, &metadata.ino().to_be_bytes())?;
    update_field(&mut hasher, &(metadata.mode() & 0o7777).to_be_bytes())?;
    update_field(&mut hasher, &metadata.uid().to_be_bytes())?;
    update_field(&mut hasher, &metadata.gid().to_be_bytes())?;
    update_field(&mut hasher, &metadata.nlink().to_be_bytes())?;
    update_field(&mut hasher, &metadata.size().to_be_bytes())?;
    update_field(&mut hasher, content_hash.as_str().as_bytes())?;
    digest_from_hasher(hasher)
}

fn sha256_digest(bytes: &[u8]) -> Result<Sha256Digest, TrustBundleSourceError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    digest_from_hasher(hasher)
}

fn digest_from_hasher(hasher: Sha256) -> Result<Sha256Digest, TrustBundleSourceError> {
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value).map_err(|_| TrustBundleSourceError::DigestConstruction)
}

fn update_field(hasher: &mut Sha256, bytes: &[u8]) -> Result<(), TrustBundleSourceError> {
    let length = u64::try_from(bytes.len()).map_err(|_| TrustBundleSourceError::MessageTooLarge)?;
    hasher.update(length.to_be_bytes());
    hasher.update(bytes);
    Ok(())
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum TrustBundleSourceError {
    #[error("trust-bundle source policy is invalid")]
    InvalidPolicy,
    #[error("trust-bundle source path is invalid")]
    InvalidPath,
    #[error("trust-bundle source path is noncanonical or symlinked")]
    NonCanonicalPath,
    #[error("trust-bundle source parent is invalid")]
    ParentInvalid,
    #[error("trust-bundle source parent owner differs from authority policy")]
    ParentOwnerMismatch,
    #[error("trust-bundle source parent permissions are invalid: {0:o}")]
    ParentPermissionsInvalid(u32),
    #[error("trust-bundle source must be a regular file")]
    SourceInvalid,
    #[error("trust-bundle source owner differs from authority policy")]
    SourceOwnerMismatch,
    #[error("trust-bundle source permissions are invalid: {0:o}")]
    SourcePermissionsInvalid(u32),
    #[error("trust-bundle source link count is invalid: {0}")]
    SourceLinkCountInvalid(u64),
    #[error("trust-bundle source size is invalid: observed {observed}, maximum {maximum}")]
    SourceSizeInvalid { observed: u64, maximum: u64 },
    #[error("trust-bundle source changed during inspection")]
    SourceChanged,
    #[error("trust-bundle source JSON is invalid")]
    InvalidJson,
    #[error("trust-bundle source JSON is not canonical")]
    NonCanonicalJson,
    #[error("trust-bundle source filesystem operation failed for {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
    #[error("trust-bundle source identity message is too large")]
    MessageTooLarge,
    #[error("failed to construct trust-bundle source digest")]
    DigestConstruction,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum CapabilityTrustBundleSourceInstallError {
    #[error("trust-bundle source was rejected: {0}")]
    Source(TrustBundleSourceError),
    #[error("trust-bundle verification or rotation was rejected: {0}")]
    Bundle(TrustBundleError),
    #[error("trust-bundle manager could not fail closed: {0}")]
    Manager(TrustBundleError),
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, File},
        io::Write,
        os::unix::fs::{MetadataExt, PermissionsExt, symlink},
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use base64ct::{Base64UrlUnpadded, Encoding};
    use ed25519_dalek::{Signer, SigningKey};
    use hepta_codex_protocol::AgentRole;

    use super::*;
    use crate::{CapabilityTrustBundleV1, CapabilityTrustKeyV1, trust_bundle_signing_bytes};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempSource {
        root: PathBuf,
        path: PathBuf,
        uid: u32,
        gid: u32,
    }

    impl TempSource {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "hepta-trust-source-{}-{nonce}-{sequence}",
                std::process::id(),
            ));
            fs::create_dir(&root).expect("create trust source root");
            fs::set_permissions(&root, fs::Permissions::from_mode(0o750))
                .expect("secure trust source root");
            let metadata = fs::metadata(&root).expect("trust source root metadata");
            let path = root.join("bundle.json");
            Self {
                root,
                path,
                uid: metadata.uid(),
                gid: metadata.gid(),
            }
        }

        fn policy(&self) -> CapabilityTrustBundleSourcePolicyV1 {
            CapabilityTrustBundleSourcePolicyV1::strict(
                self.uid,
                self.gid,
                self.uid.saturating_add(1),
            )
        }

        fn write(&self, envelope: &SignedCapabilityTrustBundleV1) {
            let bytes = serde_json::to_vec(envelope).expect("canonical trust bundle JSON");
            let mut file = File::create(&self.path).expect("create trust bundle source");
            file.write_all(&bytes).expect("write trust bundle source");
            file.sync_all().expect("sync trust bundle source");
            fs::set_permissions(&self.path, fs::Permissions::from_mode(0o440))
                .expect("read-only trust bundle source");
        }
    }

    impl Drop for TempSource {
        fn drop(&mut self) {
            if let Ok(metadata) = fs::symlink_metadata(&self.path) {
                if metadata.file_type().is_symlink() {
                    let _ = fs::remove_file(&self.path);
                } else {
                    let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
                }
            }
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn signed_bundle(
        generation: u64,
        previous: Option<Sha256Digest>,
        root: &SigningKey,
        request: &SigningKey,
    ) -> SignedCapabilityTrustBundleV1 {
        let bundle = CapabilityTrustBundleV1 {
            version: 1,
            generation,
            issuer_id: "hepta-key-owner".to_owned(),
            valid_from_unix_ms: 1_000,
            valid_until_unix_ms: 100_000,
            minimum_accepted_generation: 1,
            previous_bundle_hash: previous,
            keys: vec![CapabilityTrustKeyV1 {
                key_id: "author-key-1".to_owned(),
                public_key_base64: Base64UrlUnpadded::encode_string(
                    request.verifying_key().as_bytes(),
                ),
                valid_from_unix_ms: 1_000,
                valid_until_unix_ms: 90_000,
                allowed_roles: vec![AgentRole::Author],
            }],
            revocations: Vec::new(),
        };
        let signature =
            root.sign(&trust_bundle_signing_bytes(&bundle).expect("trust bundle signing bytes"));
        SignedCapabilityTrustBundleV1 {
            bundle,
            authority_key_id: "bundle-root-1".to_owned(),
            signature_base64: Base64UrlUnpadded::encode_string(&signature.to_bytes()),
        }
    }

    fn authority(root: &SigningKey) -> CapabilityBundleAuthorityV1 {
        CapabilityBundleAuthorityV1::new([("bundle-root-1".to_owned(), root.verifying_key())])
            .expect("bundle authority")
    }

    #[test]
    fn loads_canonical_separately_owned_read_only_source() {
        let fixture = TempSource::new();
        let root = SigningKey::from_bytes(&[1_u8; 32]);
        let request = SigningKey::from_bytes(&[2_u8; 32]);
        let expected = signed_bundle(1, None, &root, &request);
        fixture.write(&expected);
        let loaded = load_signed_capability_trust_bundle(&fixture.path, fixture.policy())
            .expect("load trust bundle source");
        assert_eq!(loaded.envelope, expected);
        assert_eq!(loaded.source.uid, fixture.uid);
        assert_eq!(loaded.source.gid, fixture.gid);
        assert_eq!(loaded.source.mode, 0o440);
        assert_eq!(loaded.source.canonical_path(), fixture.path.as_path());
    }

    #[test]
    fn installs_rotation_and_source_rejection_disables_admission() {
        let fixture = TempSource::new();
        let root = SigningKey::from_bytes(&[3_u8; 32]);
        let request = SigningKey::from_bytes(&[4_u8; 32]);
        let first = signed_bundle(1, None, &root, &request);
        let verified = crate::verify_capability_trust_bundle(
            &first,
            AgentRole::Author,
            10_000,
            &authority(&root),
            None,
        )
        .expect("bootstrap bundle");
        let manager = CapabilityTrustBundleManagerV1::new(verified.clone());
        let second = signed_bundle(2, Some(verified.bundle_hash().clone()), &root, &request);
        fixture.write(&second);
        let (rotated, source) = install_signed_capability_trust_bundle_from_source(
            &manager,
            &fixture.path,
            fixture.policy(),
            11_000,
            &authority(&root),
        )
        .expect("install source rotation");
        assert_eq!(rotated.generation(), 2);
        assert_eq!(source.canonical_path(), fixture.path.as_path());

        fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o640))
            .expect("make trust source writable");
        assert!(matches!(
            install_signed_capability_trust_bundle_from_source(
                &manager,
                &fixture.path,
                fixture.policy(),
                12_000,
                &authority(&root),
            ),
            Err(CapabilityTrustBundleSourceInstallError::Source(
                TrustBundleSourceError::SourcePermissionsInvalid(0o640),
            )),
        ));
        assert!(matches!(
            manager.snapshot(12_001),
            Err(TrustBundleError::ManagerDisabled(
                crate::TrustBundleDisableReasonV1::RefreshRejected,
            )),
        ));
    }

    #[test]
    fn rejects_same_owner_noncanonical_and_symlink_sources() {
        let fixture = TempSource::new();
        let root = SigningKey::from_bytes(&[5_u8; 32]);
        let request = SigningKey::from_bytes(&[6_u8; 32]);
        fixture.write(&signed_bundle(1, None, &root, &request));
        assert_eq!(
            load_signed_capability_trust_bundle(
                &fixture.path,
                CapabilityTrustBundleSourcePolicyV1::strict(fixture.uid, fixture.gid, fixture.uid,),
            ),
            Err(TrustBundleSourceError::InvalidPolicy),
        );

        let canonical = fs::read(&fixture.path).expect("read canonical source");
        fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o600))
            .expect("temporarily writable source");
        fs::write(
            &fixture.path,
            [b" ".as_slice(), canonical.as_slice()].concat(),
        )
        .expect("write noncanonical JSON");
        fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o440))
            .expect("restore source mode");
        assert_eq!(
            load_signed_capability_trust_bundle(&fixture.path, fixture.policy()),
            Err(TrustBundleSourceError::NonCanonicalJson),
        );

        fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o600))
            .expect("remove source");
        fs::remove_file(&fixture.path).expect("remove source file");
        let target = fixture.root.join("target.json");
        fs::write(
            &target,
            serde_json::to_vec(&signed_bundle(1, None, &root, &request)).expect("target JSON"),
        )
        .expect("write target source");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o440))
            .expect("target source mode");
        symlink(&target, &fixture.path).expect("symlink source");
        assert_eq!(
            load_signed_capability_trust_bundle(&fixture.path, fixture.policy()),
            Err(TrustBundleSourceError::NonCanonicalPath),
        );
    }
}
