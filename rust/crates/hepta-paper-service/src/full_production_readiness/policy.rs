//! Pure Rust implementation of the Node full-production-readiness policy.
//!
//! This module contains only the protocol validator and five-axis evaluator. It
//! does not execute a package command, contact an external owner/provider, or
//! inspect the filesystem. Callers provide JSON values from those boundaries;
//! malformed or stale values are rejected (or, for the nested package result,
//! converted into a blocked aggregate) with the same protocol error strings as
//! `paper-application/automation/full-production-readiness-policy.mjs`.
//!
//! The API intentionally accepts `serde_json::Value`: the incumbent contract
//! is a JSON protocol, and this keeps unknown automation-report fields intact
//! when the aggregate payload is built. Timestamps are restricted to the
//! canonical millisecond UTC strings accepted by the shared Node-compatible
//! `canonical_instant_millis` helper. JavaScript coercion outside that JSON
//! timestamp domain (for example `Date.parse` on arbitrary objects) is not a
//! supported production input and fails closed.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use thiserror::Error;

use crate::journal_connector_coverage::qualification::canonical_instant_millis;

const SHA256_PREFIX: &str = "sha256:";
const MAXIMUM_PACKAGE_AUTHORITY_VALIDITY_MS: i64 = 5 * 60 * 1000;
const MAXIMUM_PACKAGE_AUTHORITY_RESPONSE_DELAY_MS: i64 = 30 * 1000;

/// The complete owner acceptance family cardinality pinned by the Node policy.
pub const FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED: u64 = 249;
/// The owner family manifest identity required for independent acceptance.
pub const FULL_PRODUCTION_OWNER_FAMILY_MANIFEST_HASH: &str =
    "sha256:5937b03f562e7c2c26abd461bae87ffe25845e8511eee039f134f0db18c09b94";
/// Capability IDs must be complete, unique, and sorted according to the Node
/// `Object.keys(CAPABILITY_CATALOG).sort()` projection.
pub const FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS: [&str; 16] = [
    "repair.safe-apply",
    "research.change-proposal",
    "research.claim-registry",
    "research.evidence-ingestor",
    "research.evidence-quality-gate",
    "research.experiment-registry",
    "research.formal-verifier",
    "research.gap-planner",
    "research.gpu-deep-learning-training",
    "research.gpu-pde-solver",
    "runtime.artifact-repository",
    "runtime.job-receipt-store",
    "runtime.sandboxed-worker-runner",
    "submission.delivery-runtime",
    "submission.executor-port",
    "submission.release-lock",
];

const PACKAGE_READINESS_KEYS: [&str; 19] = [
    "blockers",
    "deletionFailClosedWhenUnavailable",
    "deletionLeasePortConfigured",
    "deletionLeasePortOperational",
    "finalizedAt",
    "inspectedAt",
    "kind",
    "lifecycleLockConfigured",
    "lifecycleLockOperational",
    "packageRetentionRecoveryReadinessHash",
    "recoveryAuthorityAuthenticated",
    "recoveryAuthorityConfigured",
    "recoveryAuthorityInspectionHash",
    "recoveryAuthorityReadinessVerifierConfigured",
    "recoveryAuthorityReadinessVerifierOperational",
    "recoveryAuthoritySnapshotHash",
    "recoveryAuthorityValidUntil",
    "status",
    "version",
];
const PACKAGE_BOOLEAN_KEYS: [&str; 9] = [
    "recoveryAuthorityConfigured",
    "recoveryAuthorityReadinessVerifierConfigured",
    "recoveryAuthorityReadinessVerifierOperational",
    "recoveryAuthorityAuthenticated",
    "deletionLeasePortConfigured",
    "deletionLeasePortOperational",
    "lifecycleLockConfigured",
    "lifecycleLockOperational",
    "deletionFailClosedWhenUnavailable",
];

#[derive(Debug, Error, Clone, Eq, PartialEq)]
#[error("{0}")]
pub struct FullProductionReadinessPolicyError(pub String);

type Result<T> = std::result::Result<T, FullProductionReadinessPolicyError>;

