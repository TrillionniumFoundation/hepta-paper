//! Pure, public-key-only validation of retained initial genesis and activated
//! pristine rebind history. Inputs come from the owner's one held SQL snapshot.
//! No signing, SQL, file access, process-stop claim or migration authority exists
//! here; the owner must still replay mutations and compare all current SQL heads.
use super::source_rows::JournalRows;
use crate::sqlite_mutation_coordinator::{
    Result,
    authority::files,
    contracts::{assert_authority_trust_v1, schema_transition::*},
    error, hash, hash_bytes, keys, safe, sha, timestamp,
};
use ed25519_dalek::VerifyingKey;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const INVALID: &str = "local_authority_legacy_schema_history_invalid";
const CONFIG_DOMAIN: &str = "HeptaLocalAutonomousResearchStateAuthorityConfiguration";
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// Only this module constructs the schema epoch replay starting point. This
/// opaque value is an observation, never a ready/migration/writer capability.
#[derive(Debug)]
pub(super) struct VerifiedLegacySchemaHistoryV1 {
    genesis: Value,
    trust: Value,
    report: Value,
    initialized: bool,
}
impl VerifiedLegacySchemaHistoryV1 {
    pub(super) fn genesis(&self) -> &Value {
        &self.genesis
    }
    pub(super) fn trust(&self) -> &Value {
        &self.trust
    }
    pub(super) fn report(&self) -> &Value {
        &self.report
    }
    pub(super) fn initialized(&self) -> bool {
        self.initialized
    }
}

/// The actual Ed25519 key is supplied by the independently pinned public-key
/// loader. No caller-provided signature predicate or signing key is accepted.
pub(super) fn verify_online_signature_v1(receipt: &Value, key: &VerifyingKey) -> bool {
    crate::sqlite_mutation_coordinator::authority::verify_public_payload_signature_v1(receipt, key)
}

