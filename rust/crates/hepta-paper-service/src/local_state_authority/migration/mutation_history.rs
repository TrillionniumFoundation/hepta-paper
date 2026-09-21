//! Pure, bounded-snapshot verification of the original authority mutation log.
//! This observes signatures and a complete chain relative to a separately
//! verified schema epoch. It grants no migration or business-write authority.
use super::{schema_history::verify_online_signature_v1, source_rows::JournalRows};
use crate::{
    local_state_authority::parse_record,
    sqlite_mutation_coordinator::{
        DATABASE_ROLES, Result, contracts, error, hash, int, integer, keys, role, safe, sha, text,
        timestamp,
    },
};
use ed25519_dalek::VerifyingKey;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const INVALID: &str = "local_authority_mutation_history_invalid";
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// No deserializer or public constructor. The supplied epoch and key remain
/// the caller's authentication responsibility; this is not a stop capability.
pub(super) struct MutationHistoryObservationV1 {
    head: Value,
    report: Value,
}
impl MutationHistoryObservationV1 {
    pub(super) fn head(&self) -> &Value {
        &self.head
    }
    pub(super) fn report(&self) -> &Value {
        &self.report
    }
}

pub(super) fn verify_mutation_history_v1(
    rows: &JournalRows,
    genesis: &Value,
    trust: &Value,
    public_key: &VerifyingKey,
) -> Result<MutationHistoryObservationV1> {
    contracts::assert_authority_trust_v1(trust)?;
    let mut heads = genesis_heads(genesis)?;
    let mut sequence = 0_i64;
    let mut global_hash = text(genesis, "globalHash")?.to_owned();
    let mut finalized = 0_u64;
    let mut aborted = 0_u64;
    let mut attempts = BTreeSet::new();
    let mut reservations = BTreeSet::new();
    let mut rowids = BTreeSet::new();
    // Snapshot order is physical rowid, not authenticated chronology. Sort only
    // borrowed rows by their SQL global sequence and then verify every link.
    let mut ordered = rows.mutations().iter().collect::<Vec<_>>();
    for row in &ordered {
        if row.len() != 12 || row[0].as_i64().is_none() || !integer(&row[4], 1) {
            return Err(error(INVALID));
        }
    }
    ordered.sort_by_key(|row| row[4].as_i64().unwrap_or(-1));
    for row in ordered {
        let id = row[0].as_i64().ok_or_else(|| error(INVALID))?;
        if !rowids.insert(id)
            || !safe(&row[1])
            || !safe(&row[2])
            || !safe(&row[5])
            || !attempts.insert(row[1].as_str().ok_or_else(|| error(INVALID))?)
            || !reservations.insert(row[2].as_str().ok_or_else(|| error(INVALID))?)
            || aborted != 0
        {
            return Err(error(INVALID));
        }
        let status = row[3].as_str().ok_or_else(|| error(INVALID))?;
        match status {
            "finalized"
                if row[8].is_string()
                    && row[9].is_string()
                    && row[10].is_null()
                    && row[11].is_null() => {}
            "aborted"
                if row[8].is_null()
                    && row[9].is_null()
                    && row[10].is_string()
                    && row[11].is_string() => {}
            "reserved" => return Err(error("local_authority_mutation_history_unresolved")),
            _ => return Err(error(INVALID)),
        }
        let request = record(&row[6])?;
        let reservation = record(&row[7])?;
        let issued = timestamp(&reservation["issuedAt"]).ok_or_else(|| error(INVALID))?;
        if !contracts::verify_reservation_v1(&reservation, &request, trust, issued, &|r| {
            verify_online_signature_v1(r, public_key)
        })? || request["mutationAttemptId"] != row[1]
            || reservation["mutationAttemptId"] != row[1]
            || reservation["reservationId"] != row[2]
            || request["databaseInstanceId"] != row[5]
            || reservation["databaseInstanceId"] != row[5]
            || int(&reservation, "globalSequence")? != number(&row[4])?
        {
            return Err(error(INVALID));
        }
        let instance = text(&request, "databaseInstanceId")?;
        let previous = heads.get(instance).ok_or_else(|| error(INVALID))?;
        let next_global = increment(sequence)?;
        let next_database = increment(int(previous, "sequence")?)?;
        if number(&row[4])? != next_global
            || int(&request, "globalPreviousSequence")? != sequence
            || request["globalPreviousHash"] != global_hash
            || int(&request, "databasePreviousSequence")? != int(previous, "sequence")?
            || request["databasePreviousHash"] != previous["hash"]
            || request["databaseRole"] != previous["databaseRole"]
            || request["schemaContractId"] != previous["schemaContractId"]
            || request["schemaHash"] != previous["schemaHash"]
            || request["preStateHash"] != previous["stateHash"]
            || int(&reservation, "databaseSequence")? != next_database
        {
            return Err(error(INVALID));
        }
        // The generic receipt contract accepts SHA-shaped head strings. The
        // incumbent authority additionally derives these exact domain hashes.
        let request_hash = hash("AutonomousResearchOnlineMutationReserveRequest", &request)?;
        let expected_global = hash(
            "HeptaLocalStateAuthorityGlobalHead",
            &json!({
                "previousSequence":sequence,"previousHash":global_hash,
                "requestHash":request_hash,"globalSequence":next_global
            }),
        )?;
        let expected_database = hash(
            "HeptaLocalStateAuthorityDatabaseHead",
            &json!({
                "databaseInstanceId":instance,"previousSequence":previous["sequence"],
                "previousHash":previous["hash"],"requestHash":request_hash,
                "databaseSequence":next_database
            }),
        )?;
        if reservation["globalHash"] != expected_global
            || reservation["databaseHash"] != expected_database
        {
            return Err(error(INVALID));
        }
        if status == "finalized" {
            let final_request = record(&row[8])?;
            let final_receipt = record(&row[9])?;
            let at = timestamp(&final_receipt["finalizedAt"]).ok_or_else(|| error(INVALID))?;
            if !contracts::verify_finalization_v1(
                &final_receipt,
                &final_request,
                &reservation,
                trust,
                at,
                &|r| verify_online_signature_v1(r, public_key),
            )? || final_receipt["sideEffectPermitHash"]
                != hash(
                    "HeptaLocalStateAuthoritySideEffectPermit",
                    &json!({"reservationId":final_request["reservationId"],"localMarkerHash":final_request["localMarkerHash"]}),
                )?
            {
                return Err(error(INVALID));
            }
            let mut next = previous.clone();
            next["sequence"] = json!(next_database);
            next["hash"] = json!(expected_database);
            next["stateHash"] = request["postStateHash"].clone();
            heads.insert(instance.to_owned(), next);
            sequence = next_global;
            global_hash = expected_global;
            finalized += 1;
        } else {
            let abort_request = record(&row[10])?;
            let abort_receipt = record(&row[11])?;
            let at = timestamp(&abort_receipt["abortedAt"]).ok_or_else(|| error(INVALID))?;
            if !contracts::verify_abort_v1(
                &abort_receipt,
                &abort_request,
                &reservation,
                trust,
                at,
                &|r| verify_online_signature_v1(r, public_key),
            )? {
                return Err(error(INVALID));
            }
            // The original unconditional SQL UNIQUE(global_sequence) consumes
            // this next slot forever. A genuine abort can only be the tail.
            aborted += 1;
        }
    }
    let head = json!({"globalSequence":sequence,"globalHash":global_hash,
        "databaseHeads":heads.values().collect::<Vec<_>>()});
    assert_actual_head(rows, &head, trust)?;
    Ok(MutationHistoryObservationV1 {
        head,
        report: json!({"version":1,"kind":"HeptaLegacyAuthorityMutationHistoryObservationV1",
            "evidenceScope":"signed_mutation_history_relative_to_schema_epoch_no_migration_authority",
            "mutationRows":rows.mutations().len(),"finalizedMutations":finalized,
            "abortedTailMutations":aborted}),
    })
}

