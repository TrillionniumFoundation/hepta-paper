use super::*;
const FAMILIES: [&str; 10] = [
    "bayesian",
    "causal-inference",
    "linear-algebra",
    "monte-carlo",
    "ode",
    "optimization",
    "pde",
    "signal-processing",
    "survival",
    "time-series",
];
pub(super) fn families() -> Json {
    Json::Array(FAMILIES.iter().map(|v| text(v)).collect())
}
fn safe(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 192
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}
fn version(s: &str) -> bool {
    let (core, suffix) = s.split_once('-').map_or((s, None), |(a, b)| (a, Some(b)));
    let p: Vec<_> = core.split('.').collect();
    p.len() == 3
        && p.iter()
            .all(|p| !p.is_empty() && p.len() <= 4 && p.bytes().all(|b| b.is_ascii_digit()))
        && suffix.is_none_or(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
        })
}
fn lower(v: &Value) -> Option<String> {
    v.as_str().map(str::to_lowercase).filter(|s| sha(s))
}

const GPU_FIELDS: [&str; 15] = [
    "language",
    "executable",
    "executableHash",
    "packageClosureHash",
    "runtimeProfile",
    "requiresGpu",
    "containerImage",
    "containerImageDigest",
    "containerExecutable",
    "gpuDeviceSelector",
    "cpuFallbackPolicy",
    "gpuDeviceIsolationScope",
    "gpuMemoryLimitBytes",
    "gpuMemoryLimitEnforced",
    "gpuMemoryLimitScope",
];
fn container_image(value: &str) -> bool {
    let Some((image, tag)) = value.split_once(':') else {
        return false;
    };
    !image.is_empty()
        && image.len() <= 192
        && (image.as_bytes()[0].is_ascii_lowercase() || image.as_bytes()[0].is_ascii_digit())
        && image
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._/-".contains(&b))
        && !tag.is_empty()
        && tag.len() <= 128
        && tag.as_bytes()[0].is_ascii_alphanumeric()
        && tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn gpu_uuid(value: &str) -> bool {
    let Some(uuid) = value.strip_prefix("GPU-") else {
        return false;
    };
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn runtime_valid(runtime: &Value, version: u64) -> bool {
    let hashes = lower(&runtime["executableHash"]).is_some()
        && lower(&runtime["packageClosureHash"]).is_some();
    let executable = runtime["executable"]
        .as_str()
        .is_some_and(|s| safe(crate::automation_runtime_reconciliation::sqlite_number::trim(s)));
    if version == 1 {
        return exact(
            runtime,
            &[
                "executable",
                "executableHash",
                "language",
                "packageClosureHash",
            ],
        ) && runtime["language"]
            .as_str()
            .is_some_and(|s| ["julia", "python", "r"].contains(&s))
            && executable
            && hashes;
    }
    version == 2
        && exact(runtime, &GPU_FIELDS)
        && executable
        && hashes
        && runtime["language"] == "python"
        && runtime["runtimeProfile"] == "pythonGpu"
        && runtime["requiresGpu"] == true
        && runtime["cpuFallbackPolicy"] == "forbidden"
        && runtime["executable"] == runtime["containerExecutable"]
        && runtime["containerExecutable"]
            .as_str()
            .is_some_and(|s| safe(crate::automation_runtime_reconciliation::sqlite_number::trim(s)))
        && runtime["containerImage"]
            .as_str()
            .is_some_and(container_image)
        && lower(&runtime["containerImageDigest"]).is_some()
        && lower(&runtime["containerImageDigest"]) == lower(&runtime["packageClosureHash"])
        && runtime["gpuDeviceSelector"].as_str().is_some_and(gpu_uuid)
        && runtime["gpuDeviceIsolationScope"]
            == "single-requested-device-selector-not-mig-or-vram-isolation-v1"
        && runtime["gpuMemoryLimitBytes"].is_null()
        && runtime["gpuMemoryLimitEnforced"] == false
        && runtime["gpuMemoryLimitScope"] == "not-enforced-shared-device-vram-v1"
}
fn compiled_runtime(raw: &Json, v: &Value) -> Result<Json, String> {
    let fields: &[&str] = if v["version"] == 2 {
        &GPU_FIELDS
    } else {
        &[
            "language",
            "executable",
            "executableHash",
            "packageClosureHash",
        ]
    };
    Ok(Json::Object(
        fields
            .iter()
            .map(|key| {
                let value = if key.ends_with("Hash") || *key == "containerImageDigest" {
                    text(
                        &lower(&v["runtime"][*key])
                            .ok_or("advanced_numerical_plugin_signed_bundle_invalid")?,
                    )
                } else {
                    field(field(raw, "runtime"), key).clone()
                };
                Ok((key.encode_utf16().collect(), value))
            })
            .collect::<Result<Vec<_>, String>>()?,
    ))
}
pub(super) fn gpu_authority_v2(v: &Value, c: &AtomicBool, d: Instant) -> Result<Json, String> {
    check(c, d)?;
    if v["version"] != 2 || !runtime_valid(&v["runtime"], 2) {
        return Err("advanced_numerical_plugin_gpu_runtime_authority_invalid".into());
    }
    let mut fields = vec![
        ("version".encode_utf16().collect(), Json::Number(1.0)),
        (
            "kind".encode_utf16().collect(),
            text("AdvancedNumericalGpuRuntimeAuthority"),
        ),
        (
            "pluginDescriptorHash".encode_utf16().collect(),
            json_value(&v["advancedNumericalPluginDescriptorHash"])?,
        ),
    ];
    for key in GPU_FIELDS {
        check(c, d)?;
        fields.push((
            key.encode_utf16().collect(),
            json_value(&v["runtime"][key])?,
        ));
    }
    let payload = Json::Object(fields);
    let digest = hash("AdvancedNumericalGpuRuntimeAuthority", &payload, c)?;
    let Json::Object(mut fields) = payload else {
        return Err("advanced_numerical_plugin_gpu_runtime_authority_invalid".into());
    };
    fields.push((
        "advancedNumericalGpuRuntimeAuthorityHash"
            .encode_utf16()
            .collect(),
        text(&digest),
    ));
    check(c, d)?;
    Ok(Json::Object(fields))
}
fn verify(v: &Value) -> bool {
    exact(
        v,
        &[
            "advancedNumericalPluginDescriptorHash",
            "analysisFamily",
            "assuranceContracts",
            "entrypoint",
            "kind",
            "limits",
            "networkPolicy",
            "pluginId",
            "pluginVersion",
            "runtime",
            "sourceIdentity",
            "version",
        ],
    ) && matches!(v["version"].as_u64(), Some(1 | 2))
        && v["kind"] == "AdvancedNumericalPluginDescriptor"
        && v["pluginId"].as_str().is_some_and(safe)
        && v["pluginVersion"].as_str().is_some_and(version)
        && v["analysisFamily"]
            .as_str()
            .is_some_and(|s| FAMILIES.contains(&s))
        && runtime_valid(&v["runtime"], v["version"].as_u64().unwrap_or(0))
        && exact(&v["entrypoint"], &["relativePath", "sha256"])
        && v["entrypoint"]["relativePath"].as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 4096
                && s.split('/').all(|p| {
                    !p.is_empty()
                        && p.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                })
        })
        && lower(&v["entrypoint"]["sha256"]).is_some()
        && exact(
            &v["sourceIdentity"],
            &["merkleHash", "workspaceManifestHash"],
        )
        && lower(&v["sourceIdentity"]["merkleHash"]).is_some()
        && lower(&v["sourceIdentity"]["workspaceManifestHash"]).is_some()
        && exact(
            &v["limits"],
            &[
                "cpuSeconds",
                "maximumCapturedBytes",
                "maximumOutputBytes",
                "maximumProcesses",
                "memoryBytes",
                "timeoutMs",
            ],
        )
        && [
            "cpuSeconds",
            "maximumCapturedBytes",
            "maximumOutputBytes",
            "maximumProcesses",
            "memoryBytes",
            "timeoutMs",
        ]
        .iter()
        .all(|k| {
            v["limits"][*k]
                .as_u64()
                .is_some_and(|n| (1..=9_007_199_254_740_991).contains(&n))
        })
        && v["limits"]["timeoutMs"]
            .as_u64()
            .is_some_and(|n| n <= 86_400_000)
        && v["limits"]["memoryBytes"]
            .as_u64()
            .is_some_and(|n| n >= 64 * 1024 * 1024)
        && v["limits"]["maximumCapturedBytes"].as_u64()
            <= v["limits"]["maximumOutputBytes"].as_u64()
        && v["networkPolicy"] == "none"
        && exact(
            &v["assuranceContracts"],
            &["oracle", "replay", "uncertainty"],
        )
        && [
            ("oracle", "independent-numeric-oracle-v1"),
            ("replay", "deterministic-process-replay-v1"),
            ("uncertainty", "typed-uncertainty-report-v1"),
        ]
        .iter()
        .all(|(name, kind)| {
            exact(&v["assuranceContracts"][*name], &["contractHash", "kind"])
                && v["assuranceContracts"][*name]["kind"] == *kind
                && lower(&v["assuranceContracts"][*name]["contractHash"]).is_some()
        })
}
pub(super) fn inspect(raw: &Json, c: &AtomicBool, d: Instant) -> Result<Value, String> {
    check(c, d)?;
    let v = value(raw, c)?;
    if !verify(&v) {
        return Err("advanced_numerical_plugin_signed_bundle_invalid".into());
    }
    let runtime = compiled_runtime(raw, &v)?;
    let mut contracts = vec![];
    for (name, kind) in [
        ("oracle", "independent-numeric-oracle-v1"),
        ("replay", "deterministic-process-replay-v1"),
        ("uncertainty", "typed-uncertainty-report-v1"),
    ] {
        contracts.push((
            name.encode_utf16().collect(),
            object([
                ("kind", text(kind)),
                (
                    "contractHash",
                    text(
                        &lower(&v["assuranceContracts"][name]["contractHash"])
                            .ok_or("advanced_numerical_plugin_signed_bundle_invalid")?,
                    ),
                ),
            ]),
        ));
    }
    let payload = object([
        ("version", field(raw, "version").clone()),
        ("kind", text("AdvancedNumericalPluginDescriptor")),
        (
            "pluginId",
            text(
                crate::automation_runtime_reconciliation::sqlite_number::trim(
                    v["pluginId"]
                        .as_str()
                        .ok_or("advanced_numerical_plugin_signed_bundle_invalid")?,
                ),
            ),
        ),
        ("pluginVersion", field(raw, "pluginVersion").clone()),
        ("analysisFamily", field(raw, "analysisFamily").clone()),
        ("runtime", runtime),
        (
            "entrypoint",
            object([
                (
                    "relativePath",
                    field(field(raw, "entrypoint"), "relativePath").clone(),
                ),
                (
                    "sha256",
                    text(
                        &lower(&v["entrypoint"]["sha256"])
                            .ok_or("advanced_numerical_plugin_signed_bundle_invalid")?,
                    ),
                ),
            ]),
        ),
        (
            "sourceIdentity",
            object([
                (
                    "merkleHash",
                    text(
                        &lower(&v["sourceIdentity"]["merkleHash"])
                            .ok_or("advanced_numerical_plugin_signed_bundle_invalid")?,
                    ),
                ),
                (
                    "workspaceManifestHash",
                    text(
                        &lower(&v["sourceIdentity"]["workspaceManifestHash"])
                            .ok_or("advanced_numerical_plugin_signed_bundle_invalid")?,
                    ),
                ),
            ]),
        ),
        ("limits", field(raw, "limits").clone()),
        ("networkPolicy", text("none")),
        ("assuranceContracts", Json::Object(contracts)),
    ]);
    let digest = hash("AdvancedNumericalPluginDescriptor", &payload, c)?;
    let Json::Object(mut fields) = payload else {
        return Err("advanced_numerical_plugin_signed_bundle_invalid".into());
    };
    fields.push((
        "advancedNumericalPluginDescriptorHash"
            .encode_utf16()
            .collect(),
        text(&digest),
    ));
    let compiled = Json::Object(fields);
    let limits = ProductionJsonEncodingLimitsV1::default();
    if production_json_stringify_with_limits_v1(raw, limits, c).map_err(|e| e.to_string())?
        != production_json_stringify_with_limits_v1(&compiled, limits, c)
            .map_err(|e| e.to_string())?
    {
        return Err("advanced_numerical_plugin_signed_bundle_invalid".into());
    }
    check(c, d)?;
    Ok(v)
}
