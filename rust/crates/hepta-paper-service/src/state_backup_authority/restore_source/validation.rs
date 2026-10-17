use super::*;
pub(super) fn validate_restore<T: StateBackupAuthorityTransportV1>(
    authority: &PinnedStateBackupAuthorityV1<T>,
    bundle: &Value,
    r: &Value,
    bundle_path: &Path,
) -> Result<()> {
    let expected = [
        "version",
        "kind",
        "status",
        "bundlePath",
        "bundleManifestHash",
        "snapshotContentHash",
        "authorityCurrentHeadRequest",
        "authorityCurrentHeadReceipt",
        "authorityCurrentHeadReceiptHash",
        "authorityJournalRangeRequest",
        "authorityJournalRangeReceipt",
        "authorityJournalRangeReceiptHash",
        "journalReplayMutationCount",
        "recoveredDatabaseHeads",
        "recoverabilityProtocol",
        "completeFinalizedMutationJournal",
        "recoverabilityBindingHash",
        "databaseCount",
        "productionStateMutated",
        "performedAt",
        "blockers",
        "restoreDrillReceiptHash",
    ];
    ensure(
        keys(r, &expected)
            && number(&r["version"]) == Some(1)
            && r["kind"] == "AutonomousResearchStateRestoreDrillReceipt"
            && r["status"] == "autonomous_research_state_restore_drill_passed"
            && r["bundlePath"]
                .as_str()
                .is_some_and(|v| Path::new(v) == bundle_path)
            && r["bundleManifestHash"] == bundle["bundleManifestHash"]
            && r["snapshotContentHash"] == bundle["snapshotContentHash"]
            && number(&r["databaseCount"])
                == bundle["content"]["databases"]
                    .as_array()
                    .map(|a| a.len() as i64)
            && r["productionStateMutated"] == false
            && sha(&r["recoverabilityBindingHash"])
            && r["recoveredDatabaseHeads"].is_array()
            && number(&r["journalReplayMutationCount"]).is_some_and(|v| v >= 0)
            && r["blockers"].as_array().is_some_and(Vec::is_empty),
        "autonomous_research_state_backup_restore_drill_receipt_invalid",
    )?;
    ensure(
        r["restoreDrillReceiptHash"]
            == hash(
                "AutonomousResearchStateRestoreDrillReceipt",
                &without(r, "restoreDrillReceiptHash")?,
            )?,
        "autonomous_research_state_backup_restore_drill_receipt_hash_invalid",
    )?;
    let request = &r["authorityCurrentHeadRequest"];
    let current = &r["authorityCurrentHeadReceipt"];
    ensure(
        keys(
            request,
            &[
                "version",
                "kind",
                "reservationId",
                "databaseScopeHash",
                "snapshotContentHash",
                "requestedAt",
                "maximumLeaseMs",
            ],
        ) && number(&request["version"]) == Some(1)
            && request["kind"] == "AutonomousResearchStateBackupAuthorityCurrentHeadRequest"
            && request["reservationId"] == bundle["authorityReservation"]["reservationId"]
            && request["databaseScopeHash"] == bundle["content"]["databaseScopeHash"]
            && request["snapshotContentHash"] == bundle["snapshotContentHash"]
            && number(&request["maximumLeaseMs"]).is_some_and(|v| v >= 1000)
            && instant(&request["requestedAt"]).is_some(),
        "autonomous_research_state_backup_restore_authority_request_invalid",
    )?;
    let performed = instant(&r["performedAt"]).ok_or_else(|| {
        error("autonomous_research_state_backup_restore_authority_time_binding_invalid")
    })?;
    let reservation=authority.verify_reservation(&bundle["authorityReservation"],&bundle["authorityReserveRequest"],instant(&bundle["authorityReservation"]["issuedAt"]).ok_or_else(||error("autonomous_research_state_backup_restore_authority_reservation_signature_invalid"))?).map_err(|_|error("autonomous_research_state_backup_restore_authority_reservation_signature_invalid"))?;
    authority.verify_finalization(&bundle["authorityFinalization"],&bundle["authorityFinalizeRequest"],&reservation,instant(&bundle["authorityFinalization"]["finalizedAt"]).ok_or_else(||error("autonomous_research_state_backup_restore_authority_finalization_signature_invalid"))?).map_err(|_|error("autonomous_research_state_backup_restore_authority_finalization_signature_invalid"))?;
    authority
        .verify_current_head(current, request, performed)
        .map_err(|_| {
            error(
                "autonomous_research_state_backup_restore_authority_current_head_signature_invalid",
            )
        })?;
    ensure(
        current["authorityId"] == bundle["authorityFinalization"]["authorityId"]
            && current["keyId"] == bundle["authorityFinalization"]["keyId"],
        "autonomous_research_state_backup_restore_authority_scope_binding_invalid",
    )?;
    ensure(
        r["authorityCurrentHeadReceiptHash"] == state_backup_authority_receipt_hash_v1(current)?,
        "autonomous_research_state_backup_restore_authority_receipt_hash_invalid",
    )?;
    let binding = json!({"bundleManifestHash":r["bundleManifestHash"],"snapshotContentHash":r["snapshotContentHash"],"currentHeadReceiptHash":r["authorityCurrentHeadReceiptHash"],"journalRangeReceiptHash":r["authorityJournalRangeReceiptHash"],"journalReplayMutationCount":r["journalReplayMutationCount"],"recoveredDatabaseHeads":r["recoveredDatabaseHeads"],"recoverabilityProtocol":r["recoverabilityProtocol"],"completeFinalizedMutationJournal":r["completeFinalizedMutationJournal"]});
    ensure(
        r["recoverabilityBindingHash"]
            == hash(
                "AutonomousResearchStateRestoreRecoverabilityBinding",
                &binding,
            )?,
        "autonomous_research_state_backup_restore_recoverability_binding_invalid",
    )?;
    let unchanged = equal(
        &current["headSequence"],
        &bundle["authorityFinalization"]["headSequence"],
    ) && current["headHash"] == bundle["authorityFinalization"]["headHash"];
    if unchanged {
        ensure(
            [
                "authorityJournalRangeRequest",
                "authorityJournalRangeReceipt",
                "authorityJournalRangeReceiptHash",
            ]
            .iter()
            .all(|k| r[k].is_null())
                && number(&r["journalReplayMutationCount"]) == Some(0)
                && r["recoveredDatabaseHeads"]
                    .as_array()
                    .is_some_and(Vec::is_empty)
                && r["recoverabilityProtocol"] == "snapshot-current-head-exact-v1"
                && r["completeFinalizedMutationJournal"] == false,
            "autonomous_research_state_backup_restore_snapshot_protocol_invalid",
        )?;
    } else {
        let range = &r["authorityJournalRangeReceipt"];
        ensure(
            range["reservationId"] == bundle["authorityReservation"]["reservationId"]
                && range["databaseScopeHash"] == bundle["content"]["databaseScopeHash"]
                && range["snapshotContentHash"] == bundle["snapshotContentHash"],
            "autonomous_research_state_backup_restore_journal_binding_invalid",
        )?;
        ensure(
            number(&current["headSequence"])
                >= number(&bundle["authorityFinalization"]["headSequence"])
                && r["recoverabilityProtocol"] == FINALIZED_JOURNAL_PROTOCOL
                && r["completeFinalizedMutationJournal"] == true
                && number(&r["journalReplayMutationCount"])
                    == range["entries"].as_array().map(|a| a.len() as i64)
                && r["authorityJournalRangeReceiptHash"]
                    == state_backup_authority_receipt_hash_v1(range)?
                && equal(&range["toGlobalSequence"], &current["headSequence"])
                && range["toGlobalHash"] == current["headHash"]
                && equal(
                    &range["fromGlobalSequence"],
                    &bundle["authorityFinalization"]["headSequence"],
                )
                && range["fromGlobalHash"] == bundle["authorityFinalization"]["headHash"]
                && r["recoveredDatabaseHeads"] == range["databaseHeads"],
            "autonomous_research_state_backup_restore_journal_binding_invalid",
        )?;
        let verified = authority
            .verify_journal_range(range, &r["authorityJournalRangeRequest"], performed)
            .map_err(|_| {
                error("autonomous_research_state_backup_restore_journal_signature_invalid")
            })?;
        authority.verify_finalized_journal_chain(&verified)?;
    }
    Ok(())
}
pub(super) fn bind_inventory(bundle: &Value, restore: &Value, inventory: &Value) -> Result<()> {
    let invalid = "autonomous_research_state_backup_restore_inventory_binding_invalid";
    let expected = [
        "version",
        "kind",
        "status",
        "manifestId",
        "manifestHash",
        "databaseScopeHash",
        "instances",
        "blockers",
        "inventoryHash",
    ];
    ensure(
        keys(inventory, &expected)
            && number(&inventory["version"]) == Some(1)
            && inventory["kind"] == "AutonomousResearchStateDatabaseInventory"
            && inventory["status"] == "autonomous_research_state_database_inventory_ready"
            && inventory["manifestId"] == "hepta-paper-autonomous-research-state-databases-v1"
            && inventory["blockers"].as_array().is_some_and(Vec::is_empty),
        invalid,
    )?;
    let instances = inventory["instances"]
        .as_array()
        .ok_or_else(|| error(invalid))?;
    let roles = instances
        .iter()
        .filter_map(|v| v["role"].as_str())
        .collect::<BTreeSet<_>>();
    ensure(
        roles
            == crate::sqlite_mutation_coordinator::DATABASE_ROLES
                .iter()
                .copied()
                .collect(),
        invalid,
    )?;
    let mut ids = strings(&inventory["instances"], "instanceId")?;
    ids.sort();
    let mut source_ids = strings(&bundle["content"]["databases"], "instanceId")?;
    source_ids.sort();
    ensure(
        ids == source_ids
            && ids.iter().collect::<BTreeSet<_>>().len() == ids.len()
            && inventory["databaseScopeHash"]
                == manifest::state_database_scope_hash_v1(&inventory["instances"])?
            && ["manifestId", "manifestHash", "databaseScopeHash"]
                .iter()
                .all(|k| inventory[k] == bundle["content"][k]),
        invalid,
    )?;
    let payload = json!({"manifestId":inventory["manifestId"],"manifestHash":inventory["manifestHash"],"databaseScopeHash":inventory["databaseScopeHash"],"instances":inventory["instances"]});
    ensure(
        inventory["inventoryHash"] == hash("AutonomousResearchStateDatabaseInventory", &payload)?,
        invalid,
    )?;
    if restore["completeFinalizedMutationJournal"] == true {
        let mut bindings=instances.iter().map(|v|json!({"databaseRole":v["role"],"databaseInstanceId":v["instanceId"],"schemaHash":v["schemaHash"]})).collect::<Vec<_>>();
        let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
            .map_err(|e| error(e.to_string()))?;
        bindings.sort_by(|a, b| {
            collator.compare(
                a["databaseInstanceId"].as_str().unwrap_or_default(),
                b["databaseInstanceId"].as_str().unwrap_or_default(),
            )
        });
        let recovered=restore["recoveredDatabaseHeads"].as_array().ok_or_else(||error(invalid))?.iter().map(|v|json!({"databaseRole":v["databaseRole"],"databaseInstanceId":v["databaseInstanceId"],"schemaHash":v["schemaHash"]})).collect::<Vec<_>>();
        ensure(bindings == recovered, invalid)?;
    } else {
        ensure(
            inventory["inventoryHash"] == bundle["content"]["inventoryHash"],
            invalid,
        )?;
    }
    Ok(())
}
