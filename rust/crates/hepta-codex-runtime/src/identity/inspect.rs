use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs::{self, File, Metadata},
    io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

use hepta_codex_protocol::Sha256Digest;

use super::{
    hash::{DomainHasher, hash_file_system_identity, hash_path, hash_reader},
    path::{canonical_requested_path, lexical_absolute, resolve_executable, validate_safe_relative_path},
    types::{
        CodexHomeIdentityV1, CodexRuntimeIdentityV1, CredentialMaterialIdentityV1,
        CredentialMaterialStatus, ExecutableIdentityV1, FileSystemIdentityV1,
        RuntimeIdentityError, RuntimeIdentityPolicyV1,
    },
};

/// Inspects a qualified executable, private Codex home and non-secret credential metadata.
pub fn inspect_codex_runtime_identity(
    executable: &OsStr,
    codex_home: &Path,
    model_selector: &str,
    environment_policy_hash: Sha256Digest,
    transport_profile_hash: Sha256Digest,
    source_environment: &BTreeMap<String, String>,
    policy: &RuntimeIdentityPolicyV1,
) -> Result<CodexRuntimeIdentityV1, RuntimeIdentityError> {
    policy.validate()?;
    validate_model_selector(model_selector)?;
    let executable = inspect_executable(
        executable,
        source_environment,
        policy.binary_owner_uid,
        policy.binary_owner_gid,
        policy.require_single_link_executable,
        policy.maximum_executable_bytes,
    )?;
    let home = inspect_codex_home(codex_home, policy)?;
    let mut hasher = DomainHasher::new("CodexRuntimeIdentityV1");
    hasher.digest("executableIdentityHash", &executable.identity_hash);
    hasher.digest("homeIdentityHash", &home.identity_hash);
    hasher.field("modelSelector", model_selector.as_bytes());
    hasher.digest("environmentPolicyHash", &environment_policy_hash);
    hasher.digest("transportProfileHash", &transport_profile_hash);
    let identity_hash = hasher.finish()?;
    Ok(CodexRuntimeIdentityV1 {
        executable,
        home,
        model_selector: model_selector.to_owned(),
        environment_policy_hash,
        transport_profile_hash,
        identity_hash,
    })
}

fn inspect_executable(
    executable: &OsStr,
    source_environment: &BTreeMap<String, String>,
    expected_uid: u32,
    expected_gid: Option<u32>,
    require_single_link: bool,
    maximum_bytes: u64,
) -> Result<ExecutableIdentityV1, RuntimeIdentityError> {
    let path = resolve_executable(executable, source_environment)?;
    let inspected = inspect_content_file(
        &path,
        FilePolicy {
            expected_uid,
            expected_gid,
            maximum_bytes,
            require_private: false,
            require_owner_read: true,
            require_owner_write: false,
            require_owner_execute: true,
            forbid_group_or_other_write: true,
            require_single_link,
        },
    )?;
    let mut hasher = DomainHasher::new("CodexExecutableIdentityV1");
    hasher.digest(
        "fileSystemIdentityHash",
        &hash_file_system_identity(&inspected.identity)?,
    );
    hasher.digest("contentHash", &inspected.content_hash);
    let identity_hash = hasher.finish()?;
    Ok(ExecutableIdentityV1 {
        canonical_path: inspected.canonical_path,
        file_system: inspected.identity,
        content_hash: inspected.content_hash,
        identity_hash,
    })
}

fn inspect_codex_home(
    codex_home: &Path,
    policy: &RuntimeIdentityPolicyV1,
) -> Result<CodexHomeIdentityV1, RuntimeIdentityError> {
    let canonical_path = canonical_requested_path(codex_home)?;
    let root_metadata = fs::symlink_metadata(&canonical_path)
        .map_err(|error| RuntimeIdentityError::Filesystem("codex_home", error.kind()))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(RuntimeIdentityError::HomeNotPrivateDirectory);
    }
    validate_owner(
        &root_metadata,
        policy.home_owner_uid,
        policy.home_owner_gid,
        "codex_home",
    )?;
    let root_mode = root_metadata.mode() & 0o7777;
    if root_mode & 0o077 != 0 || root_mode & 0o700 != 0o700 {
        return Err(RuntimeIdentityError::HomePermissionsInvalid(root_mode));
    }
    let root_identity = file_system_identity(&canonical_path, &root_metadata)?;

    let config_path = canonical_path.join("config.toml");
    let config = inspect_content_file(
        &config_path,
        FilePolicy {
            expected_uid: policy.home_owner_uid,
            expected_gid: policy.home_owner_gid,
            maximum_bytes: policy.maximum_config_bytes,
            require_private: true,
            require_owner_read: true,
            require_owner_write: false,
            require_owner_execute: false,
            forbid_group_or_other_write: true,
            require_single_link: true,
        },
    )?;
    if config.canonical_path.parent() != Some(canonical_path.as_path()) {
        return Err(RuntimeIdentityError::PathEscapesHome);
    }

    let mut credential_material = Vec::with_capacity(policy.credential_material_paths.len());
    for relative in &policy.credential_material_paths {
        credential_material.push(inspect_credential_material(
            &canonical_path,
            relative,
            policy.home_owner_uid,
            policy.home_owner_gid,
        )?);
    }
    credential_material.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    let mut hasher = DomainHasher::new("CodexHomeIdentityV1");
    hasher.digest(
        "rootIdentityHash",
        &hash_file_system_identity(&root_identity)?,
    );
    hasher.digest(
        "configIdentityHash",
        &hash_file_system_identity(&config.identity)?,
    );
    hasher.digest("configContentHash", &config.content_hash);
    for material in &credential_material {
        hasher.digest("credentialMaterialIdentityHash", &material.identity_hash);
    }
    let identity_hash = hasher.finish()?;
    Ok(CodexHomeIdentityV1 {
        canonical_path,
        root: root_identity,
        config: config.identity,
        config_content_hash: config.content_hash,
        credential_material,
        identity_hash,
    })
}

