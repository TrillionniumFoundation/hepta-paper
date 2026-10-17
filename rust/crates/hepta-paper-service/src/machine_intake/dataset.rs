//! Normalized dataset-mount equality used by original intake/template validation.
//! These fields are data-contract checks, not independent dataset authorization.
use serde_json::Value;

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
fn sha(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("sha256:"))
            && s.get(7..)
                .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
    })
}
fn safe_integer(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}
pub(super) fn unsupported_scope(value: &Value) -> bool {
    value["datasetMounts"].as_array().is_some_and(|mounts| {
        mounts.iter().any(|mount| {
            truthy(&mount["authorityScope"])
                || mount["operatorDatasetAuthority"]["version"].as_f64() == Some(4.0)
        })
    })
}
pub(super) fn valid_mounts(value: &Value, family: &str) -> bool {
    let Some(mounts) = value.as_array() else {
        return false;
    };
    let [mount] = mounts.as_slice() else {
        return false;
    };
    let Some(map) = mount.as_object() else {
        return false;
    };
    let required = [
        "name",
        "source",
        "readOnly",
        "manifestHash",
        "licenseId",
        "benchmarkFamily",
    ];
    let optional = [
        "operatorAuthorizationHash",
        "operatorDatasetAuthorityDocumentHash",
        "operatorDatasetAuthority",
        "operatorDatasetResearchSemantics",
        "operatorDatasetResearchSemanticsHash",
        "operatorDatasetHarnessHandle",
        "splitManifestHash",
        "benchmarkHarnessDocumentHash",
        "benchmarkHarnessDefinitionHash",
        "analysisProtocol",
        "analysisProtocolHash",
        "benchmarkSeedSchedule",
        "benchmarkMinimumRepetitions",
    ];
    if required.iter().any(|key| !map.contains_key(*key))
        || map
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
        || mount["readOnly"] != true
        || mount["benchmarkFamily"].as_str() != Some(family)
        || !sha(&mount["manifestHash"])
        || ["name", "source", "licenseId"]
            .iter()
            .any(|key| mount[*key].as_str().is_none_or(str::is_empty))
        || mount["operatorDatasetAuthority"]["version"].as_f64() == Some(4.0)
    {
        return false;
    }
    let Some(license) = mount["licenseId"].as_str() else {
        return false;
    };
    let spdx = [
        "0BSD",
        "Apache-2.0",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "CC-BY-4.0",
        "CC-BY-SA-4.0",
        "CC0-1.0",
        "MIT",
        "ODbL-1.0",
        "PDDL-1.0",
        "Unlicense",
    ];
    let reference = license.strip_prefix("LicenseRef-").is_some_and(|s| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
    });
    if !spdx.contains(&license) && !reference {
        return false;
    }
    if reference && !sha(&mount["operatorAuthorizationHash"]) {
        return false;
    }
    if map.contains_key("operatorDatasetAuthorityDocumentHash")
        && mount["operatorAuthorizationHash"] != mount["operatorDatasetAuthorityDocumentHash"]
    {
        return false;
    }
    for key in optional {
        let Some(v) = map.get(key) else {
            continue;
        };
        match key {
            "benchmarkSeedSchedule" => {
                if v.as_array()
                    .is_none_or(|a| a.is_empty() || a.iter().any(|n| !safe_integer(n)))
                {
                    return false;
                }
            }
            "benchmarkMinimumRepetitions" => {
                if !truthy(v) || !safe_integer(v) {
                    return false;
                }
            }
            "operatorDatasetHarnessHandle"
            | "operatorDatasetAuthorityDocumentHash"
            | "operatorDatasetResearchSemanticsHash"
            | "benchmarkHarnessDocumentHash"
            | "benchmarkHarnessDefinitionHash"
            | "analysisProtocolHash"
            | "splitManifestHash" => {
                if !sha(v) {
                    return false;
                }
            }
            _ => {
                if !truthy(v) {
                    return false;
                }
            }
        }
    }
    true
}
