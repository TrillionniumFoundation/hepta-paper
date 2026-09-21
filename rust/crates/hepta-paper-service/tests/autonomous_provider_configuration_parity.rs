use hepta_paper_service::autonomous_provider_configuration::{
    require_autonomous_provider_configuration_v1, resolve_autonomous_provider_configuration_v1,
    verify_autonomous_provider_configuration_v1,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};
use unicode_normalization::UnicodeNormalization;
mod machine_intake_support;
use machine_intake_support::oracle;

fn strings(value: &Value) -> BTreeMap<String, String> {
    value
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        value.as_str().expect("CLI/env string").to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn actual_node_provider_precedence_normalization_and_verification_match() {
    let cwd = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut cases = vec![
        json!({}),
        json!({"options":{"agent-provider":" AUTO ","formal-review-provider":" CODEX "}}),
        json!({"environment":{"CODEX_HOME":"../shared/./home","HEPTA_RESEARCH_AUTHOR_MODEL":"作者模型","HEPTA_FORMAL_REVIEW_MODEL":"referee"}}),
        json!({"options":{"agent-provider":"openai","formal-review-provider":"other"}}),
        json!({"options":{"formal-review-provider":"UNKNOWN"}}),
        json!({"options":{"codex-binary":"../bin/../codex/","codex-home":"/root/../../home//fixture/","formal-review-codex-binary":"codex-local","formal-review-codex-home":"."}}),
        json!({"options":{"model":"\u{feff}\u{2000}model\u{3000}","formal-review-model":"\u{85}"}}),
    ];
    let roles = [
        ("codex-home", "HEPTA_RESEARCH_AUTHOR_CODEX_HOME"),
        ("formal-review-codex-home", "HEPTA_FORMAL_REVIEW_CODEX_HOME"),
        ("model", "HEPTA_RESEARCH_AUTHOR_MODEL"),
        ("formal-review-model", "HEPTA_FORMAL_REVIEW_MODEL"),
        ("codex-binary", "HEPTA_RESEARCH_AUTHOR_CODEX_BINARY"),
        (
            "formal-review-codex-binary",
            "HEPTA_FORMAL_REVIEW_CODEX_BINARY",
        ),
    ];
    for (option, environment) in roles {
        for value in ["cli-value", "", " \t\n", "\u{feff}"] {
            cases.push(json!({"options":{(option):value}, "environment":{(environment):"environment-value","CODEX_HOME":"/fallback-home"}}));
        }
    }
    let expected = oracle(&json!({"action":"providers","cases":cases}), cwd);
    let mut verification = Vec::new();
    for (case, expected) in cases.iter().zip(expected.as_array().expect("results")) {
        let actual = resolve_autonomous_provider_configuration_v1(
            &strings(&case["options"]),
            &strings(&case["environment"]),
            cwd,
        );
        match actual {
            Ok(value) => {
                assert_eq!(expected["ok"], true, "{case}");
                assert_eq!(value, expected["value"], "{case}");
                assert_eq!(
                    verify_autonomous_provider_configuration_v1(&value, cwd),
                    expected["verified"].as_bool().expect("verified")
                );
                verification.push(json!({"configuration":value}));
            }
            Err(error) => {
                assert_eq!(expected["ok"], false);
                assert_eq!(expected["error"], error);
            }
        }
    }
    let base =
        resolve_autonomous_provider_configuration_v1(&BTreeMap::new(), &BTreeMap::new(), cwd)
            .expect("default");
    for (field, changed) in [
        ("provider", json!("auto")),
        ("codexBinary", json!("./codex")),
        ("codexHome", json!(false)),
        ("model", json!(4)),
    ] {
        let mut malformed = base.clone();
        malformed["researchAuthor"][field] = changed;
        verification.push(json!({"configuration":malformed}));
    }
    let mut extra = base.clone();
    extra["extra"] = json!(true);
    verification.push(json!({"configuration":extra}));
    let mut extra = base.clone();
    extra["formalReviewer"]["extra"] = json!(true);
    verification.push(json!({"configuration":extra}));
    verification.push(json!({"configuration":base,"expectedHash":"sha256:wrong"}));
    verification.push(json!({"configuration":base,"expectedHash":""}));
    let expected = oracle(
        &json!({"action":"verify-providers","cases":verification}),
        cwd,
    );
    for (case, expected) in verification
        .iter()
        .zip(expected.as_array().expect("verification results"))
    {
        assert_eq!(
            verify_autonomous_provider_configuration_v1(&case["configuration"], cwd),
            expected["verified"]
        );
        let actual = require_autonomous_provider_configuration_v1(
            &case["configuration"],
            case["expectedHash"].as_str(),
            cwd,
        );
        match actual {
            Ok(value) => {
                assert_eq!(expected["required"]["ok"], true);
                assert_eq!(value, &expected["required"]["value"]);
            }
            Err(error) => {
                assert_eq!(expected["required"]["ok"], false);
                assert_eq!(expected["required"]["error"], error);
            }
        }
    }
}

#[test]
fn pinned_unicode_nfkc_matches_actual_node_for_every_scalar_and_composing_sequences() {
    assert_eq!(unicode_normalization::UNICODE_VERSION, (17, 0, 0));
    let sequences = [
        "e\u{301}",
        "A\u{30a}\u{301}",
        "\u{1100}\u{1161}\u{11a8}",
        "\u{fb01}\u{0301}",
        "a\u{0315}\u{0300}",
        "ＡＢＣ ① ㍑",
        "\u{d7ff}\u{e000}\u{10ffff}",
    ];
    let expected = oracle(
        &json!({"action":"normalization","sequences":sequences}),
        Path::new(env!("CARGO_MANIFEST_DIR")),
    );
    let mut hash = Sha256::new();
    let mut count = 0;
    for scalar in 0_u32..=0x10ffff {
        let Some(character) = char::from_u32(scalar) else {
            continue;
        };
        let normalized: String = character.to_string().nfkc().collect();
        hash.update(scalar.to_le_bytes());
        hash.update(
            u32::try_from(normalized.len())
                .expect("scalar result bounded")
                .to_le_bytes(),
        );
        hash.update(normalized.as_bytes());
        count += 1;
    }
    assert_eq!(expected["unicode"], "17.0");
    assert_eq!(expected["count"], count);
    assert_eq!(expected["digest"], hex::encode(hash.finalize()));
    assert_eq!(
        expected["sequences"],
        json!(
            sequences
                .iter()
                .map(|text| text.nfkc().collect::<String>())
                .collect::<Vec<_>>()
        )
    );
}
