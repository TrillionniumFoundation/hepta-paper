//! Original machine-intake V1-configuration contracts for builtin empirical families.
//! Hashes identify data; they do not confer provider, dataset, or external authority.
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

#[path = "dataset.rs"]
mod dataset;

pub(crate) fn has_unsupported_local_golden_scope(value: &Value) -> bool {
    dataset::unsupported_scope(value)
}

pub(crate) const DAY_MS: u64 = 86_400_000;
pub(crate) const BUDGET_KEYS: &[&str] = &[
    "maxAgentCalls",
    "maxCostUsd",
    "maxCpuJobs",
    "maxGpuJobs",
    "maxMemoryMiB",
    "maxTokenCount",
    "maxWallTimeMs",
];
const INTAKE_KEYS: &[&str] = &[
    "admissionCreatedAt",
    "budgets",
    "campaignId",
    "datasetMounts",
    "intakeHash",
    "intakeId",
    "kind",
    "launchMode",
    "objective",
    "paperId",
    "protocolFamily",
    "providerConfigurationHash",
    "recurringGoldenProvenance",
    "refereeCount",
    "revisionRounds",
    "version",
];
const TEMPLATE_KEYS: &[&str] = &[
    "budgets",
    "datasetMounts",
    "epochDurationMs",
    "kind",
    "objective",
    "protocolFamily",
    "providerConfigurationHash",
    "refereeCount",
    "revisionRounds",
    "templateHash",
    "templateId",
    "version",
];
const PROVENANCE_KEYS: &[&str] = &[
    "epochDurationMs",
    "epochStart",
    "kind",
    "sourceAuthorityHash",
    "templateHash",
    "templateId",
    "version",
];
const ADMISSION_KEYS: &[&str] = &[
    "admissionCreatedAt",
    "autonomousResearchMachineIntakeAdmissionHash",
    "campaignId",
    "intakeHash",
    "intakeId",
    "kind",
    "paperId",
    "sourceAuthorityHash",
    "sourceKind",
    "version",
];

