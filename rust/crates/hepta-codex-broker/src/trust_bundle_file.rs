use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

const HARD_MAXIMUM_TRUST_BUNDLE_BYTES: u64 = 1024 * 1024;

/// Physical policy for one separately owned, broker-readable trust-bundle file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TrustBundleFilePolicyV1 {
    pub version: u16,
    pub authority_owner_uid: u32,
    pub authority_reader_gid: Option<u32>,
    pub broker_uid: u32,
    pub maximum_bytes: u64,
}

impl TrustBundleFilePolicyV1 {
    #[must_use]
    pub const fn production(
        authority_owner_uid: u32,
        authority_reader_gid: Option<u32>,
        broker_uid: u32,
    ) -> Self {
        Self {
            version: 1,
            authority_owner_uid,
            authority_reader_gid,
            broker_uid,
            maximum_bytes: 256 * 1024,
        }
    }

    fn validate(self) -> Result<Self, TrustBundleFileError> {
        if self.version != 1
            || self.authority_owner_uid == self.broker_uid
            || self.maximum_bytes == 0
            || self.maximum_bytes > HARD_MAXIMUM_TRUST_BUNDLE_BYTES
        {
            return Err(TrustBundleFileError::InvalidPolicy);
        }
        Ok(self)
    }

    fn parent_mode(self) -> u32 {
        if self.authority_reader_gid.is_some() {
            0o750
        } else {
            0o700
        }
    }

    fn file_mode(self) -> u32 {
        if self.authority_reader_gid.is_some() {
            0o440
        } else {
            0o400
        }
    }
}

/// Exact physical and content identity accepted by the preflight.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustBundleFileIdentityV1 {
    pub canonical_path: PathBuf,
    pub device: u64,
    pub inode: u64,
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
    pub link_count: u64,
    pub bytes: u64,
    pub content_hash: String,
}

/// A bounded immutable snapshot of one authority-owned trust-bundle file.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoadedAuthorityOwnedTrustBundleV1 {
    pub identity: TrustBundleFileIdentityV1,
    bytes: Vec<u8>,
}

impl LoadedAuthorityOwnedTrustBundleV1 {
    /// Decodes only an exact canonical JSON object from the inspected bytes.
    pub fn decode_canonical_json(&self) -> Result<Value, TrustBundleFileError> {
        let decoded: Value =
            serde_json::from_slice(&self.bytes).map_err(|_| TrustBundleFileError::InvalidJson)?;
        if !decoded.is_object() {
            return Err(TrustBundleFileError::JsonRootInvalid);
        }
        let canonical =
            serde_json::to_vec(&decoded).map_err(|_| TrustBundleFileError::InvalidJson)?;
        if canonical != self.bytes {
            return Err(TrustBundleFileError::NonCanonicalJson);
        }
        Ok(decoded)
    }
}

/// Loads one canonical, single-link trust-bundle file without granting write authority.
pub fn load_authority_owned_trust_bundle(
    requested: &Path,
    policy: TrustBundleFilePolicyV1,
) -> Result<LoadedAuthorityOwnedTrustBundleV1, TrustBundleFileError> {
    let policy = policy.validate()?;
    if !requested.is_absolute() || requested.file_name().is_none() {
        return Err(TrustBundleFileError::InvalidPath);
    }

    let canonical_path = fs::canonicalize(requested)
        .map_err(|error| TrustBundleFileError::Filesystem("trust_bundle", error.kind()))?;
    if canonical_path != requested {
        return Err(TrustBundleFileError::NonCanonicalPath);
    }
    let parent = canonical_path
        .parent()
        .ok_or(TrustBundleFileError::InvalidPath)?;
    let parent_before = inspect_parent(parent, policy)?;

    let before = fs::symlink_metadata(&canonical_path)
        .map_err(|error| TrustBundleFileError::Filesystem("trust_bundle", error.kind()))?;
    inspect_file_metadata(&before, policy)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
        .open(&canonical_path)
        .map_err(|error| TrustBundleFileError::Filesystem("trust_bundle", error.kind()))?;
    let opened = file
        .metadata()
        .map_err(|error| TrustBundleFileError::Filesystem("trust_bundle", error.kind()))?;
    if !same_metadata_identity(&before, &opened) {
        return Err(TrustBundleFileError::SourceChanged);
    }

    let capacity =
        usize::try_from(opened.size()).map_err(|_| TrustBundleFileError::SourceSizeInvalid {
            observed: opened.size(),
            maximum: policy.maximum_bytes,
        })?;
    let mut bytes = Vec::with_capacity(capacity);
    file.by_ref()
        .take(policy.maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| TrustBundleFileError::Filesystem("trust_bundle", error.kind()))?;
    let byte_count =
        u64::try_from(bytes.len()).map_err(|_| TrustBundleFileError::SourceSizeInvalid {
            observed: u64::MAX,
            maximum: policy.maximum_bytes,
        })?;
    if byte_count == 0 || byte_count > policy.maximum_bytes {
        return Err(TrustBundleFileError::SourceSizeInvalid {
            observed: byte_count,
            maximum: policy.maximum_bytes,
        });
    }

    let after = fs::symlink_metadata(&canonical_path)
        .map_err(|error| TrustBundleFileError::Filesystem("trust_bundle", error.kind()))?;
    if !same_metadata_identity(&opened, &after) || after.size() != byte_count {
        return Err(TrustBundleFileError::SourceChanged);
    }
    let parent_after = inspect_parent(parent, policy)?;
    if !same_metadata_identity(&parent_before, &parent_after) {
        return Err(TrustBundleFileError::ParentChanged);
    }
    let recanonicalized = fs::canonicalize(requested)
        .map_err(|error| TrustBundleFileError::Filesystem("trust_bundle", error.kind()))?;
    if recanonicalized != canonical_path {
        return Err(TrustBundleFileError::SourceChanged);
    }

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let loaded = LoadedAuthorityOwnedTrustBundleV1 {
        identity: TrustBundleFileIdentityV1 {
            canonical_path,
            device: opened.dev(),
            inode: opened.ino(),
            uid: opened.uid(),
            gid: opened.gid(),
            mode: opened.mode() & 0o7777,
            link_count: opened.nlink(),
            bytes: byte_count,
            content_hash: format!("sha256:{}", hex::encode(hasher.finalize())),
        },
        bytes,
    };
    loaded.decode_canonical_json()?;
    Ok(loaded)
}

