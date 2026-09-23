//! Read-only verifier for the `OffhostWormTargetStatus` boundary.
//!
//! The Node release composition probes a mount and independently verifies WORM
//! custody before passing this object to the five-axis policy. Rust does not
//! manufacture mount, storage, or custodian evidence. This module validates an
//! already observed status exactly at that boundary, rejects malformed claims,
//! and derives the same fail-closed readiness predicate used by the policy.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};
use std::collections::BTreeSet;
use thiserror::Error;

use crate::journal_connector_coverage::qualification::canonical_instant_millis;

const SHA256_PREFIX: &str = "sha256:";
const STATUS_KEYS: [&str; 28] = [
    "blockers",
    "contractId",
    "currentProtectionLevel",
    "custodyBlockers",
    "custodyDeclaredQualified",
    "custodyEvidenceBundleHash",
    "custodyEvidenceExpiresAt",
    "custodyEvidenceStatus",
    "custodyRequired",
    "custodyStatus",
    "custodyTrustStoreHash",
    "distinctDevice",
    "expectedStorageIdentityHash",
    "kind",
    "mountAvailable",
    "mountDeviceMatchesTarget",
    "mountIdMatchesTarget",
    "mountIdentity",
    "mountObservationHash",
    "offHostOrOffsiteCustodyQualified",
    "status",
    "storageIdentityHash",
    "storageIdentityMatchesContract",
    "targetDeviceMajorMinor",
    "targetDirectoryIdentity",
    "targetMountId",
    "targetMountRoot",
    "version",
];

#[derive(Debug, Error, Clone, Eq, PartialEq)]
#[error("{0}")]
pub struct OffhostWormStatusError(pub String);

type Result<T> = std::result::Result<T, OffhostWormStatusError>;

