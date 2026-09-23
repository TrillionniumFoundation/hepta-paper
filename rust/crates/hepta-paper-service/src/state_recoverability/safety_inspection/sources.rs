//! Actual stored-source selection. The verified source is retained through the
//! final currentness check, then only its descriptive projection is returned.
use super::*;
use crate::state_backup_authority::restore_source::{
    StoredRestoreSourceOptionsV1, verify_stored_restore_source_v1,
};
use crate::state_recoverability::publication::Directory;
use std::{fs, os::unix::fs::MetadataExt};
fn blocked(code: &str, skipped: Option<Vec<Value>>) -> Value {
    let mut value = json!({"status":"autonomous_research_state_backup_sources_blocked",
        "bundlePath":null,"sources":[],"blockers":[code]});
    if let Some(skipped) = skipped {
        value["skippedCandidates"] = json!(skipped);
    }
    value
}
pub(super) fn inspect(
    root: &Path,
    authority: &PinnedStateBackupAuthorityV1<PassiveOnly>,
    manifest: &Value,
    inventory: &Value,
    now: i64,
) -> Result<Value> {
    if matches!(fs::symlink_metadata(root), Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
        return Ok(blocked(
            "autonomous_research_state_backup_bundle_missing",
            None,
        ));
    }
    let directory = Directory::open_or_create(root, false)?;
    let mut candidates = Vec::new();
    for (count, entry) in fs::read_dir(&directory.path)
        .map_err(|_| error("autonomous_research_state_backup_bundle_missing"))?
        .enumerate()
    {
        ensure(
            count < 4096,
            "autonomous_research_state_backup_source_candidate_limit",
        )?;
        let entry =
            entry.map_err(|_| error("autonomous_research_state_backup_candidate_invalid"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| error("autonomous_research_state_backup_candidate_invalid"))?;
        if metadata.is_dir()
            && !metadata.is_symlink()
            && !entry.file_name().to_string_lossy().starts_with('.')
        {
            candidates.push((entry.path(), metadata.mtime(), metadata.mtime_nsec()));
        }
    }
    let collation = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    candidates.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then(b.2.cmp(&a.2))
            .then_with(|| collation.compare(&b.0.to_string_lossy(), &a.0.to_string_lossy()))
    });
    if candidates.is_empty() {
        directory.assert_current()?;
        return Ok(blocked(
            "autonomous_research_state_backup_bundle_missing",
            None,
        ));
    }
    let mut skipped = Vec::new();
    for (path, seconds, nanos) in candidates {
        let result = (|| {
            let bundle = super::super::files::ObservedFile::open(
                &path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json"),
                64 * 1024 * 1024,
            )?;
            let restore = super::super::files::ObservedFile::open(
                &path.join("RESTORE_DRILL_RECEIPT.json"),
                256 * 1024 * 1024,
            )?;
            let source = verify_stored_restore_source_v1(
                authority,
                StoredRestoreSourceOptionsV1 {
                    bundle_path: &path,
                    bundle_file_hash: &hash_bytes(&bundle.bytes(64 * 1024 * 1024)?),
                    restore_receipt_file_hash: &hash_bytes(&restore.bytes(256 * 1024 * 1024)?),
                    state_database_manifest: manifest,
                    current_inventory: inventory,
                    now,
                },
            )?;
            bundle.assert_current()?;
            restore.assert_current()?;
            source.assert_current(inventory, now)?;
            directory.assert_current()?;
            Ok(source.inspection().clone())
        })();
        match result {
            Ok(mut value) => {
                value["skippedCandidates"] = json!(skipped);
                return Ok(value);
            }
            Err(cause) => {
                let cause: crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError =
                    cause;
                let blocker = cause
                    .code
                    .split(':')
                    .next()
                    .filter(|s| {
                        s.starts_with("autonomous_research_state_")
                            && s.bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                    })
                    .unwrap_or("autonomous_research_state_backup_candidate_invalid");
                skipped.push(json!({"candidateDirectoryNameHash":hash("AutonomousResearchStateBackupCandidateDirectoryName", &json!(path.file_name().and_then(|s|s.to_str()).unwrap_or_default()))?,
                    "modifiedAt":iso(seconds.saturating_mul(1000).saturating_add(nanos / 1_000_000))?,"blockers":[blocker]}));
            }
        }
    }
    directory.assert_current()?;
    Ok(blocked(
        "autonomous_research_state_backup_no_valid_restore_drill_bundle",
        Some(skipped),
    ))
}
