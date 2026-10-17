//! Native provider identity configuration for the incumbent two-role contract.
//!
//! This resolves declared strings and hashes the resulting record. It does not
//! open credential homes, execute Codex, prove role independence or grant access.

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

const KIND: &str = "AutonomousResearchProviderConfiguration";
const HASH: &str = "autonomousResearchProviderConfigurationHash";
const PRINCIPAL_KEYS: [&str; 4] = ["provider", "codexBinary", "codexHome", "model"];

// ECMAScript TrimString's WhiteSpace + LineTerminator set. Rust's Unicode
// whitespace includes U+0085, which JavaScript deliberately does not trim.
fn js_space(character: char) -> bool {
    matches!(character,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn configured<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<&'a str> {
    values
        .into_iter()
        .flatten()
        .map(|value| value.trim_matches(js_space))
        .find(|value| !value.is_empty())
}

fn absolute(candidate: &str, cwd: &Path) -> Result<String, String> {
    let cwd = cwd
        .to_str()
        .filter(|_| cwd.is_absolute())
        .ok_or_else(|| "autonomous_research_provider_working_directory_invalid".to_owned())?;
    let joined = if candidate.starts_with('/') {
        candidate.to_owned()
    } else {
        format!("{cwd}/{candidate}")
    };
    let mut parts = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

fn principal(
    provider: Option<&str>,
    binary: Option<&str>,
    home: Option<&str>,
    model: Option<&str>,
    role: &str,
    cwd: &Path,
) -> Result<Value, String> {
    let provider = configured([provider, Some("codex")])
        .unwrap_or("codex")
        .to_lowercase();
    let provider = if provider == "auto" {
        "codex"
    } else {
        &provider
    };
    if provider != "codex" {
        return Err(format!(
            "autonomous_research_{role}_provider_unsupported:{provider}"
        ));
    }
    let binary = configured([binary, Some("codex")]).unwrap_or("codex");
    let binary = if binary.contains('/') {
        absolute(binary, cwd)?
    } else {
        binary.to_owned()
    };
    let home = configured([home])
        .map(|value| absolute(value, cwd))
        .transpose()?;
    Ok(
        json!({"provider": provider, "codexBinary": binary, "codexHome": home, "model": configured([model])}),
    )
}

fn digest(kind: &str, value: &Value) -> Result<String, String> {
    production_hash_record_v1(kind, value)
        .map(|value| value.as_str().to_owned())
        .map_err(|_| "autonomous_research_provider_configuration_hash_invalid".to_owned())
}

/// Resolve the Node CLI/environment string contract against an explicit working
/// directory. Only named role options are read; no process environment is read.
pub fn resolve_autonomous_provider_configuration_v1(
    options: &BTreeMap<String, String>,
    environment: &BTreeMap<String, String>,
    working_directory: &Path,
) -> Result<Value, String> {
    let option = |name: &str| options.get(name).map(String::as_str);
    let env = |name: &str| environment.get(name).map(String::as_str);
    let author = principal(
        configured([
            option("agent-provider"),
            env("HEPTA_RESEARCH_AUTHOR_PROVIDER"),
            Some("codex"),
        ]),
        configured([
            option("codex-binary"),
            env("HEPTA_RESEARCH_AUTHOR_CODEX_BINARY"),
            Some("codex"),
        ]),
        configured([
            option("codex-home"),
            env("HEPTA_RESEARCH_AUTHOR_CODEX_HOME"),
            env("CODEX_HOME"),
        ]),
        configured([option("model"), env("HEPTA_RESEARCH_AUTHOR_MODEL")]),
        "research_author",
        working_directory,
    )?;
    let reviewer = principal(
        configured([
            option("formal-review-provider"),
            env("HEPTA_FORMAL_REVIEW_PROVIDER"),
            Some("codex"),
        ]),
        configured([
            option("formal-review-codex-binary"),
            env("HEPTA_FORMAL_REVIEW_CODEX_BINARY"),
            Some("codex"),
        ]),
        configured([
            option("formal-review-codex-home"),
            env("HEPTA_FORMAL_REVIEW_CODEX_HOME"),
            option("codex-home"),
            env("HEPTA_RESEARCH_AUTHOR_CODEX_HOME"),
            env("CODEX_HOME"),
        ]),
        configured([
            option("formal-review-model"),
            env("HEPTA_FORMAL_REVIEW_MODEL"),
        ]),
        "formal_reviewer",
        working_directory,
    )?;
    let mut payload = json!({"version": 1, "kind": KIND,
        "status": "autonomous_research_provider_configuration_resolved",
        "researchAuthor": author, "formalReviewer": reviewer});
    payload[HASH] = Value::String(digest(KIND, &payload)?);
    Ok(payload)
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

/// Reconstruct canonical normalized principals and compare the actual production
/// record hash. A correctly shaped caller-supplied hash is not sufficient.
pub fn verify_autonomous_provider_configuration_v1(
    configuration: &Value,
    working_directory: &Path,
) -> bool {
    if !exact_keys(
        configuration,
        &[
            "version",
            "kind",
            "status",
            "researchAuthor",
            "formalReviewer",
            HASH,
        ],
    ) || configuration["version"].as_f64() != Some(1.0)
        || configuration["kind"] != KIND
        || configuration["status"] != "autonomous_research_provider_configuration_resolved"
    {
        return false;
    }
    let mut options = BTreeMap::new();
    for (role, names) in [
        (
            "researchAuthor",
            ["agent-provider", "codex-binary", "codex-home", "model"],
        ),
        (
            "formalReviewer",
            [
                "formal-review-provider",
                "formal-review-codex-binary",
                "formal-review-codex-home",
                "formal-review-model",
            ],
        ),
    ] {
        let principal = &configuration[role];
        if !exact_keys(principal, &PRINCIPAL_KEYS) {
            return false;
        }
        for (field, option) in PRINCIPAL_KEYS.into_iter().zip(names) {
            match &principal[field] {
                Value::String(value) => {
                    options.insert(option.to_owned(), value.clone());
                }
                Value::Null if matches!(field, "codexHome" | "model") => {}
                _ => return false,
            }
        }
    }
    let Ok(normalized) =
        resolve_autonomous_provider_configuration_v1(&options, &BTreeMap::new(), working_directory)
    else {
        return false;
    };
    match (
        digest(
            "AutonomousResearchProviderConfigurationExpected",
            configuration,
        ),
        digest(
            "AutonomousResearchProviderConfigurationExpected",
            &normalized,
        ),
    ) {
        (Ok(actual), Ok(expected)) => actual == expected,
        _ => false,
    }
}

/// Require the normalized record and an optional exact expected digest.
pub fn require_autonomous_provider_configuration_v1<'a>(
    configuration: &'a Value,
    expected_hash: Option<&str>,
    working_directory: &Path,
) -> Result<&'a Value, String> {
    if !verify_autonomous_provider_configuration_v1(configuration, working_directory) {
        return Err("autonomous_research_provider_configuration_invalid".to_owned());
    }
    if expected_hash.is_some_and(|expected| {
        !expected.is_empty() && configuration[HASH].as_str() != Some(expected)
    }) {
        return Err("autonomous_research_provider_configuration_hash_mismatch".to_owned());
    }
    Ok(configuration)
}
