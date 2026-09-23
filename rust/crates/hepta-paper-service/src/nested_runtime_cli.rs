//! Incumbent nested-platform command options and environment projection.
use crate::nested_runtime_qualification::verify_nested_runtime_platform_qualification_v1;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};

/// (CLI flag, environment name, verifier request field).
pub const NESTED_RUNTIME_ARGUMENTS_V1: &[(&str, &str, &str)] = &[
    (
        "config",
        "HEPTA_NESTED_RUNTIME_QUALIFICATION_CONFIG",
        "configPath",
    ),
    (
        "config-content-hash",
        "HEPTA_NESTED_RUNTIME_QUALIFICATION_CONFIG_SHA256",
        "expectedConfigContentHash",
    ),
    (
        "qualification-content-hash",
        "HEPTA_NESTED_RUNTIME_QUALIFICATION_RECEIPT_SHA256",
        "expectedQualificationBundleContentHash",
    ),
    (
        "conformance-content-hash",
        "HEPTA_NESTED_RUNTIME_CONFORMANCE_RECEIPT_SHA256",
        "expectedConformanceBundleContentHash",
    ),
    (
        "authority-independence-content-hash",
        "HEPTA_NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_RECEIPT_SHA256",
        "expectedAuthorityIndependenceBundleContentHash",
    ),
    ("pod-uid", "HEPTA_NESTED_RUNTIME_POD_UID", "podUid"),
    ("plan-hash", "HEPTA_NESTED_RUNTIME_PLAN_HASH", "planHash"),
    ("profile-id", "HEPTA_NESTED_RUNTIME_PROFILE_ID", "profileId"),
    (
        "runtime-class-name",
        "HEPTA_NESTED_RUNTIME_CLASS_NAME",
        "runtimeClassName",
    ),
    (
        "parent-pod-cpu-millis",
        "HEPTA_NESTED_RUNTIME_PARENT_POD_CPU_MILLIS",
        "parentPodCpuMillis",
    ),
    (
        "parent-pod-memory-bytes",
        "HEPTA_NESTED_RUNTIME_PARENT_POD_MEMORY_BYTES",
        "parentPodMemoryBytes",
    ),
    (
        "parent-pod-pids",
        "HEPTA_NESTED_RUNTIME_PARENT_POD_PIDS",
        "parentPodPids",
    ),
    (
        "qualification-key-id",
        "HEPTA_NESTED_RUNTIME_QUALIFICATION_KEY_ID",
        "qualificationKeyId",
    ),
    (
        "qualification-subject-id",
        "HEPTA_NESTED_RUNTIME_QUALIFICATION_SUBJECT_ID",
        "qualificationSubjectId",
    ),
    (
        "qualification-public-key-spki-hash",
        "HEPTA_NESTED_RUNTIME_QUALIFICATION_PUBLIC_KEY_SPKI_SHA256",
        "qualificationPublicKeySpkiHash",
    ),
    (
        "conformance-key-id",
        "HEPTA_NESTED_RUNTIME_CONFORMANCE_KEY_ID",
        "conformanceKeyId",
    ),
    (
        "conformance-subject-id",
        "HEPTA_NESTED_RUNTIME_CONFORMANCE_SUBJECT_ID",
        "conformanceSubjectId",
    ),
    (
        "conformance-public-key-spki-hash",
        "HEPTA_NESTED_RUNTIME_CONFORMANCE_PUBLIC_KEY_SPKI_SHA256",
        "conformancePublicKeySpkiHash",
    ),
];
pub const NESTED_RUNTIME_USAGE_V1: &str = "Usage: hepta-paper operator nested-runtime-platform-qualification -- [options]\n\nRead-only, fail-closed verifier for an independently signed nested-runtime\nplatform qualification bundle and a separately signed startup conformance\nbundle bound to the current Kubernetes Pod UID.\n\nOptions:\n  --config PATH\n  --config-content-hash sha256:...\n  --qualification-content-hash sha256:...\n  --conformance-content-hash sha256:...\n  --authority-independence-content-hash sha256:...\n  --pod-uid UUID\n  --plan-hash sha256:...\n  --profile-id ID\n  --runtime-class-name NAME\n  --parent-pod-cpu-millis INTEGER\n  --parent-pod-memory-bytes INTEGER\n  --parent-pod-pids INTEGER\n  --qualification-key-id ID\n  --qualification-subject-id ID\n  --qualification-public-key-spki-hash sha256:...\n  --conformance-key-id ID\n  --conformance-subject-id ID\n  --conformance-public-key-spki-hash sha256:...\n\nEvery option may instead be supplied through the corresponding\nHEPTA_NESTED_RUNTIME_* environment variable. This command never creates,\nupdates, signs, or repairs either receipt.";

