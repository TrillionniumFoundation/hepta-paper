//! Strict verifier for the personal self-hosted formal-operation receipt.
//!
//! The Node observer accepts this receipt only when its complete shape, pinned
//! test inventory, counters, content hash, and exact code provenance all agree.
//! Keeping the verifier separate makes it possible to exercise the contract
//! before wiring it into the readiness report.

#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};

const KIND: &str = "FormalOperationalTestReceipt";
const VERSION: i64 = 2;
const EXPECTED_TEST_FILES: [&str; 4] = [
    "paper-core/tests/dynamic-formal-claim-kernel-e2e.test.mjs",
    "paper-core/tests/formal-campaign-release.test.mjs",
    "paper-core/tests/formal-proof-search-operations.test.mjs",
    "paper-core/tests/typed-theorem-dependency-graph.test.mjs",
];

/// The complete diagnostic projection consumed by the readiness evaluator.
pub(crate) fn inspect_formal_receipt(value: Option<&Value>, provenance: Option<&Value>) -> Value {
    let verified = value.is_some_and(|receipt| verify_formal_receipt(receipt, provenance));
    let receipt = value.cloned().unwrap_or_else(|| json!({}));
    json!({
        "verified": verified,
        "zeroSkipped": verified
            && receipt["fail"] == 0
            && receipt["skipped"] == 0
            && receipt["todo"] == 0,
        "pass": receipt["pass"].as_i64().unwrap_or(0),
        "fail": receipt["fail"].as_i64().unwrap_or(0),
        "skipped": receipt["skipped"].as_i64().unwrap_or(0),
        "todo": receipt["todo"].as_i64().unwrap_or(0),
        "commit": receipt["codeProvenance"]["commit"].clone(),
        "receiptHash": receipt["formalOperationalReceiptHash"].clone(),
    })
}

/// Verify the exact Node `verifyFormalOperationalReceipt` contract.
pub(crate) fn verify_formal_receipt(value: &Value, provenance: Option<&Value>) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    const KEYS: [&str; 12] = [
        "cancelled",
        "codeProvenance",
        "fail",
        "formalOperationalReceiptHash",
        "kind",
        "pass",
        "suites",
        "testFiles",
        "tests",
        "todo",
        "version",
        "skipped",
    ];
    if object.len() != KEYS.len() || KEYS.iter().any(|key| !object.contains_key(*key)) {
        return false;
    }
    if value["version"] != VERSION
        || value["kind"] != KIND
        || value["testFiles"] != json!(EXPECTED_TEST_FILES)
        || value["tests"] != 23
        || value["suites"] != 0
        || value["pass"] != 23
        || value["fail"] != 0
        || value["cancelled"] != 0
        || value["skipped"] != 0
        || value["todo"] != 0
        || value["codeProvenance"].as_object().is_none()
    {
        return false;
    }
    let Some(receipt_hash) = value["formalOperationalReceiptHash"].as_str() else {
        return false;
    };
    if !is_sha256(receipt_hash) {
        return false;
    }
    let mut payload = value.clone();
    let Some(payload_object) = payload.as_object_mut() else {
        return false;
    };
    payload_object.remove("formalOperationalReceiptHash");
    if !production_hash_record_v1(KIND, &payload)
        .ok()
        .is_some_and(|hash| hash.as_str() == receipt_hash)
    {
        return false;
    }
    provenance.is_some_and(|expected| {
        production_hash_record_v1("ExactCodeProvenance", &value["codeProvenance"]).ok()
            == production_hash_record_v1("ExactCodeProvenance", expected).ok()
    })
}

fn is_sha256(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provenance() -> Value {
        json!({
            "commit": "0123456789abcdef0123456789abcdef01234567",
            "commitTree": "fedcba9876543210fedcba9876543210fedcba98",
            "repositoryContentHash": format!("sha256:{}", "a".repeat(64)),
        })
    }

    fn valid_receipt(provenance: &Value) -> Value {
        let mut payload = json!({
            "version": VERSION,
            "kind": KIND,
            "testFiles": EXPECTED_TEST_FILES,
            "tests": 23,
            "suites": 0,
            "pass": 23,
            "fail": 0,
            "cancelled": 0,
            "skipped": 0,
            "todo": 0,
            "codeProvenance": provenance,
        });
        let hash = production_hash_record_v1(KIND, &payload).expect("receipt hash");
        payload.as_object_mut().expect("receipt object").insert(
            "formalOperationalReceiptHash".into(),
            Value::String(hash.as_str().to_owned()),
        );
        payload
    }

    #[test]
    fn exact_receipt_and_provenance_are_accepted() {
        let provenance = provenance();
        let receipt = valid_receipt(&provenance);
        assert!(verify_formal_receipt(&receipt, Some(&provenance)));
        let projection = inspect_formal_receipt(Some(&receipt), Some(&provenance));
        assert_eq!(projection["verified"], true);
        assert_eq!(projection["zeroSkipped"], true);
        assert_eq!(projection["pass"], 23);
    }

    #[test]
    fn shape_hash_and_provenance_mutations_fail_closed() {
        let provenance = provenance();
        let receipt = valid_receipt(&provenance);

        let mut extra = receipt.clone();
        extra
            .as_object_mut()
            .expect("receipt object")
            .insert("unexpected".into(), json!(true));
        assert!(!verify_formal_receipt(&extra, Some(&provenance)));

        let mut changed = receipt.clone();
        changed["pass"] = json!(22);
        assert!(!verify_formal_receipt(&changed, Some(&provenance)));

        let mut wrong_provenance = provenance.clone();
        wrong_provenance["commit"] = json!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert!(!verify_formal_receipt(&receipt, Some(&wrong_provenance)));

        let mut uppercase_hash = receipt;
        uppercase_hash["formalOperationalReceiptHash"] =
            json!("sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        assert!(!verify_formal_receipt(&uppercase_hash, Some(&provenance)));
    }

    #[test]
    fn missing_receipt_is_blocked_without_diagnostic_claims() {
        let projection = inspect_formal_receipt(None, None);
        assert_eq!(projection["verified"], false);
        assert_eq!(projection["zeroSkipped"], false);
        assert_eq!(projection["pass"], 0);
        assert_eq!(projection["receiptHash"], Value::Null);
    }
}
