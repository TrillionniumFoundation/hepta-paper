//! A fresh restore drill makes private SQLite copies and applies a fully
//! authenticated finalized journal. Production database bytes are never changed.
use super::*;
use super::{
    files::ObservedFile, publication::Directory, service::BackupRecoveryServiceV1,
    sqlite_copy::Scratch,
};
use crate::sqlite_mutation_coordinator::{
    authority::{MutationAuthorityTransportV1, files::parse},
    backup_replay::{checked_snapshot_head_v1, replay_verified_database_v1},
};
use crate::state_backup_authority::{
    FINALIZED_JOURNAL_PROTOCOL, MAXIMUM_JOURNAL_ENTRIES, StateBackupAuthorityTransportV1,
    state_backup_authority_receipt_hash_v1,
};
use rusqlite::{Connection, OpenFlags};
use std::{collections::BTreeSet, fs, path::Path};
pub(super) fn run<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>(
    service: &mut BackupRecoveryServiceV1<B, O>,
    bundle_path: &Path,
    clock: &mut dyn MutationClockV1,
) -> Result<Value> {
    ensure(
        bundle_path.parent() == Some(service.options.backup_root.as_path()),
        "autonomous_research_state_backup_bundle_path_unsafe",
    )?;
    let directory = Directory::open_or_create(bundle_path, false)?;
    let manifest_file = ObservedFile::open(
        &bundle_path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json"),
        64 * 1024 * 1024,
    )?;
    let bundle = parse(
        &manifest_file.bytes(64 * 1024 * 1024)?,
        "autonomous_research_state_backup_bundle_manifest_hash_invalid",
    )?;
    crate::state_backup_authority::restore_source::validate_bundle(
        &bundle,
        &service.options.state_database_manifest,
    )?;
    let entries = bundle["content"]["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_state_backup_database_record_invalid"))?;
    let total = entries
        .iter()
        .try_fold(0i64, |s, e| s.checked_add(int(e, "bytes").ok()?));
    ensure(
        entries.len() <= 256 && total.is_some_and(|n| n > 0 && n <= 1024 * 1024 * 1024),
        "autonomous_research_state_backup_source_resource_limit",
    )?;
    let reservation = service.backup.verify_reservation(
        &bundle["authorityReservation"],
        &bundle["authorityReserveRequest"],
        timestamp(&bundle["authorityReservation"]["issuedAt"]).ok_or_else(|| {
            error("autonomous_research_state_restore_authority_reservation_invalid")
        })?,
    )?;
    service.backup.verify_finalization(
        &bundle["authorityFinalization"],
        &bundle["authorityFinalizeRequest"],
        &reservation,
        timestamp(&bundle["authorityFinalization"]["finalizedAt"]).ok_or_else(|| {
            error("autonomous_research_state_restore_authority_finalization_invalid")
        })?,
    )?;
    let expected_restore = match ObservedFile::open(
        &bundle_path.join("RESTORE_DRILL_RECEIPT.json"),
        256 * 1024 * 1024,
    ) {
        Ok(file) => Some(hash_bytes(&file.bytes(256 * 1024 * 1024)?)),
        Err(_) if matches!(fs::symlink_metadata(bundle_path.join("RESTORE_DRILL_RECEIPT.json")),Err(e) if e.kind()==std::io::ErrorKind::NotFound) => {
            None
        }
        Err(e) => return Err(e),
    };
    let before = clock_now(clock)?;
    let request = json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityCurrentHeadRequest","reservationId":reservation.value()["reservationId"],"databaseScopeHash":bundle["content"]["databaseScopeHash"],"snapshotContentHash":bundle["snapshotContentHash"],"requestedAt":before.1,"maximumLeaseMs":service.backup.trust()["maximumReservationLeaseMs"]});
    let raw_head = service.backup.observe_current_head(&request, before.0)?;
    let head =
        service
            .backup
            .verify_current_head(raw_head.value(), &request, clock_now(clock)?.0)?;
    let initial_sequence = int(&bundle["authorityFinalization"], "headSequence")?;
    let live_sequence = int(head.value(), "headSequence")?;
    let initial_hash = &bundle["authorityFinalization"]["headHash"];
    ensure(
        live_sequence >= initial_sequence
            && (live_sequence != initial_sequence || head.value()["headHash"] == *initial_hash),
        "autonomous_research_state_restore_authority_head_rollback_or_equivocation",
    )?;
    let delta = live_sequence - initial_sequence;
    let mut journal_request = Value::Null;
    let mut journal_receipt = Value::Null;
    let mut journal_evidence = None;
    if delta > 0 {
        ensure(
            delta <= MAXIMUM_JOURNAL_ENTRIES,
            "autonomous_research_state_restore_journal_range_unbounded",
        )?;
        let time = clock_now(clock)?;
        let trust = service.online.trust();
        ensure(
            trust["databaseScopeHash"] == bundle["content"]["databaseScopeHash"],
            "autonomous_research_state_restore_online_authority_trust_required",
        )?;
        journal_request = json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityJournalRangeRequest","reservationId":reservation.value()["reservationId"],"databaseScopeHash":bundle["content"]["databaseScopeHash"],"snapshotContentHash":bundle["snapshotContentHash"],"onlineAuthorityId":trust["authorityId"],"onlineKeyId":trust["keyId"],"scopeId":trust["scopeId"],"writerManifestHash":trust["writerManifestHash"],"fromGlobalSequence":initial_sequence,"fromGlobalHash":initial_hash,"toGlobalSequence":live_sequence,"toGlobalHash":head.value()["headHash"],"requestedAt":time.1,"maximumLeaseMs":service.backup.trust()["maximumReservationLeaseMs"],"maximumEntries":delta});
        let candidate = service
            .backup
            .read_finalized_mutation_journal(&journal_request, time.0)?;
        let range = service.backup.verify_journal_range(
            candidate.value(),
            &journal_request,
            clock_now(clock)?.0,
        )?;
        journal_evidence = Some(service.backup.verify_finalized_journal_chain(&range)?);
        journal_receipt = range.value().clone();
    }
    let expected = entries
        .iter()
        .map(|v| text(v, "backupRelativePath").map(str::to_owned))
        .collect::<Result<BTreeSet<_>>>()?;
    let present = fs::read_dir(bundle_path.join("databases"))
        .map_err(|_| error("autonomous_research_state_backup_database_set_mismatch"))?
        .take(expected.len() + 1)
        .map(|r| {
            r.map(|e| format!("databases/{}", e.file_name().to_string_lossy()))
                .map_err(|_| error("autonomous_research_state_backup_database_set_mismatch"))
        })
        .collect::<Result<BTreeSet<_>>>()?;
    ensure(
        expected == present,
        "autonomous_research_state_backup_database_set_mismatch",
    )?;
    let scratch = Scratch::new()?;
    let mut retained = Vec::new();
    let mut copies = Vec::new();
    let mut global: Option<Value> = None;
    for entry in entries {
        let relative = Path::new(text(entry, "backupRelativePath")?);
        let source = ObservedFile::open(&bundle_path.join(relative), 256 * 1024 * 1024)?;
        super::files::no_sidecars(&source.path)?;
        let bytes = source.bytes(256 * 1024 * 1024)?;
        ensure(
            entry["backupSha256"] == hash_bytes(&bytes)
                && int(entry, "bytes")? == bytes.len() as i64,
            "autonomous_research_state_backup_database_hash_mismatch",
        )?;
        let name = relative
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| error("autonomous_research_state_backup_database_record_invalid"))?;
        let copied = super::sqlite_copy::copy(&source.path, &scratch.directory, name, true)?;
        ensure(
            copied["schemaHash"] == entry["schemaHash"],
            "autonomous_research_state_restore_copy_invalid",
        )?;
        if journal_evidence.is_some() {
            let db = Connection::open_with_flags(
                scratch.directory.path.join(name),
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_NOFOLLOW
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            let local = checked_snapshot_head_v1(&db, entry, &service.online)?;
            let h = local.value();
            if let Some(g) = &global {
                let seq = int(h, "globalSequence")?;
                let previous = int(g, "globalSequence")?;
                if seq > previous {
                    global = Some(h.clone());
                } else if seq == previous {
                    ensure(
                        g["globalHash"] == h["globalHash"],
                        "autonomous_research_state_restore_snapshot_global_head_conflict",
                    )?;
                }
            } else {
                global = Some(h.clone());
            }
        }
        copies.push((entry.clone(), scratch.directory.path.join(name)));
        retained.push(source);
    }
    let mut recovered = Vec::new();
    if let Some(range) = journal_evidence {
        let global = global.ok_or_else(|| {
            error("autonomous_research_state_restore_snapshot_global_head_invalid")
        })?;
        ensure(
            int(&global, "globalSequence")? == initial_sequence
                && global["globalHash"] == *initial_hash,
            "autonomous_research_state_restore_snapshot_global_head_invalid",
        )?;
        let ids = entries
            .iter()
            .map(|e| text(e, "instanceId"))
            .collect::<Result<BTreeSet<_>>>()?;
        ensure(
            range.value()["entries"].as_array().is_some_and(|es| {
                es.iter().all(|e| {
                    e["reservationReceipt"]["databaseInstanceId"]
                        .as_str()
                        .is_some_and(|id| ids.contains(id))
                })
            }),
            "autonomous_research_state_restore_journal_database_unknown",
        )?;
        for (entry, path) in &copies {
            let mut db = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_NOFOLLOW
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            let h = replay_verified_database_v1(&mut db, entry, &range, &service.online)?;
            let mut projected = json!({});
            for key in [
                "databaseRole",
                "databaseInstanceId",
                "sequence",
                "hash",
                "schemaHash",
                "stateHash",
            ] {
                projected[key] = h.value()[key].clone();
            }
            recovered.push(projected);
        }
        let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
            .map_err(|e| error(e.to_string()))?;
        recovered.sort_by(|a, b| {
            collator.compare(
                a["databaseInstanceId"].as_str().unwrap_or_default(),
                b["databaseInstanceId"].as_str().unwrap_or_default(),
            )
        });
        ensure(
            journal_receipt["databaseHeads"]
                .as_array()
                .is_some_and(|heads| {
                    heads.len() == recovered.len()
                        && heads.iter().zip(&recovered).all(|(a, b)| {
                            [
                                "databaseRole",
                                "databaseInstanceId",
                                "hash",
                                "schemaHash",
                                "stateHash",
                            ]
                            .iter()
                            .all(|k| a[k] == b[k])
                                && int(a, "sequence").ok() == int(b, "sequence").ok()
                        })
                }),
            "autonomous_research_state_restore_recovered_database_heads_invalid",
        )?;
        // The actual recovered heads have been compared field-for-field above.
        // Retain the authenticated JSON number spelling for the later raw
        // JSON.stringify-style binding; 0 and 0.0 denote the same JS Number.
        for (actual, signed) in recovered.iter_mut().zip(
            journal_receipt["databaseHeads"]
                .as_array()
                .into_iter()
                .flatten(),
        ) {
            actual["sequence"] = signed["sequence"].clone();
        }
    }
    let completed = clock_now(clock)?;
    service
        .backup
        .verify_current_head(head.value(), &request, completed.0)?;
    if !journal_receipt.is_null() {
        service
            .backup
            .verify_journal_range(&journal_receipt, &journal_request, completed.0)?;
    }
    manifest_file.assert_current()?;
    directory.assert_current()?;
    for file in retained {
        file.assert_current()?;
        super::files::no_sidecars(&file.path)?;
    }
    let has_journal = !journal_receipt.is_null();
    let range_hash = if has_journal {
        json!(state_backup_authority_receipt_hash_v1(&journal_receipt)?)
    } else {
        Value::Null
    };
    let mut receipt = json!({"version":1,"kind":"AutonomousResearchStateRestoreDrillReceipt","status":"autonomous_research_state_restore_drill_passed","bundlePath":bundle_path,"bundleManifestHash":bundle["bundleManifestHash"],"snapshotContentHash":bundle["snapshotContentHash"],"authorityCurrentHeadRequest":request,"authorityCurrentHeadReceipt":head.value(),"authorityCurrentHeadReceiptHash":state_backup_authority_receipt_hash_v1(head.value())?,"authorityJournalRangeRequest":journal_request,"authorityJournalRangeReceipt":journal_receipt,"authorityJournalRangeReceiptHash":range_hash,"journalReplayMutationCount":delta,"recoveredDatabaseHeads":recovered,"recoverabilityProtocol":if has_journal{FINALIZED_JOURNAL_PROTOCOL}else{"snapshot-current-head-exact-v1"},"completeFinalizedMutationJournal":has_journal,"databaseCount":entries.len(),"productionStateMutated":false,"performedAt":completed.1,"blockers":[]});
    let mut binding = json!({});
    for (to, from) in [
        ("bundleManifestHash", "bundleManifestHash"),
        ("snapshotContentHash", "snapshotContentHash"),
        ("currentHeadReceiptHash", "authorityCurrentHeadReceiptHash"),
        (
            "journalRangeReceiptHash",
            "authorityJournalRangeReceiptHash",
        ),
        ("journalReplayMutationCount", "journalReplayMutationCount"),
        ("recoveredDatabaseHeads", "recoveredDatabaseHeads"),
        ("recoverabilityProtocol", "recoverabilityProtocol"),
        (
            "completeFinalizedMutationJournal",
            "completeFinalizedMutationJournal",
        ),
    ] {
        binding[to] = receipt[from].clone();
    }
    receipt["recoverabilityBindingHash"] = hash(
        "AutonomousResearchStateRestoreRecoverabilityBinding",
        &binding,
    )?
    .into();
    receipt["restoreDrillReceiptHash"] =
        hash("AutonomousResearchStateRestoreDrillReceipt", &receipt)?.into();
    super::publication::publish_receipt(
        &directory,
        "RESTORE_DRILL_RECEIPT.json",
        &receipt,
        expected_restore.as_deref(),
    )?;
    Ok(receipt)
}