pub enum NestedRuntimeCliOutputV1 {
    Help(&'static str),
    Report(Value),
}

/// Strictly parse the complete incumbent option set, with explicit args winning
/// over nonempty environment defaults. The clock is injected only at the API;
/// the production binary obtains its own current system clock.
pub fn nested_runtime_qualification_cli_v1(
    argv: &[String],
    environment: &BTreeMap<String, String>,
    now: &str,
) -> Result<NestedRuntimeCliOutputV1, String> {
    let mut args = BTreeMap::new();
    let mut tokens = argv.iter();
    while let Some(token) = tokens.next() {
        if token == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        let raw = token
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected_cli_positional:{token}"))?;
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(k, v)| (k, Some(v)));
        if key.is_empty() {
            return Err("empty_cli_option".into());
        }
        if key == "help" {
            if inline.is_some() {
                return Err("boolean_cli_option_does_not_take_value:--help".into());
            }
            if args.insert(key.to_owned(), String::new()).is_some() {
                return Err("duplicate_cli_option:--help".into());
            }
            continue;
        }
        if !NESTED_RUNTIME_ARGUMENTS_V1
            .iter()
            .any(|(flag, _, _)| *flag == key)
        {
            return Err(format!("unknown_cli_option:--{key}"));
        }
        let value = match inline {
            Some(v) => v,
            None => tokens
                .next()
                .filter(|v| !v.starts_with("--"))
                .map(String::as_str)
                .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?,
        };
        if value.is_empty() {
            return Err(format!("empty_cli_option_value:--{key}"));
        }
        if args.insert(key.to_owned(), value.to_owned()).is_some() {
            return Err(format!("duplicate_cli_option:--{key}"));
        }
    }
    if args.contains_key("help") {
        return Ok(NestedRuntimeCliOutputV1::Help(NESTED_RUNTIME_USAGE_V1));
    }
    let mut request = json!({"now":now});
    for (flag, variable, field) in NESTED_RUNTIME_ARGUMENTS_V1 {
        request[*field] = args
            .get(*flag)
            .or_else(|| environment.get(*variable).filter(|v| !v.is_empty()))
            .map_or(Value::Null, |v| json!(v));
    }
    verify_nested_runtime_platform_qualification_v1(&request)
        .map(NestedRuntimeCliOutputV1::Report)
        .map_err(|e| e.to_string())
}

/// UTC date formatting with Gregorian leap-year rules, independent of locale,
/// timezone, external executables and environment-supplied clocks.
pub fn nested_runtime_utc_millis_v1(millis: u64) -> Result<String, String> {
    let days = millis / 86_400_000;
    if days > 2_932_896 {
        return Err("nested_runtime_platform_verification_clock_invalid".into());
    }
    let z = days as i64 + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    let ms = millis % 86_400_000;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        ms / 3_600_000,
        (ms / 60_000) % 60,
        (ms / 1000) % 60,
        ms % 1000
    ))
}
pub fn current_nested_runtime_clock_v1() -> Result<String, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "nested_runtime_platform_verification_clock_invalid")?
        .as_millis();
    nested_runtime_utc_millis_v1(
        u64::try_from(millis).map_err(|_| "nested_runtime_platform_verification_clock_invalid")?,
    )
}