fn inspect_parent(
    parent: &Path,
    policy: TrustBundleFilePolicyV1,
) -> Result<fs::Metadata, TrustBundleFileError> {
    let canonical = fs::canonicalize(parent)
        .map_err(|error| TrustBundleFileError::Filesystem("trust_bundle_parent", error.kind()))?;
    if canonical != parent {
        return Err(TrustBundleFileError::NonCanonicalPath);
    }
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| TrustBundleFileError::Filesystem("trust_bundle_parent", error.kind()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(TrustBundleFileError::ParentInvalid);
    }
    if metadata.uid() != policy.authority_owner_uid {
        return Err(TrustBundleFileError::ParentOwnerMismatch);
    }
    if let Some(expected_gid) = policy.authority_reader_gid
        && metadata.gid() != expected_gid
    {
        return Err(TrustBundleFileError::ParentGroupMismatch);
    }
    let mode = metadata.mode() & 0o7777;
    if mode != policy.parent_mode() {
        return Err(TrustBundleFileError::ParentPermissionsInvalid(mode));
    }
    Ok(metadata)
}

fn inspect_file_metadata(
    metadata: &fs::Metadata,
    policy: TrustBundleFilePolicyV1,
) -> Result<(), TrustBundleFileError> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(TrustBundleFileError::SourceInvalid);
    }
    if metadata.uid() != policy.authority_owner_uid {
        return Err(TrustBundleFileError::SourceOwnerMismatch);
    }
    if let Some(expected_gid) = policy.authority_reader_gid
        && metadata.gid() != expected_gid
    {
        return Err(TrustBundleFileError::SourceGroupMismatch);
    }
    let mode = metadata.mode() & 0o7777;
    if mode != policy.file_mode() {
        return Err(TrustBundleFileError::SourcePermissionsInvalid(mode));
    }
    if metadata.nlink() != 1 {
        return Err(TrustBundleFileError::SourceLinkCountInvalid(
            metadata.nlink(),
        ));
    }
    if metadata.size() == 0 || metadata.size() > policy.maximum_bytes {
        return Err(TrustBundleFileError::SourceSizeInvalid {
            observed: metadata.size(),
            maximum: policy.maximum_bytes,
        });
    }
    Ok(())
}

