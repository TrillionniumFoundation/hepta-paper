use std::{
    io,
    path::{Path, PathBuf},
};

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub(super) const DEFAULT_MAXIMUM_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;
pub(super) const DEFAULT_MAXIMUM_CONFIG_BYTES: u64 = 1024 * 1024;

/// Stable Unix directory metadata. Volatile directory size/link/timestamp fields are excluded.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryIdentityV1 {
    pub canonical_path_hash: Sha256Digest,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
}

/// Exact Unix regular-file metadata bound into a runtime identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileSystemIdentityV1 {
    pub canonical_path_hash: Sha256Digest,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub link_count: u64,
    pub size: u64,
    pub modified_seconds: i64,
    pub modified_nanoseconds: i64,
    pub changed_seconds: i64,
    pub changed_nanoseconds: i64,
}

/// Qualified executable identity. The canonical path is local-only.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutableIdentityV1 {
    #[serde(skip)]
    pub(super) canonical_path: PathBuf,
    pub file_system: FileSystemIdentityV1,
    pub content_hash: Sha256Digest,
    pub identity_hash: Sha256Digest,
}

impl ExecutableIdentityV1 {
    /// Exact canonical executable path inspected and content-hashed by the broker.
    #[must_use]
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }
}

/// Presence classification for credential material inspected without opening it.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialMaterialStatus {
    Absent,
    Present,
}

/// Non-secret filesystem identity for one known credential material path.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialMaterialIdentityV1 {
    pub relative_path: String,
    pub status: CredentialMaterialStatus,
    pub path_hash: Sha256Digest,
    pub file_system: Option<FileSystemIdentityV1>,
    pub identity_hash: Sha256Digest,
}

/// Private Codex home identity and metadata-only credential identities.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexHomeIdentityV1 {
    #[serde(skip)]
    pub(super) canonical_path: PathBuf,
    pub root: DirectoryIdentityV1,
    pub config: FileSystemIdentityV1,
    pub config_content_hash: Sha256Digest,
    pub credential_material: Vec<CredentialMaterialIdentityV1>,
    pub identity_hash: Sha256Digest,
}

impl CodexHomeIdentityV1 {
    /// Exact canonical home path inspected by the broker.
    #[must_use]
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }
}

/// Aggregate runtime identity used for preflight/postflight drift checks.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexRuntimeIdentityV1 {
    pub executable: ExecutableIdentityV1,
    pub home: CodexHomeIdentityV1,
    pub model_selector: String,
    pub environment_policy_hash: Sha256Digest,
    pub transport_profile_hash: Sha256Digest,
    pub identity_hash: Sha256Digest,
}

/// Deployment-bound owner, permission, link and size policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeIdentityPolicyV1 {
    pub version: u16,
    pub binary_owner_uid: u32,
    pub binary_owner_gid: Option<u32>,
    pub home_owner_uid: u32,
    pub home_owner_gid: Option<u32>,
    pub require_single_link_executable: bool,
    pub maximum_executable_bytes: u64,
    pub maximum_config_bytes: u64,
    pub credential_material_paths: Vec<String>,
}

impl RuntimeIdentityPolicyV1 {
    /// Builds the strict Foundation V1 identity policy for a deployment.
    #[must_use]
    pub fn strict(binary_owner_uid: u32, home_owner_uid: u32) -> Self {
        Self {
            version: 1,
            binary_owner_uid,
            binary_owner_gid: None,
            home_owner_uid,
            home_owner_gid: None,
            require_single_link_executable: true,
            maximum_executable_bytes: DEFAULT_MAXIMUM_EXECUTABLE_BYTES,
            maximum_config_bytes: DEFAULT_MAXIMUM_CONFIG_BYTES,
            credential_material_paths: vec!["auth.json".to_owned()],
        }
    }

    /// Validates the policy before it can authorize filesystem inspection.
    pub fn validate(&self) -> Result<(), RuntimeIdentityError> {
        if self.version != 1 {
            return Err(RuntimeIdentityError::UnsupportedPolicyVersion(self.version));
        }
        if self.maximum_executable_bytes == 0 || self.maximum_config_bytes == 0 {
            return Err(RuntimeIdentityError::InvalidSizeLimit);
        }
        if self.credential_material_paths.len() > 32 {
            return Err(RuntimeIdentityError::TooManyCredentialPaths);
        }
        for relative in &self.credential_material_paths {
            super::path::validate_safe_relative_path(relative)?;
        }
        let mut sorted = self.credential_material_paths.clone();
        sorted.sort();
        sorted.dedup();
        if sorted.len() != self.credential_material_paths.len() {
            return Err(RuntimeIdentityError::DuplicateCredentialPath);
        }
        Ok(())
    }
}

/// Filesystem, ownership, permission or identity inspection failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum RuntimeIdentityError {
    #[error("unsupported runtime identity policy version: {0}")]
    UnsupportedPolicyVersion(u16),
    #[error("runtime identity size limit must be positive")]
    InvalidSizeLimit,
    #[error("runtime identity policy has too many credential paths")]
    TooManyCredentialPaths,
    #[error("runtime identity policy has duplicate credential paths")]
    DuplicateCredentialPath,
    #[error("credential path is invalid: {0}")]
    InvalidCredentialPath(String),
    #[error("executable is required")]
    ExecutableRequired,
    #[error("PATH is required to resolve a bare executable name")]
    PathEnvironmentRequired,
    #[error("executable is unavailable")]
    ExecutableUnavailable,
    #[error("path is invalid")]
    InvalidPath,
    #[error("requested path is noncanonical or contains a symlink component")]
    NonCanonicalOrSymlinkPath,
    #[error("regular file is required")]
    RegularFileRequired,
    #[error("Codex home must be a private real directory")]
    HomeNotPrivateDirectory,
    #[error("Codex home permissions are invalid: {0:o}")]
    HomePermissionsInvalid(u32),
    #[error("file permissions are invalid: {0:o}")]
    FilePermissionsInvalid(u32),
    #[error("file link count is invalid: {0}")]
    FileLinkCountInvalid(u64),
    #[error("file is too large: observed {observed}, maximum {maximum}")]
    FileTooLarge { observed: u64, maximum: u64 },
    #[error("path changed during inspection")]
    PathChangedDuringInspection,
    #[error("path escapes the configured Codex home")]
    PathEscapesHome,
    #[error("credential material is invalid: {0}")]
    CredentialMaterialInvalid(String),
    #[error("credential permissions are invalid for {path}: {mode:o}")]
    CredentialPermissionsInvalid { path: String, mode: u32 },
    #[error("credential link count is invalid for {path}: {link_count}")]
    CredentialLinkCountInvalid { path: String, link_count: u64 },
    #[error("filesystem owner mismatch for {subject}")]
    OwnerMismatch {
        subject: &'static str,
        expected_uid: u32,
        observed_uid: u32,
        expected_gid: Option<u32>,
        observed_gid: u32,
    },
    #[error("model selector is invalid")]
    InvalidModelSelector,
    #[error("filesystem operation failed for {0}: {1:?}")]
    Filesystem(&'static str, io::ErrorKind),
    #[error("file size arithmetic overflowed")]
    SizeOverflow,
    #[error("failed to construct canonical runtime digest")]
    DigestConstruction,
}
