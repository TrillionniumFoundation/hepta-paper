//! Refresh a historical snapshot by actually replaying authenticated fixed
//! mutations, then comparing every live effective row with the private replay.
//! Automatic general recovery requires the complete original writer registry;
//! custom registries retain only the bounded heartbeat transition.
//! Historical candidate construction never grants a current epoch.
use super::*;
use super::{
    files::ObservedFile,
    publication::Directory,
    service::{BackupRecoveryServiceV1, CurrentRestoreSourcesV1},
    sqlite_copy::Scratch,
};
use crate::sqlite_mutation_coordinator::{
    authority::{MutationAuthorityTransportV1, files::Snapshot},
    backup_replay::{checked_snapshot_head_v1, replay_verified_database_v1},
};
use crate::state_backup_authority::{
    StateBackupAuthorityTransportV1,
    restore_source::{inspect_database, validate_bundle},
};
use crate::state_database_inventory::ObservedStateDatabaseInventoryV1;
use rusqlite::{Connection, OpenFlags};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
mod checkpoint_replay;
mod equivalence;
pub(crate) use checkpoint_replay::{
    VerifiedCheckpointReplayV1, verify_checkpoint_effective_state_v1,
};
mod registered;
mod selection;
#[cfg(test)]
mod tests;
mod transition;
pub(super) use selection::replay_best_heartbeat_history;

/// Cached result of actual private replay/current-row comparison. Private
/// fields prevent callers from converting a report into proof. It is only
/// reusable while the exact opaque inventory and stored receipt remain pinned;
/// it grants no live head, lease, epoch or mutation authority by itself.
pub(super) struct VerifiedCurrentReplayV1 {
    inventory_hash: String,
    restore_hash: String,
}
impl VerifiedCurrentReplayV1 {
    fn checked(inventory: &ObservedStateDatabaseInventoryV1, restore: &Value) -> Result<Self> {
        Ok(Self {
            inventory_hash: text(inventory.value(), "inventoryHash")?.into(),
            restore_hash: text(restore, "restoreDrillReceiptHash")?.into(),
        })
    }
    pub(super) fn assert_matches(
        &self,
        inventory: &ObservedStateDatabaseInventoryV1,
        inspection: &Value,
    ) -> Result<()> {
        ensure(
            inventory.value()["inventoryHash"] == self.inventory_hash
                && inspection["restoreDrillReceiptHash"] == self.restore_hash,
            "autonomous_research_state_heartbeat_effective_proof_binding_mismatch",
        )
    }
}

