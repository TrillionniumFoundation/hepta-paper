//! Fresh, signed external-head comparison against the complete local finalized
//! journal. This read-only evidence is not a ten-database activation capability.
mod storage;
use crate::sqlite_mutation_coordinator::{
    ONLINE_MUTATION_PROTOCOL, Result,
    authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
    clock::{MutationClockV1, iso},
    contracts, error, hash, int, integer, keys, manifest, role, safe, sha,
    storage::exact_schema_hash_v1,
    timestamp,
};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{Value, json};
pub const REMAINING_BLOCKERS: &[&str] = &[
    "autonomous_research_online_mutation_fresh_active_challenge_required",
    "autonomous_research_online_mutation_ten_database_activation_required",
];
/// Constructed only after a real pinned authority observation and verification
/// of every local reservation/finalization. No Deserialize or public constructor.
pub struct VerifiedFinalizedHeadInspectionV1 {
    receipt: Value,
    current_head: Value,
    authority_configuration_hash: String,
}
impl VerifiedFinalizedHeadInspectionV1 {
    pub fn value(&self) -> &Value {
        &self.receipt
    }
    pub fn current_head(&self) -> &Value {
        &self.current_head
    }
    pub fn authority_configuration_hash(&self) -> &str {
        &self.authority_configuration_hash
    }
}
fn ensure(valid: bool, code: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(error(code)) }
}
fn code(suffix: &str) -> String {
    format!("autonomous_research_online_finalized_head_{suffix}")
}
fn checked(valid: bool, suffix: &str) -> Result<()> {
    ensure(valid, &code(suffix))
}
fn observe(clock: &mut dyn MutationClockV1) -> Result<(i64, String)> {
    let millis = clock
        .now_millis()
        .map_err(|_| error(code("clock_invalid")))?;
    let instant = iso(millis).map_err(|_| error(code("clock_invalid")))?;
    Ok((millis, instant))
}
fn equal(a: &Value, b: &Value) -> bool {
    a == b || (a.is_number() && b.is_number() && a.as_f64() == b.as_f64())
}
pub fn finalized_head_inspection_receipt_hash_v1(receipt: &Value) -> Result<String> {
    let mut payload = receipt
        .as_object()
        .cloned()
        .ok_or_else(|| error(code("inspection_receipt_invalid")))?;
    payload.remove("inspectionReceiptHash");
    hash(
        "AutonomousResearchOnlineFinalizedHeadInspectionReceipt",
        &Value::Object(payload),
    )
}
/// Structural claim validation only. This function cannot create verified
/// evidence; callers cannot turn a self-hashed JSON claim into an active runtime.
pub fn assert_finalized_head_inspection_receipt_v1(r: &Value) -> Result<()> {
    checked(
        keys(
            r,
            &[
                "version",
                "kind",
                "status",
                "inventoryHash",
                "databaseScopeHash",
                "writerManifestHash",
                "databaseRole",
                "databaseInstanceId",
                "schemaContractId",
                "schemaHash",
                "currentHeadReceiptHash",
                "authorityGlobalSequence",
                "authorityGlobalHash",
                "localDatabaseSequence",
                "localDatabaseHash",
                "localStateHash",
                "markerCount",
                "finalizationCount",
                "genesisZeroHeadVerified",
                "markerChainHash",
                "inspectedAt",
                "remainingBlockers",
                "runtimeReady",
                "inspectionReceiptHash",
            ],
        ) && equal(&r["version"], &json!(1))
            && r["kind"] == "AutonomousResearchOnlineFinalizedHeadInspectionReceipt"
            && r["status"] == "autonomous_research_online_finalized_head_reconciled"
            && [
                "inventoryHash",
                "databaseScopeHash",
                "writerManifestHash",
                "schemaHash",
                "currentHeadReceiptHash",
                "authorityGlobalHash",
                "localDatabaseHash",
                "localStateHash",
                "markerChainHash",
                "inspectionReceiptHash",
            ]
            .iter()
            .all(|k| sha(&r[k]))
            && role(&r["databaseRole"])
            && safe(&r["databaseInstanceId"])
            && safe(&r["schemaContractId"])
            && [
                "authorityGlobalSequence",
                "localDatabaseSequence",
                "markerCount",
            ]
            .iter()
            .all(|k| integer(&r[k], 0))
            && equal(&r["finalizationCount"], &r["markerCount"])
            && r["genesisZeroHeadVerified"] == true
            && timestamp(&r["inspectedAt"]).is_some()
            && r["remainingBlockers"] == json!(REMAINING_BLOCKERS)
            && r["runtimeReady"] == false
            && r["inspectionReceiptHash"] == finalized_head_inspection_receipt_hash_v1(r)?,
        "inspection_receipt_invalid",
    )
}
fn inventory_binding(inventory: &Value, id: &str, trust: &Value) -> Result<(Value, Value)> {
    let fail = || error(code("inventory_invalid"));
    let instances = inventory["instances"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 256)
        .ok_or_else(fail)?;
    let mut payload = serde_json::Map::new();
    for k in [
        "manifestId",
        "manifestHash",
        "databaseScopeHash",
        "instances",
    ] {
        if let Some(v) = inventory.get(k) {
            payload.insert(k.into(), v.clone());
        }
    }
    checked(
        equal(&inventory["version"], &json!(1))
            && inventory["kind"] == "AutonomousResearchStateDatabaseInventory"
            && inventory["status"] == "autonomous_research_state_database_inventory_ready"
            && sha(&inventory["manifestHash"])
            && sha(&inventory["databaseScopeHash"])
            && inventory["inventoryHash"]
                == hash(
                    "AutonomousResearchStateDatabaseInventory",
                    &Value::Object(payload),
                )?
            && inventory["databaseScopeHash"] == trust["databaseScopeHash"]
            && inventory["blockers"].as_array().is_some_and(Vec::is_empty),
        "inventory_invalid",
    )?;
    let selected = instances
        .iter()
        .filter(|i| i["instanceId"] == id)
        .collect::<Vec<_>>();
    checked(selected.len() == 1, "inventory_invalid")?;
    let instance = selected.first().ok_or_else(fail)?;
    checked(
        instance["quickCheck"] == "ok"
            && equal(&instance["foreignKeyViolationCount"], &json!(0))
            && instance["missingSchemaObjects"]
                .as_array()
                .is_some_and(Vec::is_empty)
            && sha(&instance["schemaHash"]),
        "inventory_invalid",
    )?;
    let mut expected=instances.iter().map(|i|json!({"databaseRole":i["role"],"databaseInstanceId":i["instanceId"],"schemaHash":i["schemaHash"]})).collect::<Vec<_>>();
    checked(
        expected.iter().all(|v| v["databaseInstanceId"].is_string()),
        "inventory_invalid",
    )?;
    let collation = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    expected.sort_by(|a, b| {
        collation.compare(
            a["databaseInstanceId"].as_str().unwrap_or_default(),
            b["databaseInstanceId"].as_str().unwrap_or_default(),
        )
    });
    Ok(((*instance).clone(), json!(expected)))
}
fn metadata(db: &Connection, instance: &Value, trust: &Value, schema: &str) -> Result<Value> {
    let rows = storage::rows(
        db,
        "SELECT singleton,schema_version,protocol,database_role,database_instance_id,schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,genesis_global_sequence,genesis_global_hash,genesis_database_sequence,genesis_database_hash,genesis_state_hash,provisioned_at FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1;",
        2,
    )?;
    checked(rows.len() == 1, "metadata_required")?;
    let meta = rows
        .into_iter()
        .next()
        .ok_or_else(|| error(code("metadata_required")))?;
    checked(
        equal(&meta["singleton"], &json!(1))
            && equal(&meta["schema_version"], &json!(1))
            && meta["protocol"] == ONLINE_MUTATION_PROTOCOL
            && meta["database_role"] == instance["role"]
            && meta["database_instance_id"] == instance["instanceId"]
            && meta["schema_contract_id"] == instance["schemaContractId"]
            && meta["schema_hash"] == schema
            && instance["schemaHash"] == schema
            && meta["database_scope_hash"] == trust["databaseScopeHash"]
            && meta["writer_manifest_hash"] == trust["writerManifestHash"]
            && equal(&meta["genesis_global_sequence"], &json!(0))
            && equal(&meta["genesis_database_sequence"], &json!(0))
            && [
                "genesis_global_hash",
                "genesis_database_hash",
                "genesis_state_hash",
            ]
            .iter()
            .all(|k| sha(&meta[k]))
            && timestamp(&meta["provisioned_at"]).is_some(),
        "metadata_invalid",
    )?;
    Ok(meta)
}
fn marker_binding(
    row: &Value,
    reserve: &Value,
    reservation: &Value,
    finalize: &Value,
) -> Result<bool> {
    Ok([
        ("reservation_id", "reservationId"),
        ("database_role", "databaseRole"),
        ("database_instance_id", "databaseInstanceId"),
        ("writer_id", "writerId"),
        ("operation_id", "operationId"),
        ("global_sequence", "globalSequence"),
        ("global_hash", "globalHash"),
        ("database_sequence", "databaseSequence"),
        ("database_hash", "databaseHash"),
        ("schema_hash", "schemaHash"),
        ("pre_state_hash", "preStateHash"),
        ("post_state_hash", "postStateHash"),
        ("changeset_hash", "changesetHash"),
    ]
    .iter()
    .all(|(local, signed)| equal(&row[local], &reservation[signed]))
        && row["reserve_request_hash"]
            == hash("AutonomousResearchOnlineMutationReserveRequest", reserve)?
        && row["reservation_receipt_hash"]
            == contracts::online_mutation_receipt_hash_v1(reservation)?
        && row["local_marker_hash"] == finalize["localMarkerHash"])
}
fn manifest_binding(
    reserve: &Value,
    reservation: &Value,
    manifest: &Value,
    instance: &Value,
) -> Result<()> {
    let operation = manifest["operations"].as_array().and_then(|a| {
        a.iter()
            .find(|o| o["operationId"] == reservation["operationId"])
    });
    let writer = manifest["writers"].as_array().and_then(|a| {
        a.iter().find(|w| {
            w["writerId"] == reservation["writerId"]
                && w["operationIds"]
                    .as_array()
                    .is_some_and(|a| a.contains(&reservation["operationId"]))
        })
    });
    checked(
        operation.is_some_and(|o| {
            o["coordinatorIntegrated"] == true && o["databaseRole"] == instance["role"]
        }) && writer.is_some_and(|w| w["implementationHash"] == reservation["codeProvenanceHash"])
            && reserve["databaseRole"] == instance["role"]
            && reserve["databaseInstanceId"] == instance["instanceId"]
            && reserve["schemaContractId"] == instance["schemaContractId"],
        "manifest_binding_invalid",
    )
}
fn marker_chain<T: MutationAuthorityTransportV1>(
    db: &Connection,
    meta: &Value,
    schema: &str,
    instance: &Value,
    manifest: &Value,
    authority: &PinnedMutationAuthorityV1<T>,
    authority_head: &Value,
) -> Result<Value> {
    let rows = storage::rows(
        db,
        "SELECT marker.*,finalized.reservation_id AS finalization_reservation_id,finalized.finalization_receipt_hash,finalized.finalization_receipt_json,finalized.side_effect_permit_hash,finalized.finalized_at,finalized.recorded_at FROM autonomous_research_online_mutation_authority_marker marker LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized ON finalized.reservation_id=marker.reservation_id ORDER BY marker.database_sequence;",
        4096,
    )?;
    let finalization_count: i64 = db.query_row(
        "SELECT count(*) FROM autonomous_research_online_mutation_finalization_receipt;",
        [],
        |r| r.get(0),
    )?;
    checked(
        finalization_count == rows.len() as i64,
        "finalization_coverage_invalid",
    )?;
    let mut previous = json!({"sequence":0,"hash":meta["genesis_database_hash"],"stateHash":meta["genesis_state_hash"]});
    let mut previous_global = -1;
    let mut chain = Vec::new();
    for row in &rows {
        let reserve = storage::parse(&row["reserve_request_json"], "reserve_request_json_invalid")?;
        let reservation =
            storage::parse(&row["reservation_receipt_json"], "reservation_json_invalid")?;
        let verified = authority
            .verify_stored_reservation(&reservation, &reserve)
            .map_err(|_| error(code("reservation_invalid")))?;
        manifest_binding(&reserve, &reservation, manifest, instance)?;
        let finalize = contracts::build_finalize_request_v1(&reservation, &row["committed_at"])?;
        let global = int(&reservation, "globalSequence")?;
        checked(
            marker_binding(row, &reserve, &reservation, &finalize)?
                && reservation["schemaHash"] == schema
                && equal(
                    &reservation["databasePreviousSequence"],
                    &previous["sequence"],
                )
                && reservation["databasePreviousHash"] == previous["hash"]
                && reservation["preStateHash"] == previous["stateHash"]
                && int(&reservation, "databaseSequence")?
                    == int(&previous, "sequence")?
                        .checked_add(1)
                        .ok_or_else(|| error(code("marker_chain_invalid")))?
                && int(&reservation, "globalPreviousSequence")?.checked_add(1) == Some(global)
                && global > previous_global
                && global <= int(authority_head, "globalSequence")?,
            "marker_chain_invalid",
        )?;
        let finalization = storage::parse(
            &row["finalization_receipt_json"],
            "finalization_json_invalid",
        )?;
        let finalization_hash = contracts::online_mutation_receipt_hash_v1(&finalization)?;
        let recorded =
            timestamp(&row["recorded_at"]).ok_or_else(|| error(code("recorded_at_invalid")))?;
        let finalized = timestamp(&finalization["finalizedAt"])
            .ok_or_else(|| error(code("finalized_at_invalid")))?;
        checked(
            row["finalization_reservation_id"] == reservation["reservationId"]
                && row["finalization_receipt_hash"] == finalization_hash
                && row["side_effect_permit_hash"] == finalization["sideEffectPermitHash"]
                && row["finalized_at"] == finalization["finalizedAt"]
                && recorded >= finalized,
            "finalization_invalid",
        )?;
        authority
            .verify_stored_finalization(&finalization, &finalize, &verified)
            .map_err(|_| error(code("finalization_invalid")))?;
        chain.push(json!({"reservationId":reservation["reservationId"],"reservationReceiptHash":row["reservation_receipt_hash"],"finalizationReceiptHash":finalization_hash,"globalSequence":reservation["globalSequence"],"globalHash":reservation["globalHash"],"databaseSequence":reservation["databaseSequence"],"databaseHash":reservation["databaseHash"],"stateHash":reservation["postStateHash"]}));
        previous = json!({"sequence":reservation["databaseSequence"],"hash":reservation["databaseHash"],"stateHash":reservation["postStateHash"]});
        previous_global = global;
    }
    let chain_hash = hash(
        "AutonomousResearchOnlineFinalizedMarkerChain",
        &json!({"databaseRole":instance["role"],"databaseInstanceId":instance["instanceId"],"genesisGlobalSequence":0,"genesisGlobalHash":meta["genesis_global_hash"],"genesisDatabaseSequence":0,"genesisDatabaseHash":meta["genesis_database_hash"],"genesisStateHash":meta["genesis_state_hash"],"markers":chain}),
    )?;
    Ok(
        json!({"markerCount":rows.len(),"finalizationCount":finalization_count,"localHead":previous,"markerChainHash":chain_hash}),
    )
}
fn nonce() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| error(code("randomness_unavailable")))?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let s = hex::encode(bytes);
    Ok(format!(
        "head:{}-{}-{}-{}-{}",
        &s[..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..]
    ))
}
/// Uses an actual pinned transport and fresh random nonce. All local reads share
/// one transaction snapshot; no schema, rows, journal or evidence cache is written.
/// The caller owns file identity/permission observation for this connection.
pub fn inspect_online_finalized_database_head_v1<T: MutationAuthorityTransportV1>(
    db: &mut Connection,
    id: &str,
    inventory: &Value,
    authority: &mut PinnedMutationAuthorityV1<T>,
    writer_manifest: &Value,
    clock: &mut dyn MutationClockV1,
) -> Result<VerifiedFinalizedHeadInspectionV1> {
    manifest::assert_writer_manifest_v1(writer_manifest)?;
    let (instance, expected) = inventory_binding(inventory, id, authority.trust())?;
    checked(
        db.is_autocommit()
            && authority.trust()["writerManifestHash"]
                == manifest::writer_manifest_hash_v1(writer_manifest)?
            && writer_manifest["coverage"]["coveredDatabaseRoles"]
                .as_array()
                .is_some_and(|a| a.contains(&instance["role"])),
        "configuration_invalid",
    )?;
    let transaction = db.transaction_with_behavior(TransactionBehavior::Deferred)?;
    storage::surface(&transaction)?;
    let schema = exact_schema_hash_v1(&transaction)?;
    let meta = metadata(&transaction, &instance, authority.trust(), &schema)?;
    let (requested, requested_at) = observe(clock)?;
    let request = json!({"version":1,"kind":"AutonomousResearchOnlineMutationCurrentHeadRequest","protocol":ONLINE_MUTATION_PROTOCOL,"scopeId":authority.trust()["scopeId"],"databaseScopeHash":authority.trust()["databaseScopeHash"],"writerManifestHash":authority.trust()["writerManifestHash"],"nonce":nonce()?,"requestedAt":requested_at});
    let observing = observe(clock)?.0;
    checked(observing >= requested, "authority_evidence_expired")?;
    let head = authority.observe_current_head(&request, Some(&expected), observing)?;
    let current = head.value();
    let matches = current["databaseHeads"]
        .as_array()
        .ok_or_else(|| error(code("authority_instance_missing")))?
        .iter()
        .filter(|h| {
            h["databaseRole"] == instance["role"]
                && h["databaseInstanceId"] == instance["instanceId"]
        })
        .collect::<Vec<_>>();
    checked(matches.len() == 1, "authority_instance_missing")?;
    let mut head = matches
        .first()
        .ok_or_else(|| error(code("authority_instance_missing")))?
        .to_owned()
        .clone();
    head["globalSequence"] = current["globalSequence"].clone();
    let chain = marker_chain(
        &transaction,
        &meta,
        &schema,
        &instance,
        writer_manifest,
        authority,
        &head,
    )?;
    checked(
        head["schemaHash"] == schema
            && equal(&head["sequence"], &chain["localHead"]["sequence"])
            && head["hash"] == chain["localHead"]["hash"]
            && head["stateHash"] == chain["localHead"]["stateHash"],
        "local_authority_mismatch",
    )?;
    let (inspected, inspected_at) = observe(clock)?;
    let observed = timestamp(&current["observedAt"])
        .ok_or_else(|| error(code("authority_evidence_expired")))?;
    checked(
        inspected >= observing
            && timestamp(&current["expiresAt"]).is_some_and(|t| t > inspected)
            && inspected.saturating_sub(observed)
                <= int(authority.trust(), "maximumObservationAgeMs")?,
        "authority_evidence_expired",
    )?;
    // Recheck signatures, full current-time policy and pinned configuration after
    // the local scan, including the genesis path with no stored marker checks.
    authority.verify_current_head_receipt(current, &request, Some(&expected), inspected)?;
    let mut receipt = json!({"version":1,"kind":"AutonomousResearchOnlineFinalizedHeadInspectionReceipt","status":"autonomous_research_online_finalized_head_reconciled","inventoryHash":inventory["inventoryHash"],"databaseScopeHash":inventory["databaseScopeHash"],"writerManifestHash":authority.trust()["writerManifestHash"],"databaseRole":instance["role"],"databaseInstanceId":instance["instanceId"],"schemaContractId":instance["schemaContractId"],"schemaHash":schema,"currentHeadReceiptHash":contracts::online_mutation_receipt_hash_v1(current)?,"authorityGlobalSequence":current["globalSequence"],"authorityGlobalHash":current["globalHash"],"localDatabaseSequence":chain["localHead"]["sequence"],"localDatabaseHash":chain["localHead"]["hash"],"localStateHash":chain["localHead"]["stateHash"],"markerCount":chain["markerCount"],"finalizationCount":chain["finalizationCount"],"genesisZeroHeadVerified":true,"markerChainHash":chain["markerChainHash"],"inspectedAt":inspected_at,"remainingBlockers":REMAINING_BLOCKERS,"runtimeReady":false});
    receipt["inspectionReceiptHash"] = json!(finalized_head_inspection_receipt_hash_v1(&receipt)?);
    assert_finalized_head_inspection_receipt_v1(&receipt)?;
    transaction.rollback()?;
    // Verifier pin reads and SQLite rollback occur after the prior sample. This
    // final memory-only check covers all I/O; no earlier clock value authorizes
    // returning an already expired or over-age signed observation.
    let completed = observe(clock)?.0;
    checked(
        completed >= inspected
            && timestamp(&current["expiresAt"]).is_some_and(|t| t > completed)
            && completed.saturating_sub(observed)
                <= int(authority.trust(), "maximumObservationAgeMs")?,
        "authority_evidence_expired",
    )?;
    Ok(VerifiedFinalizedHeadInspectionV1 {
        receipt,
        current_head: current.clone(),
        authority_configuration_hash: authority.configuration_hash().to_owned(),
    })
}
