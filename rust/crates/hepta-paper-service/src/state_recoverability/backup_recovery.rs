//! Resume only a persisted, externally signed snapshot transaction. Recovery
//! never treats local JSON hashes as authority or mutates a live database.
use super::*;
use super::{files::ObservedFile, publication::Directory, service::BackupRecoveryServiceV1};
use crate::sqlite_mutation_coordinator::authority::{
    MutationAuthorityTransportV1,
    files::{Snapshot, parse},
};
use crate::state_backup_authority::{
    StateBackupAuthorityTransportV1,
    restore_source::{inspect_database, validate_bundle, validate_content},
    state_backup_authority_receipt_hash_v1,
};
use nix::fcntl::{Flock, FlockArg, OFlag, openat};
use nix::sys::stat::Mode;
use std::{
    collections::BTreeSet,
    fs::{self, File},
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::Path,
};
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_state_backup_recovery_evidence_invalid")
}
fn checked_files<O: MutationAuthorityTransportV1>(
    content: &Value,
    stage: &Directory,
    manifest: &Value,
    online: &crate::sqlite_mutation_coordinator::authority::PinnedMutationAuthorityV1<O>,
) -> Result<Vec<Snapshot>> {
    let entries = content["databases"].as_array().ok_or_else(invalid)?;
    let total = entries
        .iter()
        .try_fold(0i64, |n, e| n.checked_add(int(e, "bytes").ok()?));
    ensure(
        entries.len() <= 256 && total.is_some_and(|n| n > 0 && n <= 1024 * 1024 * 1024),
        "autonomous_research_state_backup_source_resource_limit",
    )?;
    let expected = entries
        .iter()
        .map(|e| text(e, "backupRelativePath").map(str::to_owned))
        .collect::<Result<BTreeSet<_>>>()?;
    let actual = fs::read_dir(stage.path.join("databases"))
        .map_err(|_| invalid())?
        .take(expected.len() + 1)
        .map(|e| {
            e.map(|e| format!("databases/{}", e.file_name().to_string_lossy()))
                .map_err(|_| invalid())
        })
        .collect::<Result<BTreeSet<_>>>()?;
    ensure(
        actual == expected,
        "autonomous_research_state_backup_database_set_mismatch",
    )?;
    let mut snapshots = Vec::new();
    let private = super::sqlite_copy::Scratch::new()?;
    let mut global: Option<Value> = None;
    for entry in entries {
        let file = Snapshot::load(
            &stage.path.join(text(entry, "backupRelativePath")?),
            text(entry, "backupSha256")?,
            256 * 1024 * 1024,
            "autonomous_research_state_backup_database_hash_mismatch",
        )?;
        ensure(
            file.bytes().len() as i64 == int(entry, "bytes")?,
            "autonomous_research_state_backup_database_hash_mismatch",
        )?;
        let definition = manifest["databases"]
            .as_array()
            .and_then(|a| a.iter().find(|v| v["role"] == entry["role"]))
            .ok_or_else(invalid)?;
        inspect_database(&file, entry, definition)?;
        let name = format!("{}.sqlite", snapshots.len());
        private.directory.write_new(&name, file.bytes())?;
        let database = rusqlite::Connection::open_with_flags(
            private.directory.path.join(name),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let head = crate::sqlite_mutation_coordinator::backup_replay::checked_snapshot_head_v1(
            &database, entry, online,
        )?;
        let head = head.value();
        let seq = int(head, "globalSequence")?;
        if let Some(previous) = &global {
            let prev = int(previous, "globalSequence")?;
            if seq > prev {
                global = Some(head.clone());
            } else if seq == prev {
                ensure(
                    head["globalHash"] == previous["globalHash"],
                    "autonomous_research_state_backup_local_global_head_conflict",
                )?;
            }
        } else {
            global = Some(head.clone());
        }
        snapshots.push(file);
    }
    let global = global.ok_or_else(invalid)?;
    ensure(
        int(&global, "globalSequence")? == int(&content["authorityHead"], "sequence")?
            && global["globalHash"] == content["authorityHead"]["hash"],
        "autonomous_research_state_backup_local_authority_head_mismatch",
    )?;
    stage.assert_current()?;
    Ok(snapshots)
}
pub(super) fn recover<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>(
    service: &mut BackupRecoveryServiceV1<B, O>,
    path: &Path,
    clock: &mut dyn MutationClockV1,
) -> Result<Value> {
    ensure(
        path.parent() == Some(service.options.backup_root.as_path())
            && path.file_name().and_then(|s| s.to_str()).is_some_and(|s| {
                s.strip_prefix(".pending-")
                    .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            }),
        "autonomous_research_state_backup_recovery_path_invalid",
    )?;
    let root = Directory::open_or_create(&service.options.backup_root, false)?;
    let stage = Directory::open_or_create(path, false)?;
    let lock = File::from(
        openat(
            stage.held.as_fd(),
            ".recovery-lock",
            OFlag::O_RDWR
                | OFlag::O_CREAT
                | OFlag::O_NOFOLLOW
                | OFlag::O_CLOEXEC
                | OFlag::O_NONBLOCK,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| invalid())?,
    );
    let lock = Flock::lock(lock, FlockArg::LockExclusiveNonblock)
        .map_err(|_| error("autonomous_research_state_backup_recovery_busy"))?;
    let assert_lock = || -> Result<()> {
        let m = lock.metadata().map_err(|_| invalid())?;
        let n = fs::symlink_metadata(stage.path.join(".recovery-lock")).map_err(|_| invalid())?;
        ensure(
            m.is_file()
                && m.nlink() == 1
                && m.len() == 0
                && m.mode() & 0o077 == 0
                && m.uid() == nix::unistd::getuid().as_raw()
                && n.is_file()
                && n.dev() == m.dev()
                && n.ino() == m.ino(),
            "autonomous_research_state_backup_recovery_lock_changed",
        )?;
        stage.assert_current()
    };
    assert_lock()?;
    let pending = ObservedFile::open(&path.join("PENDING_BACKUP.json"), 64 * 1024 * 1024)?;
    let document = parse(
        &pending.bytes(64 * 1024 * 1024)?,
        "autonomous_research_state_backup_recovery_evidence_invalid",
    )?;
    let mut payload = document.clone();
    payload
        .as_object_mut()
        .ok_or_else(invalid)?
        .remove("pendingBackupHash");
    ensure(
        document["version"] == 1
            && document["kind"] == "AutonomousResearchStatePendingBackup"
            && document["pendingBackupHash"]
                == hash("AutonomousResearchStatePendingBackup", &payload)?
            && document["backupConfigurationHash"] == service.backup.configuration_hash()
            && document["onlineConfigurationHash"] == service.online.configuration_hash(),
        "autonomous_research_state_backup_recovery_evidence_invalid",
    )?;
    let content = &document["content"];
    validate_content(
        content,
        &document["snapshotContentHash"],
        &service.options.state_database_manifest,
    )?;
    let r = &document["authorityReservation"];
    let reservation = service.backup.verify_reservation(
        r,
        &document["authorityReserveRequest"],
        timestamp(&r["issuedAt"]).ok_or_else(invalid)?,
    )?;
    ensure(
        content["authorityReservationHash"] == state_backup_authority_receipt_hash_v1(r)?
            && int(&content["authorityHead"], "sequence")? == int(r, "headSequence")?
            && content["authorityHead"]["hash"] == r["headHash"]
            && content["inventoryHash"] == r["inventoryHash"]
            && content["databaseScopeHash"] == r["databaseScopeHash"],
        "autonomous_research_state_backup_recovery_evidence_invalid",
    )?;
    let request = &document["authorityFinalizeRequest"];
    ensure(
        request["version"] == 1
            && request["kind"] == "AutonomousResearchStateBackupAuthorityFinalizeRequest"
            && request["reservationId"] == r["reservationId"]
            && request["inventoryHash"] == r["inventoryHash"]
            && request["databaseScopeHash"] == r["databaseScopeHash"]
            && request["snapshotContentHash"] == document["snapshotContentHash"]
            && request["requestedAt"] == content["createdAt"],
        "autonomous_research_state_backup_recovery_evidence_invalid",
    )?;
    let snapshots = checked_files(
        content,
        &stage,
        &service.options.state_database_manifest,
        &service.online,
    )?;
    pending.assert_current()?;
    assert_lock()?;
    let manifest_path = path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json");
    let existing = match ObservedFile::open(&manifest_path, 64 * 1024 * 1024) {
        Ok(f) => Some(f),
        Err(_) if matches!(fs::symlink_metadata(&manifest_path),Err(e) if e.kind()==std::io::ErrorKind::NotFound) => {
            None
        }
        Err(e) => return Err(e),
    };
    let bundle = if let Some(file) = &existing {
        let bundle = parse(
            &file.bytes(64 * 1024 * 1024)?,
            "autonomous_research_state_backup_recovery_evidence_invalid",
        )?;
        ensure(
            bundle["content"] == *content
                && bundle["snapshotContentHash"] == document["snapshotContentHash"]
                && bundle["authorityReservation"] == *r
                && bundle["authorityReserveRequest"] == document["authorityReserveRequest"]
                && bundle["authorityFinalizeRequest"] == *request,
            "autonomous_research_state_backup_recovery_evidence_invalid",
        )?;
        service.backup.verify_finalization(
            &bundle["authorityFinalization"],
            request,
            &reservation,
            clock_now(clock)?.0,
        )?;
        bundle
    } else {
        // Reissue the exact original transaction. The external authority must return
        // a signed finalization bound to those bytes; no local retry claims success.
        let finalization =
            service
                .backup
                .finalize_snapshot(request, &reservation, clock_now(clock)?.0)?;
        service.backup.verify_finalization(
            finalization.value(),
            request,
            &reservation,
            clock_now(clock)?.0,
        )?;
        let mut bundle = json!({"version":1,"kind":"AutonomousResearchStateBackupBundleManifest","status":"autonomous_research_state_backup_recorded","snapshotContentHash":document["snapshotContentHash"],"content":content,"authorityReserveRequest":document["authorityReserveRequest"],"authorityReservation":r,"authorityFinalizeRequest":request,"authorityFinalization":finalization.value(),"productionStateMutated":false});
        bundle["bundleManifestHash"] =
            hash("AutonomousResearchStateBackupBundleManifest", &bundle)?.into();
        bundle
    };
    validate_bundle(&bundle, &service.options.state_database_manifest)?;
    for file in &snapshots {
        file.assert_current()?;
    }
    pending.assert_current()?;
    assert_lock()?;
    if let Some(file) = &existing {
        file.assert_current()?;
    } else {
        stage.write_new(
            "AUTONOMOUS_RESEARCH_STATE_BACKUP.json",
            &serde_json::to_vec(&bundle).map_err(|_| invalid())?,
        )?;
    }
    for file in snapshots {
        file.assert_current()?;
    }
    pending.assert_current()?;
    assert_lock()?;
    let snapshot_hash = text(&bundle, "snapshotContentHash")?;
    let destination = root.publish_new(&stage, &snapshot_hash[7..])?;
    Ok(
        json!({"version":1,"kind":"AutonomousResearchStateBackupReceipt","status":"autonomous_research_state_backup_recorded","bundlePath":destination,"bundleManifestHash":bundle["bundleManifestHash"],"snapshotContentHash":snapshot_hash,"inventoryHash":content["inventoryHash"],"databaseCount":content["databases"].as_array().map_or(0,Vec::len),"authorityId":r["authorityId"],"authorityHeadSequence":r["headSequence"],"authorityHeadHash":r["headHash"],"blockers":[]}),
    )
}