struct HistoricalBackupCandidateV1 {
    path: PathBuf,
    directory: Directory,
    manifest: Snapshot,
    bundle: Value,
    databases: Vec<(Value, Snapshot)>,
}
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_state_heartbeat_history_invalid")
}
fn canonical_equal(left: &Value, right: &Value) -> Result<bool> {
    Ok(hepta_legacy_compatibility::production_stable_json_v1(left)
        .map_err(|e| error(e.to_string()))?
        == hepta_legacy_compatibility::production_stable_json_v1(right)
            .map_err(|e| error(e.to_string()))?)
}
impl HistoricalBackupCandidateV1 {
    fn load<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>(
        service: &BackupRecoveryServiceV1<B, O>,
        path: &Path,
        inventory: &ObservedStateDatabaseInventoryV1,
        now: i64,
        maximum_age: i64,
    ) -> Result<Self> {
        ensure(
            path.parent() == Some(service.options.backup_root.as_path())
                && path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| !s.starts_with('.')),
            "autonomous_research_state_heartbeat_history_path_invalid",
        )?;
        let directory = Directory::open_or_create(path, false)?;
        let raw = ObservedFile::open(
            &path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json"),
            64 * 1024 * 1024,
        )?;
        let manifest = Snapshot::load(
            &raw.path,
            &hash_bytes(&raw.bytes(64 * 1024 * 1024)?),
            64 * 1024 * 1024,
            "autonomous_research_state_heartbeat_history_invalid",
        )?;
        raw.assert_current()?;
        let bundle = manifest.json("autonomous_research_state_heartbeat_history_invalid")?;
        validate_bundle(&bundle, &service.options.state_database_manifest)?;
        let content = &bundle["content"];
        let created = timestamp(&content["createdAt"]).ok_or_else(invalid)?;
        ensure(
            now >= created && now.saturating_sub(created) < maximum_age,
            "autonomous_research_state_heartbeat_history_snapshot_too_old",
        )?;
        let reservation = &bundle["authorityReservation"];
        let reserved = service.backup.verify_reservation(
            reservation,
            &bundle["authorityReserveRequest"],
            timestamp(&reservation["issuedAt"]).ok_or_else(invalid)?,
        )?;
        service.backup.verify_finalization(
            &bundle["authorityFinalization"],
            &bundle["authorityFinalizeRequest"],
            &reserved,
            timestamp(&bundle["authorityFinalization"]["finalizedAt"]).ok_or_else(invalid)?,
        )?;
        ensure(
            content["databaseScopeHash"] == inventory.value()["databaseScopeHash"]
                && content["manifestHash"] == inventory.value()["manifestHash"]
                && service.online.trust()["databaseScopeHash"] == content["databaseScopeHash"]
                && service.online.trust()["writerManifestHash"]
                    == crate::sqlite_mutation_coordinator::manifest::writer_manifest_hash_v1(
                        &service.options.writer_manifest,
                    )?,
            "autonomous_research_state_heartbeat_history_scope_mismatch",
        )?;
        let entries = content["databases"].as_array().ok_or_else(invalid)?;
        let instances = inventory.value()["instances"]
            .as_array()
            .ok_or_else(invalid)?;
        let total = entries
            .iter()
            .try_fold(0_i64, |sum, e| sum.checked_add(int(e, "bytes").ok()?));
        ensure(
            !entries.is_empty()
                && entries.len() <= 256
                && instances.len() == entries.len()
                && total.is_some_and(|n| n > 0 && n <= 1024 * 1024 * 1024),
            "autonomous_research_state_heartbeat_resource_limit",
        )?;
        let ids = entries
            .iter()
            .map(|e| text(e, "instanceId").map(str::to_owned))
            .collect::<Result<BTreeSet<_>>>()?;
        let reserved_ids = reservation["databaseInstanceIds"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .map(|v| v.as_str().map(str::to_owned).ok_or_else(invalid))
            .collect::<Result<BTreeSet<_>>>()?;
        ensure(
            ids.len() == entries.len() && ids == reserved_ids,
            "autonomous_research_state_heartbeat_history_scope_mismatch",
        )?;
        let expected = entries
            .iter()
            .map(|e| text(e, "backupRelativePath").map(str::to_owned))
            .collect::<Result<BTreeSet<_>>>()?;
        let actual = fs::read_dir(path.join("databases"))
            .map_err(|_| invalid())?
            .take(expected.len() + 1)
            .map(|entry| {
                let entry = entry.map_err(|_| invalid())?;
                let name = entry.file_name().into_string().map_err(|_| invalid())?;
                Ok(format!("databases/{name}"))
            })
            .collect::<Result<BTreeSet<_>>>()?;
        ensure(
            actual == expected,
            "autonomous_research_state_heartbeat_history_database_set_mismatch",
        )?;
        let mut databases = Vec::new();
        for entry in entries {
            let current = instances
                .iter()
                .find(|i| i["instanceId"] == entry["instanceId"])
                .ok_or_else(invalid)?;
            ensure(
                [
                    "role",
                    "instanceId",
                    "paperId",
                    "sourceRelativePath",
                    "schemaContractId",
                    "schemaHash",
                ]
                .iter()
                .all(|key| current[key] == entry[key]),
                "autonomous_research_state_heartbeat_history_scope_mismatch",
            )?;
            let file = Snapshot::load(
                &path.join(text(entry, "backupRelativePath")?),
                text(entry, "backupSha256")?,
                256 * 1024 * 1024,
                "autonomous_research_state_heartbeat_history_database_hash_mismatch",
            )?;
            ensure(
                file.bytes().len() as i64 == int(entry, "bytes")?,
                "autonomous_research_state_heartbeat_history_database_hash_mismatch",
            )?;
            let definition = service.options.state_database_manifest["databases"]
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["role"] == entry["role"]))
                .ok_or_else(invalid)?;
            inspect_database(&file, entry, definition)?;
            databases.push((entry.clone(), file));
        }
        let result = Self {
            path: path.into(),
            directory,
            manifest,
            bundle,
            databases,
        };
        result.assert_current()?;
        inventory
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        self.directory.assert_current()?;
        self.manifest.assert_current()?;
        let expected = self
            .databases
            .iter()
            .map(|(entry, _)| text(entry, "backupRelativePath").map(str::to_owned))
            .collect::<Result<BTreeSet<_>>>()?;
        let present = fs::read_dir(self.path.join("databases"))
            .map_err(|_| invalid())?
            .take(expected.len() + 1)
            .map(|entry| {
                let name = entry
                    .map_err(|_| invalid())?
                    .file_name()
                    .into_string()
                    .map_err(|_| invalid())?;
                Ok(format!("databases/{name}"))
            })
            .collect::<Result<BTreeSet<_>>>()?;
        ensure(
            expected == present,
            "autonomous_research_state_heartbeat_history_database_set_mismatch",
        )?;
        for (_, file) in &self.databases {
            file.assert_current()?;
            super::files::no_sidecars(&file.path)?;
        }
        self.directory.assert_current()?;
        Ok(())
    }
}

