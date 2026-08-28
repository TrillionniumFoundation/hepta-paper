use std::{
    fs::{self, File, Metadata},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    str::FromStr,
};

use hepta_codex_protocol::Sha256Digest;
use sha2::{Digest, Sha256};

use super::types::{
    CodexControlFileContractV1, CodexInvocationError, ControlFilePolicy,
};

pub(super) struct InspectedControlFile {
    pub(super) canonical_path: PathBuf,
    pub(super) content_hash: Sha256Digest,
    pub(super) bytes: u64,
    pub(super) contract: CodexControlFileContractV1,
}

pub(super) fn inspect_control_file(
    path: &Path,
    policy: ControlFilePolicy,
) -> Result<InspectedControlFile, CodexInvocationError> {
    if !path.is_absolute() {
        return Err(CodexInvocationError::ControlPathMustBeAbsolute(policy.subject));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| CodexInvocationError::Filesystem(policy.subject, error.kind()))?;
    if canonical != path {
        return Err(CodexInvocationError::ControlPathNonCanonical(policy.subject));
    }
    let before = fs::symlink_metadata(path)
        .map_err(|error| CodexInvocationError::Filesystem(policy.subject, error.kind()))?;
    validate_control_metadata(&before, policy)?;
    let mut file = File::open(path)
        .map_err(|error| CodexInvocationError::Filesystem(policy.subject, error.kind()))?;
    let opened = file
        .metadata()
        .map_err(|error| CodexInvocationError::Filesystem(policy.subject, error.kind()))?;
    if !same_object(&before, &opened) {
        return Err(CodexInvocationError::ControlPathChanged(policy.subject));
    }
    let content_hash = hash_reader(&mut file, policy.maximum_bytes, policy.subject)?;
    let after = fs::symlink_metadata(path)
        .map_err(|error| CodexInvocationError::Filesystem(policy.subject, error.kind()))?;
    if !same_object(&opened, &after) {
        return Err(CodexInvocationError::ControlPathChanged(policy.subject));
    }
    Ok(InspectedControlFile {
        canonical_path: canonical.clone(),
        content_hash,
        bytes: after.size(),
        contract: control_file_contract(&canonical, &after, policy.maximum_bytes),
    })
}

pub(super) fn inspect_bound_control_file(
    contract: &CodexControlFileContractV1,
) -> Result<InspectedControlFile, CodexInvocationError> {
    let canonical = fs::canonicalize(&contract.canonical_path).map_err(|error| {
        CodexInvocationError::Filesystem("postflight_control_file", error.kind())
    })?;
    if canonical != contract.canonical_path {
        return Err(CodexInvocationError::ControlPathChanged(
            "postflight_control_file",
        ));
    }
    let metadata = fs::symlink_metadata(&contract.canonical_path).map_err(|error| {
        CodexInvocationError::Filesystem("postflight_control_file", error.kind())
    })?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.dev() != contract.device
        || metadata.ino() != contract.inode
        || metadata.mode() != contract.mode
        || metadata.uid() != contract.uid
        || metadata.gid() != contract.gid
        || metadata.nlink() != contract.link_count
    {
        return Err(CodexInvocationError::ControlPathChanged(
            "postflight_control_file",
        ));
    }
    if metadata.size() > contract.maximum_bytes {
        return Err(CodexInvocationError::ControlFileTooLarge {
            subject: "postflight_control_file",
            observed: metadata.size(),
            maximum: contract.maximum_bytes,
        });
    }
    let mut file = File::open(&contract.canonical_path).map_err(|error| {
        CodexInvocationError::Filesystem("postflight_control_file", error.kind())
    })?;
    let opened = file.metadata().map_err(|error| {
        CodexInvocationError::Filesystem("postflight_control_file", error.kind())
    })?;
    if opened.dev() != contract.device || opened.ino() != contract.inode {
        return Err(CodexInvocationError::ControlPathChanged(
            "postflight_control_file",
        ));
    }
    let content_hash = hash_reader(
        &mut file,
        contract.maximum_bytes,
        "postflight_control_file",
    )?;
    let after = fs::symlink_metadata(&contract.canonical_path).map_err(|error| {
        CodexInvocationError::Filesystem("postflight_control_file", error.kind())
    })?;
    if !same_object_except_content(&opened, &after) {
        return Err(CodexInvocationError::ControlPathChanged(
            "postflight_control_file",
        ));
    }
    Ok(InspectedControlFile {
        canonical_path: contract.canonical_path.clone(),
        content_hash,
        bytes: after.size(),
        contract: contract.clone(),
    })
}

