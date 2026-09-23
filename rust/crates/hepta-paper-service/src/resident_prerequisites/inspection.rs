//! Private port of the original readiness predicate. Only the actual-source
//! collector supplies this input; successful V3 loading is not replaced by a
//! caller's ready flag, and owner-produced unusual values still face this gate.
use super::{Error, Result, value::*};
use hepta_legacy_compatibility::ProductionCollationV1;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;

const SIGNER_FIELDS: &[&str] = &[
    "keyId",
    "keyVersion",
    "subjectId",
    "organization",
    "role",
    "algorithm",
    "status",
    "effectiveFrom",
    "expiresAt",
    "revokedAt",
];
const PUBLIC_SIGNER_KEYS: &[&str] = &[
    "algorithm",
    "effectiveFrom",
    "expiresAt",
    "keyId",
    "keyVersion",
    "organization",
    "publicKeySpkiHash",
    "revokedAt",
    "role",
    "status",
    "subjectId",
];

pub(super) fn ready(inspection: &Value) -> Result<bool> {
    let Some(keys) = inspection["trustedSigners"].as_array() else {
        return Ok(false);
    };
    if inspection["trustedSignerTrustSetVersion"].as_f64() != Some(1.0)
        || !sha(&inspection["trustedSignerTrustSetHash"])
        || !(1..=32).contains(&keys.len())
        || !keys.iter().all(trusted_valid)
    {
        return Ok(false);
    }
    let collator = ProductionCollationV1::load()
        .map_err(|_| Error::new("autonomous_research_resident_json_profile_unsupported"))?;
    let tuples = keys
        .iter()
        .map(|key| format!("{}:{}", string(&key["keyId"]), string(&key["keyVersion"])))
        .collect::<Vec<_>>();
    if !tuples
        .windows(2)
        .all(|pair| collator.compare(&pair[0], &pair[1]).is_lt())
        || tuples.iter().collect::<BTreeSet<_>>().len() != keys.len()
        || keys
            .iter()
            .map(|key| string(&key["publicKeySpkiHash"]))
            .collect::<BTreeSet<_>>()
            .len()
            != keys.len()
    {
        return Ok(false);
    }
    let active = keys
        .iter()
        .filter(|key| key["status"] == "active" && key["revokedAt"].is_null())
        .collect::<Vec<_>>();
    if active.len() != 1
        || inspection["trustedSignerTrustSetHash"]
            != json!(hash(
                "ResearchExecutionReleaseAttestorTrustSet",
                &json!({"version":inspection["trustedSignerTrustSetVersion"],"keys":keys}),
            )?)
    {
        return Ok(false);
    }
    let Some(cost) = number(&inspection["maximumQualificationCostUsd"]) else {
        return Ok(false);
    };
    if !(0.0..=1000.0).contains(&cost)
        || inspection["qualificationCostAuthority"]
            != if cost == 0.0 {
                "externally_operated_zero_cost"
            } else {
                "operator_declared_worst_case_usd"
            }
        || inspection["version"].as_f64() != Some(1.0)
        || inspection["kind"] != "ExternalResearchQualificationProcessConfigurationInspection"
        || inspection["status"] != "external_research_qualification_process_configuration_ready"
        || inspection["ready"] != true
        || inspection["independentVerifierConfigured"] != true
        || inspection["authoritativeLookupSupported"] != true
        || inspection["authoritativeLookupVerifierConfigured"] != true
        || !strict_equal(
            &inspection["authoritativeLookupVerificationTrustSetHash"],
            &inspection["trustedSignerTrustSetHash"],
        )
        || inspection["independentVerifierResponseAttestationRequired"] != true
        || inspection["privateSigningKeyLoaded"] != false
        || !inspection["blockers"].as_array().is_some_and(Vec::is_empty)
    {
        return Ok(false);
    }
    for field in [
        "qualifierCommandIdentityHash",
        "verifierCommandIdentityHash",
        "qualifierCommandInspectionHash",
        "verifierCommandInspectionHash",
        "qualifierExecutableContentHash",
        "verifierExecutableContentHash",
        "qualifierCredentialRootIdentityHash",
        "verifierCredentialRootIdentityHash",
        "qualifierCredentialRootContentsIdentityHash",
        "verifierCredentialRootContentsIdentityHash",
        "qualifierChildEnvironmentIdentityHash",
        "verifierChildEnvironmentIdentityHash",
        "configurationIdentityHash",
        "trustIdentityHash",
        "clientServiceIdentityHash",
        "verifierServiceIdentityHash",
        "trustedSignerTrustSetHash",
        "authoritativeLookupVerificationTrustSetHash",
        "trustedSignerPublicKeySpkiHash",
        "verifierAttestorPublicKeySpkiHash",
    ] {
        if !sha(&inspection[field]) {
            return Ok(false);
        }
    }
    for field in ["ServiceId", "PrincipalId"] {
        let left = &inspection[format!("qualifier{field}")];
        let right = &inspection[format!("verifier{field}")];
        if !truthy(left) || !truthy(right) || strict_equal(left, right) {
            return Ok(false);
        }
    }
    for field in [
        "CommandIdentityHash",
        "ExecutableContentHash",
        "CredentialRootIdentityHash",
    ] {
        if strict_equal(
            &inspection[format!("qualifier{field}")],
            &inspection[format!("verifier{field}")],
        ) {
            return Ok(false);
        }
    }
    for prefix in ["qualifier", "verifier"] {
        if !safe_integer(&inspection[format!("{prefix}CredentialUid")], 0.0) {
            return Ok(false);
        }
        let interpreter = &inspection[format!("{prefix}InterpreterIdentityHash")];
        if !interpreter.is_null() && !sha(interpreter) {
            return Ok(false);
        }
    }
    let trusted = signer(inspection, "trustedSigner");
    let verifier = signer(inspection, "verifierAttestor");
    if !signer_projection_valid(&trusted, false)
        || !signer_projection_valid(&verifier, true)
        || strict_equal(&trusted["keyId"], &verifier["keyId"])
        || strict_equal(&trusted["subjectId"], &verifier["subjectId"])
        || strict_equal(
            &inspection["trustedSignerPublicKeySpkiHash"],
            &inspection["verifierAttestorPublicKeySpkiHash"],
        )
        || strict_equal(
            &inspection["clientServiceIdentityHash"],
            &inspection["verifierServiceIdentityHash"],
        )
        || !own_hash(
            "ExternalResearchQualificationProcessConfigurationInspection",
            inspection,
            "externalResearchQualificationProcessConfigurationInspectionHash",
        )?
    {
        return Ok(false);
    }
    for key in keys {
        if strict_equal(&key["keyId"], &verifier["keyId"])
            || strict_equal(&key["subjectId"], &verifier["subjectId"])
            || strict_equal(
                &key["publicKeySpkiHash"],
                &inspection["verifierAttestorPublicKeySpkiHash"],
            )
            || organization(&key["organization"]) == organization(&verifier["organization"])
        {
            return Ok(false);
        }
    }
    for prefix in ["qualifier", "verifier"] {
        if inspection[format!("{prefix}CommandInspectionHash")]
            != json!(command_hash(inspection, prefix)?)
        {
            return Ok(false);
        }
    }
    let mut projected_active = trusted.clone();
    projected_active["publicKeySpkiHash"] = inspection["trustedSignerPublicKeySpkiHash"].clone();
    // Both actual owner projections have the exact eleven scalar keys; the
    // original canonical object insertion order is identical on both sides.
    if active[0] != &projected_active {
        return Ok(false);
    }
    let trust_hash = hash(
        "ExternalResearchQualificationTrustIdentity",
        &json!({
            "trustedSignerTrustSetVersion":inspection["trustedSignerTrustSetVersion"],"trustedSignerTrustSetHash":inspection["trustedSignerTrustSetHash"],
            "trustedSigners":keys,"verifierAttestor":verifier,"verifierAttestorPublicKeySpkiHash":inspection["verifierAttestorPublicKeySpkiHash"],
        }),
    )?;
    let configuration_hash = hash(
        "ExternalResearchQualificationConfigurationIdentity",
        &json!({
            "qualifierCommandIdentityHash":inspection["qualifierCommandIdentityHash"],"verifierCommandIdentityHash":inspection["verifierCommandIdentityHash"],
            "maximumQualificationCostUsd":cost,"qualificationCostAuthority":inspection["qualificationCostAuthority"],"trustIdentityHash":trust_hash,
        }),
    )?;
    let client_hash = hash(
        "ExternalResearchQualificationClientServiceIdentity",
        &json!({
            "configurationIdentityHash":configuration_hash,"commandIdentityHash":inspection["qualifierCommandIdentityHash"],
            "serviceId":inspection["qualifierServiceId"],"principalId":inspection["qualifierPrincipalId"],
        }),
    )?;
    let verifier_hash = hash(
        "ExternalResearchQualificationVerifierServiceIdentity",
        &json!({
            "configurationIdentityHash":configuration_hash,"commandIdentityHash":inspection["verifierCommandIdentityHash"],
            "serviceId":inspection["verifierServiceId"],"principalId":inspection["verifierPrincipalId"],"trustIdentityHash":trust_hash,
        }),
    )?;
    Ok(inspection["trustIdentityHash"] == json!(trust_hash)
        && inspection["configurationIdentityHash"] == json!(configuration_hash)
        && inspection["clientServiceIdentityHash"] == json!(client_hash)
        && inspection["verifierServiceIdentityHash"] == json!(verifier_hash))
}
fn trusted_valid(key: &Value) -> bool {
    exact(key, PUBLIC_SIGNER_KEYS)
        && safe_id(&key["keyId"], 3)
        && safe_id(&key["keyVersion"], 1)
        && safe_id(&key["subjectId"], 3)
        && organization_valid(&key["organization"])
        && key["role"] == "research_execution_release_attestor"
        && key["algorithm"] == "ed25519"
        && (key["status"] == "active" || key["status"] == "retiring")
        && sha(&key["publicKeySpkiHash"])
        && matches!((canonical(&key["effectiveFrom"]),canonical(&key["expiresAt"])),(Some(start),Some(end)) if start < end)
        && (key["revokedAt"].is_null() || canonical(&key["revokedAt"]).is_some())
}
fn signer(inspection: &Value, prefix: &str) -> Value {
    Value::Object(
        SIGNER_FIELDS
            .iter()
            .map(|field| {
                let mut characters = field.chars();
                let first = characters
                    .next()
                    .map(|value| value.to_ascii_uppercase().to_string())
                    .unwrap_or_default();
                let value = &inspection[format!("{prefix}{first}{}", characters.as_str())];
                (
                    (*field).to_owned(),
                    if *field == "organization" {
                        or_null(value)
                    } else {
                        value.clone()
                    },
                )
            })
            .collect(),
    )
}
fn signer_projection_valid(signer: &Value, verifier: bool) -> bool {
    ["keyId", "keyVersion", "subjectId"]
        .iter()
        .all(|field| truthy(&signer[*field]))
        && organization_valid(&signer["organization"])
        && signer["algorithm"] == "ed25519"
        && signer["role"]
            == if verifier {
                "external_qualification_independent_verifier"
            } else {
                "research_execution_release_attestor"
            }
        && (signer["status"] == "active" || (verifier && signer["status"] == "retiring"))
        && signer["revokedAt"].is_null()
        && matches!((canonical(&signer["effectiveFrom"]),canonical(&signer["expiresAt"])),(Some(start),Some(end)) if start < end)
}
fn organization(value: &Value) -> Option<String> {
    value.as_str().map(|value| {
        value
            .nfkc()
            .collect::<String>()
            .split(whitespace)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    })
}
fn command_hash(inspection: &Value, prefix: &str) -> Result<String> {
    let fields = [
        "ServiceId",
        "PrincipalId",
        "CommandIdentityHash",
        "ExecutableContentHash",
        "CredentialRootIdentityHash",
        "CredentialRootContentsIdentityHash",
        "ChildEnvironmentIdentityHash",
        "InterpreterIdentityHash",
        "CredentialUid",
    ];
    let mut payload = serde_json::Map::new();
    for field in fields {
        let mut characters = field.chars();
        let first = characters
            .next()
            .map(|value| value.to_ascii_lowercase().to_string())
            .unwrap_or_default();
        payload.insert(
            format!("{first}{}", characters.as_str()),
            inspection[format!("{prefix}{field}")].clone(),
        );
    }
    hash(
        "ExternalResearchQualificationProcessCommandInspection",
        &Value::Object(payload),
    )
}
