//! Pure original recorded-contract comparisons. No provider, SQLite, authority
//! hook, installed service or independent acceptance is exercised here.
#[allow(dead_code)]
mod machine_intake_support;

use hepta_paper_service::topic_producer_canary::{
    parse_generation, verify_journal, verify_side_effect,
};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Command, sync::OnceLock};

const INVALID: &str = "autonomous_research_topic_producer_state_invalid";
const UNSUPPORTED: &str = "autonomous_research_topic_producer_state_json_profile_unsupported";
static ORIGINAL: OnceLock<Value> = OnceLock::new();

fn original() -> &'static Value {
    ORIGINAL.get_or_init(|| {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repository = manifest.join("../../..").canonicalize().expect("actual repository");
        let input = serde_json::to_string(&json!({"repositoryRoot":repository})).expect("oracle input");
        let mut command = Command::new("node");
        command.arg(manifest.join("../../oracle/topic-producer-canary-v1.mjs"))
            .arg(input).current_dir(&repository).env_clear()
            .env("PATH", std::env::var_os("PATH").expect("qualified Node PATH"))
            .env("LANG", "en_US.UTF-8");
        let output = machine_intake_support::run(&mut command);
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let output: Value = serde_json::from_slice(&output.stdout).expect("bounded original oracle JSON");
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&output["profile"])
            .expect("actual qualified Node and original record-hash source");
        assert_eq!(output["value"]["evidenceScope"], "original_pure_recorded_canary_and_generation_contracts_no_provider_or_authority_acceptance");
        output["value"].clone()
    })
}

fn verify_case(case: &Value) {
    let value = &case["value"];
    let options = &case["options"];
    let provider_clone = value["providerConfigurationHash"].clone();
    let reservation_clone = value["reservation"].clone();
    let provider = match options["providerBinding"].as_str() {
        Some("self") => Some(&value["providerConfigurationHash"]),
        Some("clone") => Some(&provider_clone),
        None => options.get("provider"),
        _ => panic!("unknown source fixture binding"),
    };
    let reservation = match options["reservationBinding"].as_str() {
        Some("self") => Some(&value["reservation"]),
        Some("clone") => Some(&reservation_clone),
        None => options.get("reservation"),
        _ => panic!("unknown source fixture binding"),
    };
    let result = match case["type"].as_str() {
        Some("journal") => verify_journal(value, provider, reservation),
        Some("inspection") => verify_side_effect(value, provider, reservation),
        _ => panic!("unknown source fixture contract"),
    };
    if case["expected"]["ok"] == true {
        assert_eq!(
            Value::Bool(result),
            case["expected"]["value"],
            "{}",
            case["name"]
        );
    } else {
        assert_eq!(case["name"], "failed-hash-string-coercion-error");
        assert_eq!(
            case["expected"]["error"],
            "Cannot convert object to primitive value"
        );
        assert!(
            !result,
            "explicit boolean-profile refusal, not original error parity"
        );
    }
}

fn generation_case(case: &Value) {
    let result = parse_generation(
        &case["row"],
        case["options"].get("provider"),
        case["options"].get("maxCost"),
    );
    if case["expected"]["ok"] == true {
        assert_eq!(
            result.expect("original-valid recorded generation"),
            case["expected"]["value"],
            "{}",
            case["name"]
        );
    } else if case["expected"]["error"] == INVALID {
        assert_eq!(
            result.expect_err("original state refusal").code(),
            INVALID,
            "{}",
            case["name"]
        );
    } else {
        let name = case["name"].as_str().expect("fixture name");
        assert!(
            name == "capability-json-null"
                || name.starts_with("inspection-actions-type-error-")
                || name.starts_with("number-coercion-type-error-"),
            "unclassified original error: {}",
            case["expected"]["error"]
        );
        assert!(
            case["expected"]["error"]
                .as_str()
                .expect("original error")
                .starts_with("Cannot read properties of")
                || case["expected"]["error"] == "Cannot convert object to primitive value"
        );
        assert_eq!(
            result
                .expect_err("explicit native profile refusal of original engine TypeError")
                .code(),
            UNSUPPORTED,
            "{name}"
        );
    }
}

