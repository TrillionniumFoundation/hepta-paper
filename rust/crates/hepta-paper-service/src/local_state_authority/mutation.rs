//! Actual online authority state transitions. The owner holds one IMMEDIATE
//! transaction around every dispatch; handlers never begin a nested transaction.
use super::*;
use crate::sqlite_mutation_coordinator::{
    ONLINE_MUTATION_PROTOCOL,
    contracts::{self, activation},
};
use base64ct::{Base64, Encoding};
use ed25519_dalek::Signature;
use rusqlite::{Connection, OptionalExtension, params};

const MAX_SAFE: i64 = 9_007_199_254_740_991;

pub(super) fn handle(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    if db.is_autocommit() {
        return Err(error("local_state_authority_transaction_required"));
    }
    match request["kind"].as_str() {
        Some("AutonomousResearchOnlineMutationReserveRequest") => reserve(db, ctx, request),
        Some("AutonomousResearchOnlineMutationFinalizeRequest") => finalize(db, ctx, request),
        Some("AutonomousResearchOnlineMutationAbortRequest") => abort(db, ctx, request),
        Some("AutonomousResearchOnlineMutationResolutionRequest") => resolve(db, ctx, request),
        Some("AutonomousResearchOnlineUnresolvedReservationListRequest") => {
            unresolved(db, ctx, request)
        }
        Some("AutonomousResearchOnlineMutationCurrentHeadRequest") => head(db, ctx, request, false),
        Some("AutonomousResearchOnlineMutationActiveChallengeRequest") => {
            head(db, ctx, request, true)
        }
        Some("AutonomousResearchOnlineMutationScopeRequest") => scope(db, ctx, request),
        _ => Err(error("local_state_authority_request_kind_unsupported")),
    }
}

fn parsed(raw: &str) -> Result<Value> {
    parse_record(raw, "local_state_authority_mutation_state_invalid")
}
fn encoded(value: &Value) -> Result<String> {
    serde_json::to_string(value).map_err(|_| error("local_state_authority_mutation_state_invalid"))
}
fn increment(value: i64) -> Result<i64> {
    value
        .checked_add(1)
        .filter(|v| (1..=MAX_SAFE).contains(v))
        .ok_or_else(|| error("local_state_authority_sequence_exhausted"))
}
fn signature(ctx: &Context, receipt: &Value) -> bool {
    let Some(value) = receipt["signature"].as_str() else {
        return false;
    };
    let Ok(bytes) = Base64::decode_vec(value) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&bytes) else {
        return false;
    };
    let Ok(payload) = contracts::online_mutation_signed_payload_v1(receipt) else {
        return false;
    };
    ctx.signing_key
        .verifying_key()
        .verify_strict(payload.as_bytes(), &signature)
        .is_ok()
}
fn stored_reservation(ctx: &Context, request: &Value, receipt: &Value) -> Result<()> {
    let issued = timestamp(&receipt["issuedAt"])
        .ok_or_else(|| error("local_state_authority_mutation_state_invalid"))?;
    if !contracts::verify_reservation_v1(receipt, request, &ctx.trust, issued, &|r| {
        signature(ctx, r)
    })? {
        return Err(error("local_state_authority_mutation_state_invalid"));
    }
    Ok(())
}
fn receipt_base(
    ctx: &Context,
    request: &Value,
    kind: &str,
    status: &str,
    remove: &[&str],
) -> Result<Value> {
    let mut result = request
        .as_object()
        .cloned()
        .ok_or_else(|| error("local_state_authority_request_invalid"))?;
    for key in remove {
        result.remove(*key);
    }
    result.insert("kind".into(), json!(kind));
    result.insert("status".into(), json!(status));
    result.insert(
        "authorityId".into(),
        ctx.configuration["authorityId"].clone(),
    );
    result.insert("keyId".into(), ctx.configuration["keyId"].clone());
    result.insert(
        "requestHash".into(),
        json!(hash(text(request, "kind")?, request)?),
    );
    Ok(Value::Object(result))
}
fn assert_heads(db: &Connection, request: &Value) -> Result<()> {
    let current = metadata(db)?;
    if current.schema_transition_state != "finalized"
        || current.global_sequence != int(request, "globalPreviousSequence")?
        || current.global_hash != text(request, "globalPreviousHash")?
    {
        return Err(error("local_state_authority_global_head_conflict"));
    }
    let head = db.query_row(
        "SELECT database_role,sequence,hash,schema_hash,state_hash FROM authority_database_head WHERE database_instance_id=?1",
        [text(request,"databaseInstanceId")?],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?)),
    ).optional()?;
    if head
        .as_ref()
        .is_none_or(|(role, seq, hash, schema, state)| {
            request["databaseRole"] != *role
                || request["databasePreviousSequence"].as_f64() != Some(*seq as f64)
                || request["databasePreviousHash"] != *hash
                || request["schemaHash"] != *schema
                || request["preStateHash"] != *state
        })
    {
        return Err(error("local_state_authority_database_head_conflict"));
    }
    Ok(())
}

