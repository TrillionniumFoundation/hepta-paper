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
fn verify_audit_shape(
    receipt: &Value,
    bytes: &[u8],
    inventory: &Value,
    manifest_hash: &str,
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
    Ok(())
}

pub(crate) fn verify_audit<T: MutationAuthorityTransportV1>(
    receipt: &Value,
    bytes: &[u8],
    inventory: &Value,
    manifest_hash: &str,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<()> {
    verify_audit_shape(receipt, bytes, inventory, manifest_hash)?;
    let fail = || error("autonomous_research_online_schema_transition_audit_receipt_invalid");
    let reserve = &receipt["reserveRequest"];
    let finalize = &receipt["finalizeRequest"];
    let observe = &receipt["observeRequest"];
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

/// A public historical archive can outlive multiple writer configurations. This
/// verifies only signed public data with the pinned authority key and principal;
/// it never constructs an opaque mutation receipt or activation capability. The
/// caller must separately prove the signed lineage to its independently pinned
/// current endpoint before accepting any archived writer configuration.
pub(crate) fn verify_historical_public_audit_v1<T: MutationAuthorityTransportV1>(
    receipt: &Value,
    bytes: &[u8],
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<()> {
    use crate::sqlite_mutation_coordinator::contracts::schema_transition::{
        verify_schema_transition_finalization_v1, verify_schema_transition_observation_v1,
        verify_schema_transition_reservation_v1,
    };
    let fail = || error("autonomous_research_online_schema_transition_audit_receipt_invalid");
    verify_audit_shape(
        receipt,
        bytes,
        &json!({"databaseScopeHash":receipt["databaseScopeHash"],"inventoryHash":receipt["postInventoryHash"]}),
        receipt["writerManifestHash"].as_str().ok_or_else(fail)?,
    )?;
    let mut historical_trust = authority.trust().clone();
    // Only the writer changes. Key, authority, scope, database scope and lease
    // bounds remain the actual independently pinned verifier's values.
    historical_trust["writerManifestHash"] = receipt["writerManifestHash"].clone();
    let signature = |value: &Value| {
        authority
            .verify_historical_public_signature_v1(value)
            .unwrap_or(false)
    };
    let reserve = &receipt["reserveRequest"];
    let reservation = &receipt["reservation"];
    let finalize = &receipt["finalizeRequest"];
    let finalization = &receipt["finalization"];
    let observe = &receipt["observeRequest"];
    let observation = &receipt["observation"];
    let time = |value: &Value, key: &str| timestamp(&value[key]).ok_or_else(fail);
    let requested = time(reserve, "requestedAt")?;
    let issued = time(reservation, "issuedAt")?;
    let completed = time(finalize, "completedAt")?;
    let finalized = time(finalization, "finalizedAt")?;
    let requested_observation = time(observe, "requestedAt")?;
    let observed = time(observation, "observedAt")?;
    if !verify_schema_transition_reservation_v1(
        reservation,
        reserve,
        &historical_trust,
        issued,
        &signature,
    )? || !verify_schema_transition_finalization_v1(
        finalization,
        finalize,
        reservation,
        &historical_trust,
        finalized,
        &signature,
    )? || !verify_schema_transition_observation_v1(
        observation,
        observe,
        &historical_trust,
        observed,
        &signature,
    )? || issued < requested.saturating_sub(5000)
        || completed < issued
        || requested_observation < finalized
        || observed < finalized
        || observed < requested_observation.saturating_sub(5000)
        || !same(finalization, observation, &["globalSequence", "globalHash"])
    {
        return Err(fail());
    }
    // Recheck the retained key/config descriptors after all three signatures.
    authority
        .verify_historical_public_signature_v1(observation)
        .and_then(|valid| if valid { Ok(()) } else { Err(fail()) })
}
