use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};

use hepta_legacy_compatibility::{
    CompatibilityError, parse_and_digest_production_v1, parse_and_encode_production_v1,
    parse_and_hash_production_record_v1, production_digest_v1, production_hash_record_v1,
    production_stable_json_v1, qualify_production_node_profile_v1,
};
use serde_json::Value;

fn oracle(fixtures: &[String], kind: &str) -> Value {
    let oracle = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("oracle/legacy-stable-json-v1.mjs");
    let mut child = Command::new("node").arg(oracle).arg("--batch")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().expect("Node v22.23.1 is REQUIRED for production compatibility qualification; missing oracle is failure");
    let request =
        serde_json::to_vec(&serde_json::json!({"cases": fixtures, "kind": kind})).unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&request)
        .expect("write oracle input");
    let output = child
        .wait_with_output()
        .expect("wait for required Node oracle");
    assert!(
        output.status.success(),
        "production oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).expect("oracle response");
    qualify_production_node_profile_v1(&response["profile"])
        .expect("exact Node/source/collation profile must qualify");
    response
}

fn assert_parity(fixtures: &[String], test_value_api: bool) {
    let kind = "SqliteLogicalDatabase";
    let response = oracle(fixtures, kind);
    let results = response["results"].as_array().unwrap();
    assert_eq!(results.len(), fixtures.len());
    for (index, (fixture, node)) in fixtures.iter().zip(results).enumerate() {
        let expected = node["canonical"].as_str().unwrap().as_bytes();
        let actual = parse_and_encode_production_v1(fixture.as_bytes()).unwrap();
        if expected != actual {
            let offset = expected
                .iter()
                .zip(&actual)
                .position(|(left, right)| left != right)
                .unwrap_or(expected.len().min(actual.len()));
            panic!(
                "canonical case {index}: first drift at byte {offset}; Node {:?}, Rust {:?}",
                String::from_utf8_lossy(
                    &expected[offset.saturating_sub(40)..expected.len().min(offset + 120)]
                ),
                String::from_utf8_lossy(
                    &actual[offset.saturating_sub(40)..actual.len().min(offset + 120)]
                )
            );
        }
        assert_eq!(
            node["digest"].as_str().unwrap(),
            parse_and_digest_production_v1(fixture.as_bytes())
                .unwrap()
                .as_str(),
            "digest case {index}"
        );
        assert_eq!(
            node["record_hash"].as_str().unwrap(),
            parse_and_hash_production_record_v1(kind, fixture.as_bytes())
                .unwrap()
                .as_str(),
            "record case {index}"
        );
        if test_value_api {
            let value: Value = serde_json::from_str(fixture).unwrap();
            if production_stable_json_v1(&value) == Err(CompatibilityError::AmbiguousObjectKeyOrder)
            {
                assert_eq!(
                    production_digest_v1(&value),
                    Err(CompatibilityError::AmbiguousObjectKeyOrder)
                );
                assert_eq!(
                    production_hash_record_v1(kind, &value),
                    Err(CompatibilityError::AmbiguousObjectKeyOrder)
                );
                continue; // Original bytes were checked above; Value must refuse lost key order.
            }
            assert_eq!(
                expected,
                production_stable_json_v1(&value).unwrap(),
                "Value canonical case {index}: {fixture}"
            );
            assert_eq!(
                node["digest"].as_str().unwrap(),
                production_digest_v1(&value).unwrap().as_str()
            );
            assert_eq!(
                node["record_hash"].as_str().unwrap(),
                production_hash_record_v1(kind, &value).unwrap().as_str()
            );
        }
    }
}

