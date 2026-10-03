use super::*;
use serde_json::json;

#[test]
fn nested_json_array_string_and_raw_identity_are_distinct_domains() {
    let value = json!([null, ["asset", 0, false], {"value": 1}, []]);
    assert_eq!(
        string(Some(&value)).unwrap(),
        ",asset,0,false,[object Object],"
    );
    assert_eq!(string_or_empty(Some(&json!(0))).unwrap(), "");
    assert_eq!(string(Some(&json!(1e21))).unwrap(), "1e+21");
    assert_eq!(raw_or_null(Some(&json!([]))).unwrap(), json!([]));
    assert_eq!(
        clone_raw(Some(&json!({"n":9007199254740993u64}))).unwrap(),
        json!({"n":9007199254740992u64})
    );
    assert!(!primitive_equal(Some(&json!(["id"])), Some(&json!(["id"]))));
    assert!(primitive_equal(Some(&json!(0)), Some(&json!(-0.0))));
    assert_eq!(trim("\u{feff} x \u{a0}"), "x");
    assert!(!has_whitespace("a\u{0085}b"));
}

#[test]
fn json_method_shadow_and_expansion_limits_refuse_before_appending() {
    assert!(string(Some(&json!({"toString": "shadow"}))).is_err());
    let component = "x".repeat(MAX_BYTES / 2);
    let too_large = Value::Array(vec![
        Value::String(component.clone()),
        Value::String(component),
    ]);
    assert_eq!(
        string(Some(&too_large)).unwrap_err().to_string(),
        "repository_asset_coercion_limit"
    );
    // A rejected expansion does not change the interpretation of the next
    // independent passive input.
    assert_eq!(string(Some(&json!(["identity"]))).unwrap(), "identity");
}