fn record(raw: &Value) -> Result<Value> {
    parse_record(raw.as_str().ok_or_else(|| error(INVALID))?, INVALID)
}
fn number(value: &Value) -> Result<i64> {
    if !integer(value, 0) {
        return Err(error(INVALID));
    }
    Ok(value.as_f64().ok_or_else(|| error(INVALID))? as i64)
}
fn increment(value: i64) -> Result<i64> {
    value
        .checked_add(1)
        .filter(|v| (1..=MAX_SAFE).contains(v))
        .ok_or_else(|| error(INVALID))
}
fn genesis_heads(genesis: &Value) -> Result<BTreeMap<String, Value>> {
    if !keys(genesis, &["globalSequence", "globalHash", "databaseHeads"])
        || number(&genesis["globalSequence"])? != 0
        || !sha(&genesis["globalHash"])
    {
        return Err(error(INVALID));
    }
    let entries = genesis["databaseHeads"]
        .as_array()
        .filter(|h| h.len() == DATABASE_ROLES.len())
        .ok_or_else(|| error(INVALID))?;
    let mut roles = BTreeSet::new();
    let mut heads = BTreeMap::new();
    for entry in entries {
        if !keys(
            entry,
            &[
                "databaseRole",
                "databaseInstanceId",
                "schemaContractId",
                "sequence",
                "hash",
                "schemaHash",
                "stateHash",
            ],
        ) || !role(&entry["databaseRole"])
            || !safe(&entry["databaseInstanceId"])
            || !safe(&entry["schemaContractId"])
            || number(&entry["sequence"])? != 0
            || !["hash", "schemaHash", "stateHash"]
                .iter()
                .all(|k| sha(&entry[k]))
            || !roles.insert(text(entry, "databaseRole")?)
            || heads
                .insert(text(entry, "databaseInstanceId")?.to_owned(), entry.clone())
                .is_some()
        {
            return Err(error(INVALID));
        }
    }
    Ok(heads)
}