fn reserve(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    contracts::assert_reserve_request_v1(request, &ctx.trust)?;
    let previous = db.query_row(
        "SELECT status,reserve_request_json,reservation_receipt_json FROM authority_mutation WHERE mutation_attempt_id=?1",
        [text(request,"mutationAttemptId")?],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)),
    ).optional()?;
    if let Some((status, raw_request, raw_receipt)) = previous {
        let saved = parsed(&raw_request)?;
        if status != "reserved" || saved != *request {
            return Err(error("local_state_authority_mutation_attempt_conflict"));
        }
        let receipt = parsed(&raw_receipt)?;
        stored_reservation(ctx, &saved, &receipt)?;
        return Ok(receipt);
    }
    let issued = ctx.now()?;
    assert_no_live_backup(db, &issued)?;
    if db.query_row(
        "SELECT count(*) FROM authority_mutation WHERE status='reserved'",
        [],
        |r| r.get::<_, i64>(0),
    )? != 0
    {
        return Err(error("local_state_authority_global_head_conflict"));
    }
    assert_heads(db, request)?;
    let global = increment(int(request, "globalPreviousSequence")?)?;
    let database = increment(int(request, "databasePreviousSequence")?)?;
    let mut receipt = receipt_base(
        ctx,
        request,
        "AutonomousResearchOnlineMutationReservationReceipt",
        "autonomous_research_online_mutation_reserved",
        &["requestedAt", "requestedLeaseMs"],
    )?;
    receipt["reservationId"] = json!(ctx.new_id("mutation")?);
    receipt["globalSequence"] = json!(global);
    receipt["globalHash"] = json!(hash(
        "HeptaLocalStateAuthorityGlobalHead",
        &json!({"previousSequence":request["globalPreviousSequence"],"previousHash":request["globalPreviousHash"],"requestHash":receipt["requestHash"],"globalSequence":global})
    )?);
    receipt["databaseSequence"] = json!(database);
    receipt["databaseHash"] = json!(hash(
        "HeptaLocalStateAuthorityDatabaseHead",
        &json!({"databaseInstanceId":request["databaseInstanceId"],"previousSequence":request["databasePreviousSequence"],"previousHash":request["databasePreviousHash"],"requestHash":receipt["requestHash"],"databaseSequence":database})
    )?);
    receipt["expiresAt"] = json!(ctx.expiry(&issued, int(request, "requestedLeaseMs")?)?);
    receipt["issuedAt"] = json!(issued);
    let receipt = ctx.sign_online(&receipt)?;
    stored_reservation(ctx, request, &receipt)?;
    db.execute("INSERT INTO authority_mutation(mutation_attempt_id,reservation_id,status,global_sequence,database_instance_id,reserve_request_json,reservation_receipt_json) VALUES(?1,?2,'reserved',?3,?4,?5,?6)",
        params![text(request,"mutationAttemptId")?,text(&receipt,"reservationId")?,global,text(request,"databaseInstanceId")?,encoded(request)?,encoded(&receipt)?])?;
    Ok(receipt)
}