fn error(code: &'static str) -> OffhostWormStatusError {
    OffhostWormStatusError(code.to_owned())
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

fn nonempty_string(value: &Value) -> bool {
    value.as_str().is_some_and(|value| !value.is_empty())
}

fn canonical_instant(value: &Value) -> Option<i64> {
    value.as_str().and_then(canonical_instant_millis)
}

fn sha256_or_null(value: &Value) -> bool {
    if value.is_null() {
        return true;
    }
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

fn sha256(value: &Value) -> bool {
    !value.is_null() && sha256_or_null(value)
}

fn unique_blockers(value: &Value) -> bool {
    let Some(values) = value.as_array() else {
        return false;
    };
    let mut unique = BTreeSet::new();
    values.iter().all(|value| {
        value
            .as_str()
            .is_some_and(|value| !value.is_empty() && unique.insert(value.to_owned()))
    })
}

fn optional_string_or_null(value: &Value) -> bool {
    value.is_null() || nonempty_string(value)
}

fn optional_object_or_null(value: &Value) -> bool {
    value.is_null() || value.as_object().is_some()
}

/// Validate a Node `verifyOffhostWormTarget` result and return whether it is
/// currently qualified for full production custody.
///
/// This function performs no mount probes, filesystem reads, subprocesses, or
/// writes. The caller must retain and revalidate the source evidence itself;
/// this function only validates the JSON protocol crossing this boundary.
pub fn verify_offhost_worm_target_status_v1(
    status: &Value,
    expected_contract_id: &str,
    observed_at: &Value,
) -> Result<bool> {
    if !nonempty_string(&Value::String(expected_contract_id.to_owned()))
        || canonical_instant(observed_at).is_none()
        || !exact_keys(status, &STATUS_KEYS)
        || status["version"] != 1
        || status["kind"] != "OffhostWormTargetStatus"
        || !matches!(
            status["status"].as_str(),
            Some("offhost_worm_target_ready" | "offhost_worm_target_blocked")
        )
        || !nonempty_string(&status["contractId"])
        || !nonempty_string(&status["targetMountRoot"])
        || !status["targetMountRoot"]
            .as_str()
            .is_some_and(|value| value.starts_with('/'))
        || !nonempty_string(&status["currentProtectionLevel"])
    {
        return Err(error("offhost_worm_target_status_protocol_invalid"));
    }

    for key in [
        "mountAvailable",
        "mountDeviceMatchesTarget",
        "mountIdMatchesTarget",
        "storageIdentityMatchesContract",
        "distinctDevice",
        "custodyRequired",
        "custodyDeclaredQualified",
        "offHostOrOffsiteCustodyQualified",
    ] {
        if !status[key].is_boolean() {
            return Err(error("offhost_worm_target_status_protocol_invalid"));
        }
    }
    for key in [
        "mountIdentity",
        "mountObservationHash",
        "targetDeviceMajorMinor",
        "targetMountId",
        "expectedStorageIdentityHash",
        "storageIdentityHash",
    ] {
        if !optional_string_or_null(&status[key]) {
            return Err(error("offhost_worm_target_status_protocol_invalid"));
        }
    }
    if !optional_object_or_null(&status["targetDirectoryIdentity"])
        || !unique_blockers(&status["blockers"])
        || !unique_blockers(&status["custodyBlockers"])
    {
        return Err(error("offhost_worm_target_status_protocol_invalid"));
    }
    for key in [
        "custodyEvidenceBundleHash",
        "custodyTrustStoreHash",
        "custodyEvidenceExpiresAt",
    ] {
        if !status[key].is_null() && key.ends_with("ExpiresAt") {
            if canonical_instant(&status[key]).is_none() {
                return Err(error("offhost_worm_target_status_protocol_invalid"));
            }
        } else if !sha256_or_null(&status[key]) {
            return Err(error("offhost_worm_target_status_protocol_invalid"));
        }
    }
    if !matches!(
        status["custodyEvidenceStatus"].as_str(),
        Some("offhost_worm_custody_evidence_verified" | "offhost_worm_custody_evidence_blocked")
    ) || !matches!(
        status["custodyStatus"].as_str(),
        Some("offhost_or_offsite_custody_qualified" | "offhost_or_offsite_custody_blocked")
    ) {
        return Err(error("offhost_worm_target_status_protocol_invalid"));
    }

    // A ready claim must contain every mount and custody predicate consumed by
    // `evaluateFullProductionReadiness`; a blocked claim remains valid evidence
    // but can never be promoted to ready by this verifier.
    let evidence_expiry = canonical_instant(&status["custodyEvidenceExpiresAt"]);
    let ready = status["status"] == "offhost_worm_target_ready"
        && status["contractId"] == expected_contract_id
        && status["custodyRequired"] == true
        && status["custodyDeclaredQualified"] == true
        && status["offHostOrOffsiteCustodyQualified"] == true
        && status["custodyStatus"] == "offhost_or_offsite_custody_qualified"
        && status["custodyEvidenceStatus"] == "offhost_worm_custody_evidence_verified"
        && sha256(&status["custodyEvidenceBundleHash"])
        && sha256(&status["custodyTrustStoreHash"])
        && sha256(&status["storageIdentityHash"])
        && evidence_expiry
            .is_some_and(|expiry| canonical_instant(observed_at).is_some_and(|now| now < expiry))
        && status["blockers"].as_array().is_some_and(Vec::is_empty)
        && status["custodyBlockers"]
            .as_array()
            .is_some_and(Vec::is_empty);
    // The target verifier may have produced a valid ready snapshot that is
    // stale by the time the aggregate policy observes it. Preserve that
    // protocol result and return `false`; the caller must not reinterpret a
    // stale snapshot as malformed or refresh it without a new probe.
    Ok(ready)
}

/// Short alias for callers that already know the enclosing readiness policy.
pub use verify_offhost_worm_target_status_v1 as verify_offhost_worm_target_status;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn h() -> Value {
        Value::String(format!("sha256:{}", "a".repeat(64)))
    }

    fn valid_status() -> Value {
        json!({
            "version": 1, "kind": "OffhostWormTargetStatus", "status": "offhost_worm_target_ready",
            "contractId": "hepta-paper-offhost-worm-toshiba-clean3-v2", "targetMountRoot": "/mnt/hepta-paper-external",
            "mountAvailable": true, "mountIdentity": "{\"target\":\"/mnt/hepta-paper-external\"}", "mountObservationHash": h(),
            "targetDirectoryIdentity": {"dev":"1", "ino":"2"}, "targetDeviceMajorMinor": "8:1", "targetMountId": "42",
            "mountDeviceMatchesTarget": true, "mountIdMatchesTarget": true,
            "expectedStorageIdentityHash": h(), "storageIdentityMatchesContract": true, "distinctDevice": true,
            "storageIdentityHash": h(), "custodyRequired": true, "currentProtectionLevel": "same_host_external_disk",
            "custodyDeclaredQualified": true, "offHostOrOffsiteCustodyQualified": true,
            "custodyStatus": "offhost_or_offsite_custody_qualified", "custodyBlockers": [],
            "custodyEvidenceStatus": "offhost_worm_custody_evidence_verified", "custodyEvidenceBundleHash": h(),
            "custodyTrustStoreHash": h(), "custodyEvidenceExpiresAt": "2026-09-20T13:00:00.000Z", "blockers": []
        })
    }

    #[test]
    fn valid_status_is_accepted_without_io() {
        assert_eq!(
            verify_offhost_worm_target_status_v1(
                &valid_status(),
                "hepta-paper-offhost-worm-toshiba-clean3-v2",
                &json!("2026-09-20T12:00:00.000Z"),
            ),
            Ok(true)
        );
    }

    #[test]
    fn expiry_and_claim_mismatch_fail_closed() {
        let mut expired = valid_status();
        expired["custodyEvidenceExpiresAt"] = json!("2026-09-20T11:00:00.000Z");
        assert_eq!(
            verify_offhost_worm_target_status_v1(
                &expired,
                "hepta-paper-offhost-worm-toshiba-clean3-v2",
                &json!("2026-09-20T12:00:00.000Z"),
            ),
            Ok(false)
        );
        let mut blocked = valid_status();
        blocked["status"] = json!("offhost_worm_target_blocked");
        blocked["blockers"] = json!(["offhost_worm_target_unavailable"]);
        assert_eq!(
            verify_offhost_worm_target_status_v1(
                &blocked,
                "hepta-paper-offhost-worm-toshiba-clean3-v2",
                &json!("2026-09-20T12:00:00.000Z"),
            ),
            Ok(false)
        );
    }

    #[test]
    fn node_target_and_aggregate_fixture_matches_rust_protocol_boundary() {
        use std::io::Read;
        use std::process::{Command, Stdio};
        let repository = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = Command::new("node")
            .arg(repository.join("rust/oracle/offhost-worm-status-v1.mjs"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("node oracle");
        let mut output = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        let result = child.wait_with_output().expect("node oracle wait");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let oracle: Value = serde_json::from_str(&output).expect("oracle JSON");
        assert_eq!(oracle["profile"]["node"], "v22.23.1");
        for case in oracle["results"].as_array().unwrap() {
            let actual = verify_offhost_worm_target_status_v1(
                &case["status"],
                case["contractId"].as_str().unwrap(),
                &case["observedAt"],
            )
            .expect("Node status shape must cross the Rust boundary");
            assert_eq!(actual, case["ready"], "case {}", case["label"]);
        }
    }

    #[test]
    fn duplicate_or_malformed_blockers_are_rejected() {
        let mut malformed = valid_status();
        malformed["blockers"] = json!(["same", "same"]);
        assert_eq!(
            verify_offhost_worm_target_status_v1(
                &malformed,
                "hepta-paper-offhost-worm-toshiba-clean3-v2",
                &json!("2026-09-20T12:00:00.000Z"),
            ),
            Err(OffhostWormStatusError(
                "offhost_worm_target_status_protocol_invalid".into()
            ))
        );
    }
}
