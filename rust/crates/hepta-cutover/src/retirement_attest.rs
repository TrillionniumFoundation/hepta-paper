//! Read-only native preparation for the legacy deletion-drill attestation.
//!
//! The incumbent `legacy-deletion-drill.mjs --attest --execute` command does
//! more than inspect an archive: it runs the Node differential and policy
//! replays, captures release provenance, signs a receipt with an external
//! release key, and publishes that receipt.  None of those authorities can be
//! inferred from a local Rust process.  This module therefore performs only
//! the locally reproducible part and emits a self-hashed, explicitly blocked
//! inspection.  It never signs, deletes, publishes, or claims Node retirement.

use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
    process::Command,
    str::FromStr,
};

use hepta_codex_protocol::Sha256Digest;
use nix::{
    fcntl::{OFlag, open},
    sys::stat::Mode,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const REQUEST_VERSION: u16 = 1;
const REQUEST_KIND: &str = "LegacyDeletionDrillAttestationRequest";
const REPORT_KIND: &str = "LegacyDeletionDrillAttestationInspection";
const REQUIRED_REPOSITORY: &str = "TrillionniumFoundation/hepta-paper";

/// JSON request for the locally reproducible portion of a drill attestation.
///
/// All paths must be absolute, normalized lexical paths.  `releaseCommit` and
/// `releaseStateSnapshotHash` are supplied by the caller so the report can
/// bind the intended release, but they are not treated as independently
/// verified release authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyDeletionDrillAttestationRequestV1 {
    /// Contract version, exactly one.
    pub version: u16,
    /// Contract kind.
    pub kind: String,
    /// Immutable Node schema-25 database to inspect.
    pub legacy_database_path: String,
    /// Immutable legacy reference archive to inspect.
    pub archive_path: String,
    /// Expected source repository.
    pub repository: String,
    /// Expected source commit.
    pub commit: String,
    /// Expected source tree.
    pub tree: String,
    /// Release commit captured by the caller.
    pub release_commit: String,
    /// Release-state snapshot hash captured by the caller.
    pub release_state_snapshot_hash: String,
}

/// Archive identity captured without mutating the selected file.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyDeletionDrillArchiveCaptureV1 {
    /// Exact absolute archive path.
    pub archive_path: String,
    /// SHA-256 of the bytes read through the opened file.
    pub archive_hash: String,
    /// Filesystem device identity.
    pub archive_device: String,
    /// Filesystem inode identity.
    pub archive_inode: String,
    /// Byte length observed before and after reading.
    pub archive_size: u64,
    /// POSIX mode bits.
    pub archive_mode: u32,
    /// ext4 inode immutable bit as reported by `lsattr`.
    pub archive_immutable: bool,
}

/// Locally verifiable, intentionally blocked attestation report.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyDeletionDrillAttestationInspectionV1 {
    /// Contract version.
    pub version: u16,
    /// Report kind.
    pub kind: String,
    /// Always blocked until the external attestation contract is supplied.
    pub status: String,
    /// The native local checks are sufficient for the local portion only.
    pub local_freeze_verified: bool,
    /// Technical Node replay and release qualification status.
    pub technical_release_ready: bool,
    /// Physical deletion is never authorized by this report.
    pub physical_deletion_allowed: bool,
    /// Requested legacy database path.
    pub legacy_database_path: String,
    /// Requested release identity.
    pub release_commit: String,
    /// Requested release snapshot identity.
    pub release_state_snapshot_hash: String,
    /// Archive capture, when the local identity check succeeded.
    pub archive: Option<LegacyDeletionDrillArchiveCaptureV1>,
    /// Freeze receipt hash, when the local schema-25 quiescence check passed.
    pub legacy_freeze_receipt_hash: Option<String>,
    /// Explicit local and external blockers.
    pub blockers: Vec<String>,
    /// This command does not invoke a release signing key.
    pub signing_key_read: bool,
    /// This command does not write runtime evidence.
    pub runtime_evidence_written: bool,
    /// This command performs no destructive or external action.
    pub external_action_performed: bool,
    /// Domain-separated hash of every preceding report field.
    pub report_hash: String,
}