fn configuration(value: &Value) -> Result<Value> {
    let value = normalize_schema_numbers_v1(value)?;
    if !keys(
        &value,
        &[
            "version",
            "kind",
            "authorityId",
            "keyId",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "privateKeyPath",
            "stateDatabasePath",
            "socketPath",
            "maximumReservationLeaseMs",
            "maximumObservationAgeMs",
        ],
    ) || value["version"] != 1
        || value["kind"] != CONFIG_DOMAIN
        || !["authorityId", "keyId", "scopeId"]
            .iter()
            .all(|k| safe(&value[k]))
        || !["databaseScopeHash", "writerManifestHash"]
            .iter()
            .all(|k| sha(&value[k]))
        || !["privateKeyPath", "stateDatabasePath", "socketPath"]
            .iter()
            .all(|k| {
                value[k]
                    .as_str()
                    .is_some_and(|s| !s.contains('\0') && std::path::Path::new(s).is_absolute())
            })
        || !["maximumReservationLeaseMs", "maximumObservationAgeMs"]
            .iter()
            .all(|k| {
                value[k]
                    .as_i64()
                    .is_some_and(|n| (1000..=900000).contains(&n))
            })
    {
        return Err(error(INVALID));
    }
    Ok(value)
}
fn trust(config: &Value) -> Result<Value> {
    let value = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityTrust",
        "authorityId":config["authorityId"],"keyId":config["keyId"],"scopeId":config["scopeId"],
        "databaseScopeHash":config["databaseScopeHash"],"writerManifestHash":config["writerManifestHash"],
        "maximumReservationLeaseMs":config["maximumReservationLeaseMs"],"maximumObservationAgeMs":config["maximumObservationAgeMs"]});
    assert_authority_trust_v1(&value)?;
    Ok(value)
}
fn positive_sql(value: &Value) -> Result<i64> {
    value
        .as_i64()
        .filter(|n| (1..=MAX_SAFE).contains(n))
        .ok_or_else(|| error(INVALID))
}
fn record(value: &Value) -> Result<Value> {
    let bytes = value
        .as_str()
        .filter(|s| s.len() <= 1024 * 1024)
        .ok_or_else(|| error(INVALID))?;
    let parsed = files::parse(bytes.as_bytes(), INVALID)?;
    if !parsed.is_object() {
        return Err(error(INVALID));
    }
    normalize_schema_numbers_v1(&parsed)
}
struct Transition {
    rowid: i64,
    request: Value,
    reservation: Value,
    finalize: Value,
    finalization: Value,
    target: Option<String>,
}
impl Transition {
    fn from_row(row: &[Value], rebind: bool) -> Result<Self> {
        if row.len() != if rebind { 7 } else { 6 } {
            return Err(error(INVALID));
        }
        let rowid = positive_sql(&row[0])?;
        let value = Self {
            rowid,
            request: record(&row[2])?,
            reservation: record(&row[3])?,
            // A missing or partial finalization is never an activated epoch.
            finalize: record(&row[4])?,
            finalization: record(&row[5])?,
            target: if rebind {
                Some(
                    row[6]
                        .as_str()
                        .filter(|_| sha(&row[6]))
                        .ok_or_else(|| error(INVALID))?
                        .to_owned(),
                )
            } else {
                None
            },
        };
        if value.request["version"] != if rebind { 2 } else { 1 }
            || if rebind {
                row[1].as_str().is_none() || row[1] != value.request["transitionId"]
            } else {
                rowid != 1 || row[1].as_i64() != Some(1)
            }
        {
            return Err(error(INVALID));
        }
        Ok(value)
    }
    fn verify(&self, config: &Value, public_key: &VerifyingKey) -> Result<()> {
        let trust = trust(config)?;
        if self.target.is_none() && crate::online_schema_execution::cli::node_history::legacy_v021::is_legacy_schema_reserve_v021(&self.request) {
            // Only the retained initial historical epoch uses this explicit old
            // wire profile. Current v1/v2 and all native activation retain their
            // existing validators; old records never confer current authority.
            crate::online_schema_execution::cli::node_history::legacy_v021::verify_legacy_schema_records_v021(
                &trust, public_key, &self.request, &self.reservation, &self.finalize, &self.finalization,
            ).map_err(|_| error(INVALID))?;
            return Ok(());
        }
        let issued = timestamp(&self.reservation["issuedAt"]).ok_or_else(|| error(INVALID))?;
        let finalized =
            timestamp(&self.finalization["finalizedAt"]).ok_or_else(|| error(INVALID))?;
        if !verify_schema_transition_reservation_v1(&self.reservation, &self.request, &trust, issued,
            &|value| verify_online_signature_v1(value, public_key))?
            || !verify_schema_transition_finalization_v1(&self.finalization, &self.finalize,
                &self.reservation, &trust, finalized, &|value| verify_online_signature_v1(value, public_key))?
            // Both original schema finalizers require a still-live lease.
            || finalized >= timestamp(&self.reservation["expiresAt"]).ok_or_else(|| error(INVALID))?
        {
            return Err(error(INVALID));
        }
        Ok(())
    }
    fn assert_terminal(&self, global_hash: &Value) -> Result<()> {
        if self.finalization["globalSequence"] != 0
            || self.finalization["globalHash"] != *global_hash
        {
            return Err(error(INVALID));
        }
        Ok(())
    }
}
fn initial_global(config: &Value) -> Result<String> {
    hash(
        "HeptaLocalStateAuthorityGenesisGlobalHead",
        &json!({
        "authorityId":config["authorityId"],"keyId":config["keyId"],"scopeId":config["scopeId"],
        "databaseScopeHash":config["databaseScopeHash"],"writerManifestHash":config["writerManifestHash"]}),
    )
}
fn initial_database_genesis(request: &Value, global: &str) -> Result<Value> {
    let instances = request["instances"]
        .as_array()
        .ok_or_else(|| error(INVALID))?;
    instances.iter().map(|i| Ok(json!({
        "databaseRole":i["databaseRole"],"databaseInstanceId":i["databaseInstanceId"],
        "schemaContractId":i["schemaContractId"],"schemaHash":i["expectedPostSchemaHash"],
        "globalSequence":0,"globalHash":global,"databaseSequence":0,
        "databaseHash":hash("HeptaLocalStateAuthorityDatabaseGenesisHead", &json!({
            "databaseRole":i["databaseRole"],"databaseInstanceId":i["databaseInstanceId"],"schemaHash":i["expectedPostSchemaHash"]}))?,
        "stateHash":hash("HeptaLocalStateAuthorityDatabaseGenesisState", &json!({
            "databaseRole":i["databaseRole"],"databaseInstanceId":i["databaseInstanceId"],
            "sourceSha256":i["sourceSha256"],"schemaHash":i["expectedPostSchemaHash"]}))?
    }))).collect::<Result<Vec<_>>>().map(Value::Array)
}
fn heads(genesis: &Value, contracts: bool) -> Result<Value> {
    Ok(Value::Array(genesis.as_array().ok_or_else(|| error(INVALID))?.iter().map(|g| {
        let mut row = json!({"databaseRole":g["databaseRole"],"databaseInstanceId":g["databaseInstanceId"],
            "sequence":g["databaseSequence"],"hash":g["databaseHash"],"schemaHash":g["schemaHash"],"stateHash":g["stateHash"]});
        if contracts { row["schemaContractId"] = g["schemaContractId"].clone(); }
        row
    }).collect()))
}

