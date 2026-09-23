use super::*;
fn common<T: StateBackupAuthorityTransportV1>(
    verifier: &PinnedStateBackupAuthorityV1<T>,
    receipt: &Value,
    kind: &str,
    expected: &[&str],
) -> bool {
    keys(receipt, expected)
        && number(&receipt["version"]) == Some(1)
        && receipt["kind"] == kind
        && receipt["authorityId"] == verifier.trust["authorityId"]
        && receipt["keyId"] == verifier.trust["keyId"]
        && safe_id(&receipt["reservationId"])
        && sha(&receipt["requestHash"])
        && sha(&receipt["databaseScopeHash"])
        && number(&receipt["headSequence"]).is_some_and(|v| v >= 0)
        && sha(&receipt["headHash"])
        && verifier.signature(receipt)
}
fn timing<T: StateBackupAuthorityTransportV1>(
    verifier: &PinnedStateBackupAuthorityV1<T>,
    receipt: &Value,
    field: &str,
    now: i64,
    fresh: bool,
) -> bool {
    let (Some(issued), Some(expires), Some(maximum), Some(age)) = (
        instant(&receipt[field]),
        instant(&receipt["expiresAt"]),
        number(&verifier.trust["maximumReservationLeaseMs"]),
        number(&verifier.trust["maximumHeadObservationAgeMs"]),
    ) else {
        return false;
    };
    issued <= now.saturating_add(5000)
        && expires > issued
        && expires > now
        && expires.saturating_sub(issued) <= maximum
        && (!fresh || now.saturating_sub(issued) <= age)
}
pub(super) fn reservation<T: StateBackupAuthorityTransportV1>(
    v: &PinnedStateBackupAuthorityV1<T>,
    r: &Value,
    q: &Value,
    now: i64,
) -> Result<bool> {
    let expected = [
        "version",
        "kind",
        "status",
        "authorityId",
        "keyId",
        "requestHash",
        "reservationId",
        "inventoryHash",
        "databaseScopeHash",
        "databaseInstanceIds",
        "headSequence",
        "headHash",
        "issuedAt",
        "expiresAt",
        "mutationFenceProtocol",
        "allRegisteredMutationsFenced",
        "signature",
    ];
    let Some(ids) = q["databaseInstanceIds"].as_array() else {
        return Ok(false);
    };
    let Some(mut ids) = ids.iter().map(Value::as_str).collect::<Option<Vec<_>>>() else {
        return Ok(false);
    };
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    // Actual producers use safe string instance identifiers. Ambiguous JS join
    // coercions (null/object/nested arrays or embedded NULs) are not authority.
    let valid_ids = ids.iter().all(|v| safe_id(&json!(v)))
        && r["databaseInstanceIds"]
            .as_array()
            .is_some_and(|a| a.iter().all(safe_id));
    Ok(common(
        v,
        r,
        "AutonomousResearchStateBackupAuthorityReservation",
        &expected,
    ) && r["status"] == "autonomous_research_state_backup_authority_reserved"
        && r["requestHash"] == hash("AutonomousResearchStateBackupAuthorityReserveRequest", q)?
        && equal(&r["inventoryHash"], &q["inventoryHash"])
        && r["databaseScopeHash"] == q["databaseScopeHash"]
        && valid_ids
        && r["databaseInstanceIds"] == json!(ids)
        && r["mutationFenceProtocol"] == "external-linearizable-reserve-apply-finalize-v1"
        && r["allRegisteredMutationsFenced"] == true
        && timing(v, r, "issuedAt", now, false))
}
pub(super) fn finalization<T: StateBackupAuthorityTransportV1>(
    v: &PinnedStateBackupAuthorityV1<T>,
    r: &Value,
    q: &Value,
    reservation: &Value,
    now: i64,
) -> Result<bool> {
    let expected = [
        "version",
        "kind",
        "status",
        "authorityId",
        "keyId",
        "requestHash",
        "reservationId",
        "inventoryHash",
        "databaseScopeHash",
        "snapshotContentHash",
        "headSequence",
        "headHash",
        "finalizedAt",
        "allRegisteredMutationsFencedThroughFinalize",
        "signature",
    ];
    let (Some(finalized), Some(issued), Some(expires)) = (
        instant(&r["finalizedAt"]),
        instant(&reservation["issuedAt"]),
        instant(&reservation["expiresAt"]),
    ) else {
        return Ok(false);
    };
    Ok(common(
        v,
        r,
        "AutonomousResearchStateBackupAuthorityFinalization",
        &expected,
    ) && r["status"] == "autonomous_research_state_backup_authority_finalized"
        && r["requestHash"] == hash("AutonomousResearchStateBackupAuthorityFinalizeRequest", q)?
        && ["reservationId", "inventoryHash", "databaseScopeHash"]
            .iter()
            .all(|k| equal(&q[k], &reservation[k]) && equal(&r[k], &reservation[k]))
        && r["snapshotContentHash"] == q["snapshotContentHash"]
        && equal(&r["headSequence"], &reservation["headSequence"])
        && r["headHash"] == reservation["headHash"]
        && r["allRegisteredMutationsFencedThroughFinalize"] == true
        && finalized >= issued
        && finalized <= now.saturating_add(5000)
        && finalized <= expires)
}
pub(super) fn current_head<T: StateBackupAuthorityTransportV1>(
    v: &PinnedStateBackupAuthorityV1<T>,
    r: &Value,
    q: &Value,
    now: i64,
) -> Result<bool> {
    let expected = [
        "version",
        "kind",
        "status",
        "authorityId",
        "keyId",
        "requestHash",
        "reservationId",
        "databaseScopeHash",
        "headSequence",
        "headHash",
        "observedAt",
        "expiresAt",
        "mutationFenceProtocol",
        "allRegisteredMutationsFenced",
        "signature",
    ];
    Ok(common(
        v,
        r,
        "AutonomousResearchStateBackupAuthorityCurrentHead",
        &expected,
    ) && r["status"] == "autonomous_research_state_backup_authority_head_observed"
        && r["requestHash"]
            == hash(
                "AutonomousResearchStateBackupAuthorityCurrentHeadRequest",
                q,
            )?
        && r["reservationId"] == q["reservationId"]
        && r["databaseScopeHash"] == q["databaseScopeHash"]
        && r["mutationFenceProtocol"] == "external-linearizable-restore-validation-v1"
        && r["allRegisteredMutationsFenced"] == true
        && timing(v, r, "observedAt", now, true))
}
fn heads_valid(heads: &Value) -> bool {
    let Some(heads) = heads.as_array().filter(|v| !v.is_empty()) else {
        return false;
    };
    heads.iter().all(|head| {
        keys(
            head,
            &[
                "databaseRole",
                "databaseInstanceId",
                "sequence",
                "hash",
                "schemaHash",
                "stateHash",
            ],
        ) && safe_id(&head["databaseRole"])
            && safe_id(&head["databaseInstanceId"])
            && number(&head["sequence"]).is_some_and(|v| v >= 0)
            && ["hash", "schemaHash", "stateHash"]
                .iter()
                .all(|k| sha(&head[k]))
    }) && heads
        .windows(2)
        .all(|pair| pair[0]["databaseInstanceId"].as_str() < pair[1]["databaseInstanceId"].as_str())
}
pub(super) fn journal_range<T: StateBackupAuthorityTransportV1>(
    v: &PinnedStateBackupAuthorityV1<T>,
    r: &Value,
    q: &Value,
    now: i64,
) -> Result<bool> {
    let request_keys = [
        "version",
        "kind",
        "reservationId",
        "databaseScopeHash",
        "snapshotContentHash",
        "onlineAuthorityId",
        "onlineKeyId",
        "scopeId",
        "writerManifestHash",
        "fromGlobalSequence",
        "fromGlobalHash",
        "toGlobalSequence",
        "toGlobalHash",
        "requestedAt",
        "maximumLeaseMs",
        "maximumEntries",
    ];
    let receipt_keys = [
        "version",
        "kind",
        "status",
        "authorityId",
        "keyId",
        "requestHash",
        "reservationId",
        "databaseScopeHash",
        "snapshotContentHash",
        "onlineAuthorityId",
        "onlineKeyId",
        "scopeId",
        "writerManifestHash",
        "fromGlobalSequence",
        "fromGlobalHash",
        "toGlobalSequence",
        "toGlobalHash",
        "databaseHeads",
        "entries",
        "observedAt",
        "expiresAt",
        "mutationFenceProtocol",
        "completeFinalizedMutationJournal",
        "signature",
    ];
    let (Some(from), Some(to), Some(lease), Some(maximum), Some(bound)) = (
        number(&q["fromGlobalSequence"]),
        number(&q["toGlobalSequence"]),
        number(&q["maximumLeaseMs"]),
        number(&q["maximumEntries"]),
        number(&v.trust["maximumReservationLeaseMs"]),
    ) else {
        return Ok(false);
    };
    Ok(keys(q, &request_keys)
        && number(&q["version"]) == Some(1)
        && q["kind"] == "AutonomousResearchStateBackupAuthorityJournalRangeRequest"
        && [
            "reservationId",
            "onlineAuthorityId",
            "onlineKeyId",
            "scopeId",
        ]
        .iter()
        .all(|k| safe_id(&q[k]))
        && [
            "databaseScopeHash",
            "snapshotContentHash",
            "writerManifestHash",
            "fromGlobalHash",
            "toGlobalHash",
        ]
        .iter()
        .all(|k| sha(&q[k]))
        && from >= 0
        && to > from
        && instant(&q["requestedAt"]).is_some()
        && lease >= 1000
        && lease <= bound
        && maximum >= to - from
        && maximum <= MAXIMUM_JOURNAL_ENTRIES
        && keys(r, &receipt_keys)
        && number(&r["version"]) == Some(1)
        && r["kind"] == "AutonomousResearchStateBackupAuthorityJournalRange"
        && r["status"] == "autonomous_research_state_backup_authority_journal_range_complete"
        && r["authorityId"] == v.trust["authorityId"]
        && r["keyId"] == v.trust["keyId"]
        && r["requestHash"]
            == hash(
                "AutonomousResearchStateBackupAuthorityJournalRangeRequest",
                q,
            )?
        && [
            "reservationId",
            "databaseScopeHash",
            "snapshotContentHash",
            "onlineAuthorityId",
            "onlineKeyId",
            "scopeId",
            "writerManifestHash",
            "fromGlobalSequence",
            "fromGlobalHash",
            "toGlobalSequence",
            "toGlobalHash",
        ]
        .iter()
        .all(|k| equal(&r[k], &q[k]))
        && heads_valid(&r["databaseHeads"])
        && r["entries"]
            .as_array()
            .is_some_and(|a| a.len() as i64 == to - from && a.len() as i64 <= maximum)
        && r["mutationFenceProtocol"] == FINALIZED_JOURNAL_PROTOCOL
        && r["completeFinalizedMutationJournal"] == true
        && timing(v, r, "observedAt", now, true)
        && v.signature(r))
}