struct Mutation {
    status: String,
    request: Value,
    reservation: Value,
    final_request: Option<String>,
    final_receipt: Option<String>,
    abort_request: Option<String>,
    abort_receipt: Option<String>,
}
fn mutation(db: &Connection, ctx: &Context, id: &str) -> Result<Mutation> {
    let row = db.query_row("SELECT status,reserve_request_json,reservation_receipt_json,finalize_request_json,finalization_receipt_json,abort_request_json,abort_receipt_json FROM authority_mutation WHERE reservation_id=?1",[id],|r| {
        Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<String>>(6)?))
    }).optional()?.ok_or_else(|| error("local_state_authority_mutation_reservation_required"))?;
    let result = Mutation {
        status: row.0,
        request: parsed(&row.1)?,
        reservation: parsed(&row.2)?,
        final_request: row.3,
        final_receipt: row.4,
        abort_request: row.5,
        abort_receipt: row.6,
    };
    stored_reservation(ctx, &result.request, &result.reservation)?;
    if result.reservation["reservationId"] != id {
        return Err(error("local_state_authority_mutation_state_invalid"));
    }
    Ok(result)
}
fn saved_result(
    request: &Value,
    saved_request: Option<&str>,
    saved_receipt: Option<&str>,
    code: &str,
) -> Result<Value> {
    let saved =
        saved_request.ok_or_else(|| error("local_state_authority_mutation_state_invalid"))?;
    if parsed(saved)? != *request {
        return Err(error(code));
    }
    parsed(saved_receipt.ok_or_else(|| error("local_state_authority_mutation_state_invalid"))?)
}
fn finalize(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    let entry = mutation(db, ctx, text(request, "reservationId")?)?;
    contracts::assert_finalize_request_v1(request, &entry.reservation)?;
    let now = ctx.now()?;
    let now_ms =
        timestamp(&json!(now)).ok_or_else(|| error("local_state_authority_clock_invalid"))?;
    if entry.status == "finalized" {
        let receipt = saved_result(
            request,
            entry.final_request.as_deref(),
            entry.final_receipt.as_deref(),
            "local_state_authority_mutation_finalization_conflict",
        )?;
        if !contracts::verify_finalization_v1(
            &receipt,
            request,
            &entry.reservation,
            &ctx.trust,
            now_ms,
            &|r| signature(ctx, r),
        )? {
            return Err(error("local_state_authority_mutation_state_invalid"));
        }
        return Ok(receipt);
    }
    if entry.status != "reserved" {
        return Err(error("local_state_authority_mutation_not_reserved"));
    }
    assert_heads(db, &entry.request)?;
    let mut receipt = receipt_base(
        ctx,
        request,
        "AutonomousResearchOnlineMutationFinalizationReceipt",
        "autonomous_research_online_mutation_finalized",
        &["committedAt"],
    )?;
    receipt["sideEffectPermitHash"] = json!(hash(
        "HeptaLocalStateAuthoritySideEffectPermit",
        &json!({"reservationId":request["reservationId"],"localMarkerHash":request["localMarkerHash"]})
    )?);
    receipt["finalizedAt"] = json!(now);
    let receipt = ctx.sign_online(&receipt)?;
    if !contracts::verify_finalization_v1(
        &receipt,
        request,
        &entry.reservation,
        &ctx.trust,
        now_ms,
        &|r| signature(ctx, r),
    )? {
        return Err(error(
            "local_state_authority_mutation_finalization_time_invalid",
        ));
    }
    db.execute(
        "UPDATE authority_metadata SET global_sequence=?1,global_hash=?2 WHERE singleton=1",
        params![
            int(request, "globalSequence")?,
            text(request, "globalHash")?
        ],
    )?;
    db.execute("UPDATE authority_database_head SET sequence=?1,hash=?2,schema_hash=?3,state_hash=?4 WHERE database_instance_id=?5",params![int(request,"databaseSequence")?,text(request,"databaseHash")?,text(request,"schemaHash")?,text(request,"postStateHash")?,text(request,"databaseInstanceId")?])?;
    db.execute("UPDATE authority_mutation SET status='finalized',finalize_request_json=?1,finalization_receipt_json=?2 WHERE reservation_id=?3",params![encoded(request)?,encoded(&receipt)?,text(request,"reservationId")?])?;
    Ok(receipt)
}
fn abort(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    let entry = mutation(db, ctx, text(request, "reservationId")?)?;
    contracts::assert_abort_request_v1(request, &entry.reservation)?;
    let now = ctx.now()?;
    let now_ms =
        timestamp(&json!(now)).ok_or_else(|| error("local_state_authority_clock_invalid"))?;
    if entry.status == "aborted" {
        let receipt = saved_result(
            request,
            entry.abort_request.as_deref(),
            entry.abort_receipt.as_deref(),
            "local_state_authority_mutation_abort_conflict",
        )?;
        if !contracts::verify_abort_v1(
            &receipt,
            request,
            &entry.reservation,
            &ctx.trust,
            now_ms,
            &|r| signature(ctx, r),
        )? {
            return Err(error("local_state_authority_mutation_state_invalid"));
        }
        return Ok(receipt);
    }
    if entry.status != "reserved" {
        return Err(error("local_state_authority_mutation_not_reserved"));
    }
    let mut receipt = receipt_base(
        ctx,
        request,
        "AutonomousResearchOnlineMutationAbortReceipt",
        "autonomous_research_online_mutation_aborted",
        &[],
    )?;
    receipt["abortedAt"] = json!(now);
    let receipt = ctx.sign_online(&receipt)?;
    if !contracts::verify_abort_v1(
        &receipt,
        request,
        &entry.reservation,
        &ctx.trust,
        now_ms,
        &|r| signature(ctx, r),
    )? {
        return Err(error("local_state_authority_mutation_abort_time_invalid"));
    }
    db.execute("UPDATE authority_mutation SET status='aborted',abort_request_json=?1,abort_receipt_json=?2 WHERE reservation_id=?3",params![encoded(request)?,encoded(&receipt)?,text(request,"reservationId")?])?;
    Ok(receipt)
}

