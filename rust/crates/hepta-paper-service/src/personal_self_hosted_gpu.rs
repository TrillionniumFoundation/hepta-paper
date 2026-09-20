//! Exact shape/hash verifier for the personal GPU operational receipt.
//!
//! Readiness only consumes receipts which claim a successful personal run.
//! The verifier therefore mirrors every positive branch of the Node contract
//! and rejects malformed or self-authored boolean/hash projections.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const PROFILE_ID: &str = "personal-single-host-gpu-v1";
const KIND: &str = "PersonalGpuOperationalReceipt";
const GPU_UUID_PREFIX: &str = "GPU-";
const GPU_KEYS: [&str; 5] = [
    "computeCapability",
    "driverVersion",
    "gpuModel",
    "gpuUuid",
    "memoryMiB",
];
const RUNTIME_KEYS: [&str; 5] = [
    "dockerDigestBound",
    "image",
    "imageDigest",
    "networkDisabled",
    "singleDevicePinned",
];
const PDE_KEYS: [&str; 5] = [
    "cpuOracleHash",
    "cpuOracleStatus",
    "receiptHash",
    "scientificChecksPassed",
    "status",
];
const DL_KEYS: [&str; 13] = [
    "checkpointManifestHash",
    "cpuOracleHash",
    "cpuOracleStatus",
    "datasetManifestHash",
    "deterministicReplay",
    "errorBudgetHash",
    "hiddenEvaluationHash",
    "hiddenEvaluationStatus",
    "modelIrHash",
    "originalReceiptHash",
    "replayReceiptHash",
    "sameDeviceReplayHash",
    "status",
];
const IR_KEYS: [&str; 6] = [
    "checkpointExecutablePayloadAllowed",
    "checkpointHash",
    "datasetHash",
    "modelExecutableCodeEmbedded",
    "modelHash",
    "pickleAllowed",
];
const POLICY_KEYS: [&str; 6] = [
    "externalAuthorityStatus",
    "kind",
    "profileId",
    "secondHardwareStatus",
    "scope",
    "version",
];
const RELEASE_KEYS: [&str; 3] = [
    "independentSecondHardwareRequired",
    "releaseBlockers",
    "releasePromotionEligible",
];
const RECEIPT_KEYS: [&str; 17] = [
    "blockers",
    "createdAtEpochMs",
    "deepLearning",
    "externalActionPerformed",
    "gpu",
    "ir",
    "kind",
    "localPolicy",
    "networkActionPerformed",
    "pde",
    "personalProductionReady",
    "profileId",
    "releaseBoundary",
    "runtime",
    "version",
    "personalGpuOperationalReceiptHash",
    "workspaceCommit",
];

/// Build the same fail-closed receipt shape emitted by the Node gate when a
/// `--check` input is absent or invalid.  This helper deliberately does not
/// observe hardware, launch Docker, or write a receipt; it is only the
/// read-only diagnostic fallback used by the partial Rust check route.
pub fn blocked_personal_gpu_receipt_v1(
    created_at_epoch_ms: i64,
    workspace_commit: Option<&str>,
    failure_token: &str,
) -> Result<Value, Box<dyn std::error::Error>> {
    let valid_commit =
        workspace_commit.is_some_and(|value| commit(Some(&Value::String(value.to_owned()))));
    let mut blockers = BTreeSet::from([
        failure_token.to_owned(),
        "personal_gpu_receipt_gpu_observation_invalid".to_owned(),
        "personal_gpu_receipt_runtime_invalid".to_owned(),
        "personal_gpu_receipt_pde_evidence_invalid".to_owned(),
        "personal_gpu_receipt_deep_learning_evidence_invalid".to_owned(),
        "personal_gpu_receipt_ir_binding_invalid".to_owned(),
    ]);
    if !valid_commit {
        blockers.insert("personal_gpu_receipt_workspace_commit_invalid".to_owned());
    }
    let payload = json!({
        "version": 1,
        "kind": KIND,
        "profileId": PROFILE_ID,
        "createdAtEpochMs": created_at_epoch_ms,
        "workspaceCommit": if valid_commit {
            Value::String(workspace_commit.unwrap_or_default().to_owned())
        } else {
            Value::Null
        },
        "gpu": Value::Null,
        "runtime": Value::Null,
        "pde": Value::Null,
        "deepLearning": Value::Null,
        "ir": Value::Null,
        "localPolicy": {
            "version": 1,
            "kind": "PersonalGpuOperationalProfile",
            "profileId": PROFILE_ID,
            "scope": "single-owner-local-runtime-v1",
            "secondHardwareStatus": "not_applicable_for_personal_use",
            "externalAuthorityStatus": "not_applicable_for_personal_use",
        },
        "releaseBoundary": {
            "independentSecondHardwareRequired": true,
            "releasePromotionEligible": false,
            "releaseBlockers": [
                "independent_second_hardware_required_for_release",
                "external_authority_required_for_release",
            ],
        },
        "personalProductionReady": false,
        "blockers": blockers.into_iter().collect::<Vec<_>>(),
        "externalActionPerformed": false,
        "networkActionPerformed": false,
    });
    let receipt_hash = production_hash_record_v1(KIND, &payload)?;
    let mut receipt = payload;
    let Some(object) = receipt.as_object_mut() else {
        return Err("blocked personal GPU receipt payload must be an object".into());
    };
    object.insert(
        "personalGpuOperationalReceiptHash".to_owned(),
        Value::String(receipt_hash.as_str().to_owned()),
    );
    Ok(receipt)
}