fn inspect_credential_material(
    home: &Path,
    relative: &str,
    expected_uid: u32,
    expected_gid: Option<u32>,
) -> Result<CredentialMaterialIdentityV1, RuntimeIdentityError> {
    validate_safe_relative_path(relative)?;
    let requested = home.join(relative);
    let normalized = lexical_absolute(&requested)?;
    if !normalized.starts_with(home) {
        return Err(RuntimeIdentityError::PathEscapesHome);
    }
    let parent = normalized
        .parent()
        .ok_or(RuntimeIdentityError::PathEscapesHome)?;
    let canonical_parent = canonical_requested_path(parent)?;
    if !canonical_parent.starts_with(home) {
        return Err(RuntimeIdentityError::PathEscapesHome);
    }
    let path_hash = hash_path(&normalized)?;
    let first = match fs::symlink_metadata(&normalized) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut hasher = DomainHasher::new("CodexCredentialMaterialIdentityV1");
            hasher.field("relativePath", relative.as_bytes());
            hasher.field("status", b"absent");
            hasher.digest("pathHash", &path_hash);
            return Ok(CredentialMaterialIdentityV1 {
                relative_path: relative.to_owned(),
                status: CredentialMaterialStatus::Absent,
                path_hash,
                file_system: None,
                identity_hash: hasher.finish()?,
            });
        }
        Err(error) => {
            return Err(RuntimeIdentityError::Filesystem(
                "credential_material",
                error.kind(),
            ));
        }
    };
    if first.file_type().is_symlink() || !first.is_file() {
        return Err(RuntimeIdentityError::CredentialMaterialInvalid(
            relative.to_owned(),
        ));
    }
    let canonical_material = fs::canonicalize(&normalized)
        .map_err(|error| RuntimeIdentityError::Filesystem("credential_material", error.kind()))?;
    if canonical_material != normalized || !canonical_material.starts_with(home) {
        return Err(RuntimeIdentityError::PathEscapesHome);
    }
    validate_owner(&first, expected_uid, expected_gid, "credential_material")?;
    let mode = first.mode() & 0o7777;
    if mode & 0o077 != 0 || mode & 0o400 == 0 {
        return Err(RuntimeIdentityError::CredentialPermissionsInvalid {
            path: relative.to_owned(),
            mode,
        });
    }
    if first.nlink() != 1 {
        return Err(RuntimeIdentityError::CredentialLinkCountInvalid {
            path: relative.to_owned(),
            link_count: first.nlink(),
        });
    }
    let second = fs::symlink_metadata(&normalized)
        .map_err(|error| RuntimeIdentityError::Filesystem("credential_material", error.kind()))?;
    if !same_object(&first, &second) {
        return Err(RuntimeIdentityError::PathChangedDuringInspection);
    }
    let file_system = file_system_identity(&normalized, &second)?;
    let mut hasher = DomainHasher::new("CodexCredentialMaterialIdentityV1");
    hasher.field("relativePath", relative.as_bytes());
    hasher.field("status", b"present");
    hasher.digest("pathHash", &path_hash);
    hasher.digest(
        "fileSystemIdentityHash",
        &hash_file_system_identity(&file_system)?,
    );
    Ok(CredentialMaterialIdentityV1 {
        relative_path: relative.to_owned(),
        status: CredentialMaterialStatus::Present,
        path_hash,
        file_system: Some(file_system),
        identity_hash: hasher.finish()?,
    })
}