/// This returns an existing opaque, strictly checked current-source object.
/// The controller must still obtain a fresh head and live lease before ready.
pub(super) fn replay_heartbeat_history<
    B: StateBackupAuthorityTransportV1,
    O: MutationAuthorityTransportV1,
>(
    service: &mut BackupRecoveryServiceV1<B, O>,
    path: &Path,
    clock: &mut dyn MutationClockV1,
    maximum_age: i64,
) -> Result<CurrentRestoreSourcesV1> {
    let inventory = service.inventory()?;
    let before = clock_now(clock)?;
    let candidate =
        HistoricalBackupCandidateV1::load(service, path, &inventory, before.0, maximum_age)?;
    replay_candidate(
        service,
        candidate,
        inventory,
        clock,
        before.0,
        ReplayPolicy::Heartbeat,
    )
}

/// The ordinary already-selected journal branch supports every mutation the
/// replay engine validates. Its publication still requires exact current rows.
pub(super) fn replay_selected_history<
    B: StateBackupAuthorityTransportV1,
    O: MutationAuthorityTransportV1,
>(
    service: &mut BackupRecoveryServiceV1<B, O>,
    path: &Path,
    clock: &mut dyn MutationClockV1,
) -> Result<CurrentRestoreSourcesV1> {
    let inventory = service.inventory()?;
    let before = clock_now(clock)?.0;
    let candidate = HistoricalBackupCandidateV1::load(service, path, &inventory, before, i64::MAX)?;
    replay_candidate(
        service,
        candidate,
        inventory,
        clock,
        before,
        ReplayPolicy::Existing,
    )
}

#[derive(Clone, Copy)]
enum ReplayPolicy {
    Heartbeat,
    Automatic,
    Existing,
}

fn replay_candidate<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>(
    service: &mut BackupRecoveryServiceV1<B, O>,
    candidate: HistoricalBackupCandidateV1,
    inventory: ObservedStateDatabaseInventoryV1,
    clock: &mut dyn MutationClockV1,
    before: i64,
    policy: ReplayPolicy,
) -> Result<CurrentRestoreSourcesV1> {
    candidate.assert_current()?;
    inventory
        .assert_current()
        .map_err(|e| error(e.to_string()))?;
    let prepared = super::drill::prepare(service, &candidate.path, clock)?;
    let drill = prepared.receipt();
    ensure(
        drill["bundleManifestHash"] == candidate.bundle["bundleManifestHash"]
            && drill["snapshotContentHash"] == candidate.bundle["snapshotContentHash"]
            && drill["completeFinalizedMutationJournal"] == true,
        "autonomous_research_state_heartbeat_signed_journal_required",
    )?;
    let observed = clock_now(clock)?;
    ensure(
        observed.0 >= before,
        "autonomous_research_state_heartbeat_clock_rollback",
    )?;
    let signed = service.backup.verify_journal_range(
        &drill["authorityJournalRangeReceipt"],
        &drill["authorityJournalRangeRequest"],
        observed.0,
    )?;
    let range = service.backup.verify_finalized_journal_chain(&signed)?;
    let registered = match policy {
        ReplayPolicy::Automatic | ReplayPolicy::Existing => {
            registered::RegisteredJournalPlansV1::authenticate(
                &service.options.writer_manifest,
                &inventory,
                range.chain(),
            )?
        }
        _ => None,
    };
    let require_heartbeat = matches!(policy, ReplayPolicy::Heartbeat)
        || (matches!(policy, ReplayPolicy::Automatic) && registered.is_none());
    if require_heartbeat {
        transition::assert_heartbeat_range(&range)?;
    }
    candidate.assert_current()?;
    inventory
        .assert_current()
        .map_err(|e| error(e.to_string()))?;
    compare_effective_state(
        service,
        &candidate,
        &inventory,
        &range,
        require_heartbeat,
        registered.as_ref(),
    )?;
    let completed = clock_now(clock)?;
    ensure(
        completed.0 >= observed.0,
        "autonomous_research_state_heartbeat_clock_rollback",
    )?;
    let proof = VerifiedCurrentReplayV1::checked(&inventory, prepared.receipt())?;
    // A clock implementation can do I/O, and another writer can change the
    // sources during that call. Recheck after the final sample, before any
    // persisted receipt replacement. These remain observation boundaries.
    candidate.assert_current()?;
    inventory
        .assert_current()
        .map_err(|e| error(e.to_string()))?;
    prepared.publish()?;
    let mut source = service.selected(&candidate.path, inventory, completed.0)?;
    proof.assert_matches(&source.inventory, source.source.inspection())?;
    source.current_replay = Some(proof);
    Ok(source)
}

