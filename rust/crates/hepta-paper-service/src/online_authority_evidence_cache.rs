//! Passive status cache. A serialized or cached authority claim is never a
//! mutation permit. Active callers must reverify their retained signed evidence.
pub mod contract;
mod files;
mod lock;
pub mod verified;
use crate::sqlite_mutation_coordinator::{Result, error, hash, text, timestamp};
use serde_json::{Value, json};
use std::path::Path;
pub const CACHE_RELATIVE_PATH: &str = "automation-cache/online-authority-evidence-v1/current.json";
pub const CACHE_CONTRACT_ID: &str = "autonomous-research-online-authority-evidence-cache-v1";
const MAXIMUM_BYTES: u64 = 4 * 1024 * 1024;
fn failure(suffix: &str) -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error(format!(
        "autonomous_research_online_authority_evidence_cache_{suffix}"
    ))
}
fn monotonic(existing: &Value, next: &Value) -> Result<()> {
    if existing["cacheHash"] == next["cacheHash"] {
        return Ok(());
    }
    if next["authorityGlobalSequence"].as_f64() < existing["authorityGlobalSequence"].as_f64() {
        return Err(failure("global_sequence_rollback"));
    }
    if next["authorityGlobalSequence"].as_f64() == existing["authorityGlobalSequence"].as_f64()
        && next["authorityGlobalHash"] != existing["authorityGlobalHash"]
    {
        return Err(failure("global_hash_conflict"));
    }
    if timestamp(&next["recordedAt"]) <= timestamp(&existing["recordedAt"]) {
        return Err(failure("recorded_at_rollback"));
    }
    if timestamp(&next["expiresAt"]) <= timestamp(&existing["expiresAt"]) {
        return Err(failure("expiry_rollback"));
    }
    Ok(())
}
/// Read a bounded cache as untrusted passive evidence. This validates structure,
/// subject, record hash and expiry; it does not verify embedded signatures.
pub fn read_passive_authority_evidence_cache_v1(
    root: &Path,
    scope: Option<&str>,
    writer: Option<&str>,
    now: Option<i64>,
) -> Result<Value> {
    let directory = files::Directory::open(root, false)?;
    let file = directory
        .read("current.json", MAXIMUM_BYTES, 0o400, 1)?
        .ok_or_else(|| failure("missing"))?;
    let document = file.json()?;
    contract::assert_cache_v1(&document, scope, writer, now)?;
    directory.assert_current()?;
    file.assert_current(&directory, "current.json")?;
    let evidence = &document["activeRefreshReceipt"]["authorityEvidence"];
    Ok(
        json!({"version":1,"kind":"AutonomousResearchOnlineAuthorityEvidenceCacheEvidence","status":"autonomous_research_online_authority_evidence_cache_loaded","cacheRole":document["cacheRole"],"cacheContractId":CACHE_CONTRACT_ID,"cacheContractHash":contract::cache_contract_hash_v1()?,"cacheHash":document["cacheHash"],"activeRefreshReceiptHash":document["activeRefreshReceiptHash"],"currentHead":evidence["currentHead"],"activeChallenge":evidence["activeChallenge"],"brokerScope":evidence["brokerScope"],"externalActionPerformed":false}),
    )
}
/// Atomically record passive evidence with the incumbent shared target lock.
/// Returned JSON is a write receipt, never a verified activation capability.
pub fn record_passive_authority_evidence_cache_v1(
    root: &Path,
    refresh: &Value,
    scope: &str,
    writer: &str,
    expires_at: &str,
) -> Result<Value> {
    let document = contract::create_cache_v1(refresh, scope, writer, expires_at)?;
    let mut bytes = serde_json::to_vec(&document).map_err(|_| failure("json_invalid"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAXIMUM_BYTES {
        return Err(failure("size_invalid"));
    }
    let directory = files::Directory::open(root, true)?;
    let mut lock = lock::TargetLock::acquire(&directory, &document)?;
    let existing = directory.read("current.json", MAXIMUM_BYTES, 0o400, 1)?;
    if let Some(existing) = &existing {
        let value = existing.json()?;
        contract::assert_cache_v1(&value, None, None, None)?;
        monotonic(&value, &document)?;
    }
    let stage_name = lock.stage_name.clone();
    let staged = directory.create_with_before_write(&stage_name, &bytes, 0o400, |stage| {
        lock.bind_temporary(stage, false)
    })?;
    let result = (|| {
        lock.bind_temporary(&staged, true)?;
        lock.assert_current(&directory)?;
        directory.assert_current()?;
        let current = directory.read("current.json", MAXIMUM_BYTES, 0o400, 1)?;
        match (&existing, &current) {
            (None, None) => (),
            (Some(old), Some(new)) if old.same(new) => (),
            _ => return Err(failure("target_changed")),
        }
        staged.assert_current(&directory, &lock.stage_name)?;
        directory.replace(&lock.stage_name, "current.json")?;
        let check = directory
            .read("current.json", MAXIMUM_BYTES, 0o400, 1)?
            .ok_or_else(|| failure("readback_mismatch"))?;
        let checked = check.json()?;
        contract::assert_cache_v1(
            &checked,
            Some(scope),
            Some(writer),
            timestamp(&document["recordedAt"]),
        )?;
        if checked["cacheHash"] != document["cacheHash"] {
            return Err(failure("readback_mismatch"));
        }
        Ok(
            json!({"version":1,"kind":"AutonomousResearchOnlineAuthorityEvidenceCacheWriteReceipt","status":"autonomous_research_online_authority_evidence_cache_recorded","cacheRelativePath":CACHE_RELATIVE_PATH,"cacheContractHash":contract::cache_contract_hash_v1()?,"cacheHash":document["cacheHash"],"activeRefreshReceiptHash":document["activeRefreshReceiptHash"],"recordedAt":document["recordedAt"],"expiresAt":document["expiresAt"]}),
        )
    })();
    directory.remove_owned(&lock.stage_name, &staged);
    let released = lock.release(&directory);
    match (result, released) {
        (Err(e), _) => Err(e),
        (Ok(_), Err(e)) => Err(e),
        (Ok(v), Ok(())) => Ok(v),
    }
}
