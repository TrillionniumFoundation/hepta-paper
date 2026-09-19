use super::*;
use crate::online_runtime_activation::ordered_json::Json;
use crate::sqlite_mutation_coordinator::{
    contracts::schema_transition::{
        PRISTINE_SCHEMA_REBIND_PROTOCOL_V2, SCHEMA_TRANSITION_PROTOCOL_V1,
    },
    sha,
};
fn same(left: &Value, right: &Value, keys: &[&str]) -> bool {
    keys.iter()
        .all(|k| left.get(k).is_some() && left.get(k) == right.get(k))
}
fn child<'a>(root: &'a Json, path: &[&str]) -> Result<&'a Json> {
    path.iter().try_fold(root, |v, k| {
        v.get(k).ok_or_else(|| {
            error("autonomous_research_online_schema_transition_audit_receipt_invalid")
        })
    })
}
fn raw_same(root: &Json, left: &[&str], right: &[&str]) -> Result<bool> {
    let encode = |path: &[&str]| child(root, path)?.stringify().map_err(|e| error(e.code));
    Ok(encode(left)? == encode(right)?)
}
pub(crate) fn verify_audit<T: MutationAuthorityTransportV1>(
    receipt: &Value,
    bytes: &[u8],
    inventory: &Value,
    manifest_hash: &str,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<()> {
    let fail = || error("autonomous_research_online_schema_transition_audit_receipt_invalid");
    let mut payload = receipt.clone();
    payload
        .as_object_mut()
        .ok_or_else(fail)?
        .remove("schemaTransitionReceiptHash");
    if ![json!(1), json!(2)].contains(&receipt["version"])
        || receipt["kind"] != "AutonomousResearchOnlineSchemaTransitionAuditReceipt"
        || receipt["status"] != "autonomous_research_online_schema_transition_ready"
        || receipt["protocol"]
            != if receipt["version"] == 2 {
                PRISTINE_SCHEMA_REBIND_PROTOCOL_V2
            } else {
                SCHEMA_TRANSITION_PROTOCOL_V1
            }
        || receipt["databaseScopeHash"] != inventory["databaseScopeHash"]
        || receipt["writerManifestHash"] != manifest_hash
        || receipt["postInventoryHash"] != inventory["inventoryHash"]
        || !sha(&receipt["postPristineRuntimeStateHash"])
        || receipt["schemaTransitionReceiptHash"]
            != hash(
                "AutonomousResearchOnlineSchemaTransitionAuditReceipt",
                &payload,
            )?
        || receipt["externalAuthorityVerified"] != true
        || receipt["crossDatabaseAtomicityClaimed"] != false
    {
        return Err(fail());
    }
    let reserve = &receipt["reserveRequest"];
    let finalize = &receipt["finalizeRequest"];
    let observe = &receipt["observeRequest"];
    // Bind the whole signed chain, including the audit's unsigned projection.
    // The Node historical verifier accepts independently signed observations;
    // it omits these cross-record checks and can accept a spliced audit.
    if !same(
        receipt,
        reserve,
        &[
            "version",
            "protocol",
            "transitionId",
            "databaseScopeHash",
            "writerManifestHash",
            "transitionInventoryHash",
            "schemaBundleHash",
        ],
    ) || !same(
        finalize,
        observe,
        &[
            "version",
            "protocol",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "transitionId",
            "transitionInventoryHash",
            "schemaBundleHash",
            "postInventoryHash",
            "postPristineRuntimeStateHash",
        ],
    ) || !same(
        receipt,
        finalize,
        &[
            "postInventoryHash",
            "postPristineRuntimeStateHash",
            "installations",
        ],
    ) || observe["finalizationReceiptHash"]
        != schema_transition_receipt_hash_v1(&receipt["finalization"])?
        || receipt["completedAt"] != receipt["finalization"]["finalizedAt"]
        || (receipt["version"] == 2
            && (!same(
                receipt,
                reserve,
                &["transitionMode", "sourceWriterManifestHash"],
            ) || receipt["authorityConfigurationActivated"] != true))
    {
        return Err(fail());
    }
    let raw: Json = serde_json::from_slice(bytes).map_err(|_| fail())?;
    if !raw_same(
        &raw,
        &["reserveRequest", "instances"],
        &["reservation", "instances"],
    )? || !raw_same(
        &raw,
        &["finalizeRequest", "installations"],
        &["finalization", "installations"],
    )? {
        return Err(fail());
    }
    if receipt["version"] == 2 {
        let rows = child(&raw, &["reservation", "databaseGenesis"])?
            .array()
            .ok_or_else(fail)?;
        let canonical = [
            "databaseRole",
            "databaseInstanceId",
            "schemaContractId",
            "schemaHash",
            "globalSequence",
            "globalHash",
            "databaseSequence",
            "databaseHash",
            "stateHash",
        ];
        for row in rows {
            let Json::Object(entries) = row else {
                return Err(fail());
            };
            if entries.iter().map(|(k, _)| k.as_str()).ne(canonical) {
                return Err(fail());
            }
        }
    }
    let reservation = authority
        .verify_historical_schema_transition_reservation(&receipt["reservation"], reserve)
        .map_err(|_| fail())?;
    authority
        .verify_historical_schema_transition_finalization(
            &receipt["finalization"],
            finalize,
            &reservation,
        )
        .map_err(|_| fail())?;
    authority
        .verify_historical_schema_transition_observation(&receipt["observation"], observe)
        .map_err(|_| fail())?;
    Ok(())
}
