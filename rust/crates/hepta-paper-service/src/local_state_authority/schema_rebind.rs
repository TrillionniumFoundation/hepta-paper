//! Pristine writer-manifest rebind. Finalization retains the source heads;
//! only reopening under the exact signed target configuration activates them.
use super::*;
use crate::sqlite_mutation_coordinator::contracts::schema_transition::*;
use rusqlite::params;
const INVALID: &str = "local_state_authority_schema_rebind_state_invalid";
const CONFIG_DOMAIN: &str = "HeptaLocalAutonomousResearchStateAuthorityConfiguration";

pub(super) fn handle(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    require_transaction(db)?;
    let request = normalize_schema_numbers_v1(request)?;
    if request["version"] != 2 {
        return Err(error("local_state_authority_request_invalid"));
    }
    match text(&request, "kind")? {
        "AutonomousResearchOnlineSchemaTransitionReserveRequest" => reserve(db, ctx, &request),
        "AutonomousResearchOnlineSchemaTransitionFinalizeRequest" => finalize(db, ctx, &request),
        "AutonomousResearchOnlineSchemaTransitionObserveRequest" => observe(db, ctx, &request),
        _ => Err(error("local_state_authority_request_kind_unsupported")),
    }
}
fn require_transaction(db: &Connection) -> Result<()> {
    if db.is_autocommit() {
        return Err(error("local_state_authority_transaction_required"));
    }
    Ok(())
}
struct Stored {
    request: Value,
    reservation: Value,
    finalize: Option<Value>,
    finalization: Option<Value>,
    target: String,
}
fn stored(db: &Connection, ctx: &Context, id: &str) -> Result<Option<Stored>> {
    let row=db.query_row("SELECT reserve_request_json,reservation_receipt_json,finalize_request_json,finalization_receipt_json,target_configuration_hash FROM authority_schema_rebind WHERE transition_id=?",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,String>(4)?))).optional()?;
    row.map(|(a, b, c, d, target)| {
        let value = Stored {
            request: parse_record(&a, INVALID)?,
            reservation: parse_record(&b, INVALID)?,
            finalize: c.map(|s| parse_record(&s, INVALID)).transpose()?,
            finalization: d.map(|s| parse_record(&s, INVALID)).transpose()?,
            target,
        };
        let issued = timestamp(&value.reservation["issuedAt"]).ok_or_else(|| error(INVALID))?;
        if value.request["version"].as_f64() != Some(2.0)
            || value.request["transitionId"] != id
            || value.reservation["targetAuthorityConfigurationHash"] != value.target
            || !verify_schema_transition_reservation_v1(
                &value.reservation,
                &value.request,
                &ctx.trust,
                issued,
                &|r| ctx.verify_online(r),
            )?
            || value.finalize.is_some() != value.finalization.is_some()
        {
            return Err(error(INVALID));
        }
        if let (Some(request), Some(receipt)) = (&value.finalize, &value.finalization) {
            let finalized = timestamp(&receipt["finalizedAt"]).ok_or_else(|| error(INVALID))?;
            if !verify_schema_transition_finalization_v1(
                receipt,
                request,
                &value.reservation,
                &ctx.trust,
                finalized,
                &|r| ctx.verify_online(r),
            )? || receipt["globalSequence"]
                != value.reservation["databaseGenesis"][0]["globalSequence"]
                || receipt["globalHash"] != value.reservation["databaseGenesis"][0]["globalHash"]
            {
                return Err(error(INVALID));
            }
        }
        Ok(value)
    })
    .transpose()
}
fn copy(to: &mut Value, from: &Value, names: &[&str]) -> Result<()> {
    for key in names {
        to[*key] = from.get(*key).cloned().ok_or_else(|| error(INVALID))?;
    }
    Ok(())
}
fn count(db: &Connection, sql: &str) -> Result<i64> {
    Ok(db.query_row(sql, [], |r| r.get(0))?)
}
fn pristine_no_mutations(db: &Connection, code: &str) -> Result<()> {
    if count(db, "SELECT count(*) FROM authority_mutation")? != 0 {
        return Err(error(code));
    }
    Ok(())
}
fn no_unfinished_backups(db: &Connection, code: &str) -> Result<()> {
    if count(
        db,
        "SELECT count(*) FROM authority_backup_reservation WHERE finalization_receipt_json IS NULL",
    )? != 0
    {
        return Err(error(code));
    }
    Ok(())
}
fn exact_source_preimage(db: &Connection, reservation: &Value, code: &str) -> Result<()> {
    let current = metadata(db)?;
    if current.schema_transition_state != "reserved"
        || current.global_sequence != 0
        || reservation["previousGlobalSequence"].as_f64() != Some(0.0)
        || current.global_hash != reservation["previousGlobalHash"]
        || current.writer_manifest_hash != reservation["sourceWriterManifestHash"]
        || current.database_scope_hash != reservation["databaseScopeHash"]
        || database_heads(db)? != reservation["previousDatabaseHeads"]
    {
        return Err(error(code));
    }
    pristine_no_mutations(db, code)
}
fn target_configuration(ctx: &Context, request: &Value) -> Value {
    let mut target = ctx.configuration.clone();
    target["databaseScopeHash"] = request["databaseScopeHash"].clone();
    target["writerManifestHash"] = request["writerManifestHash"].clone();
    target
}
fn source_configuration(ctx: &Context, request: &Value) -> Value {
    let mut source = ctx.configuration.clone();
    source["databaseScopeHash"] = request["databaseScopeHash"].clone();
    source["writerManifestHash"] = request["sourceWriterManifestHash"].clone();
    source
}
fn verify_initial_finalization(db: &Connection, ctx: &Context) -> Result<()> {
    let row=db.query_row("SELECT reserve_request_json,reservation_receipt_json,finalize_request_json,finalization_receipt_json FROM authority_schema_transition WHERE singleton=1",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?))).optional()?.ok_or_else(||error(INVALID))?;
    let request = parse_record(&row.0, INVALID)?;
    let reservation = parse_record(&row.1, INVALID)?;
    let finalize = parse_record(row.2.as_deref().ok_or_else(|| error(INVALID))?, INVALID)?;
    let finalization = parse_record(row.3.as_deref().ok_or_else(|| error(INVALID))?, INVALID)?;
    // Initial genesis may precede earlier pristine rebinds. The same real key,
    // authority and database scope must still authenticate that historical row.
    let mut historical = ctx.trust.clone();
    historical["writerManifestHash"] = request["writerManifestHash"].clone();
    if request["version"].as_f64() != Some(1.0)
        || !verify_schema_transition_reservation_v1(
            &reservation,
            &request,
            &historical,
            timestamp(&reservation["issuedAt"]).ok_or_else(|| error(INVALID))?,
            &|r| ctx.verify_online(r),
        )?
        || !verify_schema_transition_finalization_v1(
            &finalization,
            &finalize,
            &reservation,
            &historical,
            timestamp(&finalization["finalizedAt"]).ok_or_else(|| error(INVALID))?,
            &|r| ctx.verify_online(r),
        )?
    {
        return Err(error(INVALID));
    }
    Ok(())
}
fn reserve(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    assert_schema_transition_reserve_request_v1(request, &ctx.trust)?;
    if let Some(existing) = stored(db, ctx, text(request, "transitionId")?)? {
        if existing.request != *request {
            return Err(error("local_state_authority_schema_rebind_conflict"));
        }
        let renewal = ctx.now()?;
        let now = timestamp(&json!(renewal)).ok_or_else(|| error(INVALID))?;
        if existing.finalization.is_some()
            || timestamp(&existing.reservation["expiresAt"]).ok_or_else(|| error(INVALID))? > now
        {
            return Ok(existing.reservation);
        }
        exact_source_preimage(
            db,
            &existing.reservation,
            "local_state_authority_schema_rebind_recovery_preimage_changed",
        )?;
        no_unfinished_backups(
            db,
            "local_state_authority_schema_rebind_recovery_preimage_changed",
        )?;
        let mut receipt = existing.reservation;
        receipt
            .as_object_mut()
            .ok_or_else(|| error(INVALID))?
            .remove("signature");
        receipt["reservationId"] = json!(ctx.new_id("schema-rebind-recovery")?);
        receipt["issuedAt"] = json!(renewal);
        receipt["expiresAt"] = json!(ctx.expiry(&renewal, int(request, "requestedLeaseMs")?)?);
        let receipt = ctx.sign_online(&receipt)?;
        db.execute(
            "UPDATE authority_schema_rebind SET reservation_receipt_json=?1 WHERE transition_id=?2",
            params![receipt.to_string(), text(request, "transitionId")?],
        )?;
        return Ok(receipt);
    }
    let code = "local_state_authority_pristine_schema_rebind_precondition_failed";
    let current = metadata(db)?;
    let heads = database_heads(db)?;
    if current.schema_transition_state != "finalized"
        || current.global_sequence != 0
        || current.writer_manifest_hash != request["sourceWriterManifestHash"]
        || current.database_scope_hash != request["databaseScopeHash"]
        || current.configuration_hash != hash(CONFIG_DOMAIN, &ctx.configuration)?
        || ctx.configuration["writerManifestHash"] != request["sourceWriterManifestHash"]
    {
        return Err(error(code));
    }
    pristine_no_mutations(db, code)?;
    no_unfinished_backups(db, code)?;
    verify_initial_finalization(db, ctx)?;
    let genesis =
        build_pristine_schema_rebind_genesis_v2(request, &json!(current.global_hash), &heads)?;
    let target = hash(CONFIG_DOMAIN, &target_configuration(ctx, request))?;
    let now = ctx.now()?;
    let mut receipt = json!({"version":2,"kind":"AutonomousResearchOnlineSchemaTransitionReservationReceipt","status":"autonomous_research_online_schema_transition_reserved",
        "authorityId":ctx.configuration["authorityId"],"keyId":ctx.configuration["keyId"],"requestHash":hash("AutonomousResearchOnlineSchemaTransitionReserveRequest",request)?,"reservationId":ctx.new_id("schema-rebind")?,
        "databaseGenesis":genesis,"previousGlobalSequence":0,"previousGlobalHash":current.global_hash,"previousDatabaseHeads":heads,"targetAuthorityConfigurationHash":target,"authorityRestartRequired":true,
        "issuedAt":now,"expiresAt":ctx.expiry(&now,int(request,"requestedLeaseMs")?)?,"allRegisteredMutationsFenced":true,"quiescenceMode":"pristine-scope-held-through-target-configuration-restart"});
    copy(
        &mut receipt,
        request,
        &[
            "protocol",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "stateDatabaseManifestHash",
            "transitionInventoryHash",
            "schemaBundleHash",
            "authorityJournalSchemaContractId",
            "authorityJournalSchemaHash",
            "markerSchemaHash",
            "transitionId",
            "instances",
            "transitionMode",
            "sourceWriterManifestHash",
            "prePristineRuntimeStateHash",
        ],
    )?;
    let receipt = ctx.sign_online(&receipt)?;
    db.execute("INSERT INTO authority_schema_rebind(transition_id,reserve_request_json,reservation_receipt_json,target_configuration_hash) VALUES(?1,?2,?3,?4)",params![text(request,"transitionId")?,request.to_string(),receipt.to_string(),target])?;
    db.execute(
        "UPDATE authority_metadata SET schema_transition_state='reserved' WHERE singleton=1",
        [],
    )?;
    Ok(receipt)
}
fn finalize(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    let row = stored(db, ctx, text(request, "transitionId")?)?
        .ok_or_else(|| error("local_state_authority_schema_rebind_reservation_required"))?;
    assert_schema_transition_finalize_request_v1(request, &row.reservation)?;
    if let Some(receipt) = row.finalization {
        if row.finalize.as_ref() != Some(request) {
            return Err(error(
                "local_state_authority_schema_rebind_finalization_conflict",
            ));
        }
        return Ok(receipt);
    }
    exact_source_preimage(
        db,
        &row.reservation,
        "local_state_authority_schema_rebind_finalize_preimage_changed",
    )?;
    no_unfinished_backups(
        db,
        "local_state_authority_schema_rebind_finalize_preimage_changed",
    )?;
    let now = ctx.now()?;
    let now_ms = timestamp(&json!(now)).ok_or_else(|| error(INVALID))?;
    if now_ms >= timestamp(&row.reservation["expiresAt"]).ok_or_else(|| error(INVALID))? {
        return Err(error(
            "local_state_authority_schema_rebind_reservation_expired",
        ));
    }
    let mut receipt = json!({"version":2,"kind":"AutonomousResearchOnlineSchemaTransitionFinalizationReceipt","status":"autonomous_research_online_schema_transition_finalized","authorityId":ctx.configuration["authorityId"],"keyId":ctx.configuration["keyId"],"requestHash":hash("AutonomousResearchOnlineSchemaTransitionFinalizeRequest",request)?,"globalSequence":row.reservation["databaseGenesis"][0]["globalSequence"],"globalHash":row.reservation["databaseGenesis"][0]["globalHash"],"authorityRestartRequired":true,"finalizedAt":now,"allRegisteredMutationsFencedThroughFinalize":true});
    copy(
        &mut receipt,
        request,
        &[
            "protocol",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "transitionId",
            "transitionInventoryHash",
            "schemaBundleHash",
            "reservationId",
            "reservationReceiptHash",
            "postInventoryHash",
            "postPristineRuntimeStateHash",
            "installations",
        ],
    )?;
    copy(
        &mut receipt,
        &row.reservation,
        &[
            "transitionMode",
            "sourceWriterManifestHash",
            "targetAuthorityConfigurationHash",
        ],
    )?;
    let receipt = ctx.sign_online(&receipt)?;
    if !verify_schema_transition_finalization_v1(
        &receipt,
        request,
        &row.reservation,
        &ctx.trust,
        now_ms,
        &|r| ctx.verify_online(r),
    )? {
        return Err(error(
            "local_state_authority_schema_rebind_finalization_time_invalid",
        ));
    }
    db.execute("UPDATE authority_schema_rebind SET finalize_request_json=?1,finalization_receipt_json=?2 WHERE transition_id=?3",params![request.to_string(),receipt.to_string(),text(request,"transitionId")?])?;
    Ok(receipt)
}

