use super::*;
use crate::sqlite_mutation_coordinator::{
    DATABASE_ROLES, ONLINE_MUTATION_PROTOCOL, manifest::writer_manifest_hash_v1,
};
use std::collections::BTreeSet;

pub const ACTIVATION_KIND: &str = "AutonomousResearchOnlineRuntimeActivationReceipt";
const RECEIPT_KEYS: &[&str] = &[
    "version",
    "kind",
    "status",
    "protocol",
    "inventoryHash",
    "databaseScopeHash",
    "writerManifestHash",
    "authorityId",
    "keyId",
    "authorityGlobalSequence",
    "authorityGlobalHash",
    "databaseActivations",
    "activeRefreshReceiptHash",
    "authorityEvidenceCacheReceiptHash",
    "restoreDrillReceiptHash",
    "schemaTransitionReceiptHash",
    "activatedAt",
    "coordinatorRuntimeReady",
    "remainingBlockers",
    "activationReceiptHash",
];
const DATABASE_KEYS: &[&str] = &[
    "databaseRole",
    "databaseInstanceId",
    "schemaContractId",
    "schemaHash",
    "startupReconciliationReceiptHash",
    "finalizedHeadInspectionReceiptHash",
    "databaseSequence",
    "databaseHash",
    "stateHash",
];

pub fn runtime_activation_receipt_hash_v1(receipt: &Value) -> Result<String> {
    hash(ACTIVATION_KIND, &without(receipt, "activationReceiptHash")?)
}
/// Structural/hash validation only. Caller-provided receipts, including fields
/// claiming ready or verified, never confer authority through this function.
/// Canonical UTC millisecond timestamps are the native supported date profile.
pub fn assert_runtime_activation_receipt_v1(receipt: &Value) -> Result<()> {
    let fail = || error("autonomous_research_online_runtime_activation_receipt_invalid");
    if !exact_keys(receipt, RECEIPT_KEYS)
        || receipt["version"] != 1
        || receipt["kind"] != ACTIVATION_KIND
        || receipt["status"] != "autonomous_research_online_mutation_runtime_activated"
        || receipt["protocol"] != ONLINE_MUTATION_PROTOCOL
        || ![
            "inventoryHash",
            "databaseScopeHash",
            "writerManifestHash",
            "authorityGlobalHash",
            "activeRefreshReceiptHash",
            "authorityEvidenceCacheReceiptHash",
            "restoreDrillReceiptHash",
            "schemaTransitionReceiptHash",
        ]
        .iter()
        .all(|k| sha(&receipt[k]))
        || !nonempty(&receipt["authorityId"])
        || !nonempty(&receipt["keyId"])
        || !integer(&receipt["authorityGlobalSequence"])
        || timestamp(&receipt["activatedAt"]).is_none()
        || receipt["coordinatorRuntimeReady"] != true
        || !empty(&receipt["remainingBlockers"])
    {
        return Err(fail());
    }
    let entries = receipt["databaseActivations"]
        .as_array()
        .filter(|v| v.len() == DATABASE_ROLES.len())
        .ok_or_else(fail)?;
    let mut roles = BTreeSet::new();
    let mut ids = Vec::new();
    for entry in entries {
        if !exact_keys(entry, DATABASE_KEYS)
            || !["databaseRole", "databaseInstanceId", "schemaContractId"]
                .iter()
                .all(|k| nonempty(&entry[k]))
            || ![
                "schemaHash",
                "startupReconciliationReceiptHash",
                "finalizedHeadInspectionReceiptHash",
                "databaseHash",
                "stateHash",
            ]
            .iter()
            .all(|k| sha(&entry[k]))
            || !integer(&entry["databaseSequence"])
        {
            return Err(fail());
        }
        roles.insert(entry["databaseRole"].as_str().ok_or_else(fail)?);
        ids.push(entry["databaseInstanceId"].as_str().ok_or_else(fail)?);
    }
    if roles != DATABASE_ROLES.iter().copied().collect()
        || !ids
            .windows(2)
            .all(|p| p[0].encode_utf16().cmp(p[1].encode_utf16()).is_lt())
        || receipt["activationReceiptHash"] != runtime_activation_receipt_hash_v1(receipt)?
    {
        return Err(fail());
    }
    Ok(())
}

pub const SCHEMA_TRANSITION_PROTOCOL: &str =
    "external-authority-quiesced-offline-schema-transition-v1";
/// Validates the adapter's serialized readiness claim. It deliberately returns
/// no verified token: real transition signatures and current external
/// observation still need the schema-transition authority implementation.
pub fn assert_schema_transition_readiness_claim_v1(
    readiness: &Value,
    inventory: &Value,
    manifest: &Value,
    now_ms: i64,
) -> Result<()> {
    let fail = || error("autonomous_research_online_runtime_activation_schema_transition_required");
    let manifest_hash = writer_manifest_hash_v1(manifest).map_err(|_| fail())?;
    if readiness["version"] != 1
        || readiness["kind"] != "AutonomousResearchOnlineSchemaTransitionReadyReceipt"
        || readiness["status"] != "autonomous_research_online_schema_transition_ready"
        || readiness["protocol"] != SCHEMA_TRANSITION_PROTOCOL
        || readiness["databaseScopeHash"] != inventory["databaseScopeHash"]
        || readiness["writerManifestHash"] != manifest_hash
        || readiness["inventoryHash"] != inventory["inventoryHash"]
        || !sha(&readiness["schemaTransitionReceiptHash"])
        || !sha(&readiness["liveObservationReceiptHash"])
        || readiness["externalAuthorityVerified"] != true
        || !empty(&readiness["blockers"])
        || timestamp(&readiness["observedAt"]).is_none()
        || timestamp(&readiness["expiresAt"]).is_none_or(|expiry| expiry <= now_ms)
        || readiness["readinessReceiptHash"]
            != hash(
                "AutonomousResearchOnlineSchemaTransitionReadyReceipt",
                &without(readiness, "readinessReceiptHash").map_err(|_| fail())?,
            )?
    {
        return Err(fail());
    }
    Ok(())
}
