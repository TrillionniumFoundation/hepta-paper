//! Read-only proof of the latest locally journaled finalization. This is not a
//! fresh external-head observation or a runtime-activation capability.
use super::authority::{
    MutationAuthorityTransportV1, PinnedMutationAuthorityV1, VerifiedMutationReceiptV1,
};
use super::*;
use rusqlite::{Connection, types::Value as SqlValue};
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::fmt;

const MAX_JOURNAL_JSON: usize = 32 * 1024 * 1024;

fn parse_stored(value: &Value) -> Result<Value> {
    let bytes = value
        .as_str()
        .filter(|s| s.len() <= MAX_JOURNAL_JSON)
        .ok_or_else(|| error("externally_fenced_sqlite_mutation_finalized_journal_invalid"))?;
    serde_json::from_str::<Strict>(bytes)
        .map(|v| v.0)
        .map_err(|_| error("externally_fenced_sqlite_mutation_finalized_journal_invalid"))
}

/// The caller owns its transaction. All reads use that snapshot; callers that
/// will publish a side effect should hold an IMMEDIATE transaction until the
/// side effect has been checked against the same current business authority.
pub(super) fn verify_latest_finalized_mutation<T: MutationAuthorityTransportV1>(
    database: &Connection,
    authority: &PinnedMutationAuthorityV1<T>,
    instance: &str,
) -> Result<VerifiedMutationReceiptV1> {
    let meta = storage::metadata(database)?;
    let schema = storage::exact_schema_hash_v1(database)?;
    if meta["protocol"] != ONLINE_MUTATION_PROTOCOL
        || meta["database_instance_id"] != instance
        || meta["database_scope_hash"] != authority.trust()["databaseScopeHash"]
        || meta["writer_manifest_hash"] != authority.trust()["writerManifestHash"]
        || meta["schema_hash"] != schema
    {
        return Err(error(
            "externally_fenced_sqlite_mutation_finalized_metadata_mismatch",
        ));
    }
    // Select the latest marker first. Joining only finalized rows could silently
    // fall back to an older permit when the newest publication is pending.
    let markers = storage::rows(
        database,
        "SELECT * FROM autonomous_research_online_mutation_authority_marker WHERE database_instance_id=? ORDER BY database_sequence DESC LIMIT 1",
        &[SqlValue::Text(instance.into())],
    )?;
    let marker = markers
        .first()
        .ok_or_else(|| error("externally_fenced_sqlite_mutation_finalized_marker_required"))?;
    let reserve = parse_stored(&marker["reserve_request_json"])?;
    let reservation = parse_stored(&marker["reservation_receipt_json"])?;
    let request_hash = hash("AutonomousResearchOnlineMutationReserveRequest", &reserve)?;
    if marker["reserve_request_hash"] != request_hash
        || marker["reservation_receipt_hash"]
            != contracts::online_mutation_receipt_hash_v1(&reservation)?
        || reservation["requestHash"] != request_hash
        || marker["schema_hash"] != schema
        || ![
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
        .all(|(local, remote)| marker.get(*local) == reservation.get(*remote))
        || ![
            ("database_role", "databaseRole"),
            ("database_instance_id", "databaseInstanceId"),
            ("schema_contract_id", "schemaContractId"),
        ]
        .iter()
        .all(|(local, remote)| meta.get(*local) == reservation.get(*remote))
    {
        return Err(error(
            "externally_fenced_sqlite_mutation_finalized_marker_invalid",
        ));
    }
    let verified_reservation = authority.verify_stored_reservation(&reservation, &reserve)?;
    let finalize_request =
        contracts::build_finalize_request_v1(&reservation, &marker["committed_at"])?;
    if finalize_request["localMarkerHash"] != marker["local_marker_hash"] {
        return Err(error(
            "externally_fenced_sqlite_mutation_finalized_marker_invalid",
        ));
    }
    let finalized = storage::rows(
        database,
        "SELECT * FROM autonomous_research_online_mutation_finalization_receipt WHERE reservation_id=?",
        &[SqlValue::Text(text(marker, "reservation_id")?.into())],
    )?;
    if finalized.len() != 1 {
        return Err(error(
            "externally_fenced_sqlite_mutation_finalized_receipt_required",
        ));
    }
    let row = &finalized[0];
    let receipt = parse_stored(&row["finalization_receipt_json"])?;
    if row["finalization_receipt_hash"] != contracts::online_mutation_receipt_hash_v1(&receipt)?
        || row["reservation_id"] != receipt["reservationId"]
        || row["reservation_id"] != marker["reservation_id"]
        || row["side_effect_permit_hash"] != receipt["sideEffectPermitHash"]
        || row["finalized_at"] != receipt["finalizedAt"]
    {
        return Err(error(
            "externally_fenced_sqlite_mutation_finalized_receipt_invalid",
        ));
    }
    authority.verify_stored_finalization(&receipt, &finalize_request, &verified_reservation)
}

struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor)
    }
}
struct StrictVisitor;
impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Strict;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded duplicate-free JSON")
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Strict, E> {
        Ok(Strict(Value::Null))
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Strict, E> {
        Ok(Strict(v.into()))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Strict, E> {
        Ok(Strict(v.into()))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Strict, E> {
        Ok(Strict(v.into()))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Strict, E> {
        if v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0 {
            return Ok(Strict((v as i64).into()));
        }
        serde_json::Number::from_f64(v)
            .map(|v| Strict(v.into()))
            .ok_or_else(|| E::custom("nonfinite"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Strict, E> {
        Ok(Strict(v.into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Strict, E> {
        Ok(Strict(v.into()))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Strict, A::Error> {
        let mut out = Vec::new();
        while let Some(Strict(v)) = seq.next_element()? {
            if out.len() == 1_000_000 {
                return Err(de::Error::custom("collection limit"));
            }
            out.push(v);
        }
        Ok(Strict(out.into()))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Strict, A::Error> {
        let mut out = serde_json::Map::new();
        while let Some((key, Strict(v))) = map.next_entry::<String, Strict>()? {
            if out.len() == 100_000 || out.insert(key, v).is_some() {
                return Err(de::Error::custom("duplicate key or collection limit"));
            }
        }
        Ok(Strict(out.into()))
    }
}