pub(crate) fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key)))
}
pub(crate) fn integer(value: &Value, minimum: u64, maximum: u64) -> Option<u64> {
    let n = value.as_f64()?;
    if !n.is_finite() || n.fract() != 0.0 || n < minimum as f64 || n > maximum as f64 {
        None
    } else {
        Some(n as u64)
    }
}
pub(crate) fn hash_valid(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.strip_prefix("sha256:").is_some_and(|hex| {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    })
}
pub(crate) fn record_hash_valid(value: &Value, domain: &str, hash_key: &str) -> bool {
    let Some(mut payload) = value.as_object().cloned() else {
        return false;
    };
    let Some(hash) = payload.remove(hash_key) else {
        return false;
    };
    hash_valid(&hash)
        && production_hash_record_v1(domain, &Value::Object(payload))
            .is_ok_and(|actual| hash.as_str() == Some(actual.as_str()))
}
fn id(value: &Value, max: usize, at: bool) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= max
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b) || (at && b == b'@'))
    })
}
pub(crate) fn canonical_instant(value: &Value) -> Option<i64> {
    crate::journal_connector_coverage::qualification::canonical_instant_millis(value.as_str()?)
}
fn js_trim(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn placeholder(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    ["todo", "tbd", "placeholder", "fillin", "fill in", "fill-in"]
        .iter()
        .any(|word| {
            lower.match_indices(word).any(|(offset, found)| {
                let bytes = lower.as_bytes();
                let word_byte = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
                (offset == 0 || !word_byte(bytes[offset - 1]))
                    && (offset + found.len() == bytes.len()
                        || !word_byte(bytes[offset + found.len()]))
            })
        })
}
fn objective(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    if text.is_empty()
        || text.len() > 8192
        || text.encode_utf16().count() > 7000
        || text.chars().any(|c| (c as u32) < 32 || c == '\u{007f}')
        || placeholder(text)
    {
        return false;
    }
    let normalized: String = text.nfkc().collect();
    // Already serialized contracts must equal the rebuilt canonical objective.
    if normalized != text || text.trim_matches(js_trim) != text {
        return false;
    }
    !text.contains("  ")
}
pub(crate) fn builtin_repetitions(family: &str) -> Option<u64> {
    match family {
        "rl_stochastic_control_benchmark"
        | "econometrics_panel_benchmark"
        | "finance_asset_pricing_benchmark" => Some(2),
        "ml_algorithm_benchmark" | "operations_optimization_benchmark" => Some(7),
        _ => None,
    }
}
fn budgets(value: &Value) -> bool {
    if !exact_keys(value, BUDGET_KEYS) {
        return false;
    }
    BUDGET_KEYS.iter().all(|key| {
        if *key == "maxCostUsd" {
            value[*key]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n > 0.0)
        } else {
            integer(
                &value[*key],
                u64::from(*key != "maxGpuJobs"),
                9_007_199_254_740_991,
            )
            .is_some()
        }
    })
}
fn common(value: &Value) -> bool {
    let Some(family) = value["protocolFamily"].as_str() else {
        return false;
    };
    builtin_repetitions(family).is_some()
        && objective(&value["objective"])
        && dataset::valid_mounts(&value["datasetMounts"], family)
        && budgets(&value["budgets"])
        && hash_valid(&value["providerConfigurationHash"])
        && integer(&value["revisionRounds"], 1, 10).is_some()
        && integer(&value["refereeCount"], 2, 7).is_some()
}
pub(crate) fn epoch(value: &Value) -> Option<u64> {
    integer(value, 3_600_000, 43_200_000).filter(|n| DAY_MS.is_multiple_of(*n))
}
fn provenance(value: &Value) -> bool {
    if !exact_keys(value, PROVENANCE_KEYS)
        || value["version"].as_f64() != Some(1.0)
        || value["kind"] != "AutonomousResearchRecurringGoldenProvenance"
        || !id(&value["templateId"], 132, false)
        || !hash_valid(&value["templateHash"])
        || !hash_valid(&value["sourceAuthorityHash"])
    {
        return false;
    }
    let Some(duration) = epoch(&value["epochDurationMs"]) else {
        return false;
    };
    canonical_instant(&value["epochStart"]).is_some_and(|start| start % duration as i64 == 0)
}
pub(crate) fn verify_intake(value: &Value) -> bool {
    if !exact_keys(value, INTAKE_KEYS)
        || value["version"].as_f64() != Some(2.0)
        || value["kind"] != "AutonomousResearchMachineIntake"
        || !id(&value["paperId"], 160, false)
        || !id(&value["campaignId"], 192, true)
        || !id(&value["intakeId"], 192, true)
        || !common(value)
        || canonical_instant(&value["admissionCreatedAt"]).is_none()
    {
        return false;
    }
    let Some(paper) = value["paperId"].as_str() else {
        return false;
    };
    if value["campaignId"].as_str() != Some(format!("autonomous-research:{paper}").as_str()) {
        return false;
    }
    match value["launchMode"].as_str() {
        Some("production-run") if value["recurringGoldenProvenance"].is_null() => (),
        Some("golden-bootstrap") => {
            let p = &value["recurringGoldenProvenance"];
            if !provenance(p) || value["admissionCreatedAt"] != p["epochStart"] {
                return false;
            }
            let (Some(start), Some(template)) =
                (p["epochStart"].as_str(), p["templateId"].as_str())
            else {
                return false;
            };
            let key = start.replace(['-', ':', '.'], "");
            if paper != format!("golden:{template}:{key}") {
                return false;
            }
        }
        _ => return false,
    }
    record_hash_valid(value, "AutonomousResearchMachineIntake", "intakeHash")
}
pub(crate) fn verify_recurring_template(value: &Value) -> bool {
    if !exact_keys(value, TEMPLATE_KEYS)
        || value["version"].as_f64() != Some(1.0)
        || value["kind"] != "AutonomousResearchRecurringGoldenTemplate"
        || !id(&value["templateId"], 132, false)
        || epoch(&value["epochDurationMs"]).is_none()
        || !common(value)
    {
        return false;
    }
    let (Some(rounds), Some(reviewers), Some(family)) = (
        integer(&value["revisionRounds"], 1, 10),
        integer(&value["refereeCount"], 2, 7),
        value["protocolFamily"].as_str(),
    ) else {
        return false;
    };
    let Some(repetitions) = builtin_repetitions(family) else {
        return false;
    };
    // Exact projection of full-campaign nodes with one builtin CPU profile:
    // all nodes have three attempts; three base formal chains and one per round.
    // Each empirical/replay pair costs (3+2)*3 attempts*5 seeds*repetitions*3 processes.
    let required_agents = 75 + rounds * (6 * reviewers + 24);
    let required_cpu = 225 * repetitions * (rounds + 2);
    let b = &value["budgets"];
    for (key, ceiling) in [
        ("maxWallTimeMs", 7_200_000.0),
        ("maxAgentCalls", 512.0),
        ("maxCpuJobs", 32_768.0),
        ("maxGpuJobs", 32_768.0),
        ("maxTokenCount", 4_000_000.0),
        ("maxCostUsd", 100.0),
        ("maxMemoryMiB", 8192.0),
    ] {
        if b[key].as_f64().is_none_or(|n| n > ceiling) {
            return false;
        }
    }
    if b["maxAgentCalls"]
        .as_f64()
        .is_none_or(|n| n < required_agents as f64)
        || b["maxCpuJobs"]
            .as_f64()
            .is_none_or(|n| n < required_cpu as f64)
    {
        return false;
    }
    record_hash_valid(
        value,
        "AutonomousResearchRecurringGoldenTemplate",
        "templateHash",
    )
}
pub(crate) fn verify_admission_v1(value: &Value, intake: &Value) -> bool {
    if !verify_intake(intake)
        || !exact_keys(value, ADMISSION_KEYS)
        || value["version"].as_f64() != Some(1.0)
        || value["kind"] != "AutonomousResearchMachineIntakeAdmission"
        || !hash_valid(&value["sourceAuthorityHash"])
    {
        return false;
    }
    let recurring = match value["sourceKind"].as_str() {
        Some("recurring-golden") => true,
        Some("machine" | "static-file") => false,
        _ => return false,
    };
    if recurring != (intake["launchMode"] == "golden-bootstrap") {
        return false;
    }
    if [
        "intakeId",
        "intakeHash",
        "paperId",
        "campaignId",
        "admissionCreatedAt",
    ]
    .iter()
    .any(|key| value[*key] != intake[*key])
    {
        return false;
    }
    record_hash_valid(
        value,
        "AutonomousResearchMachineIntakeAdmission",
        "autonomousResearchMachineIntakeAdmissionHash",
    )
}
