use super::{Result, collect::ConfigurationObservation, value::*};
use ed25519_dalek::{Signature, VerifyingKey, pkcs8::DecodePublicKey};
use serde_json::{Value, json};

pub(super) fn configuration_matches(
    configuration: Option<&ConfigurationObservation>,
    inspection: &Value,
) -> Result<bool> {
    let Some(configuration) = configuration else {
        return Ok(false);
    };
    Ok(super::inspection::ready(inspection)?
        && [
            "configurationIdentityHash",
            "trustIdentityHash",
            "maximumQualificationCostUsd",
            "qualificationCostAuthority",
        ]
        .iter()
        .all(|field| strict_equal(&configuration.identity[*field], &inspection[*field])))
}
pub(super) fn receipt_valid_from_pointer(pointer: Option<&Value>) -> Result<bool> {
    let Some(pointer) = pointer else {
        return Ok(false);
    };
    let receipt = &pointer["receipt"];
    // The actual pointer reader has ALREADY checked original manifest key order,
    // profiles, current plugin source and full own hash before yielding this
    // private input. Re-sorting a serde projection cannot reconstruct that order.
    Ok(receipt.is_object()
        && receipt["version"].as_f64() == Some(1.0)
        && receipt["kind"] == "FullResearchGoldenMicroCampaignQualificationReceipt"
        && receipt["status"] == "full_research_golden_micro_campaign_qualified"
        && receipt["externalActionPerformed"] == true
        && sha(&receipt["fullResearchQualificationReceiptHash"])
        && sha(&receipt["runtimeImageReproducibilityReceiptHash"])
        && sha(&pointer["qualificationStateHash"])
        && number(&pointer["qualificationStateGeneration"]).is_some_and(|value| {
            value.is_finite()
                && value.fract() == 0.0
                && (1.0..=9_007_199_254_740_991.0).contains(&value)
        })
        && own_hash(
            "FullResearchGoldenMicroCampaignQualificationReceipt",
            receipt,
            "fullResearchQualificationReceiptHash",
        )?)
}
pub(super) fn state_matches(state: &Value, pointer: &Value, configuration: &Value) -> Result<bool> {
    let receipt = &pointer["receipt"];
    let expected = hash(
        "AutonomousExternalQualificationRecoveryConfigurationIdentity",
        &json!({
            "configurationIdentityHash":or_null(&configuration["configurationIdentityHash"]),
            "trustIdentityHash":or_null(&configuration["trustIdentityHash"]),
            "clientServiceIdentityHash":or_null(&configuration["clientServiceIdentityHash"]),
            "verifierServiceIdentityHash":or_null(&configuration["verifierServiceIdentityHash"]),
            "maximumQualificationCostUsd":configuration["maximumQualificationCostUsd"],
            "qualificationCostAuthority":or_null(&configuration["qualificationCostAuthority"]),
        }),
    )?;
    Ok(strict_equal(
        &state["autonomousExternalQualificationStateHash"],
        &pointer["qualificationStateHash"],
    ) && strict_equal(
        &state["generation"],
        &pointer["qualificationStateGeneration"],
    ) && ["campaignId", "paperId", "campaignReleaseBundleHash"]
        .iter()
        .all(|field| strict_equal(&state[*field], &receipt[*field]))
        && strict_equal(
            &state["receipt"]["fullResearchQualificationReceiptHash"],
            &receipt["fullResearchQualificationReceiptHash"],
        )
        && state["recovery"]["status"] == "qualification_verified"
        && [
            "configurationIdentityHash",
            "trustIdentityHash",
            "clientServiceIdentityHash",
            "verifierServiceIdentityHash",
        ]
        .iter()
        .all(|field| strict_equal(&state["recovery"][*field], &configuration[*field]))
        && state["recovery"]["recoveryConfigurationIdentityHash"] == json!(expected))
}
pub(super) fn receipt_current(receipt: &Value, now: i64) -> bool {
    matches!((canonical(&receipt["issuedAt"]),canonical(&receipt["expiresAt"])),
        (Some(start),Some(end)) if end > start && end - start <= 86_400_000 && now >= start && now < end)
}
pub(super) fn code_matches(receipt_code: &Value, current: &Value) -> bool {
    receipt_code["version"].as_f64() == Some(2.0)
        && current["version"].as_f64() == Some(2.0)
        && [
            "version",
            "packageVersion",
            "commit",
            "commitTree",
            "treeDirty",
            "indexStateHash",
            "repositoryEntryCount",
            "repositoryContentHash",
            "worktreeStateHash",
        ]
        .iter()
        .all(|field| strict_equal(&receipt_code[*field], &current[*field]))
}
pub(super) fn signer_matches(configuration: &Value, receipt: &Value, now: i64) -> bool {
    let trusted = &configuration["trustedSigner"];
    let signer = &receipt["signer"];
    trusted["status"] == "active"
        && trusted["revokedAt"].is_null()
        && ["keyId", "keyVersion", "subjectId", "role", "algorithm"]
            .iter()
            .all(|field| strict_equal(&signer[*field], &trusted[*field]))
        && strict_equal(
            &or_null(&signer["organization"]),
            &or_null(&trusted["organization"]),
        )
        && matches!((canonical(&receipt["issuedAt"]),canonical(&trusted["effectiveFrom"]),canonical(&trusted["expiresAt"])),
            (Some(signed),Some(start),Some(end)) if signed >= start && signed < end && now >= start && now < end)
}
pub(super) fn signature_valid(
    configuration: Option<&ConfigurationObservation>,
    receipt: &Value,
) -> Result<bool> {
    let (Some(configuration), Some(object)) = (configuration, receipt.as_object()) else {
        return Ok(false);
    };
    let mut payload = object.clone();
    // Resident verifies this narrower signing contract, not the generic release/
    // prior-art envelope. Every additional receipt field remains in the payload.
    payload.remove("signature");
    payload.remove("fullResearchQualificationReceiptHash");
    let payload_hash = hash(
        "FullResearchQualificationSigningPayload",
        &Value::Object(payload),
    )?;
    let Some(signature) = receipt["signature"]
        .as_str()
        .filter(|value| !value.is_empty())
    else {
        return Ok(false);
    };
    let Some(bytes) = signature_bytes(signature) else {
        return Ok(false);
    };
    let Ok(signature) = Signature::from_slice(&bytes) else {
        return Ok(false);
    };
    let Ok(key) = VerifyingKey::from_public_key_pem(&configuration.public_key_pem) else {
        return Ok(false);
    };
    Ok(key
        .verify_strict(payload_hash.as_bytes(), &signature)
        .is_ok())
}
fn signature_bytes(input: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(64);
    let mut bits = 0u32;
    let mut count = 0;
    // Buffer.from(string, 'base64') consumes low bytes of ECMAScript UTF-16
    // code units, including both halves of supplementary scalars.
    for byte in input.encode_utf16().map(|unit| unit as u8) {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = ((bits << 6) | u32::from(digit)) & 0x00ff_ffff;
        count += 6;
        if count >= 8 {
            count -= 8;
            output.push((bits >> count) as u8);
            if output.len() > 64 {
                return None;
            }
        }
    }
    if output.len() == 64 {
        Some(output)
    } else {
        None
    }
}
