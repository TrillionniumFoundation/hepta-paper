//! Bounded local inspection for the incumbent generic-domain evidence file.
//!
//! The Node command also composes live research authorities, external replay,
//! independent review and an atomic publication/convergence workflow.  Those
//! are deliberately outside this adapter.  Rust only reads the one explicit
//! runtime file, validates its filesystem identity and exact top-level shape,
//! and reports a fail-closed convergence diagnostic.  It never publishes,
//! invokes an authority, starts a replay, or treats the file as production
//! evidence.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};
use thiserror::Error;

const EVIDENCE_FILE: &str = "generic-domain-capability-evidence.json";
const MAXIMUM_BYTES: u64 = 16 * 1024 * 1024;
const EVIDENCE_KEYS: [&str; 14] = [
    "dynamicFormalExecutionAuthority",
    "experimentHarnessExecutionReceipt",
    "experimentIrExecutionAuthorityReceipt",
    "experimentReplayReceipt",
    "externalResearchReplayReceipt",
    "externalResearchReplayRequest",
    "formalDomainCoverageReceipt",
    "formalDomainQualificationExternalEvidence",
    "independentFormalReviewReceipt",
    "priorArtClaimAlignmentReceipt",
    "priorArtEvidenceReceipt",
    "researchAgendaIr",
    "venueProfile",
    "venueRequirementIr",
];

#[derive(Debug, Error)]
pub enum GenericDomainCapabilityEvidenceError {
    #[error("generic-domain capability evidence path is not absolute and canonical")]
    Path,
    #[error("generic-domain capability evidence path is not valid UTF-8")]
    Utf8,
    #[error("generic-domain capability evidence hash could not be encoded")]
    Hash,
    #[error("generic-domain capability evidence filesystem operation failed")]
    Filesystem,
}

fn current_uid() -> Option<u32> {
    nix::unistd::Uid::current().as_raw().into()
}

fn path_string(path: &Path) -> Result<String, GenericDomainCapabilityEvidenceError> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or(GenericDomainCapabilityEvidenceError::Utf8)
}

fn unsafe_component(path: &Path) -> bool {
    path.components()
        .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
}

fn runtime_root_path(runtime_root: &Path) -> Result<PathBuf, GenericDomainCapabilityEvidenceError> {
    if !runtime_root.is_absolute() || unsafe_component(runtime_root) {
        return Err(GenericDomainCapabilityEvidenceError::Path);
    }
    let canonical =
        fs::canonicalize(runtime_root).map_err(|_| GenericDomainCapabilityEvidenceError::Path)?;
    if canonical != runtime_root {
        return Err(GenericDomainCapabilityEvidenceError::Path);
    }
    let metadata = fs::symlink_metadata(runtime_root)
        .map_err(|_| GenericDomainCapabilityEvidenceError::Path)?;
    let uid = current_uid();
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || uid.is_some_and(|value| metadata.uid() != 0 && metadata.uid() != value)
        || (metadata.mode() & 0o077) != 0
    {
        return Err(GenericDomainCapabilityEvidenceError::Path);
    }
    Ok(canonical)
}

/// Return the only file accepted by this bounded adapter.
pub fn generic_domain_capability_evidence_path(
    runtime_root: &Path,
) -> Result<PathBuf, GenericDomainCapabilityEvidenceError> {
    Ok(runtime_root_path(runtime_root)?.join(EVIDENCE_FILE))
}

fn shape_valid(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != EVIDENCE_KEYS.len() {
        return false;
    }
    let expected = EVIDENCE_KEYS.iter().copied().collect::<BTreeSet<_>>();
    object.keys().map(String::as_str).collect::<BTreeSet<_>>() == expected
}

fn evidence_hash(value: &Value) -> Result<String, GenericDomainCapabilityEvidenceError> {
    production_hash_record_v1("GenericDomainCapabilityEvidence", value)
        .map(|hash| hash.as_str().to_owned())
        .map_err(|_| GenericDomainCapabilityEvidenceError::Hash)
}

fn blocked_report(canonical_path: String, blockers: Vec<&'static str>) -> Value {
    json!({
        "version": 1,
        "kind": "GenericDomainCapabilityEvidenceInspection",
        "status": "generic_domain_capability_evidence_blocked",
        "ready": false,
        "canonicalPath": canonical_path,
        "configuredPath": Value::Null,
        "evidence": Value::Null,
        "evidenceHash": Value::Null,
        "blockers": blockers,
        "statusReadOnly": true
    })
}