pub(super) fn verify_schema_history_v1(
    rows: &JournalRows,
    current_configuration: &Value,
    public_key: &VerifyingKey,
) -> Result<VerifiedLegacySchemaHistoryV1> {
    verify_activated_history(
        rows,
        rows.schema_rebind(),
        current_configuration,
        public_key,
    )
}

// This distinct composition admits one fully signed, finalized successor while
// retaining the source epoch. Ordinary inspection above remains settled-only.
// The prepared target observation is checked against the actual retained row;
// no metadata, heads, SQL values or signed TEXT are changed here.
pub(super) fn verify_pending_finalized_history_v1(
    rows: &JournalRows,
    current_configuration: &Value,
    public_key: &VerifyingKey,
    target_observation: &Value,
    target_configuration_hash: &str,
) -> Result<VerifiedLegacySchemaHistoryV1> {
    let current = configuration(current_configuration)?;
    let observation = normalize_schema_numbers_v1(target_observation)?;
    let matches = rows
        .schema_rebind()
        .iter()
        .enumerate()
        .filter(|(_, row)| row.get(1) == observation.get("transitionId"))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if matches.len() != 1 || !rows.mutations().is_empty() {
        return Err(error(INVALID));
    }
    let index = matches[0];
    let row = Transition::from_row(&rows.schema_rebind()[index], true)?;
    if rows
        .schema_rebind()
        .iter()
        .any(|other| other[0].as_i64().is_none_or(|id| id > row.rowid))
    {
        return Err(error(INVALID));
    }
    let activated = rows
        .schema_rebind()
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != index)
        .map(|(_, row)| row.clone())
        .collect::<Vec<_>>();
    let mut source = verify_activated_history(rows, &activated, &current, public_key)?;
    if !source.initialized || source.genesis["globalSequence"] != 0 {
        return Err(error(INVALID));
    }
    row.verify(&current, public_key)?;
    let source_heads = Value::Array(
        source.genesis["databaseHeads"]
            .as_array()
            .ok_or_else(|| error(INVALID))?
            .iter()
            .map(|head| {
                let mut value = head.clone();
                if let Some(fields) = value.as_object_mut() {
                    fields.remove("schemaContractId");
                }
                value
            })
            .collect(),
    );
    if row.request["sourceWriterManifestHash"] != current["writerManifestHash"]
        || row.reservation["previousGlobalSequence"] != 0
        || row.reservation["previousGlobalHash"] != source.genesis["globalHash"]
        || row.reservation["previousDatabaseHeads"] != source_heads
    {
        return Err(error(INVALID));
    }
    let target_genesis = build_pristine_schema_rebind_genesis_v2(
        &row.request,
        &source.genesis["globalHash"],
        &source_heads,
    )?;
    if row.reservation["databaseGenesis"] != target_genesis {
        return Err(error(INVALID));
    }
    row.assert_terminal(&target_genesis[0]["globalHash"])?;
    let mut target = current.clone();
    target["writerManifestHash"] = row.request["writerManifestHash"].clone();
    let target_hash = hash(CONFIG_DOMAIN, &target)?;
    if target_hash != target_configuration_hash
        || row.target.as_deref() != Some(target_configuration_hash)
        || row.reservation["targetAuthorityConfigurationHash"] != target_hash
    {
        return Err(error(INVALID));
    }
    assert_schema_transition_observe_request_v1(&observation, &trust(&target)?)?;
    for field in [
        "transitionId",
        "transitionInventoryHash",
        "schemaBundleHash",
        "postInventoryHash",
        "postPristineRuntimeStateHash",
        "transitionMode",
        "sourceWriterManifestHash",
        "writerManifestHash",
        "databaseScopeHash",
        "scopeId",
    ] {
        if observation[field] != row.finalization[field] {
            return Err(error(INVALID));
        }
    }
    let receipt_hash = schema_transition_receipt_hash_v1(&row.finalization)?;
    if observation["finalizationReceiptHash"] != receipt_hash {
        return Err(error(INVALID));
    }
    source.report["pendingFinalizedRebind"] = json!({
        "transitionId":row.request["transitionId"],
        "targetAuthorityConfigurationHash":target_hash,
        "finalizationReceiptHash":receipt_hash,
        "targetObservationRequestHash":hash("AutonomousResearchOnlineSchemaTransitionObserveRequest", &observation)?,
        "sourceEpochPreserved":true,"activationRequired":true});
    Ok(source)
}

