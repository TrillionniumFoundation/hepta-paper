//! Pure V2 environment BOM contract; observations come from execution owners.
//! Hash integrity never establishes hardware, package completeness or authority.
use super::{Json, check, field, hash, object, text, value};
use crate::native_business::local_submission_preflight::local_submission_truthy as truthy;
use serde_json::Value;
use std::{collections::BTreeSet, sync::atomic::AtomicBool, time::Instant};

fn own<'a>(v: &'a Json, key: &str) -> Option<&'a Json> {
    match v {
        Json::Object(fields) => fields
            .iter()
            .find(|(k, _)| k.iter().copied().eq(key.encode_utf16()))
            .map(|(_, v)| v),
        _ => None,
    }
}
fn json_truthy(v: &Json) -> bool {
    match v {
        Json::Null => false,
        Json::Bool(v) => *v,
        Json::Number(v) => *v != 0.0 && !v.is_nan(),
        Json::String(v) => !v.is_empty(),
        Json::Array(_) | Json::Object(_) => true,
    }
}
fn literal(v: Option<&Json>, expected: &str) -> bool {
    matches!(v,Some(Json::String(s)) if s.iter().copied().eq(expected.encode_utf16()))
}
fn equals(a: Option<&Json>, b: Option<&Json>) -> bool {
    match (a, b) {
        (None, None) | (Some(Json::Null), Some(Json::Null)) => true,
        (Some(Json::Bool(a)), Some(Json::Bool(b))) => a == b,
        (Some(Json::Number(a)), Some(Json::Number(b))) => a == b,
        (Some(Json::String(a)), Some(Json::String(b))) => a == b,
        _ => false,
    }
}
fn positive(v: Option<&Json>) -> bool {
    matches!(v,Some(Json::Number(n)) if n.is_finite() && n.fract()==0.0 && *n>0.0 && *n<=9_007_199_254_740_991.0)
}
fn zero_or_positive(v: Option<&Json>) -> bool {
    matches!(v,Some(Json::Number(n)) if n.is_finite() && n.fract()==0.0 && *n>=0.0 && *n<=9_007_199_254_740_991.0)
}
fn is_true(v: Option<&Json>) -> bool {
    matches!(v, Some(Json::Bool(true)))
}
fn raw_string(v: &Value, c: &AtomicBool, d: Instant) -> Result<String, String> {
    let raw = super::json_value(v)?;
    String::from_utf16(&super::execution_contract::json_string(&raw, c, d)?)
        .map_err(|_| "environment_bom_json_string_domain_unaccepted".into())
}
fn valid_hash(v: Option<&Json>, c: &AtomicBool, d: Instant) -> Result<bool, String> {
    check(c, d)?;
    let Some(v) = v.filter(|v| json_truthy(v)) else {
        return Ok(false);
    };
    let units = super::execution_contract::json_string(v, c, d)?;
    let Ok(selected) = String::from_utf16(&units) else {
        return Ok(false);
    };
    check(c, d)?;
    Ok(selected.strip_prefix("sha256:").is_some_and(|body| {
        body.len() == 64
            && body
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }))
}
fn reserve<'a>(
    inputs: impl IntoIterator<Item = &'a Json>,
    c: &AtomicBool,
    d: Instant,
) -> Result<(), String> {
    let mut bytes = 0usize;
    let mut values = 0usize;
    let mut units = 0usize;
    for input in inputs {
        check(c, d)?;
        let measured = hepta_legacy_compatibility::production_json_resources_v1(
            input,
            hepta_legacy_compatibility::ProductionJsonEncodingLimitsV1 {
                maximum_bytes: 4 * 1024 * 1024 - bytes,
                maximum_values: 200_000 - values,
                maximum_utf16_units: 4 * 1024 * 1024 - units,
            },
            c,
        );
        check(c, d)?;
        let measured = measured.map_err(|e| e.to_string())?;
        bytes += measured.bytes;
        values += measured.values;
        units += measured.utf16_units;
    }
    Ok(())
}
fn nullable_hash(v: Option<&Json>, c: &AtomicBool, d: Instant) -> Result<bool, String> {
    Ok(matches!(v, Some(Json::Null)) || valid_hash(v, c, d)?)
}
fn hash_payload(
    kind: &str,
    v: &Json,
    key: &str,
    c: &AtomicBool,
    d: Instant,
) -> Result<bool, String> {
    let Json::Object(fields) = v else {
        return Ok(false);
    };
    let payload = Json::Object(
        fields
            .iter()
            .filter(|(k, _)| !k.iter().copied().eq(key.encode_utf16()))
            .cloned()
            .collect(),
    );
    let digest = hash(kind, &payload, c);
    check(c, d)?;
    let digest = digest?;
    Ok(literal(own(v, key), &digest))
}
fn add_hash(
    kind: &str,
    mut v: Json,
    key: &str,
    c: &AtomicBool,
    d: Instant,
) -> Result<Json, String> {
    let digest = hash(kind, &v, c);
    check(c, d)?;
    let digest = digest?;
    let Json::Object(fields) = &mut v else {
        return Err("environment_bom_contract_object_invalid".into());
    };
    fields.push((key.encode_utf16().collect(), text(&digest)));
    Ok(v)
}
// Reuse the established JSON-data JS coercion owners. User-defined conversion
// methods and non-JSON executable values fail closed in that existing domain.
enum Scalar {
    String(&'static str, bool),
    NullableLower,
    Number,
    True,
}
fn normalize(
    input: &Value,
    specs: &[(&str, Scalar)],
    c: &AtomicBool,
    d: Instant,
) -> Result<Json, String> {
    let mut fields = Vec::with_capacity(specs.len());
    for (name, kind) in specs {
        check(c, d)?;
        let v = &input[*name];
        let item = match kind {
            Scalar::String(default, lower) => {
                let s = if truthy(v) {
                    raw_string(v, c, d)?
                } else {
                    (*default).into()
                };
                text(&if *lower { s.to_lowercase() } else { s })
            }
            Scalar::NullableLower => {
                if truthy(v) {
                    text(&raw_string(v, c, d)?.to_lowercase())
                } else {
                    Json::Null
                }
            }
            Scalar::Number => Json::Number(if truthy(v) {
                crate::native_research_claims::number(v)?
            } else {
                0.0
            }),
            Scalar::True => Json::Bool(v == &Value::Bool(true)),
        };
        fields.push((name.encode_utf16().collect(), item));
    }
    Ok(Json::Object(fields))
}
fn sorted_strings(v: &Value, c: &AtomicBool, d: Instant) -> Result<Json, String> {
    let absent = Vec::new();
    let values = if truthy(v) {
        v.as_array().ok_or("environment_bom_string_set_invalid")?
    } else {
        &absent
    };
    let mut strings = Vec::with_capacity(values.len());
    for v in values {
        check(c, d)?;
        let s = raw_string(v, c, d)?;
        if !s.is_empty() {
            strings.push(s.encode_utf16().collect::<Vec<_>>())
        }
    }
    strings.sort();
    strings.dedup();
    Ok(Json::Array(strings.into_iter().map(Json::String).collect()))
}
fn canonical_string_set(v: Option<&Json>, c: &AtomicBool, d: Instant) -> Result<bool, String> {
    let Some(Json::Array(values)) = v else {
        return Ok(false);
    };
    let mut previous: Option<&Vec<u16>> = None;
    let mut valid = true;
    for v in values {
        check(c, d)?;
        if let Json::String(s) = v {
            valid &= !s.is_empty() && previous.is_none_or(|p| p < s);
            previous = Some(s);
        } else {
            // The incumbent maps String over every element before comparing;
            // an early non-string must not hide a later JSON conversion error.
            super::execution_contract::json_string(v, c, d)?;
            valid = false;
        }
    }
    Ok(valid)
}

fn require_finite_builder_numbers(v: &Json, c: &AtomicBool, d: Instant) -> Result<(), String> {
    check(c, d)?;
    match v {
        Json::Number(n) if !n.is_finite() => {
            return Err("environment_bom_nonfinite_builder_domain_unaccepted".into());
        }
        Json::Array(items) => {
            for item in items {
                require_finite_builder_numbers(item, c, d)?;
            }
        }
        Json::Object(fields) => {
            for (_, item) in fields {
                require_finite_builder_numbers(item, c, d)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn build_v2(input: &Json, c: &AtomicBool, d: Instant) -> Result<Json, String> {
    check(c, d)?;
    reserve([input], c, d)?;
    require_finite_builder_numbers(input, c, d)?;
    let input = value(input, c)?;
    check(c, d)?;
    if input.is_null() {
        return Err("Cannot read properties of null (reading 'platform')".into());
    }
    let s = |default, lower| Scalar::String(default, lower);
    if input.get("platform").is_some_and(Value::is_null) {
        return Err("Cannot read properties of null (reading 'cpu')".into());
    }
    let cpu = normalize(
        &input["platform"]["cpu"],
        &[
            ("modelHash", s("", true)),
            ("flagsHash", s("", true)),
            ("logicalProcessorCount", Scalar::Number),
            ("observation", s("unobserved", false)),
        ],
        c,
        d,
    )?;
    let mut platform = normalize(
        &input["platform"],
        &[
            ("operatingSystem", s("", true)),
            ("architecture", s("", true)),
            ("kernelReleaseHash", s("", true)),
            ("machineIdentityHash", Scalar::NullableLower),
            ("machineIdentityObservation", s("unobserved", false)),
        ],
        c,
        d,
    )?;
    if let Json::Object(fields) = &mut platform {
        fields.push(("cpu".encode_utf16().collect(), cpu))
    }
    let platform = add_hash(
        "EmpiricalEnvironmentHardwareIdentity",
        platform,
        "hardwareIdentityHash",
        c,
        d,
    )?;
    if input.get("runtime").is_some_and(Value::is_null) {
        return Err("Cannot read properties of null (reading 'packageClosure')".into());
    }
    let closure = normalize(
        &input["runtime"]["packageClosure"],
        &[
            ("basis", s("unobserved", false)),
            ("identityHash", Scalar::NullableLower),
            ("manifestHash", Scalar::NullableLower),
            ("observedPackageCount", Scalar::Number),
        ],
        c,
        d,
    )?;
    let mut runtime = normalize(
        &input["runtime"],
        &[
            ("type", s("", false)),
            ("identityHash", s("", true)),
            ("language", s("", true)),
            ("languageVersionHash", Scalar::NullableLower),
            ("containerImageDigest", Scalar::NullableLower),
            ("hostExecutableHash", Scalar::NullableLower),
        ],
        c,
        d,
    )?;
    if let Json::Object(fields) = &mut runtime {
        fields.push(("packageClosure".encode_utf16().collect(), closure))
    }
    let runtime = add_hash(
        "EmpiricalEnvironmentRuntimeClosure",
        runtime,
        "runtimeClosureHash",
        c,
        d,
    )?;
    if input.get("gpu").is_some_and(Value::is_null) {
        return Err("Cannot read properties of null (reading 'required')".into());
    }
    let gpu_default = if truthy(&input["gpu"]["required"]) {
        "unavailable"
    } else {
        "not_required"
    };
    let gpu = normalize(
        &input["gpu"],
        &[
            ("required", Scalar::True),
            ("status", s(gpu_default, false)),
            ("deviceCount", Scalar::Number),
            ("modelSetHash", Scalar::NullableLower),
            ("computeCapabilitySetHash", Scalar::NullableLower),
            ("driverVersionHash", Scalar::NullableLower),
            ("runtimeVersionHash", Scalar::NullableLower),
        ],
        c,
        d,
    )?;
    let gpu = add_hash(
        "EmpiricalEnvironmentGpuIdentity",
        gpu,
        "gpuIdentityHash",
        c,
        d,
    )?;
    if input.get("numericRuntime").is_some_and(Value::is_null) {
        return Err("Cannot read properties of null (reading 'threads')".into());
    }
    let mut threads = Vec::new();
    if truthy(&input["numericRuntime"]["threads"]) {
        let source = input["numericRuntime"]["threads"]
            .as_object()
            .ok_or("environment_bom_threads_data_domain_unaccepted")?;
        for (key, v) in source {
            check(c, d)?;
            if !THREAD_KEYS.contains(&key.as_str()) {
                return Err("environment_bom_threads_data_domain_unaccepted".into());
            }
            threads.push((key.clone(), raw_string(v, c, d)?))
        }
        let collation =
            hepta_legacy_compatibility::ProductionCollationV1::load().map_err(|e| e.to_string())?;
        threads.sort_by(|a, b| collation.compare(&a.0, &b.0));
    }
    let threads = Json::Object(
        threads
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), text(&v)))
            .collect(),
    );
    let numeric = normalize(
        &input["numericRuntime"],
        &[
            ("dynamicThreadingDisabled", Scalar::True),
            ("explicitSingleThreadPolicy", Scalar::True),
            ("policyObservation", s("environment_allowlist", false)),
            ("blasImplementationHash", Scalar::NullableLower),
            ("blasImplementationObservation", s("unobserved", false)),
            ("numericalLibraryBehaviorHash", Scalar::NullableLower),
            (
                "numericalLibraryBehaviorObservation",
                s("unobserved", false),
            ),
        ],
        c,
        d,
    )?;
    let Json::Object(mut numeric_fields) = numeric else {
        return Err("environment_bom_contract_object_invalid".into());
    };
    numeric_fields.insert(0, ("threads".encode_utf16().collect(), threads));
    let numeric = add_hash(
        "EmpiricalNumericRuntimePolicy",
        Json::Object(numeric_fields),
        "numericRuntimePolicyHash",
        c,
        d,
    )?;
    if input.get("limits").is_some_and(Value::is_null) {
        return Err("Cannot read properties of null (reading 'timeoutMs')".into());
    }
    let limits = normalize(
        &input["limits"],
        &[
            ("timeoutMs", Scalar::Number),
            ("memoryBytes", Scalar::Number),
            ("cpuSeconds", Scalar::Number),
            ("maximumPids", Scalar::Number),
            ("maximumOutputBytes", Scalar::Number),
            ("maximumCapturedBytes", Scalar::Number),
        ],
        c,
        d,
    )?;
    let limits = add_hash(
        "EmpiricalEnvironmentResourceLimits",
        limits,
        "resourceLimitsHash",
        c,
        d,
    )?;
    if input.get("determinism").is_some_and(Value::is_null) {
        return Err("Cannot read properties of null (reading 'classification')".into());
    }
    let determinism = normalize(
        &input["determinism"],
        &[
            ("classification", s("unknown", false)),
            ("explicitlyRequested", Scalar::True),
            ("deterministicSeedRequired", Scalar::True),
            ("deterministicSeedBound", Scalar::True),
            ("threadPolicyVerified", Scalar::True),
            ("gpuDeterminismVerified", Scalar::True),
        ],
        c,
        d,
    )?;
    let determinism = add_hash(
        "EmpiricalDeterminismPolicy",
        determinism,
        "determinismPolicyHash",
        c,
        d,
    )?;
    if input
        .get("buildReproducibility")
        .is_some_and(Value::is_null)
    {
        return Err("Cannot read properties of null (reading 'status')".into());
    }
    let mut build = normalize(
        &input["buildReproducibility"],
        &[
            ("status", s("not_assessed", false)),
            ("runtimeContentIdentityPinned", Scalar::True),
            ("bitwiseRebuildVerified", Scalar::True),
            ("definitionHash", Scalar::NullableLower),
            ("evidenceHash", Scalar::NullableLower),
        ],
        c,
        d,
    )?;
    let blockers = sorted_strings(&input["buildReproducibility"]["blockers"], c, d)?;
    if let Json::Object(fields) = &mut build {
        fields.push(("blockers".encode_utf16().collect(), blockers))
    }
    let build = add_hash(
        "RuntimeBuildReproducibilityAssessment",
        build,
        "buildReproducibilityHash",
        c,
        d,
    )?;
    let payload = object([
        ("version", Json::Number(2.0)),
        ("kind", text("EmpiricalEnvironmentBOM")),
        (
            "assurance",
            text(
                "observed_runtime_hardware_numeric_behavior_and_execution_policy_not_bitwise_rebuild",
            ),
        ),
        ("platform", platform),
        ("runtime", runtime),
        ("gpu", gpu),
        ("numericRuntime", numeric),
        ("limits", limits),
        ("determinism", determinism),
        ("buildReproducibility", build),
        (
            "observedClaims",
            sorted_strings(&input["observedClaims"], c, d)?,
        ),
        (
            "unobservedClaims",
            sorted_strings(&input["unobservedClaims"], c, d)?,
        ),
    ]);
    add_hash(
        "EmpiricalEnvironmentBOM",
        payload,
        "environmentBomHash",
        c,
        d,
    )
}

const THREAD_KEYS: [&str; 7] = [
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "BLIS_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "RAYON_NUM_THREADS",
];
fn in_set(v: Option<&Json>, choices: &[&str]) -> bool {
    choices.iter().any(|s| literal(v, s))
}
fn nullable_observation(
    part: &Json,
    hash_key: &str,
    observation: &str,
    c: &AtomicBool,
    d: Instant,
) -> Result<bool, String> {
    let h = own(part, hash_key);
    let valid = valid_hash(h, c, d)?;
    Ok(nullable_hash(h, c, d)?
        && if matches!(h, Some(Json::Null)) {
            literal(own(part, observation), "unobserved")
        } else {
            valid && !literal(own(part, observation), "unobserved")
        })
}
fn report(blockers: Vec<String>) -> Json {
    object([
        ("valid", Json::Bool(blockers.is_empty())),
        (
            "blockers",
            Json::Array(blockers.into_iter().map(|s| text(&s)).collect()),
        ),
    ])
}

pub(super) fn verify_v2(bom: &Json, c: &AtomicBool, d: Instant) -> Result<Json, String> {
    check(c, d)?;
    reserve([bom], c, d)?;
    let mut blockers = Vec::new();
    if !matches!(own(bom,"version"),Some(Json::Number(n)) if *n==2.0)
        || !literal(own(bom, "kind"), "EmpiricalEnvironmentBOM")
        || !literal(
            own(bom, "assurance"),
            "observed_runtime_hardware_numeric_behavior_and_execution_policy_not_bitwise_rebuild",
        )
    {
        return Ok(report(vec!["environment_bom_shape_invalid".into()]));
    }
    if !valid_hash(own(bom, "environmentBomHash"), c, d)?
        || !hash_payload("EmpiricalEnvironmentBOM", bom, "environmentBomHash", c, d)?
    {
        blockers.push("environment_bom_hash_invalid".into())
    }
    let platform = field(bom, "platform");
    let cpu = field(platform, "cpu");
    if !own(platform, "operatingSystem").is_some_and(json_truthy)
        || !own(platform, "architecture").is_some_and(json_truthy)
        || !valid_hash(own(platform, "kernelReleaseHash"), c, d)?
        || !valid_hash(own(cpu, "modelHash"), c, d)?
        || !valid_hash(own(cpu, "flagsHash"), c, d)?
        || !positive(own(cpu, "logicalProcessorCount"))
        || !nullable_observation(
            platform,
            "machineIdentityHash",
            "machineIdentityObservation",
            c,
            d,
        )?
        || !valid_hash(own(platform, "hardwareIdentityHash"), c, d)?
        || !hash_payload(
            "EmpiricalEnvironmentHardwareIdentity",
            platform,
            "hardwareIdentityHash",
            c,
            d,
        )?
    {
        blockers.push("environment_bom_hardware_identity_invalid".into())
    }
    let runtime = field(bom, "runtime");
    let closure = field(runtime, "packageClosure");
    if !in_set(own(runtime, "type"), &["container", "host"])
        || !valid_hash(own(runtime, "identityHash"), c, d)?
        || !own(runtime, "language").is_some_and(json_truthy)
        || !valid_hash(own(runtime, "runtimeClosureHash"), c, d)?
        || !hash_payload(
            "EmpiricalEnvironmentRuntimeClosure",
            runtime,
            "runtimeClosureHash",
            c,
            d,
        )?
        || !in_set(
            own(closure, "basis"),
            &["container_image_digest", "content_manifest", "unobserved"],
        )
        || !nullable_hash(own(runtime, "languageVersionHash"), c, d)?
        || !nullable_hash(own(closure, "identityHash"), c, d)?
        || !nullable_hash(own(closure, "manifestHash"), c, d)?
        || !zero_or_positive(own(closure, "observedPackageCount"))
        || (literal(own(runtime, "type"), "container")
            && (!valid_hash(own(runtime, "containerImageDigest"), c, d)?
                || !matches!(own(runtime, "hostExecutableHash"), Some(Json::Null))))
        || (literal(own(runtime, "type"), "host")
            && (!valid_hash(own(runtime, "hostExecutableHash"), c, d)?
                || !matches!(own(runtime, "containerImageDigest"), Some(Json::Null))))
    {
        blockers.push("environment_bom_runtime_closure_invalid".into())
    }
    let mut binding_invalid = false;
    if literal(own(closure, "basis"), "container_image_digest") {
        binding_invalid = !literal(own(runtime, "type"), "container")
            || !equals(
                own(closure, "identityHash"),
                own(runtime, "containerImageDigest"),
            )
            || !matches!(own(closure, "manifestHash"), Some(Json::Null));
    } else if literal(own(closure, "basis"), "content_manifest") {
        let mut closure_payload = Vec::new();
        // JS object-literal properties whose value is undefined disappear from
        // record hashing; an absent property must never become explicit null.
        for key in ["manifestHash", "observedPackageCount"] {
            if let Some(v) = own(closure, key) {
                closure_payload.push((key.encode_utf16().collect(), v.clone()));
            }
        }
        let digest = hash(
            "RuntimePackageClosureIdentity",
            &Json::Object(closure_payload),
            c,
        );
        check(c, d)?;
        binding_invalid = !valid_hash(own(closure, "manifestHash"), c, d)?
            || !literal(own(closure, "identityHash"), &digest?);
    } else if literal(own(closure, "basis"), "unobserved") {
        binding_invalid = !matches!(own(closure, "identityHash"), Some(Json::Null))
            || !matches!(own(closure, "manifestHash"), Some(Json::Null))
            || !matches!(own(closure,"observedPackageCount"),Some(Json::Number(n)) if *n==0.0);
    }
    if binding_invalid {
        blockers.push("environment_bom_package_closure_binding_invalid".into())
    }
    let gpu = field(bom, "gpu");
    let required = own(gpu, "required").is_some_and(json_truthy);
    if !in_set(
        own(gpu, "status"),
        &["not_required", "observed", "unavailable"],
    ) || !valid_hash(own(gpu, "gpuIdentityHash"), c, d)?
        || !hash_payload(
            "EmpiricalEnvironmentGpuIdentity",
            gpu,
            "gpuIdentityHash",
            c,
            d,
        )?
        || (required
            && (!literal(own(gpu, "status"), "observed")
                || !positive(own(gpu, "deviceCount"))
                || !valid_hash(own(gpu, "modelSetHash"), c, d)?
                || !valid_hash(own(gpu, "computeCapabilitySetHash"), c, d)?
                || !valid_hash(own(gpu, "driverVersionHash"), c, d)?
                || !valid_hash(own(gpu, "runtimeVersionHash"), c, d)?))
        || (!required && !literal(own(gpu, "status"), "not_required"))
    {
        blockers.push("environment_bom_gpu_identity_invalid".into())
    }
    let numeric = field(bom, "numericRuntime");
    let threads = field(numeric, "threads");
    // Preserve original OR short-circuiting: Object.entries(null) throws only
    // after the prior hash, type and optional-observation predicates passed.
    let mut numeric_valid = valid_hash(own(numeric, "numericRuntimePolicyHash"), c, d)?
        && hash_payload(
            "EmpiricalNumericRuntimePolicy",
            numeric,
            "numericRuntimePolicyHash",
            c,
            d,
        )?
        && matches!(own(numeric, "threads"), Some(Json::Object(_) | Json::Null))
        && nullable_observation(
            numeric,
            "blasImplementationHash",
            "blasImplementationObservation",
            c,
            d,
        )?
        && nullable_observation(
            numeric,
            "numericalLibraryBehaviorHash",
            "numericalLibraryBehaviorObservation",
            c,
            d,
        )?;
    if numeric_valid {
        match threads {
            Json::Null => return Err("Cannot convert undefined or null to object".into()),
            Json::Object(fields) => {
                for (k, v) in fields {
                    check(c, d)?;
                    let key =
                        String::from_utf16(k).map_err(|_| "environment_bom_thread_key_invalid")?;
                    if !THREAD_KEYS.contains(&key.as_str()) {
                        numeric_valid = false;
                        break;
                    }
                    let units = super::execution_contract::json_string(v, c, d)?;
                    let selected = String::from_utf16(&units);
                    let valid = selected.is_ok_and(|s| {
                        s.as_bytes()
                            .first()
                            .is_some_and(|b| (b'1'..=b'9').contains(b))
                            && s.bytes().all(|b| b.is_ascii_digit())
                    });
                    if !valid {
                        numeric_valid = false;
                        break;
                    }
                }
            }
            _ => numeric_valid = false,
        }
    }
    if !numeric_valid {
        blockers.push("environment_bom_numeric_runtime_policy_invalid".into());
    }
    if is_true(own(numeric, "explicitSingleThreadPolicy"))
        && (!THREAD_KEYS[..6]
            .iter()
            .all(|k| literal(own(threads, k), "1"))
            || match threads {
                Json::Object(fields) => fields.iter().any(|(_, v)| !literal(Some(v), "1")),
                _ => true,
            })
    {
        blockers.push("environment_bom_single_thread_policy_invalid".into())
    }
    let limits = field(bom, "limits");
    if ![
        "timeoutMs",
        "memoryBytes",
        "cpuSeconds",
        "maximumPids",
        "maximumOutputBytes",
        "maximumCapturedBytes",
    ]
    .iter()
    .all(|k| positive(own(limits, k)))
        || !valid_hash(own(limits, "resourceLimitsHash"), c, d)?
        || !hash_payload(
            "EmpiricalEnvironmentResourceLimits",
            limits,
            "resourceLimitsHash",
            c,
            d,
        )?
    {
        blockers.push("environment_bom_resource_limits_invalid".into())
    }
    let determinism = field(bom, "determinism");
    if !in_set(
        own(determinism, "classification"),
        &[
            "explicit_deterministic_cpu",
            "nondeterministic",
            "unknown",
            "gpu_nondeterministic",
        ],
    ) || !valid_hash(own(determinism, "determinismPolicyHash"), c, d)?
        || !hash_payload(
            "EmpiricalDeterminismPolicy",
            determinism,
            "determinismPolicyHash",
            c,
            d,
        )?
    {
        blockers.push("environment_bom_determinism_policy_invalid".into())
    }
    let build = field(bom, "buildReproducibility");
    let bitwise = own(build, "bitwiseRebuildVerified").is_some_and(json_truthy);
    let empty_blockers = matches!(own(build,"blockers"),Some(Json::Array(v)) if v.is_empty());
    if !in_set(
        own(build, "status"),
        &[
            "not_assessed",
            "build_reproducibility_unverified",
            "runtime_content_identity_pinned_rebuild_not_assessed",
            "runtime_content_identity_pinned_rebuild_not_verified",
            "bitwise_rebuild_verified",
        ],
    ) || !matches!(own(build, "blockers"), Some(Json::Array(_)))
        || !valid_hash(own(build, "buildReproducibilityHash"), c, d)?
        || !hash_payload(
            "RuntimeBuildReproducibilityAssessment",
            build,
            "buildReproducibilityHash",
            c,
            d,
        )?
        || !nullable_hash(own(build, "definitionHash"), c, d)?
        || !nullable_hash(own(build, "evidenceHash"), c, d)?
        || (bitwise
            && (!literal(own(build, "status"), "bitwise_rebuild_verified")
                || !is_true(own(build, "runtimeContentIdentityPinned"))
                || !valid_hash(own(build, "definitionHash"), c, d)?
                || !valid_hash(own(build, "evidenceHash"), c, d)?
                || !empty_blockers))
        || (!bitwise && literal(own(build, "status"), "bitwise_rebuild_verified"))
    {
        blockers.push("environment_bom_build_reproducibility_invalid".into())
    }
    let observed = own(bom, "observedClaims");
    let unobserved = own(bom, "unobservedClaims");
    let observed_canonical = canonical_string_set(observed, c, d)?;
    let unobserved_canonical = observed_canonical && canonical_string_set(unobserved, c, d)?;
    let mut overlap = false;
    if observed_canonical
        && unobserved_canonical
        && let (Some(Json::Array(a)), Some(Json::Array(b))) = (observed, unobserved)
    {
        let mut members = BTreeSet::new();
        for item in a {
            check(c, d)?;
            if let Json::String(units) = item {
                members.insert(units.as_slice());
            }
        }
        for item in b {
            check(c, d)?;
            if let Json::String(units) = item {
                overlap |= members.contains(units.as_slice());
            }
        }
    }
    if !observed_canonical || !unobserved_canonical || overlap {
        blockers.push("environment_bom_assurance_scope_invalid".into())
    }
    check(c, d)?;
    Ok(report(blockers))
}

pub(super) fn against_worker_receipt_v2(
    bom: &Json,
    receipt: &Json,
    c: &AtomicBool,
    d: Instant,
) -> Result<bool, String> {
    check(c, d)?;
    reserve([bom, receipt], c, d)?;
    if !is_true(own(&verify_v2(bom, c, d)?, "valid")) || !json_truthy(receipt) {
        return Ok(false);
    }
    let runtime = field(bom, "runtime");
    let gpu = field(bom, "gpu");
    let actual_limits = field(receipt, "limits");
    let expected_limits = field(bom, "limits");
    let gpu_requested =
        own(field(receipt, "isolation"), "gpuAccessRequested").is_some_and(json_truthy);
    let valid = equals(
        own(bom, "environmentBomHash"),
        own(receipt, "environmentBomHash"),
    ) && equals(
        own(runtime, "identityHash"),
        own(receipt, "runtimeIdentityHash"),
    ) && equals(own(runtime, "type"), own(receipt, "runtimeIdentityType"))
        && (!literal(own(runtime, "type"), "container")
            || equals(
                own(runtime, "containerImageDigest"),
                own(receipt, "containerImageDigest"),
            ))
        && equals(own(gpu, "required"), Some(&Json::Bool(gpu_requested)))
        && [
            "timeoutMs",
            "memoryBytes",
            "cpuSeconds",
            "maximumPids",
            "maximumOutputBytes",
            "maximumCapturedBytes",
        ]
        .iter()
        .all(|key| equals(own(expected_limits, key), own(actual_limits, key)));
    check(c, d)?;
    Ok(valid)
}

#[cfg(test)]
mod tests;