fn verifier_group(name: &str) -> u8 {
    if name == "failed-hash-string-coercion-error" {
        6
    } else if name.starts_with("builder-") {
        0
    } else if name.starts_with("array-reference-") || name.starts_with("reservation-option-") {
        3
    } else if name.starts_with("provider-option-")
        || name == "phase-and-action-hash-array-positive"
        || name == "failed-nonnull-nonhash-and-code-array"
    {
        2
    } else {
        1
    }
}
fn row_group(name: &str) -> u8 {
    if name.starts_with("no-journal-") {
        7
    } else if name.starts_with("generation-number-")
        || name.starts_with("started-number-")
        || name.starts_with("lease-number-")
        || name == "undefined-output-fields-omitted"
    {
        4
    } else if name == "capability-json-null"
        || name.starts_with("inspection-actions-type-error-")
        || name.starts_with("number-coercion-type-error-")
    {
        6
    } else if name.contains("journal")
        || name.starts_with("real-builder-action-prefix")
        || name.starts_with("raw-action-member-order")
        || name.starts_with("failed-code-mismatch")
        || name.starts_with("inspection-")
        || name.starts_with("separately-parsed-array")
    {
        5
    } else {
        7
    }
}
fn run_group(group: u8) {
    let mut count = 0;
    for case in original()["cases"]
        .as_array()
        .expect("original verifier matrix")
    {
        if verifier_group(case["name"].as_str().expect("name")) == group {
            verify_case(case);
            count += 1;
        }
    }
    for case in original()["rows"]
        .as_array()
        .expect("original generation matrix")
    {
        if row_group(case["name"].as_str().expect("name")) == group {
            generation_case(case);
            count += 1;
        }
    }
    assert!(count > 0, "meaningful original cases in group {group}");
}

#[test]
fn actual_original_builders_cover_role_transitions_and_complete_failure_accounting() {
    run_group(0);
}
#[test]
fn actual_rehashed_shape_and_derived_field_tampering_is_rejected() {
    run_group(1);
}
#[test]
fn actual_js_truthiness_and_nested_array_string_coercions_match() {
    run_group(2);
}
#[test]
fn actual_same_reservation_and_provider_use_reference_identity_for_arrays() {
    run_group(3);
}
#[test]
fn actual_number_coercion_nan_projection_and_undefined_omission_match() {
    run_group(4);
}
#[test]
fn actual_generation_action_prefix_raw_json_order_and_cost_bindings_match() {
    run_group(5);
}
#[test]
fn original_incidental_type_errors_are_explicit_native_profile_refusals() {
    run_group(6);
}
#[test]
fn actual_legacy_terminal_and_weaker_historical_capability_contract_is_preserved() {
    run_group(7);
}

#[test]
fn finite_native_json_bounds_refuse_before_pure_contract_processing() {
    let original_case = original()["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .find(|case| case["name"] == "recorded-planned-without-full-rehash")
        .expect("actual source baseline");
    let mut row = original_case["row"].clone();
    row["planned_generation_json"] = Value::String(" ".repeat(2 * 1024 * 1024 + 1));
    assert_eq!(
        parse_generation(&row, None, None)
            .expect_err("bounded raw row")
            .code(),
        UNSUPPORTED
    );
    let mut nested = Value::String("owned".to_owned());
    for _ in 0..66 {
        nested = json!([nested]);
    }
    row = original_case["row"].clone();
    row["intake_id"] = nested;
    assert_eq!(
        parse_generation(&row, None, None)
            .expect_err("bounded traversal")
            .code(),
        UNSUPPORTED
    );
    // A correctly parsed unpaired JS UTF-16 string cannot be losslessly carried
    // by serde Value. Refuse it instead of hashing replacement characters.
    row = original_case["row"].clone();
    let mut planned: Value = serde_json::from_str(
        row["planned_generation_json"]
            .as_str()
            .expect("raw planned"),
    )
    .expect("planned");
    planned["recordedExtra"] = "PLACEHOLDER".into();
    row["planned_generation_json"] = serde_json::to_string(&planned)
        .expect("planned JSON")
        .replace("PLACEHOLDER", "\\ud800")
        .into();
    assert_eq!(
        parse_generation(&row, None, None)
            .expect_err("lossless UTF16 profile refusal")
            .code(),
        UNSUPPORTED
    );
}
