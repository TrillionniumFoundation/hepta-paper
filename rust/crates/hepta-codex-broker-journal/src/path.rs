use std::{
    fs::{self, OpenOptions},
    io,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use super::{store::JournalStoreError, types::BrokerJournalPolicyV1};

pub(super) fn prepare_database_path(
    database_path: &Path,
    policy: BrokerJournalPolicyV1,
) -> Result<PathBuf, JournalStoreError> {
    if !policy.valid() {
        return Err(JournalStoreError::InvalidPolicy);
    }
    if !database_path.is_absolute() {
        return Err(JournalStoreError::DatabasePathMustBeAbsolute);
    }
    let parent = database_path
        .parent()
        .ok_or(JournalStoreError::DatabaseParentMissing)?;
    let canonical_parent = canonical_real_directory(parent, policy)?;
    let file_name = database_path
        .file_name()
        .ok_or(JournalStoreError::DatabasePathInvalid)?;
    let canonical_path = canonical_parent.join(file_name);
    if canonical_path != database_path {
        return Err(JournalStoreError::DatabasePathNonCanonical);
    }
    match fs::symlink_metadata(&canonical_path) {
        Ok(_) => validate_database_file(&canonical_path, policy)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let file = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .mode(0o600)
                .open(&canonical_path)
                .map_err(|error| {
                    JournalStoreError::Filesystem("database_create", error.kind())
                })?;
            file.sync_all().map_err(|error| {
                JournalStoreError::Filesystem("database_create_sync", error.kind())
            })?;
            canonical_parent_sync(&canonical_parent)?;
            validate_database_file(&canonical_path, policy)?;
        }
        Err(error) => {
            return Err(JournalStoreError::Filesystem(
                "database_metadata",
                error.kind(),
            ));
        }
    }
    Ok(canonical_path)
}

pub(super) fn validate_database_and_sidecars(
    database_path: &Path,
    policy: BrokerJournalPolicyV1,
) -> Result<(), JournalStoreError> {
    validate_database_file(database_path, policy)?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", database_path.display()));
        match fs::symlink_metadata(&sidecar) {
            Ok(_) => validate_private_regular_file(&sidecar, policy, false)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(JournalStoreError::Filesystem(
                    "database_sidecar_metadata",
                    error.kind(),
                ));
            }
        }
    }
    Ok(())
}

fn canonical_real_directory(
    directory: &Path,
    policy: BrokerJournalPolicyV1,
) -> Result<PathBuf, JournalStoreError> {
    let metadata = fs::symlink_metadata(directory)
        .map_err(|error| JournalStoreError::Filesystem("database_parent", error.kind()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(JournalStoreError::DatabaseParentNotRealDirectory);
    }
    let canonical = fs::canonicalize(directory).map_err(|error| {
        JournalStoreError::Filesystem("database_parent_canonicalize", error.kind())
    })?;
    if canonical != directory {
        return Err(JournalStoreError::DatabaseParentNonCanonical);
    }
    validate_owner(&metadata, policy, "database_parent")?;
    if metadata.mode() & 0o077 != 0 {
        return Err(JournalStoreError::DatabaseParentPermissionsInvalid(
            metadata.mode() & 0o7777,
        ));
    }
    Ok(canonical)
}

fn validate_database_file(
    path: &Path,
    policy: BrokerJournalPolicyV1,
) -> Result<(), JournalStoreError> {
    validate_private_regular_file(path, policy, true)?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| JournalStoreError::Filesystem("database_canonicalize", error.kind()))?;
    if canonical != path {
        return Err(JournalStoreError::DatabasePathNonCanonical);
    }
    Ok(())
}

fn validate_private_regular_file(
    path: &Path,
    policy: BrokerJournalPolicyV1,
    enforce_database_size: bool,
) -> Result<(), JournalStoreError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| JournalStoreError::Filesystem("database_file", error.kind()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(JournalStoreError::DatabaseNotRealRegularFile);
    }
    validate_owner(&metadata, policy, "database_file")?;
    if metadata.mode() & 0o177 != 0 || metadata.mode() & 0o600 != 0o600 {
        return Err(JournalStoreError::DatabasePermissionsInvalid(
            metadata.mode() & 0o7777,
        ));
    }
    if metadata.nlink() != 1 {
        return Err(JournalStoreError::DatabaseLinkCountInvalid(
            metadata.nlink(),
        ));
    }
    if enforce_database_size && metadata.len() > policy.maximum_database_bytes {
        return Err(JournalStoreError::DatabaseTooLarge {
            observed: metadata.len(),
            maximum: policy.maximum_database_bytes,
        });
    }
    Ok(())
}

fn validate_owner(
    metadata: &fs::Metadata,
    policy: BrokerJournalPolicyV1,
    subject: &'static str,
) -> Result<(), JournalStoreError> {
    if metadata.uid() != policy.expected_owner_uid
        || policy
            .expected_owner_gid
            .is_some_and(|expected| expected != metadata.gid())
    {
        return Err(JournalStoreError::OwnerMismatch {
            subject,
            expected_uid: policy.expected_owner_uid,
            observed_uid: metadata.uid(),
            expected_gid: policy.expected_owner_gid,
            observed_gid: metadata.gid(),
        });
    }
    Ok(())
}

fn canonical_parent_sync(parent: &Path) -> Result<(), JournalStoreError> {
    let directory = fs::File::open(parent)
        .map_err(|error| JournalStoreError::Filesystem("database_parent_open", error.kind()))?;
    directory.sync_all().map_err(|error| {
        JournalStoreError::Filesystem("database_parent_sync", error.kind())
    })
}