pub(super) fn canonical_directory(
    path: &Path,
    subject: &'static str,
) -> Result<PathBuf, CodexInvocationError> {
    if !path.is_absolute() {
        return Err(CodexInvocationError::ControlPathMustBeAbsolute(subject));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| CodexInvocationError::Filesystem(subject, error.kind()))?;
    if canonical != path {
        return Err(CodexInvocationError::ControlPathNonCanonical(subject));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| CodexInvocationError::Filesystem(subject, error.kind()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CodexInvocationError::WorkspaceInvalid);
    }
    Ok(canonical)
}

pub(super) fn hash_reader(
    reader: &mut File,
    maximum_bytes: u64,
    subject: &'static str,
) -> Result<Sha256Digest, CodexInvocationError> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| CodexInvocationError::Filesystem(subject, error.kind()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).map_err(|_| CodexInvocationError::SizeOverflow)?)
            .ok_or(CodexInvocationError::SizeOverflow)?;
        if total > maximum_bytes {
            return Err(CodexInvocationError::ControlFileTooLarge {
                subject,
                observed: total,
                maximum: maximum_bytes,
            });
        }
        hasher.update(&buffer[..read]);
    }
    digest_from_hasher(hasher)
}

fn control_file_contract(
    canonical_path: &Path,
    metadata: &Metadata,
    maximum_bytes: u64,
) -> CodexControlFileContractV1 {
    CodexControlFileContractV1 {
        canonical_path: canonical_path.to_path_buf(),
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        link_count: metadata.nlink(),
        maximum_bytes,
    }
}

fn validate_control_metadata(
    metadata: &Metadata,
    policy: ControlFilePolicy,
) -> Result<(), CodexInvocationError> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CodexInvocationError::ControlFileInvalid(policy.subject));
    }
    if metadata.uid() != policy.expected_uid
        || policy.expected_gid.is_some_and(|gid| metadata.gid() != gid)
    {
        return Err(CodexInvocationError::ControlOwnerMismatch(policy.subject));
    }
    let mode = metadata.mode() & 0o7777;
    if mode & 0o077 != 0
        || mode & 0o400 == 0
        || (policy.owner_write_required && mode & 0o200 == 0)
        || mode & 0o7000 != 0
    {
        return Err(CodexInvocationError::ControlPermissionsInvalid {
            subject: policy.subject,
            mode,
        });
    }
    if metadata.nlink() != 1 {
        return Err(CodexInvocationError::ControlLinkCountInvalid {
            subject: policy.subject,
            link_count: metadata.nlink(),
        });
    }
    if metadata.size() > policy.maximum_bytes {
        return Err(CodexInvocationError::ControlFileTooLarge {
            subject: policy.subject,
            observed: metadata.size(),
            maximum: policy.maximum_bytes,
        });
    }
    if policy.must_be_empty && metadata.size() != 0 {
        return Err(CodexInvocationError::OutputMessageFileNotEmpty);
    }
    Ok(())
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

fn same_object_except_content(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
}

fn digest_from_hasher(hasher: Sha256) -> Result<Sha256Digest, CodexInvocationError> {
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value).map_err(|_| CodexInvocationError::DigestConstruction)
}