fn exact_request(request: &Value, ctx: &Context, kind: &str, extra: &[&str]) -> Result<()> {
    let mut fields = vec![
        "version",
        "kind",
        "protocol",
        "scopeId",
        "databaseScopeHash",
        "writerManifestHash",
        "requestedAt",
    ];
    fields.extend_from_slice(extra);
    if !keys(request, &fields)
        || request["version"].as_f64() != Some(1.0)
        || request["kind"] != kind
        || request["protocol"] != ONLINE_MUTATION_PROTOCOL
        || ["scopeId", "databaseScopeHash", "writerManifestHash"]
            .iter()
            .any(|k| request[*k] != ctx.configuration[*k])
        || timestamp(&request["requestedAt"]).is_none()
    {
        return Err(error("local_state_authority_request_invalid"));
    }
    Ok(())
}
fn resolve(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    exact_request(
        request,
        ctx,
        "AutonomousResearchOnlineMutationResolutionRequest",
        &["mutationAttemptId", "reserveRequestHash"],
    )?;
    if !safe(&request["mutationAttemptId"]) || !sha(&request["reserveRequestHash"]) {
        return Err(error("local_state_authority_resolution_request_invalid"));
    }
    let row=db.query_row("SELECT status,reserve_request_json,reservation_receipt_json FROM authority_mutation WHERE mutation_attempt_id=?1",[text(request,"mutationAttemptId")?],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()?;
    let mut reservation = Value::Null;
    if let Some((status, saved, receipt)) = row {
        let saved = parsed(&saved)?;
        contracts::assert_resolution_request_v1(request, &saved)?;
        let observed = parsed(&receipt)?;
        stored_reservation(ctx, &saved, &observed)?;
        if status == "reserved" {
            reservation = observed;
        } else if !matches!(status.as_str(), "aborted" | "finalized") {
            return Err(error("local_state_authority_mutation_state_invalid"));
        }
    }
    let mut receipt = receipt_base(
        ctx,
        request,
        "AutonomousResearchOnlineMutationResolutionReceipt",
        "autonomous_research_online_mutation_resolution_observed",
        &[],
    )?;
    receipt["resolution"] = json!(if reservation.is_null() {
        "not-found"
    } else {
        "reserved"
    });
    receipt["reservation"] = reservation;
    receipt["observedAt"] = json!(ctx.now()?);
    ctx.sign_online(&receipt)
}
fn unresolved(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    activation::assert_unresolved_list_request_v1(request, &ctx.trust)?;
    let mut statement=db.prepare("SELECT reserve_request_json,reservation_receipt_json FROM authority_mutation WHERE status='reserved' AND database_instance_id=?1 ORDER BY mutation_attempt_id LIMIT 2")?;
    let rows = statement
        .query_map([text(request, "databaseInstanceId")?], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() > 1 {
        return Err(error(
            "local_state_authority_multiple_unresolved_reservations",
        ));
    }
    let mut entries = Vec::new();
    for (saved, receipt) in rows {
        let saved = parsed(&saved)?;
        let receipt = parsed(&receipt)?;
        stored_reservation(ctx, &saved, &receipt)?;
        if saved["databaseRole"] != request["databaseRole"]
            || saved["databaseInstanceId"] != request["databaseInstanceId"]
        {
            return Err(error("local_state_authority_mutation_state_invalid"));
        }
        entries.push(json!({"reserveRequest":saved,"reservation":receipt}));
    }
    let now = ctx.now()?;
    let mut receipt = receipt_base(
        ctx,
        request,
        "AutonomousResearchOnlineUnresolvedReservationListReceipt",
        "autonomous_research_online_unresolved_reservations_observed",
        &[],
    )?;
    receipt["unresolvedReservationCount"] = json!(entries.len());
    receipt["unresolvedReservationSetHash"] = json!(
        activation::unresolved_reservation_set_hash_v1(&json!(entries))?
    );
    receipt["unresolvedReservations"] = json!(entries);
    receipt["expiresAt"] =
        json!(ctx.expiry(&now, int(&ctx.configuration, "maximumObservationAgeMs")?)?);
    receipt["observedAt"] = json!(now);
    ctx.sign_online(&receipt)
}
fn head(db: &Connection, ctx: &Context, request: &Value, challenge: bool) -> Result<Value> {
    let now = ctx.now()?;
    let now_ms =
        timestamp(&json!(now)).ok_or_else(|| error("local_state_authority_clock_invalid"))?;
    if challenge {
        activation::verify_active_challenge_v1(
            &Value::Null,
            request,
            &ctx.trust,
            now_ms,
            None,
            &|_| false,
        )?;
    } else {
        contracts::verify_current_head_v1(
            &Value::Null,
            request,
            &ctx.trust,
            now_ms,
            None,
            &|_| false,
        )?;
    }
    let current = metadata(db)?;
    let (kind, status, time_key) = if challenge {
        (
            "AutonomousResearchOnlineMutationActiveChallengeReceipt",
            "autonomous_research_online_mutation_active_challenge_verified",
            "challengedAt",
        )
    } else {
        (
            "AutonomousResearchOnlineMutationCurrentHeadReceipt",
            "autonomous_research_online_mutation_current_head_observed",
            "observedAt",
        )
    };
    let mut receipt = receipt_base(
        ctx,
        request,
        kind,
        status,
        if challenge {
            &["requestedAt"]
        } else {
            &["requestedAt", "nonce"]
        },
    )?;
    receipt["globalSequence"] = json!(current.global_sequence);
    receipt["globalHash"] = json!(current.global_hash);
    receipt["databaseHeads"] = database_heads(db)?;
    if !challenge {
        receipt["unresolvedReservationCount"] = json!(db.query_row(
            "SELECT count(*) FROM authority_mutation WHERE status='reserved'",
            [],
            |r| r.get::<_, i64>(0)
        )?);
    }
    receipt["expiresAt"] =
        json!(ctx.expiry(&now, int(&ctx.configuration, "maximumObservationAgeMs")?)?);
    receipt[time_key] = json!(now);
    ctx.sign_online(&receipt)
}
fn scope(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    activation::assert_scope_request_v1(request, &ctx.trust)?;
    let current = metadata(db)?;
    let now = ctx.now()?;
    let mut receipt = receipt_base(
        ctx,
        request,
        "AutonomousResearchOnlineMutationScopeReceipt",
        "autonomous_research_online_mutation_scope_observed",
        &["requestedAt", "nonce"],
    )?;
    receipt["globalSequence"] = json!(current.global_sequence);
    receipt["globalHash"] = json!(current.global_hash);
    receipt["expiresAt"] =
        json!(ctx.expiry(&now, int(&ctx.configuration, "maximumObservationAgeMs")?)?);
    receipt["observedAt"] = json!(now);
    ctx.sign_online(&receipt)
}

#[cfg(test)]
mod tests;