fn verify_activated_history(
    rows: &JournalRows,
    rebind_rows: &[Vec<Value>],
    current_configuration: &Value,
    public_key: &VerifyingKey,
) -> Result<VerifiedLegacySchemaHistoryV1> {
    let current = configuration(current_configuration)?;
    let final_trust = trust(&current)?;
    let initial_rows = rows.schema_transition();
    if initial_rows.len() > 1 || rebind_rows.len() > 64 {
        return Err(error(INVALID));
    }
    if initial_rows.is_empty() {
        if !rebind_rows.is_empty() {
            return Err(error(INVALID));
        }
        return Ok(VerifiedLegacySchemaHistoryV1 {
            genesis: json!({"globalSequence":0,"globalHash":initial_global(&current)?,"databaseHeads":[]}),
            trust: final_trust,
            report: json!({"version":1,"kind":"HeptaLegacyAuthoritySchemaHistoryV1",
                "evidenceScope":"schema_epoch_only_no_migration_authority","initialized":false,
                "rebindCount":0,"publicKeyHash":hash_bytes(public_key.as_bytes()),
                "currentConfigurationHash":hash(CONFIG_DOMAIN,&current)?}),
            initialized: false,
        });
    }
    let initial = Transition::from_row(&initial_rows[0], false)?;
    let mut historical = current.clone();
    historical["writerManifestHash"] = initial.request["writerManifestHash"].clone();
    initial.verify(&historical, public_key)?;
    let mut global = json!(initial_global(&historical)?);
    let mut database_genesis = initial_database_genesis(
        &initial.request,
        global.as_str().ok_or_else(|| error(INVALID))?,
    )?;
    if initial.reservation["databaseGenesis"] != database_genesis {
        return Err(error(INVALID));
    }
    initial.assert_terminal(&global)?;
    let initial_hash = schema_transition_receipt_hash_v1(&initial.finalization)?;
    let mut finalization_hashes = Vec::new();
    let mut pending = rebind_rows
        .iter()
        .map(|r| Transition::from_row(r, true))
        .collect::<Result<Vec<_>>>()?;
    let mut target_hashes = BTreeSet::new();
    let mut transition_ids = BTreeSet::new();
    for row in &pending {
        if !transition_ids.insert(
            row.request["transitionId"]
                .as_str()
                .ok_or_else(|| error(INVALID))?
                .to_owned(),
        ) || !target_hashes.insert(row.target.clone().ok_or_else(|| error(INVALID))?)
        {
            return Err(error(INVALID));
        }
    }
    let mut previous_rowid = 0;
    while !pending.is_empty() {
        let previous_heads = heads(&database_genesis, false)?;
        // Find the unique content-linked successor. SQL order alone is not
        // evidence of continuity, and leftover/orphan/forked rows must fail.
        let candidates = pending
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                row.request["sourceWriterManifestHash"] == historical["writerManifestHash"]
                    && row.reservation["previousGlobalHash"] == global
                    && row.reservation["previousDatabaseHeads"] == previous_heads
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if candidates.len() != 1 {
            return Err(error(INVALID));
        }
        let row = pending.remove(candidates[0]);
        if row.rowid <= previous_rowid {
            return Err(error(INVALID));
        }
        previous_rowid = row.rowid;
        row.verify(&historical, public_key)?;
        let mut target = historical.clone();
        target["writerManifestHash"] = row.request["writerManifestHash"].clone();
        let target_hash = hash(CONFIG_DOMAIN, &target)?;
        if row.target.as_deref() != Some(&target_hash)
            || row.reservation["targetAuthorityConfigurationHash"] != target_hash
        {
            return Err(error(INVALID));
        }
        database_genesis =
            build_pristine_schema_rebind_genesis_v2(&row.request, &global, &previous_heads)?;
        if row.reservation["databaseGenesis"] != database_genesis {
            return Err(error(INVALID));
        }
        global = database_genesis[0]["globalHash"].clone();
        row.assert_terminal(&global)?;
        historical = target;
        finalization_hashes.push(schema_transition_receipt_hash_v1(&row.finalization)?);
    }
    if historical != current {
        return Err(error(INVALID));
    }
    Ok(VerifiedLegacySchemaHistoryV1 {
        genesis: json!({"globalSequence":0,"globalHash":global,"databaseHeads":heads(&database_genesis,true)?}),
        trust: final_trust,
        report: json!({"version":1,"kind":"HeptaLegacyAuthoritySchemaHistoryV1",
            "evidenceScope":"schema_epoch_only_no_migration_authority","initialized":true,
            "rebindCount":finalization_hashes.len(),"publicKeyHash":hash_bytes(public_key.as_bytes()),
            "initialFinalizationReceiptHash":initial_hash,"rebindFinalizationReceiptHashes":finalization_hashes,
            "currentConfigurationHash":hash(CONFIG_DOMAIN,&current)?}),
        initialized: true,
    })
}

#[cfg(test)]
mod tests;
