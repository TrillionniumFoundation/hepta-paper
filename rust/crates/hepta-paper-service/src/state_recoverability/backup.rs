//! Real SQLite backups under a pinned external snapshot reservation.
use super::*;
use super::{publication::Directory, service::BackupRecoveryServiceV1};
use crate::sqlite_mutation_coordinator::{
    authority::MutationAuthorityTransportV1, backup_replay::checked_snapshot_head_v1,
};
use crate::state_backup_authority::{
    StateBackupAuthorityTransportV1, state_backup_authority_receipt_hash_v1,
};
use rusqlite::{Connection, OpenFlags};
pub(super) fn create<B: StateBackupAuthorityTransportV1, O: MutationAuthorityTransportV1>(
    service: &mut BackupRecoveryServiceV1<B, O>,
    clock: &mut dyn MutationClockV1,
) -> Result<Value> {
    let inventory = service.inventory()?;
    let initial = inventory.value();
    let mut ids = initial["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_state_backup_inventory_invalid"))?
        .iter()
        .map(|v| text(v, "instanceId").map(str::to_owned))
        .collect::<Result<Vec<_>>>()?;
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let before = clock_now(clock)?;
    let request = json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityReserveRequest","inventoryHash":initial["inventoryHash"],"databaseScopeHash":initial["databaseScopeHash"],"databaseInstanceIds":ids,"requestedAt":before.1,"maximumLeaseMs":service.backup.trust()["maximumReservationLeaseMs"]});
    let candidate = service.backup.reserve_snapshot(&request, before.0)?;
    let reservation =
        service
            .backup
            .verify_reservation(candidate.value(), &request, clock_now(clock)?.0)?;
    let mut global: Option<Value> = None;
    for instance in initial["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_state_backup_inventory_invalid"))?
    {
        let head = inventory
            .with_database_snapshot(text(instance, "instanceId")?, |path| {
                let db = Connection::open_with_flags(
                    path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY
                        | OpenFlags::SQLITE_OPEN_NOFOLLOW
                        | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )
                .map_err(|e| error(e.to_string()))?;
                checked_snapshot_head_v1(&db, instance, &service.online)
            })
            .map_err(|e| error(e.to_string()))?;
        let h = head.value();
        if let Some(current) = &global {
            let seq = int(h, "globalSequence")?;
            let previous = int(current, "globalSequence")?;
            if seq > previous {
                global = Some(h.clone());
            } else if seq == previous {
                ensure(
                    h["globalHash"] == current["globalHash"],
                    "autonomous_research_state_backup_local_global_head_conflict",
                )?;
            }
        } else {
            global = Some(h.clone());
        }
    }
    let global = global
        .ok_or_else(|| error("autonomous_research_state_backup_local_authority_head_mismatch"))?;
    ensure(
        int(&global, "globalSequence")? == int(reservation.value(), "headSequence")?
            && global["globalHash"] == reservation.value()["headHash"],
        "autonomous_research_state_backup_local_authority_head_mismatch",
    )?;
    let observed = service.inventory()?;
    ensure(
        observed.value()["inventoryHash"] == initial["inventoryHash"],
        "autonomous_research_state_backup_inventory_changed_after_reservation",
    )?;
    inventory
        .assert_current()
        .map_err(|e| error(e.to_string()))?;
    let root = Directory::open_or_create(&service.options.backup_root, true)?;
    let stage = root.child(&format!(".pending-{}", super::publication::nonce()?))?;
    let database_directory = stage.child("databases")?;
    let mut finalized = false;
    let result = (|| {
        let mut databases = Vec::new();
        for (index, instance) in initial["instances"]
            .as_array()
            .ok_or_else(|| error("autonomous_research_state_backup_inventory_invalid"))?
            .iter()
            .enumerate()
        {
            let digest = hash_bytes(text(instance, "instanceId")?.as_bytes());
            let name = format!(
                "{:03}-{}-{}.sqlite",
                index + 1,
                text(instance, "role")?,
                &digest[7..23]
            );
            let copy = inventory
                .with_database_snapshot(text(instance, "instanceId")?, |path| {
                    super::sqlite_copy::copy(path, &database_directory, &name, false)
                })
                .map_err(|e| error(e.to_string()))?;
            ensure(
                copy["schemaHash"] == instance["schemaHash"],
                "autonomous_research_state_backup_copy_invalid",
            )?;
            let mut entry = json!({"instanceId":instance["instanceId"],"role":instance["role"],"paperId":instance["paperId"],"sourceRelativePath":instance["sourceRelativePath"],"backupRelativePath":format!("databases/{name}"),"schemaContractId":instance["schemaContractId"]});
            for (key, value) in copy
                .as_object()
                .ok_or_else(|| error("autonomous_research_state_backup_copy_invalid"))?
            {
                entry[key] = value.clone();
            }
            databases.push(entry);
        }
        database_directory
            .held
            .sync_all()
            .map_err(|_| error("autonomous_research_state_backup_fsync_failed"))?;
        let post = service.inventory()?;
        ensure(
            post.value()["inventoryHash"] == initial["inventoryHash"],
            "autonomous_research_state_backup_source_changed_during_copy",
        )?;
        inventory
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        let created = clock_now(clock)?;
        let content = json!({"version":1,"kind":"AutonomousResearchStateBackupContent","manifestId":initial["manifestId"],"manifestHash":initial["manifestHash"],"inventoryHash":initial["inventoryHash"],"databaseScopeHash":initial["databaseScopeHash"],"authorityReservationHash":state_backup_authority_receipt_hash_v1(reservation.value())?,"authorityHead":{"sequence":reservation.value()["headSequence"],"hash":reservation.value()["headHash"]},"createdAt":created.1,"databases":databases});
        let snapshot_hash = hash("AutonomousResearchStateBackupContent", &content)?;
        let final_request = json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityFinalizeRequest","reservationId":reservation.value()["reservationId"],"inventoryHash":reservation.value()["inventoryHash"],"databaseScopeHash":reservation.value()["databaseScopeHash"],"snapshotContentHash":snapshot_hash,"requestedAt":created.1});
        let mut pending = json!({"version":1,"kind":"AutonomousResearchStatePendingBackup","content":content,"snapshotContentHash":snapshot_hash,"authorityReserveRequest":request,"authorityReservation":reservation.value(),"authorityFinalizeRequest":final_request,"backupConfigurationHash":service.backup.configuration_hash(),"onlineConfigurationHash":service.online.configuration_hash()});
        pending["pendingBackupHash"] =
            hash("AutonomousResearchStatePendingBackup", &pending)?.into();
        stage.write_new(
            "PENDING_BACKUP.json",
            &serde_json::to_vec(&pending).map_err(|e| error(e.to_string()))?,
        )?;
        // Once dispatch occurs, a transport error may hide a successful remote
        // finalization. Preserve staged bytes for recovery even without a reply.
        finalized = true;
        let final_receipt =
            service
                .backup
                .finalize_snapshot(&final_request, &reservation, created.0)?;
        service.backup.verify_finalization(
            final_receipt.value(),
            &final_request,
            &reservation,
            clock_now(clock)?.0,
        )?;
        let mut bundle = json!({"version":1,"kind":"AutonomousResearchStateBackupBundleManifest","status":"autonomous_research_state_backup_recorded","snapshotContentHash":snapshot_hash,"content":content,"authorityReserveRequest":request,"authorityReservation":reservation.value(),"authorityFinalizeRequest":final_request,"authorityFinalization":final_receipt.value(),"productionStateMutated":false});
        bundle["bundleManifestHash"] =
            hash("AutonomousResearchStateBackupBundleManifest", &bundle)?.into();
        stage.write_new(
            "AUTONOMOUS_RESEARCH_STATE_BACKUP.json",
            &serde_json::to_vec(&bundle).map_err(|e| error(e.to_string()))?,
        )?;
        inventory
            .assert_current()
            .map_err(|e| error(e.to_string()))?;
        let path = root.publish_new(&stage, &snapshot_hash[7..])?;
        Ok(
            json!({"version":1,"kind":"AutonomousResearchStateBackupReceipt","status":"autonomous_research_state_backup_recorded","bundlePath":path,"bundleManifestHash":bundle["bundleManifestHash"],"snapshotContentHash":snapshot_hash,"inventoryHash":initial["inventoryHash"],"databaseCount":databases.len(),"authorityId":reservation.value()["authorityId"],"authorityHeadSequence":reservation.value()["headSequence"],"authorityHeadHash":reservation.value()["headHash"],"blockers":[]}),
        )
    })();
    result.map_err(
        |mut e: crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError| {
            e.details["recoverableStagingPath"] = json!(stage.path);
            e.details["authorityFinalizationMayHaveSucceeded"] = json!(finalized);
            e
        },
    )
}
