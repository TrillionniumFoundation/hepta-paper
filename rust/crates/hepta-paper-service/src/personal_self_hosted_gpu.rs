//! Exact shape/hash verifier for the personal GPU operational receipt.
//!
//! Readiness only consumes receipts which claim a successful personal run.
//! The verifier therefore mirrors every positive branch of the Node contract
//! and rejects malformed or self-authored boolean/hash projections.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};

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

fn valid_gpu(value: &Value) -> bool {
    exact_keys(Some(value), &GPU_KEYS)
        && value["gpuUuid"].as_str().is_some_and(|text| {
            let bytes = text.as_bytes();
            bytes.len() == 40
                && text.starts_with(GPU_UUID_PREFIX)
                && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
                && bytes.iter().enumerate().skip(4).all(|(index, byte)| {
                    [8, 13, 18, 23].contains(&index)
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
    if !exact_keys(Some(value), &RECEIPT_KEYS)
        || value["version"] != 1
        || value["kind"] != KIND
        || value["profileId"] != PROFILE_ID
        || value["personalProductionReady"] != true
        || value["externalActionPerformed"] != false
        || value["networkActionPerformed"] != false
        || value["blockers"]
            .as_array()
            .is_none_or(|values| !values.is_empty())
        || !value["createdAtEpochMs"]
            .as_i64()
            .is_some_and(|value| (1..=9_007_199_254_740_991).contains(&value))
        || !commit(value.get("workspaceCommit"))
        || !valid_gpu(&value["gpu"])
        || !valid_runtime(&value["runtime"])
        || !valid_pde(&value["pde"])
        || !valid_dl(&value["deepLearning"])
        || !valid_ir(&value["ir"], &value["deepLearning"])
        || !valid_policy(&value["localPolicy"])
        || !valid_release(&value["releaseBoundary"])
    {
        return false;
    }
    let mut payload = value.clone();
    let Some(object) = payload.as_object_mut() else {
        return false;
    };
    let Some(receipt_hash) = object.remove("personalGpuOperationalReceiptHash") else {
        return false;
    };
    let Some(receipt_hash) = receipt_hash.as_str() else {
        return false;
    };
    hash(Some(&Value::String(receipt_hash.to_owned())))
        && production_hash_record_v1(KIND, &payload)
            .ok()
            .is_some_and(|hash| hash.as_str() == receipt_hash)
}