struct InspectedContentFile {
    canonical_path: PathBuf,
    identity: FileSystemIdentityV1,
    content_hash: Sha256Digest,
}

#[derive(Clone, Copy)]
struct FilePolicy {
    expected_uid: u32,
    expected_gid: Option<u32>,
    maximum_bytes: u64,
    require_private: bool,
    require_owner_read: bool,
    require_owner_write: bool,
    require_owner_execute: bool,
    forbid_group_or_other_write: bool,
    require_single_link: bool,
}

fn inspect_content_file(
    requested: &Path,
    policy: FilePolicy,
) -> Result<InspectedContentFile, RuntimeIdentityError> {
    let canonical_path = canonical_requested_path(requested)?;
    let first = fs::symlink_metadata(&canonical_path)
        .map_err(|error| RuntimeIdentityError::Filesystem("content_file", error.kind()))?;
    if first.file_type().is_symlink() || !first.is_file() {
        return Err(RuntimeIdentityError::RegularFileRequired);
    }
    validate_owner(
        &first,
        policy.expected_uid,
        policy.expected_gid,
        "content_file",
    )?;
    validate_file_mode(&first, policy)?;
    if policy.require_single_link && first.nlink() != 1 {
        return Err(RuntimeIdentityError::FileLinkCountInvalid(first.nlink()));
    }
    if first.size() > policy.maximum_bytes {
        return Err(RuntimeIdentityError::FileTooLarge {
            observed: first.size(),
            maximum: policy.maximum_bytes,
        });
    }

    let mut file = File::open(&canonical_path)
        .map_err(|error| RuntimeIdentityError::Filesystem("content_file", error.kind()))?;
    let opened = file
        .metadata()
        .map_err(|error| RuntimeIdentityError::Filesystem("content_file", error.kind()))?;
    if !same_object(&first, &opened) {
        return Err(RuntimeIdentityError::PathChangedDuringInspection);
    }
    let content_hash = hash_reader(&mut file, policy.maximum_bytes)?;
    let after = fs::symlink_metadata(&canonical_path)
        .map_err(|error| RuntimeIdentityError::Filesystem("content_file", error.kind()))?;
    if !same_object(&opened, &after) {
        return Err(RuntimeIdentityError::PathChangedDuringInspection);
    }
    Ok(InspectedContentFile {
        canonical_path: canonical_path.clone(),
        identity: file_system_identity(&canonical_path, &after)?,
        content_hash,
    })
}

fn validate_file_mode(
    metadata: &Metadata,
    policy: FilePolicy,
) -> Result<(), RuntimeIdentityError> {
    let mode = metadata.mode() & 0o7777;
    if policy.require_private && mode & 0o077 != 0 {
        return Err(RuntimeIdentityError::FilePermissionsInvalid(mode));
    }
    if policy.forbid_group_or_other_write && mode & 0o022 != 0 {
        return Err(RuntimeIdentityError::FilePermissionsInvalid(mode));
    }
    if policy.require_owner_read && mode & 0o400 == 0 {
        return Err(RuntimeIdentityError::FilePermissionsInvalid(mode));
    }
    if policy.require_owner_write && mode & 0o200 == 0 {
        return Err(RuntimeIdentityError::FilePermissionsInvalid(mode));
    }
    if policy.require_owner_execute && mode & 0o100 == 0 {
        return Err(RuntimeIdentityError::FilePermissionsInvalid(mode));
    }
    Ok(())
}

fn validate_owner(
    metadata: &Metadata,
    expected_uid: u32,
    expected_gid: Option<u32>,
    subject: &'static str,
) -> Result<(), RuntimeIdentityError> {
    if metadata.uid() != expected_uid || expected_gid.is_some_and(|gid| metadata.gid() != gid) {
        return Err(RuntimeIdentityError::OwnerMismatch {
            subject,
            expected_uid,
            observed_uid: metadata.uid(),
            expected_gid,
            observed_gid: metadata.gid(),
        });
    }
    Ok(())
}

fn validate_model_selector(model_selector: &str) -> Result<(), RuntimeIdentityError> {
    if model_selector.trim().is_empty()
        || model_selector.len() > 256
        || model_selector.chars().any(char::is_control)
    {
        return Err(RuntimeIdentityError::InvalidModelSelector);
    }
    Ok(())
}

fn file_system_identity(
    canonical_path: &Path,
    metadata: &Metadata,
) -> Result<FileSystemIdentityV1, RuntimeIdentityError> {
    Ok(FileSystemIdentityV1 {
        canonical_path_hash: hash_path(canonical_path)?,
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        link_count: metadata.nlink(),
        size: metadata.size(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        changed_seconds: metadata.ctime(),
        changed_nanoseconds: metadata.ctime_nsec(),
    })
}

fn same_object(left: &Metadata, right: &Metadata) -> bool {
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