fn assert_actual_head(rows: &JournalRows, head: &Value, trust: &Value) -> Result<()> {
    let metadata = rows.metadata();
    if metadata.len() != 1 || metadata[0].len() != 11 {
        return Err(error(INVALID));
    }
    let m = &metadata[0];
    if number(&m[1])? != 1
        || m[10] != "finalized"
        || number(&m[8])? != int(head, "globalSequence")?
        || m[9] != head["globalHash"]
        || m[3] != trust["authorityId"]
        || m[4] != trust["keyId"]
        || m[5] != trust["scopeId"]
        || m[6] != trust["databaseScopeHash"]
        || m[7] != trust["writerManifestHash"]
        || rows.heads().len() != DATABASE_ROLES.len()
    {
        return Err(error(INVALID));
    }
    let mut actual = BTreeMap::new();
    for row in rows.heads() {
        if row.len() != 7
            || !safe(&row[1])
            || !role(&row[2])
            || !integer(&row[3], 0)
            || ![4, 5, 6].iter().all(|i| sha(&row[*i]))
        {
            return Err(error(INVALID));
        }
        if actual
            .insert(row[1].as_str().ok_or_else(|| error(INVALID))?, row)
            .is_some()
        {
            return Err(error(INVALID));
        }
    }
    for expected in head["databaseHeads"]
        .as_array()
        .ok_or_else(|| error(INVALID))?
    {
        let row = actual
            .get(text(expected, "databaseInstanceId")?)
            .ok_or_else(|| error(INVALID))?;
        if row[2] != expected["databaseRole"]
            || number(&row[3])? != int(expected, "sequence")?
            || row[4] != expected["hash"]
            || row[5] != expected["schemaHash"]
            || row[6] != expected["stateHash"]
        {
            return Err(error(INVALID));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "mutation_history/tests.rs"]
mod tests;
