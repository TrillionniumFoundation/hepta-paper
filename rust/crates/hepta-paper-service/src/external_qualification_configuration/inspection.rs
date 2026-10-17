use super::{Result, value::hash};
use serde_json::{Value, json};

pub(super) fn project(configuration: Option<&Value>, blocker: Option<&str>) -> Result<Value> {
    let ready = configuration.is_some() && blocker.is_none();
    let empty = Value::Null;
    let configuration = configuration.unwrap_or(&empty);
    let mut payload = json!({
        "version": 1,
        "kind": "ExternalResearchQualificationProcessConfigurationInspection",
        "status": if ready { "external_research_qualification_process_configuration_ready" } else { "external_research_qualification_process_configuration_blocked" },
        "ready": ready,
        "maximumQualificationCostUsd": configuration["maximumQualificationCostUsd"],
        "qualificationCostAuthority": configuration["qualificationCostAuthority"],
        "configurationIdentityHash": configuration["configurationIdentityHash"],
        "trustIdentityHash": configuration["trustIdentityHash"],
        "clientServiceIdentityHash": configuration["clientServiceIdentityHash"],
        "verifierServiceIdentityHash": configuration["verifierServiceIdentityHash"],
        "independentVerifierConfigured": ready,
        "authoritativeLookupSupported": ready,
        "authoritativeLookupVerifierConfigured": ready,
        "authoritativeLookupVerificationTrustSetHash": configuration["trustedSignerTrustSetHash"],
        "independentVerifierResponseAttestationRequired": true,
        "trustedSignerTrustSetVersion": configuration["trustedSignerTrustSetVersion"],
        "trustedSignerTrustSetHash": configuration["trustedSignerTrustSetHash"],
        "trustedSigners": configuration.get("trustedSigners").cloned().unwrap_or_else(|| json!([])),
        "trustedSignerPublicKeySpkiHash": configuration["trustedSignerPublicKeySpkiHash"],
        "verifierAttestorPublicKeySpkiHash": configuration["verifierAttestorPublicKeySpkiHash"],
        "privateSigningKeyLoaded": false,
        "blockers": blocker.into_iter().collect::<Vec<_>>(),
    });
    for prefix in ["qualifier", "verifier"] {
        let command = &configuration[prefix];
        for field in [
            "ServiceId",
            "PrincipalId",
            "CommandIdentityHash",
            "ExecutableContentHash",
            "CredentialRootIdentityHash",
            "CredentialRootContentsIdentityHash",
            "ChildEnvironmentIdentityHash",
            "InterpreterIdentityHash",
            "CredentialUid",
        ] {
            let lower = lower_first(field);
            payload[format!("{prefix}{field}")] = command[lower].clone();
        }
        payload[format!("{prefix}CommandInspectionHash")] = if configuration.is_null() {
            Value::Null
        } else {
            json!(command_hash(command)?)
        };
    }
    for prefix in ["trustedSigner", "verifierAttestor"] {
        for field in [
            "KeyId",
            "KeyVersion",
            "SubjectId",
            "Organization",
            "Role",
            "Algorithm",
            "Status",
            "EffectiveFrom",
            "ExpiresAt",
            "RevokedAt",
        ] {
            payload[format!("{prefix}{field}")] = configuration[prefix][lower_first(field)].clone();
        }
    }
    payload["externalResearchQualificationProcessConfigurationInspectionHash"] = json!(hash(
        "ExternalResearchQualificationProcessConfigurationInspection",
        &payload
    )?);
    Ok(payload)
}

fn lower_first(field: &str) -> String {
    let mut characters = field.chars();
    let first = characters
        .next()
        .map(|character| character.to_ascii_lowercase().to_string())
        .unwrap_or_default();
    format!("{first}{}", characters.as_str())
}

fn command_hash(command: &Value) -> Result<String> {
    hash(
        "ExternalResearchQualificationProcessCommandInspection",
        &json!({
            "serviceId": command["serviceId"], "principalId": command["principalId"],
            "commandIdentityHash": command["commandIdentityHash"], "executableContentHash": command["executableContentHash"],
            "credentialRootIdentityHash": command["credentialRootIdentityHash"],
            "credentialRootContentsIdentityHash": command["credentialRootContentsIdentityHash"],
            "childEnvironmentIdentityHash": command["childEnvironmentIdentityHash"],
            "interpreterIdentityHash": command["interpreterIdentityHash"], "credentialUid": command["credentialUid"],
        }),
    )
}