#[test]
fn rust_matches_actual_production_node_functions_on_regression_corpus() {
    let fixtures = [
        "null", "true", "false", "{}", "[]", r#"{"10":3,"2":4}"#,
        r#"{"z":1,"a":[true,false,null]}"#,
        r#"{"unicode":"λ雪🧬","escaped":"a\nb\u0000\t\b\f\r\\\"/"}"#,
        r#"[-0,1.0,1.5,1000000,0.000001,1e-7,1e20,1e21,9007199254740993,18446744073709551615]"#,
        r#"[2.9802322387695313e-8,1.234567890123456e30,5e-324,1.7976931348623157e308,1e23]"#,
        r#"{"nested":{"10":1,"2":{"z":3,"a":4}},"A":1,"a":2,"a_b":3,"a-b":4,"a.b":5}"#,
        r#"{"4294967295":1,"4294967294":2,"0":3,"00":4,"01":5,"-0":6,"-1":7,"1.0":8,"10":9,"2":10}"#,
        r#"{"é":1,"é":2,"É":3,"É":4,"Å":5,"Å":6,"å":7,"a":8}"#,
        r#"{"é":2,"é":1,"É":4,"É":3,"Å":6,"Å":5,"a":8,"å":7}"#,
        r#"{"é":1,"é":2,"é":3,"__proto__":{"x":1},"constructor":4,"prototype":5}"#,
        r##"{"":0," ":1,"_":2,"-":3,"!":4,"?":5,"@":6,"#":7,"$":8,"%":9,"&":10,"*":11,"/":12}"##,
        r#"{"中":0,"文":1,"雪":2,"λ":3,"Ж":4,"Я":5,"あ":6,"ア":7,"가":8,"ن":9,"न":10,"😀":11,"🧬":12}"#,
        r#"{"𠆈":1,"佁":2,"㒼":3,"a𠆈":4,"a佁":5,"가":6,"각":7}"#,
        r#"{"a\u0000":1,"a":2,"a\u200d":3,"\u0000":4,"\ufeff":5,"\u2028":6,"\u2029":7}"#,
        r#"{"\ufffe":1,"\uffff":2,"\udbff\udffe":3,"\udbff\udfff":4,"a\ufffe":5,"a":6}"#,
        r#"{"kind":"Record","value":{"record_hash":"sha256:x","version":25,"table_name":"data","rows":[[1,"λ",null]]}}"#,
    ].map(str::to_owned);
    assert_parity(&fixtures, true);
}

#[test]
fn raw_json_preserves_js_features_not_representable_in_serde_value() {
    let fixtures = [
        r#"["\ud800","\udc00","\ud800a","\ud83d\ude00","\ud800\ud800\udc00"]"#,
        "[1e400,-1e400,1e-9999,-1e-9999,0e9999999,-0e9999999]",
        "1234567890123456789012345678901234567890123456789012345678901234567890",
        "[0.99999999999999999999999999999999999999999,2.2250738585072012e-308]",
    ]
    .map(str::to_owned);
    assert_parity(&fixtures, false);
}

#[test]
fn randomized_ieee754_values_match_production_bytes_and_hashes() {
    let mut state = 0x1bdb_25cf_32aa_349f_u64;
    let mut fixtures = Vec::new();
    for _ in 0..4096 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let number = f64::from_bits(state);
        if number.is_finite() {
            fixtures.push(format!("{number:e}"));
        }
    }
    assert_parity(&fixtures, true);
}

#[test]
fn unicode_collation_corpus_matches_source_including_stable_equal_keys() {
    let mut keys = vec![
        "é".to_owned(),
        "é".to_owned(),
        "Å".to_owned(),
        "Å".to_owned(),
        "a\0".to_owned(),
        "a".to_owned(),
    ];
    keys.extend(
        (0_u32..=0x024f)
            .filter_map(char::from_u32)
            .map(|ch| ch.to_string()),
    );
    let mut state = 0x718a_73c5_u32;
    for _ in 0..2048 {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        if let Some(ch) = char::from_u32(state % 0x110000) {
            keys.push(ch.to_string());
        }
    }
    let entries = keys
        .into_iter()
        .enumerate()
        .map(|(index, key)| format!("{}:{index}", serde_json::to_string(&key).unwrap()))
        .collect::<Vec<_>>();
    let forward = format!("{{{}}}", entries.join(","));
    let reverse = format!(
        "{{{}}}",
        entries.into_iter().rev().collect::<Vec<_>>().join(",")
    );
    assert_parity(&[forward, reverse], true);
}

#[test]
fn qualification_rejects_runtime_and_source_drift() {
    let response = oracle(&["null".to_owned()], "Profile");
    for key in ["node", "icu", "cldr", "unicode", "source_sha256", "profile"] {
        let mut profile = response["profile"].clone();
        profile[key] = Value::String("different".to_owned());
        assert!(
            qualify_production_node_profile_v1(&profile).is_err(),
            "accepted drift in {key}"
        );
    }
    let mut profile = response["profile"].clone();
    profile["collator"]["locale"] = Value::String("sv-SE".to_owned());
    assert!(qualify_production_node_profile_v1(&profile).is_err());
}