fn compare_effective_state<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>(
    service: &BackupRecoveryServiceV1<B, O>,
    candidate: &HistoricalBackupCandidateV1,
    inventory: &ObservedStateDatabaseInventoryV1,
    range: &crate::state_backup_authority::VerifiedFinalizedJournalEvidenceV1,
    require_heartbeat_schema: bool,
    registered: Option<&registered::RegisteredJournalPlansV1>,
) -> Result<()> {
    let scratch = Scratch::new()?;
    for (index, (entry, file)) in candidate.databases.iter().enumerate() {
        let name = format!("replay-{index}.sqlite");
        scratch.directory.write_new(&name, file.bytes())?;
        let replay_path = scratch.directory.path.join(&name);
        let mut replay = Connection::open_with_flags(
            &replay_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        equivalence::limit_private_sqlite(&replay)?;
        replay.pragma_update(None, "trusted_schema", false)?;
        if require_heartbeat_schema && entry["role"] == "resident-instance" {
            let columns=replay.prepare("SELECT name FROM pragma_table_xinfo('autonomous_research_supervisor_instance') ORDER BY cid")?.query_map([],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            ensure(
                columns == transition::COLUMNS,
                "autonomous_research_state_heartbeat_schema_unsupported",
            )?;
        }
        if let Some(plans) = registered {
            plans.assert_database_surface(&replay, entry, range.chain())?;
        }
        let restored =
            replay_verified_database_v1(&mut replay, entry, range.chain(), &service.online)?;
        let restored_digest = equivalence::effective_digest(&replay)?;
        inventory
            .with_database_snapshot(text(entry, "instanceId")?, |private| {
                let live = Connection::open_with_flags(
                    private,
                    OpenFlags::SQLITE_OPEN_READ_ONLY
                        | OpenFlags::SQLITE_OPEN_NOFOLLOW
                        | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )?;
                equivalence::limit_private_sqlite(&live)?;
                let head = checked_snapshot_head_v1(&live, entry, &service.online)?;
                ensure(
                    canonical_equal(head.value(), restored.value())?,
                    "autonomous_research_state_heartbeat_local_signed_head_mismatch",
                )?;
                ensure(
                    equivalence::effective_digest(&live)? == restored_digest,
                    "autonomous_research_state_heartbeat_effective_state_mismatch",
                )
            })
            .map_err(|e| error(e.to_string()))?;
        drop(replay);
        scratch.directory.assert_current()?;
    }
    candidate.assert_current()?;
    inventory
        .assert_current()
        .map_err(|e| error(e.to_string()))?;
    Ok(())
}

/// Every controller source based on historical replay must prove that the
/// actual current rows are the exact replay result. A signed historical head
/// plus current schema/scope alone does not authenticate unrecorded live data.
pub(super) fn verify_journal_source_current_state<
    B: StateBackupAuthorityTransportV1,
    O: MutationAuthorityTransportV1,
>(
    service: &BackupRecoveryServiceV1<B, O>,
    path: &Path,
    inventory: &ObservedStateDatabaseInventoryV1,
    restore: &Value,
    now: i64,
) -> Result<Option<VerifiedCurrentReplayV1>> {
    if restore["completeFinalizedMutationJournal"] != true {
        return Ok(None);
    }
    let candidate = HistoricalBackupCandidateV1::load(service, path, inventory, now, i64::MAX)?;
    let performed = timestamp(&restore["performedAt"]).ok_or_else(invalid)?;
    let receipt = service.backup.verify_journal_range(
        &restore["authorityJournalRangeReceipt"],
        &restore["authorityJournalRangeRequest"],
        performed,
    )?;
    let range = service.backup.verify_finalized_journal_chain(&receipt)?;
    let registered = registered::RegisteredJournalPlansV1::authenticate(
        &service.options.writer_manifest,
        inventory,
        range.chain(),
    )?;
    compare_effective_state(
        service,
        &candidate,
        inventory,
        &range,
        false,
        registered.as_ref(),
    )?;
    Ok(Some(VerifiedCurrentReplayV1::checked(inventory, restore)?))
}
