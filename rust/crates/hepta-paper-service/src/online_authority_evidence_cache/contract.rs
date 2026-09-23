//! Node-compatible structural contracts. Successful parsing carries no authority.
use super::*;
use crate::sqlite_mutation_coordinator::sha;
const KEYS: &[&str] = &[
    "version",
    "kind",
    "status",
    "cacheRole",
    "databaseScopeHash",
    "writerManifestHash",
    "authorityGlobalSequence",
    "authorityGlobalHash",
    "activeRefreshReceipt",
    "activeRefreshReceiptHash",
    "recordedAt",
    "expiresAt",
    "cacheHash",
];
fn safe_integer(v: &Value) -> bool {
    v.as_f64().is_some_and(|n| {
        n.is_finite() && n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n)
    })
}
fn active_refresh(receipt: &Value) -> Result<()> {
    if receipt["version"].as_f64() != Some(1.0)
        || receipt["kind"] != "AutonomousResearchOnlineMutationActiveRefreshReceipt"
        || receipt["status"] != "autonomous_research_online_mutation_active_refresh_complete"
        || receipt["externalActionPerformed"] != true
        || receipt["journalRecorded"] != false
        || receipt["journalReceipt"] != Value::Null
        || !receipt
            .as_object()
            .is_some_and(|o| o.contains_key("journalReceipt"))
        || !safe_integer(&receipt["globalSequence"])
        || !sha(&receipt["globalHash"])
        || timestamp(&receipt["recordedAt"]).is_none()
        || ["currentHead", "activeChallenge", "brokerScope"]
            .iter()
            .any(|k| !receipt["authorityEvidence"][k].is_object())
    {
        return Err(failure("refresh_invalid"));
    }
    Ok(())
}
pub fn cache_contract_hash_v1() -> Result<String> {
    hash(
        "AutonomousResearchOnlineAuthorityEvidenceCacheContract",
        &json!({"version":1,"contractId":CACHE_CONTRACT_ID,"keys":KEYS,"cacheRole":"passive-status-only-never-mutation-authorization"}),
    )
}
pub fn cache_hash_v1(value: &Value) -> Result<String> {
    let mut v = value
        .as_object()
        .cloned()
        .ok_or_else(|| failure("invalid"))?;
    v.remove("cacheHash");
    hash(
        "AutonomousResearchOnlineAuthorityEvidenceCache",
        &Value::Object(v),
    )
}
pub fn assert_cache_v1(
    document: &Value,
    scope: Option<&str>,
    writer: Option<&str>,
    now: Option<i64>,
) -> Result<()> {
    let refresh = &document["activeRefreshReceipt"];
    active_refresh(refresh)?;
    let recorded = timestamp(&document["recordedAt"]);
    let expires = timestamp(&document["expiresAt"]);
    if !document
        .as_object()
        .is_some_and(|o| o.len() == KEYS.len() && KEYS.iter().all(|k| o.contains_key(*k)))
        || document["version"].as_f64() != Some(1.0)
        || document["kind"] != "AutonomousResearchOnlineAuthorityEvidenceCache"
        || document["status"] != "autonomous_research_online_authority_evidence_cache_ready"
        || document["cacheRole"] != "passive-status-only-never-mutation-authorization"
        || !sha(&document["databaseScopeHash"])
        || !sha(&document["writerManifestHash"])
        || !safe_integer(&document["authorityGlobalSequence"])
        || !sha(&document["authorityGlobalHash"])
        || document["authorityGlobalSequence"].as_f64() != refresh["globalSequence"].as_f64()
        || document["authorityGlobalHash"] != refresh["globalHash"]
        || document["activeRefreshReceiptHash"]
            != hash(
                "AutonomousResearchOnlineMutationActiveRefreshReceipt",
                refresh,
            )?
        || recorded.is_none()
        || expires.is_none()
        || recorded != timestamp(&refresh["recordedAt"])
        || expires <= recorded
        || scope.is_some_and(|s| document["databaseScopeHash"] != s)
        || writer.is_some_and(|s| document["writerManifestHash"] != s)
        || now.is_some_and(|t| expires.is_none_or(|e| e <= t))
        || document["cacheHash"] != cache_hash_v1(document)?
    {
        return Err(failure("invalid"));
    }
    Ok(())
}
pub fn create_cache_v1(refresh: &Value, scope: &str, writer: &str, expires: &str) -> Result<Value> {
    active_refresh(refresh)?;
    let mut value = json!({"version":1,"kind":"AutonomousResearchOnlineAuthorityEvidenceCache","status":"autonomous_research_online_authority_evidence_cache_ready","cacheRole":"passive-status-only-never-mutation-authorization","databaseScopeHash":scope,"writerManifestHash":writer,"authorityGlobalSequence":refresh["globalSequence"],"authorityGlobalHash":refresh["globalHash"],"activeRefreshReceipt":refresh,"activeRefreshReceiptHash":hash("AutonomousResearchOnlineMutationActiveRefreshReceipt",refresh)?,"recordedAt":refresh["recordedAt"],"expiresAt":expires});
    value["cacheHash"] = cache_hash_v1(&value)?.into();
    assert_cache_v1(&value, None, None, None)?;
    let bytes = hepta_legacy_compatibility::production_stable_json_v1(&value)
        .map_err(|_| failure("invalid"))?;
    serde_json::from_slice(&bytes).map_err(|_| failure("invalid"))
}
