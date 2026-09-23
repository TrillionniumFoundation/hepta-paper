//! Backup authority transitions under the owner's IMMEDIATE transaction.
//! Signed fencing claims require a live lease and unchanged finalized head;
//! request serialization alone cannot fence a reserve-to-finalize interval.
use super::*;
use crate::{
    sqlite_mutation_coordinator::{ONLINE_MUTATION_PROTOCOL, contracts, sorted},
    state_backup_authority::{
        FINALIZED_JOURNAL_PROTOCOL, MAXIMUM_JOURNAL_ENTRIES,
        state_backup_authority_signature_payload_v1,
    },
};
use ed25519_dalek::Signature;
use rusqlite::params;
use std::collections::BTreeMap;

const RESERVE: &str = "AutonomousResearchStateBackupAuthorityReserveRequest";
const FINALIZE: &str = "AutonomousResearchStateBackupAuthorityFinalizeRequest";
const HEAD: &str = "AutonomousResearchStateBackupAuthorityCurrentHeadRequest";
const JOURNAL: &str = "AutonomousResearchStateBackupAuthorityJournalRangeRequest";
const RESERVE_KEYS: &[&str] = &[
    "version",
    "kind",
    "inventoryHash",
    "databaseScopeHash",
    "databaseInstanceIds",
    "requestedAt",
    "maximumLeaseMs",
];
const FINALIZE_KEYS: &[&str] = &[
    "version",
    "kind",
    "reservationId",
    "inventoryHash",
    "databaseScopeHash",
    "snapshotContentHash",
    "requestedAt",
];
const HEAD_KEYS: &[&str] = &[
    "version",
    "kind",
    "reservationId",
    "databaseScopeHash",
    "snapshotContentHash",
    "requestedAt",
    "maximumLeaseMs",
];
const JOURNAL_KEYS: &[&str] = &[
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

pub(super) fn handle(db: &Connection, ctx: &Context, request: &Value) -> Result<Value> {
    if db.is_autocommit() {
        return Err(error("local_state_authority_transaction_required"));
    }
    match request["kind"].as_str() {
        Some(RESERVE) => reserve(db, ctx, request),
        Some(FINALIZE) => finalize(db, ctx, request),
        Some(HEAD) => head(db, ctx, request),
        Some(JOURNAL) => journal(db, ctx, request),
        _ => Err(error("local_state_authority_request_kind_unsupported")),
    }
}
fn encoded(value: &Value) -> Result<String> {
    serde_json::to_string(value).map_err(|_| error("local_state_authority_backup_state_invalid"))
}
fn lease(ctx: &Context, request: &Value) -> Result<i64> {
    let duration = int(request, "maximumLeaseMs").ok().filter(|n| {
        *n >= 1000 && *n <= int(&ctx.configuration, "maximumReservationLeaseMs").unwrap_or(0)
    });
    if timestamp(&request["requestedAt"]).is_none() || duration.is_none() {
        return Err(error("local_state_authority_backup_lease_invalid"));
    }
    duration.ok_or_else(|| error("local_state_authority_backup_lease_invalid"))
}
fn reserve_valid(ctx: &Context, request: &Value) -> Result<()> {
    if !keys(request, RESERVE_KEYS)
        || request["version"].as_f64() != Some(1.0)
        || request["kind"] != RESERVE
        || !sha(&request["inventoryHash"])
        || request["databaseScopeHash"] != ctx.configuration["databaseScopeHash"]
        || !sorted(&request["databaseInstanceIds"], safe)
    {
        return Err(error(
            "local_state_authority_backup_reserve_request_invalid",
        ));
    }
    lease(ctx, request)?;
    Ok(())
}
fn quiescent(db: &Connection) -> Result<Metadata> {
    let current = metadata(db)?;
    if current.schema_transition_state != "finalized"
        || !(0..=MAX_SAFE).contains(&current.global_sequence)
        || !sha(&json!(current.global_hash))
        || db.query_row(
            "SELECT count(*) FROM authority_mutation WHERE status='reserved'",
            [],
            |r| r.get::<_, i64>(0),
        )? != 0
    {
        return Err(error("local_state_authority_backup_scope_not_quiescent"));
    }
    Ok(current)
}
fn signature(ctx: &Context, receipt: &Value, online: bool) -> bool {
    let Some(raw) = receipt["signature"].as_str() else {
        return false;
    };
    let Ok(bytes) = Base64::decode_vec(raw) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&bytes) else {
        return false;
    };
    let payload = if online {
        online_mutation_signed_payload_v1(receipt)
    } else {
        state_backup_authority_signature_payload_v1(receipt)
    };
    payload.is_ok_and(|p| {
        ctx.signing_key
            .verifying_key()
            .verify_strict(p.as_bytes(), &sig)
            .is_ok()
    })
}
fn base(ctx: &Context, request: &Value, kind: &str, status: &str) -> Result<Value> {
    Ok(
        json!({"version":1,"kind":kind,"status":status,"authorityId":ctx.configuration["authorityId"],"keyId":ctx.configuration["keyId"],"requestHash":hash(text(request,"kind")?,request)?}),
    )
}
fn extend_body(body: &mut Value, fields: Value) -> Result<()> {
    let (Value::Object(body), Value::Object(fields)) = (body, fields) else {
        return Err(error("local_state_authority_backup_state_invalid"));
    };
    body.extend(fields);
    Ok(())
}
fn reservation_body(
    ctx: &Context,
    q: &Value,
    id: &str,
    sequence: i64,
    head: &str,
    issued: &str,
) -> Result<Value> {
    let mut r = base(
        ctx,
        q,
        "AutonomousResearchStateBackupAuthorityReservation",
        "autonomous_research_state_backup_authority_reserved",
    )?;
    extend_body(
        &mut r,
        json!({"reservationId":id,"inventoryHash":q["inventoryHash"],"databaseScopeHash":q["databaseScopeHash"],"databaseInstanceIds":q["databaseInstanceIds"],"headSequence":sequence,"headHash":head,"issuedAt":issued,"expiresAt":ctx.expiry(issued,lease(ctx,q)?)?,"mutationFenceProtocol":ONLINE_MUTATION_PROTOCOL,"allRegisteredMutationsFenced":true}),
    )?;
    Ok(r)
}
fn stored_reservation(ctx: &Context, q: &Value, r: &Value, id: &str) -> Result<()> {
    let code = "local_state_authority_backup_state_invalid";
    reserve_valid(ctx, q).map_err(|_| error(code))?;
    let seq = int(r, "headSequence").map_err(|_| error(code))?;
    if seq < 0
        || !safe(&r["reservationId"])
        || r["reservationId"] != id
        || !sha(&r["headHash"])
        || !signature(ctx, r, false)
    {
        return Err(error(code));
    }
    let mut expected =
        reservation_body(ctx, q, id, seq, text(r, "headHash")?, text(r, "issuedAt")?)?;
    expected["signature"] = r["signature"].clone();
    if expected != *r {
        return Err(error(code));
    }
    Ok(())
}
fn reserve(db: &Connection, ctx: &Context, q: &Value) -> Result<Value> {
    reserve_valid(ctx, q)?;
    let current = quiescent(db)?;
    let heads = database_heads(db)?;
    let ids = heads
        .as_array()
        .ok_or_else(|| error("local_state_authority_backup_state_invalid"))?
        .iter()
        .map(|h| h["databaseInstanceId"].clone())
        .collect::<Vec<_>>();
    if ids.is_empty() || q["databaseInstanceIds"] != json!(ids) {
        return Err(error("local_state_authority_backup_scope_not_quiescent"));
    }
    let issued = ctx.now()?;
    assert_no_live_backup(db, &issued)?;
    let receipt = ctx.sign_backup(&reservation_body(
        ctx,
        q,
        &ctx.new_id("backup")?,
        current.global_sequence,
        &current.global_hash,
        &issued,
    )?)?;
    db.execute("INSERT INTO authority_backup_reservation(reservation_id,reserve_request_json,reservation_receipt_json) VALUES(?1,?2,?3)",params![text(&receipt,"reservationId")?,encoded(q)?,encoded(&receipt)?])?;
    Ok(receipt)
}
fn finalization_body(ctx: &Context, q: &Value, r: &Value, at: &str) -> Result<Value> {
    let mut value = base(
        ctx,
        q,
        "AutonomousResearchStateBackupAuthorityFinalization",
        "autonomous_research_state_backup_authority_finalized",
    )?;
    extend_body(
        &mut value,
        json!({"reservationId":r["reservationId"],"inventoryHash":r["inventoryHash"],"databaseScopeHash":r["databaseScopeHash"],"snapshotContentHash":q["snapshotContentHash"],"headSequence":r["headSequence"],"headHash":r["headHash"],"finalizedAt":at,"allRegisteredMutationsFencedThroughFinalize":true}),
    )?;
    Ok(value)
}
fn finalize(db: &Connection, ctx: &Context, q: &Value) -> Result<Value> {
    if !keys(q, FINALIZE_KEYS)
        || q["version"].as_f64() != Some(1.0)
        || q["kind"] != FINALIZE
        || !safe(&q["reservationId"])
        || !sha(&q["inventoryHash"])
        || q["databaseScopeHash"] != ctx.configuration["databaseScopeHash"]
        || !sha(&q["snapshotContentHash"])
        || timestamp(&q["requestedAt"]).is_none()
    {
        return Err(error(
            "local_state_authority_backup_finalize_request_invalid",
        ));
    }
    let id = text(q, "reservationId")?;
    let row=db.query_row("SELECT reserve_request_json,reservation_receipt_json,finalize_request_json,finalization_receipt_json FROM authority_backup_reservation WHERE reservation_id=?",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?))).optional()?.ok_or_else(||error("local_state_authority_backup_reservation_required"))?;
    let code = "local_state_authority_backup_state_invalid";
    let original = parse_record(&row.0, code)?;
    let reservation = parse_record(&row.1, code)?;
    stored_reservation(ctx, &original, &reservation, id)?;
    if q["inventoryHash"] != reservation["inventoryHash"]
        || q["databaseScopeHash"] != reservation["databaseScopeHash"]
    {
        return Err(error("local_state_authority_backup_finalize_mismatch"));
    }
    let issued = timestamp(&reservation["issuedAt"]).ok_or_else(|| error(code))?;
    let expires = timestamp(&reservation["expiresAt"]).ok_or_else(|| error(code))?;
    if let Some(raw) = row.3 {
        let previous = parse_record(row.2.as_deref().ok_or_else(|| error(code))?, code)?;
        if previous != *q {
            return Err(error("local_state_authority_backup_finalize_conflict"));
        }
        let receipt = parse_record(&raw, code)?;
        let at = text(&receipt, "finalizedAt")?;
        let time = timestamp(&json!(at)).ok_or_else(|| error(code))?;
        let mut expected = finalization_body(ctx, q, &reservation, at)?;
        expected["signature"] = receipt["signature"].clone();
        if time < issued
            || time >= expires
            || expected != receipt
            || !signature(ctx, &receipt, false)
        {
            return Err(error(code));
        }
        return Ok(receipt);
    }
    if row.2.is_some() {
        return Err(error(code));
    }
    let current = quiescent(db)?;
    if current.global_sequence != int(&reservation, "headSequence")?
        || current.global_hash != text(&reservation, "headHash")?
    {
        return Err(error("local_state_authority_backup_head_conflict"));
    }
    let at = ctx.now()?;
    let time = timestamp(&json!(at)).ok_or_else(|| error(code))?;
    if time < issued || time >= expires {
        return Err(error("local_state_authority_backup_lease_expired"));
    }
    let receipt = ctx.sign_backup(&finalization_body(ctx, q, &reservation, &at)?)?;
    if db.execute("UPDATE authority_backup_reservation SET finalize_request_json=?1,finalization_receipt_json=?2 WHERE reservation_id=?3 AND finalization_receipt_json IS NULL",params![encoded(q)?,encoded(&receipt)?,id])?!=1 {return Err(error(code));}
    Ok(receipt)
}
fn head(db: &Connection, ctx: &Context, q: &Value) -> Result<Value> {
    if !keys(q, HEAD_KEYS)
        || q["version"].as_f64() != Some(1.0)
        || q["kind"] != HEAD
        || !safe(&q["reservationId"])
        || q["databaseScopeHash"] != ctx.configuration["databaseScopeHash"]
        || !sha(&q["snapshotContentHash"])
    {
        return Err(error("local_state_authority_backup_head_request_invalid"));
    }
    let duration = lease(ctx, q)?;
    let current = quiescent(db)?;
    let at = ctx.now()?;
    let mut receipt = base(
        ctx,
        q,
        "AutonomousResearchStateBackupAuthorityCurrentHead",
        "autonomous_research_state_backup_authority_head_observed",
    )?;
    extend_body(
        &mut receipt,
        json!({"reservationId":q["reservationId"],"databaseScopeHash":q["databaseScopeHash"],"headSequence":current.global_sequence,"headHash":current.global_hash,"observedAt":at,"expiresAt":ctx.expiry(&at,duration)?,"mutationFenceProtocol":"external-linearizable-restore-validation-v1","allRegisteredMutationsFenced":true}),
    )?;
    ctx.sign_backup(&receipt)
}
fn journal(db: &Connection, ctx: &Context, q: &Value) -> Result<Value> {
    if !keys(q, JOURNAL_KEYS)
        || q["version"].as_f64() != Some(1.0)
        || q["kind"] != JOURNAL
        || !safe(&q["reservationId"])
        || q["databaseScopeHash"] != ctx.configuration["databaseScopeHash"]
        || !sha(&q["snapshotContentHash"])
        || q["onlineAuthorityId"] != ctx.configuration["authorityId"]
        || q["onlineKeyId"] != ctx.configuration["keyId"]
        || q["scopeId"] != ctx.configuration["scopeId"]
        || q["writerManifestHash"] != ctx.configuration["writerManifestHash"]
        || !integer(&q["fromGlobalSequence"], 0)
        || !integer(&q["toGlobalSequence"], 1)
        || int(q, "toGlobalSequence")? <= int(q, "fromGlobalSequence")?
        || !sha(&q["fromGlobalHash"])
        || !sha(&q["toGlobalHash"])
        || !integer(&q["maximumEntries"], 1)
        || int(q, "maximumEntries")? > MAXIMUM_JOURNAL_ENTRIES
    {
        return Err(error(
            "local_state_authority_backup_journal_request_invalid",
        ));
    }
    let duration = lease(ctx, q)?;
    let current = quiescent(db)?;
    let from = int(q, "fromGlobalSequence")?;
    let to = int(q, "toGlobalSequence")?;
    if current.global_sequence != to || current.global_hash != text(q, "toGlobalHash")? {
        return Err(error(
            "local_state_authority_backup_journal_head_unavailable",
        ));
    }
    if to - from > int(q, "maximumEntries")? {
        return Err(error("local_state_authority_backup_journal_incomplete"));
    }
    let mut statement=db.prepare("SELECT reserve_request_json,reservation_receipt_json,finalize_request_json,finalization_receipt_json FROM authority_mutation WHERE status='finalized' AND global_sequence>?1 AND global_sequence<=?2 ORDER BY global_sequence")?;
    let rows = statement
        .query_map(params![from, to], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.len() as i64 != to - from {
        return Err(error("local_state_authority_backup_journal_incomplete"));
    }
    let mut global = q["fromGlobalHash"].clone();
    let mut touched = BTreeMap::<String, Value>::new();
    let mut entries = Vec::new();
    for (sequence, row) in (from..).zip(rows) {
        let code = "local_state_authority_mutation_state_invalid";
        let reserve = parse_record(&row.0, code)?;
        let r = parse_record(&row.1, code)?;
        let finalize = parse_record(&row.2, code)?;
        let f = parse_record(&row.3, code)?;
        let issued = timestamp(&r["issuedAt"]).ok_or_else(|| error(code))?;
        let finalized = timestamp(&f["finalizedAt"]).ok_or_else(|| error(code))?;
        if !contracts::verify_reservation_v1(&r, &reserve, &ctx.trust, issued, &|r| {
            signature(ctx, r, true)
        })? || !contracts::verify_finalization_v1(
            &f,
            &finalize,
            &r,
            &ctx.trust,
            finalized,
            &|r| signature(ctx, r, true),
        )? {
            return Err(error(code));
        }
        let id = text(&r, "databaseInstanceId")?.to_owned();
        if int(&r, "globalPreviousSequence")? != sequence
            || r["globalPreviousHash"] != global
            || int(&r, "globalSequence")? != sequence + 1
        {
            return Err(error("local_state_authority_backup_journal_chain_invalid"));
        }
        if let Some(previous) = touched.get(&id)
            && (int(&r, "databasePreviousSequence")? != int(previous, "databaseSequence")?
                || r["databasePreviousHash"] != previous["databaseHash"]
                || r["preStateHash"] != previous["postStateHash"]
                || r["schemaHash"] != previous["schemaHash"]
                || r["databaseRole"] != previous["databaseRole"])
        {
            return Err(error("local_state_authority_backup_journal_chain_invalid"));
        }
        global = r["globalHash"].clone();
        touched.insert(id, r.clone());
        entries.push(json!({"reserveRequest":reserve,"reservationReceipt":r,"finalizeRequest":finalize,"finalizationReceipt":f}));
    }
    if global != q["toGlobalHash"] {
        return Err(error("local_state_authority_backup_journal_chain_invalid"));
    }
    let heads = database_heads(db)?;
    for (id, r) in touched {
        let h = heads
            .as_array()
            .and_then(|a| a.iter().find(|h| h["databaseInstanceId"] == id))
            .ok_or_else(|| error("local_state_authority_backup_journal_chain_invalid"))?;
        if int(h, "sequence")? != int(&r, "databaseSequence")?
            || h["hash"] != r["databaseHash"]
            || h["schemaHash"] != r["schemaHash"]
            || h["stateHash"] != r["postStateHash"]
            || h["databaseRole"] != r["databaseRole"]
        {
            return Err(error("local_state_authority_backup_journal_chain_invalid"));
        }
    }
    let at = ctx.now()?;
    let mut receipt = base(
        ctx,
        q,
        "AutonomousResearchStateBackupAuthorityJournalRange",
        "autonomous_research_state_backup_authority_journal_range_complete",
    )?;
    for k in [
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
    ] {
        receipt[k] = q[k].clone();
    }
    extend_body(
        &mut receipt,
        json!({"databaseHeads":heads,"entries":entries,"observedAt":at,"expiresAt":ctx.expiry(&at,duration)?,"mutationFenceProtocol":FINALIZED_JOURNAL_PROTOCOL,"completeFinalizedMutationJournal":true}),
    )?;
    ctx.sign_backup(&receipt)
}

#[cfg(test)]
mod tests;