/// Native drill-attest input or filesystem failure.
#[derive(Debug, Error)]
pub enum LegacyDeletionDrillAttestError {
    /// Request shape or identity is invalid.
    #[error("legacy deletion-drill attestation request is invalid")]
    RequestInvalid,
    /// Request JSON could not be decoded by the command boundary.
    #[error("legacy deletion-drill attestation request JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    /// Local file inspection failed before a bounded report could be built.
    #[error("legacy deletion-drill attestation filesystem inspection failed: {0}")]
    Io(#[from] std::io::Error),
    /// A generated report hash could not be represented by the protocol type.
    #[error("legacy deletion-drill attestation report hash is invalid")]
    DigestInvalid,
}

fn absolute_normalized(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return None;
    }
    Some(path)
}

fn valid_git_hash(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn archive_capture(
    path: &Path,
) -> Result<(LegacyDeletionDrillArchiveCaptureV1, Vec<String>), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or("legacy_deletion_drill_archive_parent_unsafe")?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|_| "legacy_deletion_drill_archive_parent_unsafe")?;
    if canonical_parent != parent {
        return Err("legacy_deletion_drill_archive_parent_unsafe".to_owned());
    }
    let parent_before =
        fs::symlink_metadata(parent).map_err(|_| "legacy_deletion_drill_archive_parent_unsafe")?;
    if !parent_before.is_dir() || parent_before.file_type().is_symlink() {
        return Err("legacy_deletion_drill_archive_parent_unsafe".to_owned());
    }
    let selected =
        fs::symlink_metadata(path).map_err(|_| "legacy_deletion_drill_archive_missing")?;
    if !selected.is_file() || selected.file_type().is_symlink() || selected.nlink() != 1 {
        return Err("legacy_deletion_drill_archive_unsafe".to_owned());
    }
    if selected.len() < 1 {
        return Err("legacy_deletion_drill_archive_empty".to_owned());
    }
    let descriptor = open(
        path,
        OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )
    .map_err(|_| "legacy_deletion_drill_archive_unreadable")?;
    let mut file = File::from(descriptor);
    let before = file
        .metadata()
        .map_err(|_| "legacy_deletion_drill_archive_unreadable")?;
    if !before.is_file()
        || before.dev() != selected.dev()
        || before.ino() != selected.ino()
        || before.nlink() != 1
    {
        return Err("legacy_deletion_drill_archive_unsafe".to_owned());
    }
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "legacy_deletion_drill_archive_read_failed")?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        bytes = bytes
            .checked_add(count as u64)
            .ok_or("legacy_deletion_drill_archive_size_overflow")?;
    }
    let after = file
        .metadata()
        .map_err(|_| "legacy_deletion_drill_archive_read_failed")?;
    let final_path = fs::symlink_metadata(path)
        .map_err(|_| "legacy_deletion_drill_archive_changed_during_inspection")?;
    let parent_after = fs::symlink_metadata(parent)
        .map_err(|_| "legacy_deletion_drill_archive_changed_during_inspection")?;
    if bytes != before.len()
        || after.dev() != before.dev()
        || after.ino() != before.ino()
        || after.len() != before.len()
        || after.mtime() != before.mtime()
        || after.ctime() != before.ctime()
        || !final_path.is_file()
        || final_path.file_type().is_symlink()
        || final_path.dev() != before.dev()
        || final_path.ino() != before.ino()
        || !parent_after.is_dir()
        || parent_after.file_type().is_symlink()
        || parent_after.dev() != parent_before.dev()
        || parent_after.ino() != parent_before.ino()
        || parent_after.mtime() != parent_before.mtime()
        || parent_after.ctime() != parent_before.ctime()
        || fs::canonicalize(parent).ok().as_deref() != Some(parent)
    {
        return Err("legacy_deletion_drill_archive_changed_during_inspection".to_owned());
    }
    // Keep the external filesystem flag as an observation.  The command is
    // deliberately fail-closed when `lsattr` is absent or the flag is absent.
    let immutable_result = Command::new("lsattr").args(["-d", "--"]).arg(path).output();
    let attributes = immutable_result
        .as_ref()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .unwrap_or_default()
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_owned();
    let archive_immutable = immutable_result
        .as_ref()
        .is_ok_and(|output| output.status.success() && attributes.contains('i'));
    let mut blockers = Vec::new();
    if !archive_immutable {
        blockers.push("legacy_reference_archive_not_filesystem_immutable".to_owned());
    }
    Ok((
        LegacyDeletionDrillArchiveCaptureV1 {
            archive_path: path.to_string_lossy().into_owned(),
            archive_hash: format!("sha256:{:x}", hasher.finalize()),
            archive_device: before.dev().to_string(),
            archive_inode: before.ino().to_string(),
            archive_size: before.len(),
            archive_mode: before.mode() & 0o7777,
            archive_immutable,
        },
        blockers,
    ))
}

