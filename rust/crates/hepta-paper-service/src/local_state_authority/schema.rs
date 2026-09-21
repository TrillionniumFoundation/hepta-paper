//! Original schema-genesis reservation/finalization/observation protocol.
//! All operations run under the owning runtime's IMMEDIATE transaction.
use super::*;
use crate::sqlite_mutation_coordinator::contracts::schema_transition::*;

pub(super) fn handle(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    if request["version"] == 2 {
        return super::schema_rebind::handle(db, ctx, request);
    }
    if request["version"] != 1 {
        return Err(error("local_state_authority_native_schema_rebind_required"));
    }
    match text(request, "kind")? {
        "AutonomousResearchOnlineSchemaTransitionReserveRequest" => reserve(db, ctx, request),
        "AutonomousResearchOnlineSchemaTransitionFinalizeRequest" => finalize(db, ctx, request),
        "AutonomousResearchOnlineSchemaTransitionObserveRequest" => observe(db, ctx, request),
        _ => Err(error("local_state_authority_request_kind_unsupported")),
    }
}
struct Stored {
    reserve: Value,
    reservation: Value,
    finalize: Option<Value>,
    finalization: Option<Value>,
}
fn stored(db: &Connection, ctx: &Context) -> Result<Option<Stored>> {
    let row = db.query_row("SELECT reserve_request_json,reservation_receipt_json,finalize_request_json,finalization_receipt_json FROM authority_schema_transition WHERE singleton=1",[],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?))).optional()?;
    let stored = row
        .map(|(a, b, c, d)| -> Result<Stored> {
            let code = "local_state_authority_schema_transition_state_invalid";
            Ok(Stored {
                reserve: parse_record(&a, code)?,
                reservation: parse_record(&b, code)?,
                finalize: c.map(|v| parse_record(&v, code)).transpose()?,
                finalization: d.map(|v| parse_record(&v, code)).transpose()?,
            })
        })
        .transpose()?;
    if let Some(value) = &stored {
        let code = "local_state_authority_schema_transition_state_invalid";
        let issued = timestamp(&value.reservation["issuedAt"]).ok_or_else(|| error(code))?;
        if !verify_schema_transition_reservation_v1(
            &value.reservation,
            &value.reserve,
            &ctx.trust,
            issued,
            &|v| ctx.verify_online(v),
        )? {
            return Err(error(code));
        }
        match (&value.finalize, &value.finalization) {
            (None, None) => {}
            (Some(request), Some(receipt)) => {
                let finalized = timestamp(&receipt["finalizedAt"]).ok_or_else(|| error(code))?;
                if !verify_schema_transition_finalization_v1(
                    receipt,
                    request,
                    &value.reservation,
                    &ctx.trust,
                    finalized,
                    &|v| ctx.verify_online(v),
                )? {
                    return Err(error(code));
                }
            }
            _ => return Err(error(code)),
        }
    }
    Ok(stored)
}
fn reserve(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    assert_schema_transition_reserve_request_v1(request, &ctx.trust)?;
    if let Some(existing) = stored(db, ctx)? {
        if existing.reserve != *request {
            return Err(error("local_state_authority_schema_transition_conflict"));
        }
        let renewal = ctx.now()?;
        let expires = timestamp(&existing.reservation["expiresAt"])
            .ok_or_else(|| error("local_state_authority_schema_transition_state_invalid"))?;
        if existing.finalization.is_some()
            || expires > timestamp(&json!(renewal)).unwrap_or(i64::MAX)
        {
            return Ok(existing.reservation);
        }
        let current = metadata(db)?;
        let heads: i64 = db.query_row("SELECT count(*) FROM authority_database_head", [], |r| {
            r.get(0)
        })?;
        let mutations: i64 =
            db.query_row("SELECT count(*) FROM authority_mutation", [], |r| r.get(0))?;
        let backups:i64 = db.query_row("SELECT count(*) FROM authority_backup_reservation WHERE finalization_receipt_json IS NULL",[],|r|r.get(0))?;
        if current.schema_transition_state != "reserved"
            || current.global_sequence != 0
            || heads != 0
            || mutations != 0
            || backups != 0
        {
            return Err(error(
                "local_state_authority_schema_transition_recovery_preimage_changed",
            ));
        }
        let mut value = existing.reservation;
        value
            .as_object_mut()
            .ok_or_else(|| error("local_state_authority_schema_transition_state_invalid"))?
            .remove("signature");
        value["reservationId"] = json!(ctx.new_id("schema-recovery")?);
        value["issuedAt"] = json!(renewal);
        value["expiresAt"] = json!(ctx.expiry(&renewal, int(request, "requestedLeaseMs")?)?);
        let signed = ctx.sign_online(&value)?;
        db.execute(
            "UPDATE authority_schema_transition SET reservation_receipt_json=? WHERE singleton=1",
            [signed.to_string()],
        )?;
        return Ok(signed);
    }
    let current = metadata(db)?;
    let heads: i64 = db.query_row("SELECT count(*) FROM authority_database_head", [], |r| {
        r.get(0)
    })?;
    if current.schema_transition_state != "uninitialized" || heads != 0 {
        return Err(error(
            "local_state_authority_schema_transition_already_initialized",
        ));
    }
    let now = ctx.now()?;
    assert_no_live_backup(db, &now)?;
    let genesis = request["instances"].as_array().ok_or_else(||error("local_state_authority_request_invalid"))?.iter().map(|instance| {
        Ok(json!({"databaseRole":instance["databaseRole"],"databaseInstanceId":instance["databaseInstanceId"],
            "schemaContractId":instance["schemaContractId"],"schemaHash":instance["expectedPostSchemaHash"],
            "globalSequence":0,"globalHash":current.global_hash,"databaseSequence":0,
            "databaseHash":hash("HeptaLocalStateAuthorityDatabaseGenesisHead",&json!({"databaseRole":instance["databaseRole"],"databaseInstanceId":instance["databaseInstanceId"],"schemaHash":instance["expectedPostSchemaHash"]}))?,
            "stateHash":hash("HeptaLocalStateAuthorityDatabaseGenesisState",&json!({"databaseRole":instance["databaseRole"],"databaseInstanceId":instance["databaseInstanceId"],"sourceSha256":instance["sourceSha256"],"schemaHash":instance["expectedPostSchemaHash"]}))?}))
    }).collect::<Result<Vec<_>>>()?;
    let mut receipt = json!({"version":1,"kind":"AutonomousResearchOnlineSchemaTransitionReservationReceipt",
        "status":"autonomous_research_online_schema_transition_reserved","authorityId":ctx.configuration["authorityId"],"keyId":ctx.configuration["keyId"],
        "requestHash":hash("AutonomousResearchOnlineSchemaTransitionReserveRequest",request)?,
        "reservationId":ctx.new_id("schema")?,"databaseGenesis":genesis,"issuedAt":now,
        "expiresAt":ctx.expiry(&now,int(request,"requestedLeaseMs")?)?,"allRegisteredMutationsFenced":true,
        "quiescenceMode":"scope-wide-no-new-reservations-until-finalize-or-expiry"});
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
        ],
    )?;
    let signed = ctx.sign_online(&receipt)?;
    db.execute("INSERT INTO authority_schema_transition(singleton,reserve_request_json,reservation_receipt_json) VALUES(1,?,?)",rusqlite::params![request.to_string(),signed.to_string()])?;
    db.execute(
        "UPDATE authority_metadata SET schema_transition_state='reserved' WHERE singleton=1",
        [],
    )?;
    Ok(signed)
}
fn finalize(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    let row = stored(db, ctx)?
        .ok_or_else(|| error("local_state_authority_schema_transition_reservation_required"))?;
    assert_schema_transition_finalize_request_v1(request, &row.reservation)?;
    if let Some(receipt) = row.finalization {
        if row.finalize.as_ref() != Some(request) {
            return Err(error(
                "local_state_authority_schema_transition_finalization_conflict",
            ));
        }
        return Ok(receipt);
    }
    let current = metadata(db)?;
    let now = ctx.now()?;
    if timestamp(&json!(now)).ok_or_else(|| error("local_state_authority_clock_invalid"))?
        >= timestamp(&row.reservation["expiresAt"])
            .ok_or_else(|| error("local_state_authority_schema_transition_state_invalid"))?
    {
        return Err(error(
            "local_state_authority_schema_transition_reservation_expired",
        ));
    }
    if current.schema_transition_state != "reserved" || current.global_sequence != 0 {
        return Err(error(
            "local_state_authority_schema_transition_recovery_preimage_changed",
        ));
    }
    let mut receipt = json!({"version":1,"kind":"AutonomousResearchOnlineSchemaTransitionFinalizationReceipt",
        "status":"autonomous_research_online_schema_transition_finalized","authorityId":ctx.configuration["authorityId"],"keyId":ctx.configuration["keyId"],
        "requestHash":hash("AutonomousResearchOnlineSchemaTransitionFinalizeRequest",request)?,"globalSequence":current.global_sequence,
        "globalHash":current.global_hash,"finalizedAt":now,"allRegisteredMutationsFencedThroughFinalize":true});
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
    let signed = ctx.sign_online(&receipt)?;
    for genesis in row.reservation["databaseGenesis"]
        .as_array()
        .ok_or_else(|| error("local_state_authority_schema_transition_state_invalid"))?
    {
        db.execute("INSERT INTO authority_database_head(database_instance_id,database_role,sequence,hash,schema_hash,state_hash) VALUES(?,?,?,?,?,?)",rusqlite::params![
            text(genesis,"databaseInstanceId")?,text(genesis,"databaseRole")?,int(genesis,"databaseSequence")?,
            text(genesis,"databaseHash")?,text(genesis,"schemaHash")?,text(genesis,"stateHash")?])?;
    }
    db.execute("UPDATE authority_schema_transition SET finalize_request_json=?,finalization_receipt_json=? WHERE singleton=1",rusqlite::params![request.to_string(),signed.to_string()])?;
    db.execute(
        "UPDATE authority_metadata SET schema_transition_state='finalized' WHERE singleton=1",
        [],
    )?;
    Ok(signed)
}
fn observe(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    assert_schema_transition_observe_request_v1(request, &ctx.trust)?;
    let finalized = stored(db, ctx)?
        .and_then(|v| v.finalization)
        .ok_or_else(|| error("local_state_authority_schema_transition_not_finalized"))?;
    for key in [
        "transitionId",
        "transitionInventoryHash",
        "schemaBundleHash",
        "postInventoryHash",
        "postPristineRuntimeStateHash",
    ] {
        if request[key] != finalized[key] {
            return Err(error(
                "local_state_authority_schema_transition_observation_mismatch",
            ));
        }
    }
    if request["finalizationReceiptHash"] != schema_transition_receipt_hash_v1(&finalized)? {
        return Err(error(
            "local_state_authority_schema_transition_observation_mismatch",
        ));
    }
    let current = metadata(db)?;
    let now = ctx.now()?;
    let mut receipt = json!({"version":1,"kind":"AutonomousResearchOnlineSchemaTransitionObservationReceipt",
        "status":"autonomous_research_online_schema_transition_observed_finalized","authorityId":ctx.configuration["authorityId"],"keyId":ctx.configuration["keyId"],
        "requestHash":hash("AutonomousResearchOnlineSchemaTransitionObserveRequest",request)?,"transitionState":"finalized",
        "globalSequence":current.global_sequence,"globalHash":current.global_hash,"observedAt":now,
        "expiresAt":ctx.expiry(&now,int(&ctx.configuration,"maximumObservationAgeMs")?)?});
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
        ],
    )?;
    ctx.sign_online(&receipt)
}
fn copy(target: &mut Value, source: &Value, keys: &[&str]) -> Result<()> {
    let target = target
        .as_object_mut()
        .ok_or_else(|| error("local_state_authority_receipt_invalid"))?;
    for key in keys {
        target.insert(
            (*key).into(),
            source
                .get(*key)
                .cloned()
                .ok_or_else(|| error("local_state_authority_request_invalid"))?,
        );
    }
    Ok(())
}