/// Called only in the storage owner's transaction after actual key pin checks.
/// It never reloads configuration, opens files, or begins a nested transaction.
pub(super) fn activate_finalized(db: &Connection, ctx: &Context) -> Result<bool> {
    require_transaction(db)?;
    let current = metadata(db)?;
    let expected = hash(CONFIG_DOMAIN, &ctx.configuration)?;
    if current.configuration_hash == expected {
        return Ok(false);
    }
    let ids=db.prepare("SELECT transition_id FROM authority_schema_rebind WHERE finalization_receipt_json IS NOT NULL AND target_configuration_hash=? ORDER BY transition_id")?.query_map([&expected],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    if ids.len() != 1 || current.schema_transition_state != "reserved" {
        return Err(error("local_state_authority_persisted_identity_mismatch"));
    }
    let row = stored(db, ctx, &ids[0])?.ok_or_else(|| error(INVALID))?;
    if row.finalization.is_none()
        || row.request["writerManifestHash"] != ctx.configuration["writerManifestHash"]
        || row.request["databaseScopeHash"] != ctx.configuration["databaseScopeHash"]
        || current.authority_id != text(&ctx.configuration, "authorityId")?
        || current.key_id != text(&ctx.configuration, "keyId")?
        || current.scope_id != text(&ctx.configuration, "scopeId")?
        || current.configuration_hash
            != hash(CONFIG_DOMAIN, &source_configuration(ctx, &row.request))?
    {
        return Err(error(
            "local_state_authority_schema_rebind_activation_invalid",
        ));
    }
    exact_source_preimage(
        db,
        &row.reservation,
        "local_state_authority_schema_rebind_activation_invalid",
    )?;
    no_unfinished_backups(db, "local_state_authority_schema_rebind_activation_invalid")?;
    for genesis in row.reservation["databaseGenesis"]
        .as_array()
        .ok_or_else(|| error(INVALID))?
    {
        if db.execute("UPDATE authority_database_head SET database_role=?1,sequence=?2,hash=?3,schema_hash=?4,state_hash=?5 WHERE database_instance_id=?6",params![text(genesis,"databaseRole")?,int(genesis,"databaseSequence")?,text(genesis,"databaseHash")?,text(genesis,"schemaHash")?,text(genesis,"stateHash")?,text(genesis,"databaseInstanceId")?])?!=1 {return Err(error("local_state_authority_schema_rebind_head_activation_invalid"));}
    }
    db.execute("UPDATE authority_metadata SET configuration_hash=?1,database_scope_hash=?2,writer_manifest_hash=?3,global_sequence=?4,global_hash=?5,schema_transition_state='finalized' WHERE singleton=1",params![expected,text(&ctx.configuration,"databaseScopeHash")?,text(&ctx.configuration,"writerManifestHash")?,int(&row.reservation["databaseGenesis"][0],"globalSequence")?,text(&row.reservation["databaseGenesis"][0],"globalHash")?])?;
    Ok(true)
}
fn observe(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    assert_schema_transition_observe_request_v1(request, &ctx.trust)?;
    let row = stored(db, ctx, text(request, "transitionId")?)?
        .ok_or_else(|| error("local_state_authority_schema_rebind_not_finalized"))?;
    let finalization = row
        .finalization
        .ok_or_else(|| error("local_state_authority_schema_rebind_not_finalized"))?;
    let current = metadata(db)?;
    if [
        "transitionId",
        "transitionInventoryHash",
        "schemaBundleHash",
        "postInventoryHash",
        "postPristineRuntimeStateHash",
        "transitionMode",
        "sourceWriterManifestHash",
    ]
    .iter()
    .any(|k| request[*k] != finalization[*k])
        || request["finalizationReceiptHash"] != schema_transition_receipt_hash_v1(&finalization)?
        || current.schema_transition_state != "finalized"
        || current.configuration_hash != row.target
        || current.configuration_hash != hash(CONFIG_DOMAIN, &ctx.configuration)?
        || current.writer_manifest_hash != request["writerManifestHash"]
    {
        return Err(error(
            "local_state_authority_schema_rebind_target_configuration_activation_required",
        ));
    }
    let now = ctx.now()?;
    let mut receipt = json!({"version":2,"kind":"AutonomousResearchOnlineSchemaTransitionObservationReceipt","status":"autonomous_research_online_schema_transition_observed_finalized","authorityId":ctx.configuration["authorityId"],"keyId":ctx.configuration["keyId"],"requestHash":hash("AutonomousResearchOnlineSchemaTransitionObserveRequest",request)?,"transitionState":"finalized","globalSequence":current.global_sequence,"globalHash":current.global_hash,"authorityConfigurationActivated":true,"observedAt":now,"expiresAt":ctx.expiry(&now,int(&ctx.configuration,"maximumObservationAgeMs")?)?});
    copy(
        &mut receipt,
        request,
        &[
            "protocol",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "transitionId",
            "transitionInventoryHash",
            "schemaBundleHash",
            "finalizationReceiptHash",
            "postInventoryHash",
            "postPristineRuntimeStateHash",
            "transitionMode",
            "sourceWriterManifestHash",
        ],
    )?;
    ctx.sign_online(&receipt)
}
pub(super) fn inspect(db: &Connection, ctx: &Context) -> Result<Value> {
    require_transaction(db)?;
    let current = metadata(db)?;
    let id = db
        .query_row(
            "SELECT transition_id FROM authority_schema_rebind ORDER BY rowid DESC LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    let row = id.map(|id| stored(db, ctx, &id)).transpose()?.flatten();
    let finalized = row.as_ref().filter(|r| r.finalization.is_some());
    let restart = finalized.is_some_and(|r| r.target != current.configuration_hash);
    Ok(
        json!({"configurationHash":current.configuration_hash,"authorityWriterManifestHash":current.writer_manifest_hash,"schemaRebindRestartRequired":restart,
        "pendingTargetWriterManifestHash":if restart {row.as_ref().unwrap().request["writerManifestHash"].clone()} else {Value::Null},
        "pendingTargetAuthorityConfigurationHash":if restart {json!(row.as_ref().unwrap().target)} else {Value::Null},
        "schemaRebindFinalizationReceiptHash":finalized.map(|r|schema_transition_receipt_hash_v1(r.finalization.as_ref().unwrap())).transpose()?,
        "schemaRebindTargetConfigurationHash":finalized.map(|r|r.target.clone()),"schemaRebindActivated":finalized.is_some_and(|r|r.target==current.configuration_hash),
        "unfinishedSchemaRebindCount":count(db,"SELECT count(*) FROM authority_schema_rebind WHERE finalization_receipt_json IS NULL")?,"unfinishedBackupCount":count(db,"SELECT count(*) FROM authority_backup_reservation WHERE finalization_receipt_json IS NULL")?}),
    )
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod runtime_tests;
