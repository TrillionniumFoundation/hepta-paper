//! Verification of retained legacy backup rows. Fencing booleans are historical
//! claims only: admission additionally requires an empty mutation history and an
//! exact signed terminal head, so no reserve-to-finalize mutation interval exists.
use super::source_rows::JournalRows;
use crate::{
    sqlite_mutation_coordinator::{Result, error, hash, keys, sha, timestamp},
    state_backup_authority::state_backup_authority_signature_payload_v1,
};
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const RESERVE_KEYS: &[&str] = &[
    "version",
    "kind",
    "inventoryHash",
    "databaseScopeHash",
    "databaseInstanceIds",
    "requestedAt",
    "maximumLeaseMs",
];
const RESERVATION_KEYS: &[&str] = &[
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
const FINALIZE_KEYS: &[&str] = &[
    "version",
    "kind",
    "reservationId",
    "inventoryHash",
    "databaseScopeHash",
    "snapshotContentHash",
    "requestedAt",
];
const FINALIZATION_KEYS: &[&str] = &[
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

fn number(value: &Value) -> Option<i64> {
    value
        .as_f64()
        .filter(|value| {
            value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
        })
        .map(|value| value as i64)
}
fn safe_id(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        (2..=192).contains(&value.len())
            && value.as_bytes()[0].is_ascii_alphanumeric()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    })
}
fn signature(value: &Value, key: &VerifyingKey) -> bool {
    let Some(raw) = value["signature"].as_str() else {
        return false;
    };
    let Ok(bytes) = Base64::decode_vec(raw) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&bytes) else {
        return false;
    };
    state_backup_authority_signature_payload_v1(value)
        .is_ok_and(|payload| key.verify_strict(payload.as_bytes(), &signature).is_ok())
}
fn record(raw: &Value) -> Result<Value> {
    let text = raw
        .as_str()
        .ok_or_else(|| error("local_authority_backup_history_row_invalid"))?;
    super::super::parse_record(text, "local_authority_backup_history_row_invalid")
}
fn exact_ids(head: &Value) -> Result<Value> {
    let mut ids = head["databaseHeads"]
        .as_array()
        .ok_or_else(|| error("local_authority_backup_history_terminal_head_invalid"))?
        .iter()
        .map(|value| {
            value["databaseInstanceId"]
                .as_str()
                .filter(|_| safe_id(&value["databaseInstanceId"]))
                .map(str::to_owned)
                .ok_or_else(|| error("local_authority_backup_history_terminal_head_invalid"))
        })
        .collect::<Result<Vec<_>>>()?;
    ids.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    if ids.is_empty() || ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(error(
            "local_authority_backup_history_terminal_head_invalid",
        ));
    }
    Ok(json!(ids))
}