fn hash_report(
    report: &LegacyDeletionDrillAttestationInspectionV1,
) -> Result<String, LegacyDeletionDrillAttestError> {
    let mut payload = serde_json::to_value(report).map_err(LegacyDeletionDrillAttestError::Json)?;
    payload
        .as_object_mut()
        .ok_or(LegacyDeletionDrillAttestError::RequestInvalid)?
        .remove("reportHash");
    let bytes = serde_json::to_vec(&payload).map_err(LegacyDeletionDrillAttestError::Json)?;
    let mut hasher = Sha256::new();
    hasher.update((REPORT_KIND.len() as u64).to_be_bytes());
    hasher.update(REPORT_KIND.as_bytes());
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
    let digest = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&digest).map_err(|_| LegacyDeletionDrillAttestError::DigestInvalid)?;
    Ok(digest)
}

fn freeze_blocker(error: &crate::LegacyNodeFreezeError) -> &'static str {
    use crate::LegacyNodeFreezeError;
    match error {
        LegacyNodeFreezeError::ActiveLegacyRuntime => "legacy_node_runtime_not_quiesced",
        LegacyNodeFreezeError::DatabaseFormatInvalid => "legacy_node_database_format_invalid",
        LegacyNodeFreezeError::SchemaVersionInvalid(_) => "legacy_node_schema_version_invalid",
        LegacyNodeFreezeError::RequiredTableMissing(_) => "legacy_node_required_table_missing",
        LegacyNodeFreezeError::RequiredColumnMissing { .. } => {
            "legacy_node_required_column_missing"
        }
        LegacyNodeFreezeError::SnapshotInvalid => "legacy_node_snapshot_invalid",
        LegacyNodeFreezeError::SubjectInvalid => "legacy_node_freeze_subject_invalid",
        LegacyNodeFreezeError::EncodingInvalid
        | LegacyNodeFreezeError::DigestInvalid
        | LegacyNodeFreezeError::ReadOnly(_) => "legacy_node_freeze_inspection_failed",
    }
}