fn exact_keys(value: Option<&Value>, keys: &[&str]) -> bool {
    let Some(object) = value.and_then(Value::as_object) else {
        return false;
    };
    object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
}

fn hash(value: Option<&Value>) -> bool {
    let Some(value) = value.and_then(Value::as_str) else {
        return false;
    };
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn commit(value: Option<&Value>) -> bool {
    let Some(value) = value.and_then(Value::as_str) else {
        return false;
    };
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn safe_epoch(value: &Value) -> bool {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    if let Some(integer) = value.as_i64() {
        return (1..=9_007_199_254_740_991).contains(&integer);
    }
    if let Some(integer) = value.as_u64() {
        return (1..=9_007_199_254_740_991).contains(&integer);
    }
    value.as_f64().is_some_and(|number| {
        number.is_finite() && number.fract() == 0.0 && number > 0.0 && number <= MAX_SAFE_INTEGER
    })
}

fn valid_gpu(value: &Value) -> bool {
    exact_keys(Some(value), &GPU_KEYS)
        && value["gpuUuid"].as_str().is_some_and(|text| {
            let bytes = text.as_bytes();
            bytes.len() == 40
                && text.starts_with(GPU_UUID_PREFIX)
                && [12, 17, 22, 27].iter().all(|index| bytes[*index] == b'-')
                && bytes.iter().enumerate().skip(4).all(|(index, byte)| {
                    [12, 17, 22, 27].contains(&index)
                        || (byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                })
        })
        && value["gpuModel"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
        && value["computeCapability"].as_str().is_some_and(|text| {
            let mut parts = text.split('.');
            parts.next().is_some_and(|v| {
                (1..=2).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit())
            }) && parts.next().is_some_and(|v| {
                (1..=2).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit())
            }) && parts.next().is_none()
        })
        && value["driverVersion"].as_str().is_some_and(|text| {
            let parts = text.split('.').collect::<Vec<_>>();
            (2..=4).contains(&parts.len())
                && parts
                    .iter()
                    .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        })
        && value["memoryMiB"]
            .as_i64()
            .is_some_and(|value| (1..=9_007_199_254_740_991).contains(&value))
}

fn valid_runtime(value: &Value) -> bool {
    exact_keys(Some(value), &RUNTIME_KEYS)
        && value["image"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
        && hash(value.get("imageDigest"))
        && value["dockerDigestBound"] == true
        && value["networkDisabled"] == true
        && value["singleDevicePinned"] == true
}

fn valid_pde(value: &Value) -> bool {
    exact_keys(Some(value), &PDE_KEYS)
        && hash(value.get("receiptHash"))
        && hash(value.get("cpuOracleHash"))
        && value["status"] == "canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable"
        && value["cpuOracleStatus"] == "process_isolated_pde_poisson_2d_cpu_oracle_verified"
        && value["scientificChecksPassed"] == true
}

fn valid_dl(value: &Value) -> bool {
    exact_keys(Some(value), &DL_KEYS)
        && [
            "originalReceiptHash",
            "replayReceiptHash",
            "sameDeviceReplayHash",
            "cpuOracleHash",
            "hiddenEvaluationHash",
            "modelIrHash",
            "datasetManifestHash",
            "checkpointManifestHash",
            "errorBudgetHash",
        ]
        .iter()
        .all(|key| hash(value.get(*key)))
        && value["status"] == "personal_deep_learning_gpu_verified_non_promotable"
        && value["cpuOracleStatus"] == "process_isolated_deep_learning_cpu_oracle_verified"
        && value["hiddenEvaluationStatus"] == "deep_learning_hidden_evaluation_recorded"
        && value["deterministicReplay"] == true
}

fn valid_ir(value: &Value, deep_learning: &Value) -> bool {
    exact_keys(Some(value), &IR_KEYS)
        && value["modelHash"] == deep_learning["modelIrHash"]
        && value["datasetHash"] == deep_learning["datasetManifestHash"]
        && value["checkpointHash"] == deep_learning["checkpointManifestHash"]
        && value["modelExecutableCodeEmbedded"] == false
        && value["checkpointExecutablePayloadAllowed"] == false
        && value["pickleAllowed"] == false
}

fn valid_policy(value: &Value) -> bool {
    exact_keys(Some(value), &POLICY_KEYS)
        && *value
            == json!({
                "version": 1,
                "kind": "PersonalGpuOperationalProfile",
                "profileId": PROFILE_ID,
                "scope": "single-owner-local-runtime-v1",
                "secondHardwareStatus": "not_applicable_for_personal_use",
                "externalAuthorityStatus": "not_applicable_for_personal_use",
            })
}

fn valid_release(value: &Value) -> bool {
    exact_keys(Some(value), &RELEASE_KEYS)
        && *value
            == json!({
                "independentSecondHardwareRequired": true,
                "releasePromotionEligible": false,
                "releaseBlockers": [
                    "independent_second_hardware_required_for_release",
                    "external_authority_required_for_release",
                ],
            })
}

/// Verify a successful receipt. Blocked receipts are intentionally rejected
/// here because readiness additionally requires `personalProductionReady`.
pub(crate) fn verify_personal_gpu_receipt(value: &Value) -> bool {
    verify_personal_gpu_operational_receipt(value) && value["personalProductionReady"] == true
}

/// Verify the complete Node operational-receipt contract, including blocked
/// receipts.  The readiness observer consumes only a positive receipt, but
/// the Node `--check` route deliberately accepts a valid blocked receipt and
/// exits with status 2.  Keeping this verifier separate prevents the Rust
/// check route from accidentally accepting a forged readiness boolean while
/// preserving the incumbent blocked-receipt semantics.
pub fn verify_personal_gpu_operational_receipt(value: &Value) -> bool {
    if !exact_keys(Some(value), &RECEIPT_KEYS)
        || value["version"] != 1
        || value["kind"] != KIND
        || value["profileId"] != PROFILE_ID
        || value["externalActionPerformed"] != false
        || value["networkActionPerformed"] != false
        || !valid_policy(&value["localPolicy"])
        || !valid_release(&value["releaseBoundary"])
    {
        return false;
    }

    let Some(blockers) = value["blockers"].as_array() else {
        return false;
    };
    // `buildPersonalGpuOperationalReceipt` stringifies blocker entries before
    // sorting/deduplicating them.  A parsed receipt therefore always contains
    // strings and the exact canonical order.
    let Some(supplied_blockers) = blockers
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    let mut expected_blockers = supplied_blockers.clone();
    expected_blockers.sort();
    expected_blockers.dedup();
    if supplied_blockers != expected_blockers {
        return false;
    }

    let valid_created_at = safe_epoch(&value["createdAtEpochMs"]);
    let valid_workspace_commit = commit(value.get("workspaceCommit"));
    let valid_gpu_evidence = valid_gpu(&value["gpu"]);
    let valid_runtime_evidence = valid_runtime(&value["runtime"]);
    let valid_pde_evidence = valid_pde(&value["pde"]);
    let valid_dl_evidence = valid_dl(&value["deepLearning"]);
    let valid_ir_evidence = valid_ir(&value["ir"], &value["deepLearning"]);
    if !valid_created_at {
        expected_blockers.push("personal_gpu_receipt_timestamp_invalid".to_owned());
    }
    if !valid_workspace_commit {
        expected_blockers.push("personal_gpu_receipt_workspace_commit_invalid".to_owned());
    }
    if !valid_gpu_evidence {
        expected_blockers.push("personal_gpu_receipt_gpu_observation_invalid".to_owned());
    }
    if !valid_runtime_evidence {
        expected_blockers.push("personal_gpu_receipt_runtime_invalid".to_owned());
    }
    if !valid_pde_evidence {
        expected_blockers.push("personal_gpu_receipt_pde_evidence_invalid".to_owned());
    }
    if !valid_dl_evidence {
        expected_blockers.push("personal_gpu_receipt_deep_learning_evidence_invalid".to_owned());
    }
    if !valid_ir_evidence {
        expected_blockers.push("personal_gpu_receipt_ir_binding_invalid".to_owned());
    }
    expected_blockers.sort();
    expected_blockers.dedup();
    if supplied_blockers != expected_blockers
        || value["personalProductionReady"] != (supplied_blockers.is_empty())
    {
        return false;
    }

    // Reproduce the domain builder's normalization for invalid evidence.  A
    // blocked receipt may contain only null evidence fields; accepting a
    // malformed object here would diverge from Node's JSON.stringify(rebuilt)
    // equality check and could hide a forged hash.
    let mut normalized = value.clone();
    let Some(object) = normalized.as_object_mut() else {
        return false;
    };
    if !valid_workspace_commit {
        object.insert("workspaceCommit".to_owned(), Value::Null);
    }
    if !valid_gpu_evidence {
        object.insert("gpu".to_owned(), Value::Null);
    }
    if !valid_runtime_evidence {
        object.insert("runtime".to_owned(), Value::Null);
    }
    if !valid_pde_evidence {
        object.insert("pde".to_owned(), Value::Null);
    }
    if !valid_dl_evidence {
        object.insert("deepLearning".to_owned(), Value::Null);
    }
    if !valid_ir_evidence {
        object.insert("ir".to_owned(), Value::Null);
    }
    if normalized != *value {
        return false;
    }

    let Some(receipt_hash) = normalized
        .get("personalGpuOperationalReceiptHash")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return false;
    };
    if !hash(Some(&Value::String(receipt_hash.clone()))) {
        return false;
    }
    let Some(object) = normalized.as_object_mut() else {
        return false;
    };
    object.remove("personalGpuOperationalReceiptHash");
    production_hash_record_v1(KIND, &normalized)
        .ok()
        .is_some_and(|computed| computed.as_str() == receipt_hash)
}