pub(super) fn verify_backup_history_v1(
    rows: &JournalRows,
    terminal: &Value,
    configuration: &Value,
    key: &VerifyingKey,
) -> Result<Value> {
    if rows.backups().is_empty() {
        return Ok(json!({
            "finalizedBackupCount":0,
            "uniqueInventoryHashCount":0,
            "admissionPolicy":"empty_backup_history",
            "historicalFenceClaimsUsedAsAuthority":false,
        }));
    }
    // This is the independent fact that makes historical reserve/finalize fence
    // claims unnecessary. A non-empty mutation ledger remains a future migration
    // profile even when every backup receipt is correctly signed.
    if !rows.mutations().is_empty() || number(&terminal["globalSequence"]) != Some(0) {
        return Err(error(
            "local_authority_backup_history_requires_empty_mutation_history",
        ));
    }
    let terminal_hash = terminal["globalHash"]
        .as_str()
        .filter(|_| sha(&terminal["globalHash"]))
        .ok_or_else(|| error("local_authority_backup_history_terminal_head_invalid"))?;
    let ids = exact_ids(terminal)?;
    let maximum_lease = number(&configuration["maximumReservationLeaseMs"])
        .filter(|value| *value >= 1_000)
        .ok_or_else(|| error("local_authority_backup_history_configuration_invalid"))?;
    let mut previous_rowid = 0i64;
    let mut reservation_ids = BTreeSet::new();
    let mut inventory_hashes = BTreeSet::new();
    let mut first_finalized = None::<i64>;
    let mut last_finalized = None::<i64>;
    for row in rows.backups() {
        if row.len() != 6 {
            return Err(error("local_authority_backup_history_row_invalid"));
        }
        let rowid = number(&row[0])
            .filter(|value| *value > previous_rowid)
            .ok_or_else(|| error("local_authority_backup_history_row_invalid"))?;
        previous_rowid = rowid;
        let id = row[1]
            .as_str()
            .filter(|_| safe_id(&row[1]))
            .ok_or_else(|| error("local_authority_backup_history_row_invalid"))?;
        if !reservation_ids.insert(id.to_owned()) || row[4].is_null() || row[5].is_null() {
            return Err(error("local_authority_backup_history_unresolved"));
        }
        let reserve = record(&row[2])?;
        let reservation = record(&row[3])?;
        let finalize = record(&row[4])?;
        let finalization = record(&row[5])?;
        let issued = timestamp(&reservation["issuedAt"])
            .ok_or_else(|| error("local_authority_backup_history_time_invalid"))?;
        let expires = timestamp(&reservation["expiresAt"])
            .ok_or_else(|| error("local_authority_backup_history_time_invalid"))?;
        let finalized = timestamp(&finalization["finalizedAt"])
            .ok_or_else(|| error("local_authority_backup_history_time_invalid"))?;
        let requested = timestamp(&reserve["requestedAt"])
            .ok_or_else(|| error("local_authority_backup_history_time_invalid"))?;
        let finalize_requested = timestamp(&finalize["requestedAt"])
            .ok_or_else(|| error("local_authority_backup_history_time_invalid"))?;
        if !keys(&reserve, RESERVE_KEYS)
            || number(&reserve["version"]) != Some(1)
            || reserve["kind"] != "AutonomousResearchStateBackupAuthorityReserveRequest"
            || !sha(&reserve["inventoryHash"])
            || reserve["databaseScopeHash"] != configuration["databaseScopeHash"]
            || reserve["databaseInstanceIds"] != ids
            || number(&reserve["maximumLeaseMs"])
                .is_none_or(|value| !(1_000..=maximum_lease).contains(&value))
            || !keys(&reservation, RESERVATION_KEYS)
            || number(&reservation["version"]) != Some(1)
            || reservation["kind"] != "AutonomousResearchStateBackupAuthorityReservation"
            || reservation["status"] != "autonomous_research_state_backup_authority_reserved"
            || reservation["authorityId"] != configuration["authorityId"]
            || reservation["keyId"] != configuration["keyId"]
            || reservation["requestHash"]
                != hash(
                    "AutonomousResearchStateBackupAuthorityReserveRequest",
                    &reserve,
                )?
            || reservation["reservationId"] != id
            || reservation["inventoryHash"] != reserve["inventoryHash"]
            || reservation["databaseScopeHash"] != reserve["databaseScopeHash"]
            || reservation["databaseInstanceIds"] != ids
            || number(&reservation["headSequence"]) != Some(0)
            || reservation["headHash"] != terminal_hash
            || reservation["mutationFenceProtocol"]
                != "external-linearizable-reserve-apply-finalize-v1"
            || reservation["allRegisteredMutationsFenced"] != true
            || !signature(&reservation, key)
            || !keys(&finalize, FINALIZE_KEYS)
            || number(&finalize["version"]) != Some(1)
            || finalize["kind"] != "AutonomousResearchStateBackupAuthorityFinalizeRequest"
            || finalize["reservationId"] != id
            || finalize["inventoryHash"] != reservation["inventoryHash"]
            || finalize["databaseScopeHash"] != reservation["databaseScopeHash"]
            || !sha(&finalize["snapshotContentHash"])
            || !keys(&finalization, FINALIZATION_KEYS)
            || number(&finalization["version"]) != Some(1)
            || finalization["kind"] != "AutonomousResearchStateBackupAuthorityFinalization"
            || finalization["status"] != "autonomous_research_state_backup_authority_finalized"
            || finalization["authorityId"] != configuration["authorityId"]
            || finalization["keyId"] != configuration["keyId"]
            || finalization["requestHash"]
                != hash(
                    "AutonomousResearchStateBackupAuthorityFinalizeRequest",
                    &finalize,
                )?
            || finalization["reservationId"] != id
            || finalization["inventoryHash"] != reservation["inventoryHash"]
            || finalization["databaseScopeHash"] != reservation["databaseScopeHash"]
            || finalization["snapshotContentHash"] != finalize["snapshotContentHash"]
            || number(&finalization["headSequence"]) != Some(0)
            || finalization["headHash"] != terminal_hash
            || finalization["allRegisteredMutationsFencedThroughFinalize"] != true
            || !signature(&finalization, key)
            || issued < requested
            || expires <= issued
            || Some(expires - issued) != number(&reserve["maximumLeaseMs"])
            || finalize_requested < issued
            || finalize_requested > finalized
            || finalized < issued
            || finalized >= expires
        {
            return Err(error("local_authority_backup_history_invalid"));
        }
        inventory_hashes.insert(
            reserve["inventoryHash"]
                .as_str()
                .ok_or_else(|| error("local_authority_backup_history_invalid"))?
                .to_owned(),
        );
        first_finalized = Some(first_finalized.map_or(finalized, |value| value.min(finalized)));
        last_finalized = Some(last_finalized.map_or(finalized, |value| value.max(finalized)));
    }
    Ok(json!({
        "finalizedBackupCount":rows.backups().len(),
        "uniqueInventoryHashCount":inventory_hashes.len(),
        "terminalHeadSequence":0,
        "terminalHeadHash":terminal_hash,
        "firstFinalizedAtMillis":first_finalized,
        "lastFinalizedAtMillis":last_finalized,
        "admissionPolicy":"signed_finalized_backups_at_exact_empty_mutation_terminal_head_v1",
        "historicalFenceClaimsUsedAsAuthority":false,
    }))
}