fn same_metadata_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
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

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum TrustBundleFileError {
    #[error("trust-bundle file policy is invalid")]
    InvalidPolicy,
    #[error("trust-bundle file path is invalid")]
    InvalidPath,
    #[error("trust-bundle file path is noncanonical or symlinked")]
    NonCanonicalPath,
    #[error("trust-bundle parent is invalid")]
    ParentInvalid,
    #[error("trust-bundle parent owner differs from authority policy")]
    ParentOwnerMismatch,
    #[error("trust-bundle parent group differs from authority policy")]
    ParentGroupMismatch,
    #[error("trust-bundle parent permissions are invalid: {0:o}")]
    ParentPermissionsInvalid(u32),
    #[error("trust-bundle parent changed during inspection")]
    ParentChanged,
    #[error("trust-bundle source must be a regular file")]
    SourceInvalid,
    #[error("trust-bundle source owner differs from authority policy")]
    SourceOwnerMismatch,
    #[error("trust-bundle source group differs from authority policy")]
    SourceGroupMismatch,
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
    #[error("trust-bundle source JSON root must be an object")]
    JsonRootInvalid,
    #[error("trust-bundle source JSON is not canonical")]
    NonCanonicalJson,
    #[error("trust-bundle filesystem operation failed for {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
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

    use super::*;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempBundle {
        root: PathBuf,
        path: PathBuf,
        uid: u32,
        gid: u32,
    }

    impl TempBundle {
        fn new(bytes: &[u8]) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "hepta-trust-bundle-file-{}-{nonce}-{sequence}",
                std::process::id(),
            ));
            fs::create_dir(&root).expect("create trust-bundle root");
            fs::set_permissions(&root, fs::Permissions::from_mode(0o750))
                .expect("secure trust-bundle root");
            let path = root.join("bundle.json");
            let mut file = File::create(&path).expect("create trust bundle");
            file.write_all(bytes).expect("write trust bundle");
            file.sync_all().expect("sync trust bundle");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o440))
                .expect("secure trust bundle");
            let metadata = fs::metadata(&path).expect("trust-bundle metadata");
            Self {
                root,
                path,
                uid: metadata.uid(),
                gid: metadata.gid(),
            }
        }

        fn policy(&self) -> TrustBundleFilePolicyV1 {
            let broker_uid = if self.uid == u32::MAX {
                self.uid - 1
            } else {
                self.uid + 1
            };
            TrustBundleFilePolicyV1::production(self.uid, Some(self.gid), broker_uid)
        }
    }

    impl Drop for TempBundle {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn canonical_authority_owned_bundle_is_loaded_with_exact_identity() {
        let fixture = TempBundle::new(
            br#"{"generation":1,"issuer":"qualification","version":1}"#,
        );
        let loaded = load_authority_owned_trust_bundle(&fixture.path, fixture.policy())
            .expect("canonical trust bundle");
        let decoded = loaded
            .decode_canonical_json()
            .expect("decode canonical trust bundle");
        assert_eq!(
            decoded.get("generation").and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(loaded.identity.canonical_path, fixture.path);
        assert_eq!(loaded.identity.mode, 0o440);
        assert_eq!(loaded.identity.link_count, 1);
        assert!(loaded.identity.content_hash.starts_with("sha256:"));
    }

    #[test]
    fn noncanonical_or_nonobject_json_is_rejected() {
        let noncanonical = TempBundle::new(br#"{"version":1, "generation":1}"#);
        assert_eq!(
            load_authority_owned_trust_bundle(&noncanonical.path, noncanonical.policy()),
            Err(TrustBundleFileError::NonCanonicalJson)
        );

        let nonobject = TempBundle::new(br#"[1,2,3]"#);
        assert_eq!(
            load_authority_owned_trust_bundle(&nonobject.path, nonobject.policy()),
            Err(TrustBundleFileError::JsonRootInvalid)
        );
    }

    #[test]
    fn authority_aliasing_modes_links_and_symlinks_fail_closed() {
        let fixture = TempBundle::new(br#"{"version":1}"#);
        assert_eq!(
            load_authority_owned_trust_bundle(
                &fixture.path,
                TrustBundleFilePolicyV1::production(
                    fixture.uid,
                    Some(fixture.gid),
                    fixture.uid,
                ),
            ),
            Err(TrustBundleFileError::InvalidPolicy)
        );

        fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o640))
            .expect("weaken source mode");
        assert_eq!(
            load_authority_owned_trust_bundle(&fixture.path, fixture.policy()),
            Err(TrustBundleFileError::SourcePermissionsInvalid(0o640))
        );
        fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o440))
            .expect("restore source mode");

        let hardlink = fixture.root.join("bundle-hardlink.json");
        fs::hard_link(&fixture.path, &hardlink).expect("create hardlink");
        assert_eq!(
            load_authority_owned_trust_bundle(&fixture.path, fixture.policy()),
            Err(TrustBundleFileError::SourceLinkCountInvalid(2))
        );
        fs::remove_file(&hardlink).expect("remove hardlink");

        let alias = fixture.root.join("bundle-alias.json");
        symlink(&fixture.path, &alias).expect("create symlink");
        assert_eq!(
            load_authority_owned_trust_bundle(&alias, fixture.policy()),
            Err(TrustBundleFileError::NonCanonicalPath)
        );
    }
}
