use super::super::BoundedOutput;
use super::*;
use serde_json::json;
use std::io::Write;

fn receipt(bytes: &[u8]) -> Value {
    let request = files::parse(bytes, INVALID).unwrap();
    json!({"kind":"test receipt","instances":request["instances"],
        "installations":request["installations"],"signature":"unchanged signature"})
}

#[test]
fn only_semantically_equal_echoes_keep_original_nested_property_order() {
    let instances =
        r#"[ {"z":1.0,"a":{"second":2,"first":1},"nested":[{"right":true,"left":false}]} ]"#;
    let installations = r#"[{"target":"db","before":{"z":3,"a":2},"after":{"y":1,"b":0}}]"#;
    let bytes = format!(r#"{{"instances":{instances},"installations":{installations},"signature":"request signature"}}"#).into_bytes();
    let actual = receipt(&bytes);
    let echo = CapturedEchoFields::capture(&bytes, bytes.len()).unwrap();
    let envelope = echo.bind(&actual);
    assert_eq!(
        envelope.retained_bytes(),
        instances.len() + installations.len()
    );
    let text = serde_json::to_string(&envelope).unwrap();
    assert!(text.contains(&format!("\"instances\":{instances}")));
    assert!(text.contains(&format!("\"installations\":{installations}")));
    assert_eq!(
        files::parse(text.as_bytes(), INVALID).unwrap(),
        json!({"ok":true,"receipt":actual})
    );
    assert!(text.contains("unchanged signature"));
    assert!(!text.contains("request signature"));
}

#[test]
fn unequal_or_missing_receipt_values_never_adopt_request_content() {
    let bytes = br#"{"instances":[{"z":1,"a":2}],"installations":[{"y":3,"b":4}]}"#;
    let mut actual = receipt(bytes);
    actual["instances"][0]["z"] = json!(99);
    let envelope = CapturedEchoFields::capture(bytes, bytes.len())
        .unwrap()
        .bind(&actual);
    assert_eq!(envelope.retained_bytes(), r#"[{"y":3,"b":4}]"#.len());
    let text = serde_json::to_string(&envelope).unwrap();
    assert!(text.contains(r#""instances":[{"a":2,"z":99}]"#));
    assert!(text.contains(r#""installations":[{"y":3,"b":4}]"#));
    assert_eq!(
        files::parse(text.as_bytes(), INVALID).unwrap(),
        json!({"ok":true,"receipt":actual})
    );
    let actual = json!({"kind":"no echo fields","other":{"z":1,"a":2}});
    let envelope = CapturedEchoFields::capture(bytes, bytes.len())
        .unwrap()
        .bind(&actual);
    assert_eq!(envelope.retained_bytes(), 0);
    assert_eq!(
        serde_json::to_value(envelope).unwrap(),
        json!({"ok":true,"receipt":actual})
    );
}

#[test]
fn strict_capture_rejects_duplicates_and_malformed_requests_before_handling() {
    for bytes in [
        br#"{"instances":[],"instances":[]}"#.as_slice(),
        br#"{"installations":[{"a":1,"a":1}]}"#,
        br#"{"other":1,"other":1}"#,
        br#"{"instances":[{"x":1,"x":2}]}"#,
        br#"{"instances":[]} trailing"#,
        br#"{"instances":[NaN]}"#,
    ] {
        assert!(CapturedEchoFields::capture(bytes, usize::MAX).is_err());
    }
}

#[test]
fn owned_echo_and_serialized_output_share_the_existing_wire_budget() {
    let raw = r#"[{"z":1,"a":2}]"#;
    let bytes = format!(r#"{{"instances":{raw}}}"#).into_bytes();
    assert!(CapturedEchoFields::capture(&bytes, raw.len() - 1).is_err());
    let captured = CapturedEchoFields::capture(&bytes, raw.len()).unwrap();
    let actual = json!({"instances":[{"a":2,"z":1}],"signature":"same"});
    let envelope = captured.bind(&actual);
    let encoded = serde_json::to_vec(&envelope).unwrap();
    let budget = envelope.retained_bytes() + encoded.len() + 1;
    let mut output = BoundedOutput {
        bytes: Vec::new(),
        maximum: budget - envelope.retained_bytes(),
    };
    serde_json::to_writer(&mut output, &envelope).unwrap();
    output.write_all(b"\n").unwrap();
    assert_eq!(output.bytes.len() + envelope.retained_bytes(), budget);
    let mut short = BoundedOutput {
        bytes: Vec::new(),
        maximum: encoded.len() - 1,
    };
    assert!(serde_json::to_writer(&mut short, &envelope).is_err());
    assert!(short.bytes.len() <= short.maximum);
}