fn file_open_no_follow(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        // O_NONBLOCK is required even though a regular file is the only
        // accepted type: the path can be swapped to a FIFO after lstat and
        // before open.  The pre-check below rejects the FIFO without reading;
        // this flag also prevents open itself from waiting on a writer.
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(path)
}

fn same_metadata(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.file_type() == right.file_type()
        && left.mode() == right.mode()
        && left.nlink() == right.nlink()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn private_regular_metadata(metadata: &Metadata, maximum: u64) -> bool {
    metadata.is_file()
        && !metadata.file_type().is_symlink()
        && metadata.nlink() == 1
        && metadata.len() > 0
        && metadata.len() <= maximum
        && (metadata.mode() & 0o077) == 0
        && current_uid().is_none_or(|uid| metadata.uid() == uid)
}

fn read_stable_file(
    mut file: File,
    path: &Path,
    path_before: &Metadata,
    root: &Path,
    root_before: &Metadata,
) -> Result<Vec<u8>, &'static str> {
    let before = file
        .metadata()
        .map_err(|_| "generic_domain_capability_evidence_unreadable")?;
    if !private_regular_metadata(path_before, MAXIMUM_BYTES)
        || !private_regular_metadata(&before, MAXIMUM_BYTES)
        || !same_metadata(path_before, &before)
    {
        return Err("generic_domain_capability_evidence_not_private_regular_file");
    }
    let mut bytes = Vec::new();
    {
        let mut bounded = (&mut file).take(MAXIMUM_BYTES + 1);
        bounded
            .read_to_end(&mut bytes)
            .map_err(|_| "generic_domain_capability_evidence_unreadable")?;
    }
    if bytes.len() as u64 > MAXIMUM_BYTES {
        return Err("generic_domain_capability_evidence_size_invalid");
    }
    let after = file
        .metadata()
        .map_err(|_| "generic_domain_capability_evidence_unreadable")?;
    let path_after = fs::symlink_metadata(path)
        .map_err(|_| "generic_domain_capability_evidence_changed_during_read")?;
    let root_after = fs::symlink_metadata(root)
        .map_err(|_| "generic_domain_capability_evidence_changed_during_read")?;
    if bytes.len() as u64 != before.len()
        || !same_metadata(&before, &after)
        || !same_metadata(path_before, &path_after)
        || !same_metadata(root_before, &root_after)
        || !private_regular_metadata(&path_after, MAXIMUM_BYTES)
    {
        return Err("generic_domain_capability_evidence_changed_during_read");
    }
    Ok(bytes)
}