fn error(code: impl Into<String>) -> FullProductionReadinessPolicyError {
    FullProductionReadinessPolicyError(code.into())
}

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    let Some(value) = object(value) else {
        return false;
    };
    let actual = value.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    actual == expected
}

fn canonical_instant(value: &Value) -> Option<i64> {
    let value = value.as_str()?;
    canonical_instant_millis(value).filter(|_| {
        // `canonical_instant_millis` already performs the exact ISO check used
        // by the Node adapter. Keep this explicit guard so future adapters do
        // not accidentally broaden the policy's accepted JSON surface.
        value.len() == 24 || value.len() == 27
    })
}

fn is_sha256(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    let Some(hex) = value.strip_prefix(SHA256_PREFIX) else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_git_object_id(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    (40..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn boolean(value: &Value) -> bool {
    value.is_boolean()
}

/// JSON numbers produced by `JSON.parse` are binary64 values. This check
/// mirrors `Number.isSafeInteger` for the bounded positive cardinalities used
/// by this policy while rejecting booleans, strings, arrays, and objects.
fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 || number.abs() > 9_007_199_254_740_991.0 {
        return None;
    }
    let integer = number as i64;
    (integer as f64 == number).then_some(integer)
}

fn exact_number(value: &Value, expected: i64) -> bool {
    safe_integer(value) == Some(expected)
}

fn bounded_count(value: &Value, required: &Value, code: &str) -> Result<i64> {
    let Some(value) = safe_integer(value) else {
        return Err(error(format!("full_production_{code}_count_invalid")));
    };
    let Some(required) = safe_integer(required) else {
        return Err(error(format!("full_production_{code}_count_invalid")));
    };
    if required < 1 || value < 0 || value > required {
        return Err(error(format!("full_production_{code}_count_invalid")));
    }
    Ok(value)
}

fn package_readiness_protocol_error<T>() -> Result<T> {
    Err(error("full_production_package_readiness_protocol_invalid"))
}

/// Validate the exact v2 package-retention-recovery response and derive its
/// time-bounded v1 inspection. This is a pure function: no child process or
/// filesystem operation is performed.
pub fn inspect_package_retention_recovery_readiness_response_v1(
    response: &Value,
    observed_at: &Value,
) -> Result<Value> {
    let Some(observation) = canonical_instant(observed_at) else {
        return package_readiness_protocol_error();
    };
    if !exact_keys(response, &["result", "status"])
        || response["status"] != "paper_campaign_retention-recovery-readiness"
    {
        return package_readiness_protocol_error();
    }
    let readiness = &response["result"];
    if !exact_keys(readiness, &PACKAGE_READINESS_KEYS)
        || !exact_number(&readiness["version"], 2)
        || readiness["kind"] != "PackageRetentionRecoveryReadiness"
        || !matches!(
            readiness["status"].as_str(),
            Some(
                "package_retention_recovery_authority_ready"
                    | "package_retention_recovery_authority_unavailable"
            )
        )
        || PACKAGE_BOOLEAN_KEYS
            .iter()
            .any(|key| !boolean(&readiness[*key]))
        || readiness["deletionFailClosedWhenUnavailable"] != true
    {
        return package_readiness_protocol_error();
    }
    let Some(blockers) = readiness["blockers"].as_array() else {
        return package_readiness_protocol_error();
    };
    let mut unique_blockers = BTreeSet::new();
    if blockers.iter().any(|blocker| {
        let Some(blocker) = blocker.as_str() else {
            return true;
        };
        blocker.is_empty() || !unique_blockers.insert(blocker.to_owned())
    }) {
        return package_readiness_protocol_error();
    }
    let Some(inspected_at) = canonical_instant(&readiness["inspectedAt"]) else {
        return package_readiness_protocol_error();
    };
    let Some(finalized_at) = canonical_instant(&readiness["finalizedAt"]) else {
        return package_readiness_protocol_error();
    };
    if finalized_at < inspected_at
        || finalized_at - inspected_at > MAXIMUM_PACKAGE_AUTHORITY_RESPONSE_DELAY_MS
        || ![
            "recoveryAuthoritySnapshotHash",
            "recoveryAuthorityInspectionHash",
        ]
        .iter()
        .all(|key| readiness[*key].is_null() || is_sha256(&readiness[*key]))
        || (!readiness["recoveryAuthorityValidUntil"].is_null()
            && canonical_instant(&readiness["recoveryAuthorityValidUntil"]).is_none())
        || !is_sha256(&readiness["packageRetentionRecoveryReadinessHash"])
    {
        return package_readiness_protocol_error();
    }
    let mut payload = readiness.clone();
    let Some(payload_object) = payload.as_object_mut() else {
        return package_readiness_protocol_error();
    };
    payload_object.remove("packageRetentionRecoveryReadinessHash");
    let Ok(expected_hash) =
        production_hash_record_v1("PackageRetentionRecoveryReadiness", &payload)
    else {
        return package_readiness_protocol_error();
    };
    if readiness["packageRetentionRecoveryReadinessHash"] != expected_hash.as_str() {
        return package_readiness_protocol_error();
    }
    let declared_ready = readiness["status"] == "package_retention_recovery_authority_ready";
    let declared_ready_fields_valid = PACKAGE_BOOLEAN_KEYS
        .iter()
        .all(|key| readiness[*key] == true)
        && blockers.is_empty()
        && is_sha256(&readiness["recoveryAuthoritySnapshotHash"])
        && is_sha256(&readiness["recoveryAuthorityInspectionHash"])
        && canonical_instant(&readiness["recoveryAuthorityValidUntil"]).is_some_and(
            |valid_until| {
                valid_until > finalized_at
                    && valid_until - inspected_at <= MAXIMUM_PACKAGE_AUTHORITY_VALIDITY_MS
            },
        );
    if declared_ready && !declared_ready_fields_valid {
        return package_readiness_protocol_error();
    }
    let ready = declared_ready
        && finalized_at <= observation
        && canonical_instant(&readiness["recoveryAuthorityValidUntil"])
            .is_some_and(|valid_until| observation < valid_until);
    Ok(json!({
        "version": 1,
        "kind": "PackageRetentionRecoveryReadinessInspection",
        "status": if ready {
            "package_retention_recovery_readiness_verified"
        } else {
            "package_retention_recovery_readiness_blocked"
        },
        "ready": ready,
        "observedAt": observed_at,
        "readiness": readiness,
    }))
}

fn validate_owner_acceptance_inspection(inspection: &Value) -> Result<()> {
    if !exact_number(&inspection["version"], 1)
        || inspection["kind"] != "IndependentExternalOwnerAcceptanceInspection"
        || !matches!(
            inspection["status"].as_str(),
            Some(
                "independent_external_owner_acceptance_ready"
                    | "independent_external_owner_acceptance_blocked"
            )
        )
        || !exact_number(
            &inspection["required"],
            FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED as i64,
        )
        || safe_integer(&inspection["localAdminAccepted"]).is_none()
        || safe_integer(&inspection["localAdminAccepted"]).is_some_and(|value| {
            !(0..=FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED as i64).contains(&value)
        })
        || !boolean(&inspection["familyManifestBound"])
        || !boolean(&inspection["automaticAcceptanceForbidden"])
    {
        return Err(error("full_production_owner_acceptance_inspection_invalid"));
    }
    bounded_count(
        &inspection["externallyAccepted"],
        &inspection["required"],
        "external_owner_acceptance",
    )?;
    Ok(())
}

fn validate_operational_proof_inspection(inspection: &Value) -> Result<()> {
    let Some(capabilities) = inspection["capabilities"].as_array() else {
        return Err(error(
            "full_production_operational_proof_inspection_invalid",
        ));
    };
    if !exact_number(&inspection["version"], 1)
        || inspection["kind"] != "IndependentProductionOperationalProofInspection"
        || !matches!(
            inspection["status"].as_str(),
            Some(
                "independent_production_operational_proof_ready"
                    | "independent_production_operational_proof_blocked"
            )
        )
        || !is_git_object_id(&inspection["releaseCommit"])
        || !exact_number(
            &inspection["required"],
            FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.len() as i64,
        )
        || capabilities.len() != FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.len()
        || !boolean(&inspection["externalIndependentRequired"])
        || !boolean(&inspection["conformanceCannotQualify"])
    {
        return Err(error(
            "full_production_operational_proof_inspection_invalid",
        ));
    }
    let capability_ids = capabilities
        .iter()
        .map(|item| item["capabilityId"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    let mut sorted_ids = capability_ids.clone();
    sorted_ids.sort_unstable();
    if sorted_ids.as_slice() != FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS
        || sorted_ids.windows(2).any(|window| window[0] == window[1])
    {
        return Err(error(
            "full_production_operational_proof_inspection_invalid",
        ));
    }
    let mut verified = 0_i64;
    for item in capabilities {
        if !exact_keys(
            item,
            &[
                "capabilityId",
                "verified",
                "operationalReceiptHashes",
                "issuerAssurances",
            ],
        ) || !boolean(&item["verified"])
        {
            return Err(error(
                "full_production_operational_proof_inspection_invalid",
            ));
        }
        let Some(receipt_hashes) = item["operationalReceiptHashes"].as_array() else {
            return Err(error(
                "full_production_operational_proof_inspection_invalid",
            ));
        };
        let mut receipt_set = BTreeSet::new();
        if receipt_hashes.iter().any(|value| {
            !is_sha256(value)
                || !value
                    .as_str()
                    .is_some_and(|text| receipt_set.insert(text.to_owned()))
        }) {
            return Err(error(
                "full_production_operational_proof_inspection_invalid",
            ));
        }
        let Some(issuer_assurances) = item["issuerAssurances"].as_array() else {
            return Err(error(
                "full_production_operational_proof_inspection_invalid",
            ));
        };
        let mut issuer_set = BTreeSet::new();
        if issuer_assurances.iter().any(|value| {
            let Some(value) = value.as_str() else {
                return true;
            };
            value.is_empty() || !issuer_set.insert(value.to_owned())
        }) {
            return Err(error(
                "full_production_operational_proof_inspection_invalid",
            ));
        }
        if item["verified"] == true {
            verified += 1;
        }
    }
    if !exact_number(&inspection["verified"], verified) {
        return Err(error(
            "full_production_operational_proof_inspection_invalid",
        ));
    }
    bounded_count(
        &inspection["verified"],
        &inspection["required"],
        "operational_proof",
    )?;
    Ok(())
}

/// Evaluate the five independent production-readiness axes.
///
/// `input` has the same property names as the Node destructuring call:
/// `automationReport`, `packageRetentionRecoveryInspection`,
/// `offhostWormCustodyInspection`, `independentExternalOwnerAcceptanceInspection`,
/// `independentProductionOperationalProofInspection`, `offhostWormContractId`,
/// and `observedAt`.
pub fn evaluate_full_production_readiness_v1(input: &Value) -> Result<Value> {
    let Some(input) = object(input) else {
        return Err(error("full_production_readiness_inputs_invalid"));
    };
    let automation_report = input.get("automationReport").unwrap_or(&Value::Null);
    let package_inspection = input
        .get("packageRetentionRecoveryInspection")
        .unwrap_or(&Value::Null);
    let offhost_inspection = input
        .get("offhostWormCustodyInspection")
        .unwrap_or(&Value::Null);
    let owner_inspection = input
        .get("independentExternalOwnerAcceptanceInspection")
        .unwrap_or(&Value::Null);
    let operational_inspection = input
        .get("independentProductionOperationalProofInspection")
        .unwrap_or(&Value::Null);
    let observation_text = input.get("observedAt").unwrap_or(&Value::Null);
    let Some(observation) = canonical_instant(observation_text) else {
        return Err(error("full_production_readiness_inputs_invalid"));
    };
    if object(automation_report).is_none()
        || package_inspection["kind"] != "PackageRetentionRecoveryReadinessInspection"
        || offhost_inspection["kind"] != "OffhostWormTargetStatus"
        || owner_inspection["kind"] != "IndependentExternalOwnerAcceptanceInspection"
        || operational_inspection["kind"] != "IndependentProductionOperationalProofInspection"
        || input
            .get("offhostWormContractId")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err(error("full_production_readiness_inputs_invalid"));
    }
    validate_owner_acceptance_inspection(owner_inspection)?;
    validate_operational_proof_inspection(operational_inspection)?;

    let automation_plane_ready = exact_number(&automation_report["version"], 2)
        && automation_report["kind"] == "AutomationPlaneStatus"
        && automation_report["status"] == "automation_plane_production_ready"
        && automation_report["productionReady"] == true
        && automation_report["fullyAutonomousResearchSystemReady"] == true
        && automation_report["fullyAutonomousResearchSystemStatus"]
            == "generic_domain_autonomous_research_system_ready"
        && automation_report["liveProviderCanaryRequested"] == true
        && automation_report["liveProviderCanaryReady"] == true
        && automation_report["liveReleaseAttestorVerificationRequested"] == true
        && automation_report["researchExecutionReleaseAttestorProductionReady"] == true;

    let final_package_inspection = inspect_package_retention_recovery_readiness_response_v1(
        &json!({
            "status": "paper_campaign_retention-recovery-readiness",
            "result": package_inspection["readiness"],
        }),
        observation_text,
    )
    .ok();
    let package_inspection_observed_at = canonical_instant(&package_inspection["observedAt"]);
    let package_retention_recovery_ready = exact_number(&package_inspection["version"], 1)
        && package_inspection["status"] == "package_retention_recovery_readiness_verified"
        && package_inspection["ready"] == true
        && package_inspection_observed_at.is_some_and(|observed| observed <= observation)
        && final_package_inspection
            .as_ref()
            .is_some_and(|inspection| inspection["ready"] == true);

    let offhost_worm_custody_prefix = exact_number(&offhost_inspection["version"], 1)
        && offhost_inspection["status"] == "offhost_worm_target_ready"
        && offhost_inspection["contractId"] == input["offhostWormContractId"]
        && offhost_inspection["custodyRequired"] == true
        && offhost_inspection["custodyDeclaredQualified"] == true
        && offhost_inspection["offHostOrOffsiteCustodyQualified"] == true
        && offhost_inspection["custodyStatus"] == "offhost_or_offsite_custody_qualified"
        && offhost_inspection["custodyEvidenceStatus"] == "offhost_worm_custody_evidence_verified"
        && [
            "custodyEvidenceBundleHash",
            "custodyTrustStoreHash",
            "storageIdentityHash",
        ]
        .iter()
        .all(|key| is_sha256(&offhost_inspection[*key]));
    let custody_expiry = canonical_instant(&offhost_inspection["custodyEvidenceExpiresAt"]);
    let offhost_worm_custody_ready = offhost_worm_custody_prefix
        && custody_expiry.is_some_and(|expires| observation < expires)
        && offhost_inspection["blockers"]
            .as_array()
            .is_some_and(Vec::is_empty);

    let independent_external_owner_acceptance_ready = owner_inspection["status"]
        == "independent_external_owner_acceptance_ready"
        && exact_number(
            &owner_inspection["externallyAccepted"],
            FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED as i64,
        )
        && owner_inspection["familyManifestBound"] == true
        && owner_inspection["familyManifestHash"] == FULL_PRODUCTION_OWNER_FAMILY_MANIFEST_HASH
        && owner_inspection["automaticAcceptanceForbidden"] == true;

    let independent_production_operational_proof_ready = operational_inspection["status"]
        == "independent_production_operational_proof_ready"
        && exact_number(
            &operational_inspection["verified"],
            FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.len() as i64,
        )
        && operational_inspection["capabilities"]
            .as_array()
            .is_some_and(|capabilities| {
                capabilities.iter().all(|item| {
                    item["verified"] == true
                        && item["operationalReceiptHashes"]
                            .as_array()
                            .is_some_and(|hashes| !hashes.is_empty())
                        && item["issuerAssurances"].as_array().is_some_and(|issuers| {
                            issuers.len() == 1
                                && issuers.first() == Some(&json!("external_independent"))
                        })
                })
            })
        && operational_inspection["externalIndependentRequired"] == true
        && operational_inspection["conformanceCannotQualify"] == true;

    let mut blockers = Vec::new();
    if !automation_plane_ready {
        blockers.push("automation_plane_not_full_production_ready");
    }
    if !package_retention_recovery_ready {
        blockers.push("package_retention_recovery_not_ready");
    }
    if !offhost_worm_custody_ready {
        blockers.push("offhost_worm_custody_not_ready");
    }
    if !independent_external_owner_acceptance_ready {
        blockers.push("independent_external_owner_acceptance_not_ready");
    }
    if !independent_production_operational_proof_ready {
        blockers.push("independent_production_operational_proof_not_ready");
    }
    let full_production_ready = blockers.is_empty();

    let mut payload = automation_report.clone();
    let Some(payload) = payload.as_object_mut() else {
        return Err(error("full_production_readiness_inputs_invalid"));
    };
    payload.insert("version".to_owned(), json!(1));
    payload.insert("kind".to_owned(), json!("FullProductionReadinessStatus"));
    payload.insert(
        "status".to_owned(),
        json!(if full_production_ready {
            "full_production_ready"
        } else {
            "full_production_blocked"
        }),
    );
    payload.insert(
        "fullProductionStatus".to_owned(),
        json!(if full_production_ready {
            "full_production_ready"
        } else {
            "full_production_blocked"
        }),
    );
    payload.insert(
        "fullProductionReady".to_owned(),
        json!(full_production_ready),
    );
    payload.insert("observedAt".to_owned(), observation_text.clone());
    payload.insert(
        "automationPlaneStatus".to_owned(),
        automation_report
            .get("status")
            .filter(|value| match value {
                Value::Null => false,
                Value::Bool(value) => *value,
                Value::Number(value) => value.as_f64() != Some(0.0),
                Value::String(value) => !value.is_empty(),
                _ => true,
            })
            .cloned()
            .unwrap_or(Value::Null),
    );
    payload.insert(
        "automationPlaneReady".to_owned(),
        json!(automation_plane_ready),
    );
    payload.insert(
        "packageRetentionRecoveryReady".to_owned(),
        json!(package_retention_recovery_ready),
    );
    payload.insert(
        "packageRetentionRecoveryInspection".to_owned(),
        package_inspection.clone(),
    );
    payload.insert(
        "offhostWormCustodyReady".to_owned(),
        if offhost_worm_custody_prefix && custody_expiry.is_none() {
            Value::Null
        } else {
            json!(offhost_worm_custody_ready)
        },
    );
    payload.insert(
        "offhostWormCustodyInspection".to_owned(),
        offhost_inspection.clone(),
    );
    payload.insert(
        "independentExternalOwnerAcceptanceReady".to_owned(),
        json!(independent_external_owner_acceptance_ready),
    );
    payload.insert(
        "independentExternalOwnerAcceptanceInspection".to_owned(),
        owner_inspection.clone(),
    );
    payload.insert(
        "independentProductionOperationalProofReady".to_owned(),
        json!(independent_production_operational_proof_ready),
    );
    payload.insert(
        "independentProductionOperationalProofInspection".to_owned(),
        operational_inspection.clone(),
    );
    payload.insert("blockers".to_owned(), json!(blockers));
    let payload = Value::Object(payload.clone());
    let hash = production_hash_record_v1("FullProductionReadinessStatus", &payload)
        .map_err(|_| error("full_production_readiness_status_hash_failed"))?;
    let mut result = payload;
    result["fullProductionReadinessStatusHash"] = json!(hash.as_str());
    Ok(result)
}

/// Short alias convenient for callers that already name the enclosing policy.
pub use evaluate_full_production_readiness_v1 as evaluate_full_production_readiness;
/// Short alias matching the Node function name.
pub use inspect_package_retention_recovery_readiness_response_v1 as inspect_package_retention_recovery_readiness_response;

#[cfg(test)]
#[path = "policy_tests.rs"]
mod parity_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_timestamps_match_node_shape() {
        assert!(canonical_instant(&json!("2026-08-21T00:00:00.000Z")).is_some());
        assert!(canonical_instant(&json!("2026-08-21T00:00:00Z")).is_none());
        assert!(canonical_instant(&json!(0)).is_none());
    }

    #[test]
    fn capability_catalog_is_complete_and_sorted() {
        let mut ids = FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.to_vec();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        assert_eq!(ids, sorted);
        ids.dedup();
        assert_eq!(ids.len(), FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.len());
    }
}