/// Inspect local drill inputs and return an explicitly blocked native report.
pub fn inspect_legacy_deletion_drill_attest_v1(
    request: LegacyDeletionDrillAttestationRequestV1,
) -> Result<LegacyDeletionDrillAttestationInspectionV1, LegacyDeletionDrillAttestError> {
    let database_path = absolute_normalized(&request.legacy_database_path)
        .ok_or(LegacyDeletionDrillAttestError::RequestInvalid)?;
    let archive_path = absolute_normalized(&request.archive_path)
        .ok_or(LegacyDeletionDrillAttestError::RequestInvalid)?;
    if request.version != REQUEST_VERSION
        || request.kind != REQUEST_KIND
        || request.repository != REQUIRED_REPOSITORY
        || !valid_git_hash(&request.commit)
        || !valid_git_hash(&request.tree)
        || !valid_git_hash(&request.release_commit)
        || !valid_digest(&request.release_state_snapshot_hash)
    {
        return Err(LegacyDeletionDrillAttestError::RequestInvalid);
    }

    let mut blockers = vec![
        "legacy_deletion_drill_node_differential_replay_external".to_owned(),
        "legacy_deletion_drill_matrix_policy_replay_external".to_owned(),
        "legacy_deletion_drill_release_state_provenance_external".to_owned(),
        "legacy_deletion_drill_owner_acceptance_external".to_owned(),
        "legacy_deletion_drill_operational_proof_external".to_owned(),
        "legacy_deletion_drill_release_signature_external".to_owned(),
        "legacy_deletion_drill_receipt_publication_external".to_owned(),
    ];
    if request.release_commit != request.commit {
        blockers.push("legacy_deletion_drill_release_commit_subject_mismatch".to_owned());
    }
    let (archive, mut archive_blockers) = match archive_capture(&archive_path) {
        Ok(value) => (Some(value.0), value.1),
        Err(blocker) => (None, vec![blocker]),
    };
    blockers.append(&mut archive_blockers);
    let (local_freeze_verified, legacy_freeze_receipt_hash) =
        match crate::verify_legacy_node_freeze_v1(
            &database_path,
            crate::LegacyNodeFreezeSubjectV1 {
                repository: request.repository.clone(),
                commit: request.commit.clone(),
                tree: request.tree.clone(),
            },
        ) {
            Ok(receipt) => (true, Some(receipt.receipt_hash().to_string())),
            Err(error) => {
                blockers.push(freeze_blocker(&error).to_owned());
                (false, None)
            }
        };
    blockers.sort();
    blockers.dedup();
    let mut report = LegacyDeletionDrillAttestationInspectionV1 {
        version: REQUEST_VERSION,
        kind: REPORT_KIND.to_owned(),
        status: "legacy_reference_restore_drill_attestation_blocked".to_owned(),
        local_freeze_verified,
        technical_release_ready: false,
        physical_deletion_allowed: false,
        legacy_database_path: database_path.to_string_lossy().into_owned(),
        release_commit: request.release_commit,
        release_state_snapshot_hash: request.release_state_snapshot_hash,
        archive,
        legacy_freeze_receipt_hash,
        blockers,
        signing_key_read: false,
        runtime_evidence_written: false,
        external_action_performed: false,
        report_hash: String::new(),
    };
    report.report_hash = hash_report(&report)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    fn request(root: &Path) -> LegacyDeletionDrillAttestationRequestV1 {
        LegacyDeletionDrillAttestationRequestV1 {
            version: 1,
            kind: REQUEST_KIND.to_owned(),
            legacy_database_path: root.join("missing.sqlite").to_string_lossy().into_owned(),
            archive_path: root.join("archive.tar.gz").to_string_lossy().into_owned(),
            repository: REQUIRED_REPOSITORY.to_owned(),
            commit: "a".repeat(40),
            tree: "b".repeat(40),
            release_commit: "a".repeat(40),
            release_state_snapshot_hash: format!("sha256:{}", "c".repeat(64)),
        }
    }

    #[test]
    fn missing_database_and_nonimmutable_archive_are_fail_closed() {
        let root = std::env::temp_dir().join(format!("hepta-drill-attest-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
        fs::write(root.join("archive.tar.gz"), b"archive").expect("archive");
        let report = inspect_legacy_deletion_drill_attest_v1(request(&root)).expect("report");
        assert_eq!(
            report.status,
            "legacy_reference_restore_drill_attestation_blocked"
        );
        assert!(!report.technical_release_ready);
        assert!(!report.physical_deletion_allowed);
        assert!(!report.local_freeze_verified);
        assert!(!report.signing_key_read);
        assert!(
            report
                .blockers
                .contains(&"legacy_deletion_drill_node_differential_replay_external".to_owned())
        );
        assert!(
            report
                .blockers
                .contains(&"legacy_reference_archive_not_filesystem_immutable".to_owned())
        );
        assert!(
            report
                .blockers
                .contains(&"legacy_node_freeze_inspection_failed".to_owned())
        );
        assert!(valid_digest(&report.report_hash));
        let claimed_hash = report.report_hash.clone();
        let mut unhashed = report;
        unhashed.report_hash.clear();
        assert_eq!(hash_report(&unhashed).expect("report hash"), claimed_hash);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn request_rejects_relative_paths_and_unknown_contract_kind() {
        let root = PathBuf::from("/tmp");
        let mut value = request(&root);
        value.archive_path = "relative.tar.gz".to_owned();
        assert!(matches!(
            inspect_legacy_deletion_drill_attest_v1(value),
            Err(LegacyDeletionDrillAttestError::RequestInvalid)
        ));
        let mut value = request(&root);
        value.kind = "LegacyDeletionDrillReceipt".to_owned();
        assert!(matches!(
            inspect_legacy_deletion_drill_attest_v1(value),
            Err(LegacyDeletionDrillAttestError::RequestInvalid)
        ));
    }
}