/// Inspect the canonical explicit runtime evidence file without external input.
pub fn inspect_generic_domain_capability_evidence_v1(
    runtime_root: &Path,
) -> Result<Value, GenericDomainCapabilityEvidenceError> {
    let canonical_path = match generic_domain_capability_evidence_path(runtime_root) {
        Ok(root) => root,
        Err(_) => {
            let lexical = runtime_root.join(EVIDENCE_FILE);
            return Ok(blocked_report(
                path_string(&lexical).unwrap_or_else(|_| EVIDENCE_FILE.to_owned()),
                vec!["generic_domain_capability_runtime_root_invalid"],
            ));
        }
    };
    let canonical_text = path_string(&canonical_path)?;
    let root_before = match fs::symlink_metadata(runtime_root) {
        Ok(metadata) => metadata,
        Err(_) => {
            return Ok(blocked_report(
                canonical_text,
                vec!["generic_domain_capability_runtime_root_invalid"],
            ));
        }
    };
    let path_before = match fs::symlink_metadata(&canonical_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(blocked_report(
                canonical_text,
                vec!["generic_domain_capability_evidence_required"],
            ));
        }
        Err(_) => {
            return Ok(blocked_report(
                canonical_text,
                vec!["generic_domain_capability_evidence_unreadable"],
            ));
        }
    };
    if path_before.file_type().is_symlink() {
        return Ok(blocked_report(
            canonical_text,
            vec!["generic_domain_capability_evidence_not_private_regular_file"],
        ));
    }
    if !path_before.is_file()
        || path_before.nlink() != 1
        || (path_before.mode() & 0o077) != 0
        || current_uid().is_some_and(|uid| path_before.uid() != uid)
    {
        return Ok(blocked_report(
            canonical_text,
            vec!["generic_domain_capability_evidence_not_private_regular_file"],
        ));
    }
    if path_before.len() == 0 || path_before.len() > MAXIMUM_BYTES {
        return Ok(blocked_report(
            canonical_text,
            vec!["generic_domain_capability_evidence_size_invalid"],
        ));
    }
    let file = match file_open_no_follow(&canonical_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(blocked_report(
                canonical_text,
                vec!["generic_domain_capability_evidence_required"],
            ));
        }
        Err(error) if error.raw_os_error() == Some(nix::libc::ELOOP) => {
            return Ok(blocked_report(
                canonical_text,
                vec!["generic_domain_capability_evidence_not_private_regular_file"],
            ));
        }
        Err(_) => {
            return Ok(blocked_report(
                canonical_text,
                vec!["generic_domain_capability_evidence_unreadable"],
            ));
        }
    };
    let bytes = match read_stable_file(
        file,
        &canonical_path,
        &path_before,
        runtime_root,
        &root_before,
    ) {
        Ok(bytes) => bytes,
        Err(blocker) => return Ok(blocked_report(canonical_text, vec![blocker])),
    };
    let parsed = match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => value,
        Err(_) => {
            return Ok(blocked_report(
                canonical_text,
                vec!["generic_domain_capability_evidence_unreadable"],
            ));
        }
    };
    if !shape_valid(&parsed) {
        return Ok(blocked_report(
            canonical_text,
            vec!["generic_domain_capability_evidence_shape_invalid"],
        ));
    }
    let hash = evidence_hash(&parsed)?;
    Ok(json!({
        "version": 1,
        "kind": "GenericDomainCapabilityEvidenceInspection",
        "status": "generic_domain_capability_evidence_loaded",
        "ready": true,
        "canonicalPath": canonical_text,
        "configuredPath": Value::Null,
        "evidence": parsed,
        "evidenceHash": hash,
        "blockers": [],
        "statusReadOnly": true
    }))
}

/// Bounded convergence diagnostic.  It never writes the evidence file and
/// always remains blocked until the full authority/replay/publication chain is
/// migrated and independently qualified.
pub fn converge_generic_domain_capability_evidence_v1(
    runtime_root: &Path,
) -> Result<Value, GenericDomainCapabilityEvidenceError> {
    let inspection = inspect_generic_domain_capability_evidence_v1(runtime_root)?;
    let mut blockers = inspection
        .get("blockers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    blockers.push(Value::String(
        "rust_generic_domain_capability_convergence_not_ported".to_owned(),
    ));
    Ok(json!({
        "version": 1,
        "kind": "RustGenericDomainCapabilityEvidenceConvergence",
        "status": "generic_domain_capability_convergence_blocked",
        "ready": false,
        "inspection": inspection,
        "convergenceImplemented": false,
        "statusReadOnly": true,
        "externalActionPerformed": false,
        "serviceStateChanged": false,
        "published": false,
        "blockers": blockers
    }))
}

/// Help metadata for the bounded route.
pub fn generic_domain_capability_evidence_help_json_v1() -> Value {
    json!({
        "version": 1,
        "kind": "GenericDomainCapabilityEvidenceUsage",
        "usage": "generic-domain-capability-evidence --action status|converge --runtime-root ABSOLUTE_PATH",
        "scope": "explicit runtime evidence file only",
        "mutation": "none",
        "externalAction": "none",
        "serviceStateChange": "none"
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn metadata_snapshot_rejects_ctime_and_path_inode_drift() {
        let root = std::env::temp_dir().join(format!(
            "hepta-generic-domain-metadata-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("evidence.json");
        fs::write(&path, b"stable").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let before = fs::symlink_metadata(&path).unwrap();

        // Restore the original mode after two chmod operations. The mode is
        // equal again, so this assertion specifically protects ctime drift.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let ctime_changed = fs::symlink_metadata(&path).unwrap();
        assert_eq!(before.mode(), ctime_changed.mode());
        assert!(!same_metadata(&before, &ctime_changed));

        let moved = root.join("evidence.moved");
        fs::rename(&path, &moved).unwrap();
        fs::write(&path, b"stable").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let rebound = fs::symlink_metadata(&path).unwrap();
        assert!(!same_metadata(&before, &rebound));

        fs::remove_dir_all(root).unwrap();
    }
}
