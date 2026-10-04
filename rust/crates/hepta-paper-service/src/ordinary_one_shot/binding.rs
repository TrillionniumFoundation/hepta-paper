//! Validate the incumbent current and anchored historical execution binding.
//! These are audit facts, never provider credentials or an action permit.
use super::{contract::contract, json::*};
use hepta_legacy_compatibility::ProductionJsonValue as Json;
use std::{collections::BTreeSet, sync::atomic::AtomicBool};
const LEGACY_KEYS: &[&str] = &[
    "version",
    "codeProvenance",
    "codeProvenanceHash",
    "sourceExecutionSnapshot",
    "sourceExecutionSnapshotHash",
    "autonomousResearchProviderConfigurationHash",
    "protectedCampaignDefinition",
    "protectedCampaignFingerprintHash",
    "targetCampaignDefinition",
    "targetCampaignDefinitionHash",
    "environmentProjection",
    "preparationPolicy",
    "campaignLaunchPolicy",
];
const PROVENANCE_KEYS: &[&str] = &[
    "commit",
    "commitTree",
    "evidenceClass",
    "evidenceEnvironment",
    "indexStateHash",
    "kind",
    "packageVersion",
    "repositoryContentHash",
    "repositoryEntryCount",
    "tags",
    "treeDirty",
    "version",
    "worktreeStateHash",
];
const PROTECTED_KEYS: &[&str] = &[
    "activeNodeCount",
    "campaignId",
    "failedTerminalNodeCount",
    "failureClass",
    "ledgerCount",
    "logicalStateHash",
    "nodeLeaseCount",
    "outboxCount",
    "resourceLeaseCount",
    "skippedNodeCount",
    "status",
    "submissionCount",
    "version",
    "waiterCount",
];
const PROVIDER_KEYS: &[&str] = &[
    "formalReviewerCapabilityReceiptHash",
    "formalReviewerCredentialConfigIdentityHash",
    "formalReviewerOpenClawManagedAuthProfileIdentityHash",
    "kind",
    "openClawManagedAuthSourceIdentityHash",
    "openClawManagedRuntimeProvenanceHash",
    "providerConfigurationHash",
    "researchAuthorCapabilityReceiptHash",
    "researchAuthorCredentialConfigIdentityHash",
    "researchAuthorOpenClawManagedAuthProfileIdentityHash",
    "version",
];
const COMMON_PROVIDER_HASHES: &[&str] = &[
    "formalReviewerCapabilityReceiptHash",
    "formalReviewerCredentialConfigIdentityHash",
    "openClawManagedAuthSourceIdentityHash",
    "openClawManagedRuntimeProvenanceHash",
    "providerConfigurationHash",
    "researchAuthorCapabilityReceiptHash",
    "researchAuthorCredentialConfigIdentityHash",
];
fn extended_keys(value: &Json, keys: &[&str], extra: &[&str]) -> bool {
    let Json::Object(fields) = value else {
        return false;
    };
    fields.len() == keys.len() + extra.len()
        && fields.iter().all(|(name, _)| {
            keys.iter()
                .chain(extra)
                .any(|key| name.iter().copied().eq(key.encode_utf16()))
        })
}
fn nonempty_string(value: &Json) -> bool {
    matches!(value,Json::String(v) if !v.is_empty())
}
fn regex_text(value: &Json) -> Option<String> {
    match value {
        Json::Array(v) if v.len() == 1 => regex_text(&v[0]),
        _ => text(value),
    }
}
fn git_id(value: &Json) -> bool {
    regex_text(value).is_some_and(|s| {
        matches!(s.len(), 40 | 64)
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub(super) fn provenance(value: &Json) -> bool {
    if !exact(value, PROVENANCE_KEYS)
        || !number(field(value, "version"), 2.0)
        || !is_text(field(value, "kind"), "CodeProvenance")
        || !nonempty_string(field(value, "packageVersion"))
        || !git_id(field(value, "commit"))
        || !git_id(field(value, "commitTree"))
        || !boolean(field(value, "treeDirty"), false)
    {
        return false;
    }
    let Json::Number(count) = field(value, "repositoryEntryCount") else {
        return false;
    };
    if count.fract() != 0.0 || *count < 1.0 || *count > 9_007_199_254_740_991.0 {
        return false;
    }
    let Json::Array(tags) = field(value, "tags") else {
        return false;
    };
    let mut seen = BTreeSet::new();
    if tags.iter().any(|v| match v {
        Json::String(s) => !seen.insert(s),
        _ => true,
    }) {
        return false;
    }
    [
        "indexStateHash",
        "repositoryContentHash",
        "worktreeStateHash",
    ]
    .iter()
    .all(|key| sha(field(value, key)))
        && ["evidenceEnvironment", "evidenceClass"]
            .iter()
            .all(|key| nonempty_string(field(value, key)))
}
pub(super) fn protected(value: &Json, cancelled: &AtomicBool) -> Result<bool, String> {
    let c = contract()?;
    if !exact(value, PROTECTED_KEYS)
        || !is_text(
            field(value, "campaignId"),
            c["protectedCampaignId"]
                .as_str()
                .ok_or("one_shot_status_contract_invalid")?,
        )
        || !is_text(field(value, "status"), "failed")
        || !is_text(field(value, "failureClass"), "agent_usage_unknown_terminal")
        || !sha(field(value, "logicalStateHash"))
    {
        return Ok(false);
    }
    let _ = cancelled;
    Ok(number(field(value, "version"), 1.0)
        && number(field(value, "failedTerminalNodeCount"), 1.0)
        && number(field(value, "skippedNodeCount"), 65.0)
        && [
            "activeNodeCount",
            "nodeLeaseCount",
            "resourceLeaseCount",
            "waiterCount",
            "submissionCount",
            "outboxCount",
            "ledgerCount",
        ]
        .iter()
        .all(|key| number(field(value, key), 0.0)))
}
fn provider(value: &Json) -> bool {
    if !is_text(
        field(value, "kind"),
        "AutonomousResearchOneShotProviderRuntimeBinding",
    ) {
        return false;
    }
    if number(field(value, "version"), 1.0) {
        return exact(value, PROVIDER_KEYS)
            && PROVIDER_KEYS
                .iter()
                .filter(|k| !matches!(**k, "version" | "kind"))
                .all(|key| sha(field(value, key)));
    }
    if !number(field(value, "version"), 2.0)
        || !extended_keys(
            value,
            PROVIDER_KEYS,
            &[
                "openClawManagedAuthBindingMode",
                "openClawManagedGatewayRouteIdentityHash",
            ],
        )
        || !COMMON_PROVIDER_HASHES.iter().all(|k| sha(field(value, k)))
    {
        return false;
    }
    match text(field(value, "openClawManagedAuthBindingMode")).as_deref() {
        Some("user-locked-profile") => {
            sha(field(
                value,
                "researchAuthorOpenClawManagedAuthProfileIdentityHash",
            )) && sha(field(
                value,
                "formalReviewerOpenClawManagedAuthProfileIdentityHash",
            )) && matches!(
                field(value, "openClawManagedGatewayRouteIdentityHash"),
                Json::Null
            )
        }
        Some("current-agent-gateway-oauth-route") => {
            matches!(
                field(
                    value,
                    "researchAuthorOpenClawManagedAuthProfileIdentityHash"
                ),
                Json::Null
            ) && matches!(
                field(
                    value,
                    "formalReviewerOpenClawManagedAuthProfileIdentityHash"
                ),
                Json::Null
            ) && sha(field(value, "openClawManagedGatewayRouteIdentityHash"))
        }
        _ => false,
    }
}
fn record_hash_matches(
    value: &Json,
    component: &str,
    claimed: &str,
    kind: &str,
    cancelled: &AtomicBool,
) -> Result<bool, String> {
    Ok(is_text(
        field(value, claimed),
        &hash(kind, field(value, component), cancelled)?,
    ))
}
fn projection(value: &Json) -> bool {
    let Json::Object(values) = value else {
        return false;
    };
    values.iter().all(|(key, value)| {
        let Ok(key) = String::from_utf16(key) else {
            return false;
        };
        let Json::String(value) = value else {
            return false;
        };
        !key.is_empty()
            && key.len() <= 128
            && key.as_bytes()[0].is_ascii_uppercase()
            && key
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            && ![
                "TOKEN",
                "SECRET",
                "PASSWORD",
                "CREDENTIAL",
                "COOKIE",
                "API_KEY",
                "AUTHORIZATION",
            ]
            .iter()
            .any(|n| key.contains(n))
            && std::char::decode_utf16(value.iter().copied())
                .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER).len_utf8())
                .sum::<usize>()
                <= 4096
    })
}
pub(super) fn execution_binding(
    value: &Json,
    cancelled: &AtomicBool,
) -> Result<Option<bool>, String> {
    let c = contract()?;
    if canonical_bytes(value, 64 * 1024, cancelled).is_err() {
        return Ok(None);
    }
    let target = field(value, "targetCampaignDefinition");
    let target_hash = hash(
        "AutonomousResearchOneShotTargetCampaignDefinition",
        target,
        cancelled,
    )?;
    let current = c["currentTargetHash"].as_str() == Some(target_hash.as_str());
    let Some(paper) = text(field(target, "paperId")) else {
        return Ok(None);
    };
    if !current
        && (c["historicalTargets"][&paper].as_str() != Some(target_hash.as_str())
            || !is_text(
                field(target, "campaignId"),
                &format!("autonomous-research:{paper}"),
            ))
    {
        return Ok(None);
    }
    let legacy = paper == "local-auto-20260730-52";
    if !(if legacy {
        exact(value, LEGACY_KEYS)
    } else {
        extended_keys(
            value,
            LEGACY_KEYS,
            &["providerRuntimeBinding", "providerRuntimeBindingHash"],
        )
    }) {
        return Ok(None);
    }
    let config = c["providerConfigurationHash"]
        .as_str()
        .ok_or("one_shot_status_contract_invalid")?;
    if !is_text(
        field(value, "autonomousResearchProviderConfigurationHash"),
        config,
    ) || !provenance(field(value, "codeProvenance"))
        || !exact(
            field(value, "sourceExecutionSnapshot"),
            &["version", "manifestHash", "merkleHash"],
        )
        || !number(
            field(field(value, "sourceExecutionSnapshot"), "version"),
            1.0,
        )
        || !["manifestHash", "merkleHash"]
            .iter()
            .all(|key| sha(field(field(value, "sourceExecutionSnapshot"), key)))
        || !protected(field(value, "protectedCampaignDefinition"), cancelled)?
    {
        return Ok(None);
    }
    for (component, claim, kind) in [
        (
            "codeProvenance",
            "codeProvenanceHash",
            "AutonomousResearchOneShotCampaignCodeProvenance",
        ),
        (
            "sourceExecutionSnapshot",
            "sourceExecutionSnapshotHash",
            "AutonomousResearchOneShotCampaignSourceExecutionSnapshot",
        ),
        (
            "protectedCampaignDefinition",
            "protectedCampaignFingerprintHash",
            "AutonomousResearchOneShotProtectedCampaignFingerprint",
        ),
        (
            "targetCampaignDefinition",
            "targetCampaignDefinitionHash",
            "AutonomousResearchOneShotTargetCampaignDefinition",
        ),
    ] {
        if !record_hash_matches(value, component, claim, kind, cancelled)? {
            return Ok(None);
        }
    }
    if !legacy
        && (!provider(field(value, "providerRuntimeBinding"))
            || !is_text(
                field(
                    field(value, "providerRuntimeBinding"),
                    "providerConfigurationHash",
                ),
                config,
            )
            || !record_hash_matches(
                value,
                "providerRuntimeBinding",
                "providerRuntimeBindingHash",
                "AutonomousResearchOneShotProviderRuntimeBinding",
                cancelled,
            )?)
    {
        return Ok(None);
    }
    let policy = field(value, "preparationPolicy");
    let projected = field(value, "environmentProjection");
    let launch = field(value, "campaignLaunchPolicy");
    if !exact(
        policy,
        &[
            "allowedExternalActionKinds",
            "contentMode",
            "environmentProjectionHash",
            "forbiddenEnvironmentKeys",
            "mode",
            "providerFreeRequired",
            "version",
        ],
    ) || !number(field(policy, "version"), 1.0)
        || !is_text(field(policy, "mode"), "deterministic-bounded-offline-v1")
        || !is_text(field(policy, "contentMode"), "deterministic-bounded")
        || !boolean(field(policy, "providerFreeRequired"), true)
        || !matches!(field(policy,"allowedExternalActionKinds"),Json::Array(v) if v.is_empty())
        || !projection(projected)
        || !is_text(
            field(projected, "HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE"),
            "deterministic-bounded",
        )
        || canonical_bytes(projected, 32 * 1024, cancelled).is_err()
    {
        return Ok(None);
    }
    let forbidden_raw =
        serde_json::to_vec(&c["forbiddenEnvironmentKeys"]).map_err(|e| e.to_string())?;
    let forbidden = hepta_legacy_compatibility::parse_production_json_v1(&forbidden_raw)
        .map_err(|e| e.to_string())?;
    if !same_json(
        field(policy, "forbiddenEnvironmentKeys"),
        &forbidden,
        cancelled,
    ) || c["forbiddenEnvironmentKeys"]
        .as_array()
        .ok_or("one_shot_status_contract_invalid")?
        .iter()
        .filter_map(serde_json::Value::as_str)
        .any(|key| !matches!(field(projected, key), Json::Null))
        || !is_text(
            field(policy, "environmentProjectionHash"),
            &hash(
                "AutonomousResearchOneShotCampaignEnvironmentProjection",
                projected,
                cancelled,
            )?,
        )
        || !exact(
            launch,
            &[
                "allowedRecoveryActions",
                "createOnly",
                "forbiddenActions",
                "version",
            ],
        )
        || !number(field(launch, "version"), 1.0)
        || !boolean(field(launch, "createOnly"), true)
        || !matches!(field(launch,"allowedRecoveryActions"),Json::Array(v) if v.len()==1 && is_text(&v[0],"status"))
        || !matches!(field(launch,"forbiddenActions"),Json::Array(v) if v.len()==2 && is_text(&v[0],"converge") && is_text(&v[1],"resume"))
    {
        return Ok(None);
    }
    Ok(Some(current))
}
