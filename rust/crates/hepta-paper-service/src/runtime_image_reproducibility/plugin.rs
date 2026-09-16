use super::*;
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use std::collections::BTreeSet;
const ADAPTER: &str = "repository-system-benchmark-harness-v1";
const INPUTS: &str = include_str!("plugin-inputs.v1.json");
#[derive(Debug)]
pub struct PluginAuthority {
    pub package: Value,
    pub registry: Value,
    pub startup_inspection: Value,
    pub scope: Value,
}
fn raw() -> Result<Value> {
    parse(INPUTS.as_bytes())
}
fn ident(v: &Value, max: usize, punctuation: &[u8], letter: bool) -> bool {
    let x = s(v);
    !x.is_empty()
        && x.len() <= max
        && if letter {
            x.as_bytes()[0].is_ascii_alphabetic()
        } else {
            x.as_bytes()[0].is_ascii_alphanumeric()
        }
        && x.bytes()
            .all(|b| b.is_ascii_alphanumeric() || punctuation.contains(&b))
}
fn plugin_id(v: &Value) -> Result<String> {
    let x = s(v).trim();
    ensure(
        ident(&x.into(), 192, b"_.:-", false),
        "autonomous_empirical_family_plugin_profile_invalid",
    )?;
    Ok(x.into())
}
fn strings(v: &Value, max: usize, predicate: impl Fn(&Value) -> bool) -> Result<Vec<String>> {
    let a = array(v);
    ensure(
        !a.is_empty() && a.len() <= max && a.iter().all(&predicate),
        "runtime_reproducibility_plugin_array_invalid",
    )?;
    let values: Vec<_> = a.iter().map(|v| s(v).to_owned()).collect();
    ensure(
        values.iter().collect::<BTreeSet<_>>().len() == values.len(),
        "runtime_reproducibility_plugin_array_duplicate",
    )?;
    Ok(values)
}
fn number(v: &Value) -> Option<f64> {
    let value = match v {
        Value::Number(n) => n.as_f64()?,
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::String(s) => {
            let s = s.trim();
            if s.is_empty() {
                0.0
            } else if let Some(h) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                u64::from_str_radix(h, 16).ok()? as f64
            } else if let Some(h) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
                u64::from_str_radix(h, 2).ok()? as f64
            } else if let Some(h) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
                u64::from_str_radix(h, 8).ok()? as f64
            } else {
                s.parse::<f64>().ok()?
            }
        }
        _ => return None,
    };
    value.is_finite().then_some(value)
}
fn integer(v: &Value) -> Option<i64> {
    let n = number(v)?;
    (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}
fn numeric_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        Value::from(n as i64)
    } else {
        json!(n)
    }
}
fn evaluator(raw: &Value) -> Result<Value> {
    let values = array(raw);
    ensure(
        !values.is_empty() && values.len() <= 128,
        "system_benchmark_evaluator_registry_descriptors_invalid",
    )?;
    let mut profiles = Vec::new();
    let mut families = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for v in values {
        ensure(
            exact(
                v,
                &[
                    "version",
                    "kind",
                    "profileId",
                    "benchmarkFamily",
                    "armOperations",
                    "oracleFields",
                    "rawEventFields",
                    "metrics",
                ],
            ) && v["version"] == 1
                && v["kind"] == "SystemBenchmarkEvaluatorDescriptor"
                && ident(&v["profileId"], 128, b"_.-", false)
                && ident(&v["benchmarkFamily"], 64, b"_", true),
            "system_benchmark_evaluator_descriptor_shape_invalid",
        )?;
        ensure(
            ids.insert(s(&v["profileId"])) && families.insert(s(&v["benchmarkFamily"])),
            "system_benchmark_evaluator_registry_duplicate",
        )?;
        let arms = &v["armOperations"];
        ensure(
            exact(arms, &["treatment", "baseline", "ablation"])
                && ["treatment", "baseline", "ablation"]
                    .iter()
                    .all(|k| ident(&arms[*k], 128, b"_.-", false))
                && [
                    s(&arms["treatment"]),
                    s(&arms["baseline"]),
                    s(&arms["ablation"]),
                ]
                .into_iter()
                .collect::<BTreeSet<_>>()
                .len()
                    == 3,
            "system_benchmark_evaluator_descriptor_arm_operations_invalid",
        )?;
        for field in ["oracleFields", "rawEventFields"] {
            let strings = strings(&v[field], 64, |v| ident(v, 64, b"_", true))?;
            ensure(
                strings.windows(2).all(|w| w[0] < w[1]),
                "system_benchmark_evaluator_descriptor_fields_not_canonical",
            )?;
        }
        let metrics = array(&v["metrics"]);
        ensure(
            !metrics.is_empty() && metrics.len() <= 64,
            "system_benchmark_evaluator_descriptor_metrics_invalid",
        )?;
        let mut metric_names = BTreeSet::new();
        for m in metrics {
            ensure(
                exact(m, &["metric", "expression"])
                    && ident(&m["metric"], 64, b"_", true)
                    && metric_names.insert(s(&m["metric"]))
                    && exact(&m["expression"], &["operator", "operands"]),
                "system_benchmark_evaluator_descriptor_metric_invalid",
            )?;
            let count = match s(&m["expression"]["operator"]) {
                "arithmetic_mean" | "sample_standard_error" => 1,
                "arithmetic_mean_difference" => 2,
                _ => return Err("system_benchmark_evaluator_descriptor_operator_unknown".into()),
            };
            let operands = strings(&m["expression"]["operands"], count, |v| {
                ident(v, 64, b"_", true)
            })?;
            ensure(
                operands.len() == count
                    && operands
                        .iter()
                        .all(|s| array(&v["rawEventFields"]).contains(&Value::String(s.clone()))),
                "system_benchmark_evaluator_descriptor_operands_invalid",
            )?;
        }
        profiles.push(seal(
            "SystemBenchmarkEvaluatorDescriptor",
            v.clone(),
            "systemBenchmarkEvaluatorDescriptorHash",
        )?);
    }
    profiles.sort_by(|a, b| s(&a["benchmarkFamily"]).cmp(s(&b["benchmarkFamily"])));
    seal(
        "SystemBenchmarkEvaluatorRegistry",
        json!({"version":1,"kind":"SystemBenchmarkEvaluatorRegistry","profiles":profiles}),
        "systemBenchmarkEvaluatorRegistryHash",
    )
}
fn profile(v: &Value, evaluators: &Value, oracle_types: &Value) -> Result<Value> {
    ensure(
        exact(
            v,
            &[
                "benchmarkFamily",
                "executionAdapterId",
                "executionProfile",
                "fixtureEvaluatorId",
                "inferenceMode",
                "kind",
                "metricSpecs",
                "minimumRepetitions",
                "primaryMetric",
                "profileId",
                "requiredMetrics",
                "responseField",
                "secondaryMetric",
                "seedSchedule",
                "typedOracleKinds",
                "version",
            ],
        ) && v["version"] == 1
            && v["kind"] == "AutonomousEmpiricalFamilyPluginProfile",
        "autonomous_empirical_family_plugin_profile_shape_invalid",
    )?;
    let mut payload = v.clone();
    for key in [
        "benchmarkFamily",
        "profileId",
        "executionAdapterId",
        "fixtureEvaluatorId",
        "responseField",
        "primaryMetric",
        "secondaryMetric",
    ] {
        payload[key] = plugin_id(&v[key])?.into();
    }
    let parse_ids = |v: &Value, max: usize| -> Result<Vec<String>> {
        ensure(
            v.is_array() && !array(v).is_empty() && array(v).len() <= max,
            "autonomous_empirical_family_plugin_profile_invalid",
        )?;
        let a = array(v).iter().map(plugin_id).collect::<Result<Vec<_>>>()?;
        ensure(
            a.iter().collect::<BTreeSet<_>>().len() == a.len(),
            "autonomous_empirical_family_plugin_profile_invalid",
        )?;
        Ok(a)
    };
    let required = parse_ids(&v["requiredMetrics"], 64)?;
    let mut typed = parse_ids(&v["typedOracleKinds"], 32)?;
    typed.sort();
    let evaluator = array(&evaluators["profiles"])
        .iter()
        .find(|p| p["benchmarkFamily"] == payload["benchmarkFamily"])
        .ok_or("autonomous_empirical_family_plugin_profile_invalid")?;
    let expected: BTreeSet<_> = array(&evaluator["metrics"])
        .iter()
        .map(|v| s(&v["metric"]))
        .collect();
    let actual: BTreeSet<_> = required.iter().map(String::as_str).collect();
    let prod = payload["executionAdapterId"] == ADAPTER;
    let execution = &v["executionProfile"];
    ensure(
        required.contains(&s(&payload["primaryMetric"]).to_owned())
            && required.contains(&s(&payload["secondaryMetric"]).to_owned())
            && expected == actual
            && ["property-oracle-v1", "residual-bound-v1"]
                .iter()
                .all(|k| typed.iter().any(|v| v == k))
            && typed
                .iter()
                .all(|v| array(oracle_types).contains(&Value::String(v.clone())))
            && ["seed-cluster", "seed-repetition-cell"].contains(&s(&v["inferenceMode"]))
            && exact(execution, &["label", "language", "requiresGpu"])
            && ["python", "r"].contains(&s(&execution["language"]))
            && execution["label"] == execution["language"]
            && execution["requiresGpu"].is_boolean()
            && (!prod || execution["requiresGpu"] == false),
        "autonomous_empirical_family_plugin_profile_invalid",
    )?;
    let repetitions = integer(&v["minimumRepetitions"])
        .filter(|n| (1..=10000).contains(n))
        .ok_or("autonomous_empirical_family_plugin_profile_invalid")?;
    let seeds = array(&v["seedSchedule"])
        .iter()
        .map(integer)
        .collect::<Option<Vec<_>>>()
        .ok_or("autonomous_empirical_family_plugin_profile_invalid")?;
    ensure(
        !seeds.is_empty()
            && seeds.len() <= 1024
            && seeds.iter().collect::<BTreeSet<_>>().len() == seeds.len(),
        "autonomous_empirical_family_plugin_profile_invalid",
    )?;
    let specs = &v["metricSpecs"];
    ensure(
        specs.as_object().is_some_and(|o| {
            o.len() == required.len() && required.iter().all(|k| o.contains_key(k))
        }),
        "autonomous_empirical_family_plugin_profile_invalid",
    )?;
    let mut compiled_specs = json!({});
    for metric in &required {
        let spec = &specs[metric];
        let min =
            number(&spec["minimum"]).ok_or("autonomous_empirical_family_plugin_profile_invalid")?;
        let max =
            number(&spec["maximum"]).ok_or("autonomous_empirical_family_plugin_profile_invalid")?;
        ensure(
            exact(spec, &["direction", "minimum", "maximum", "unit"])
                && ["maximize", "minimize"].contains(&s(&spec["direction"]))
                && min <= max
                && min.abs() <= 1e15
                && max.abs() <= 1e15,
            "autonomous_empirical_family_plugin_profile_invalid",
        )?;
        let _ = plugin_id(&spec["unit"])?;
        compiled_specs[metric] = json!({"unit":spec["unit"],"direction":spec["direction"],"minimum":numeric_value(min),"maximum":numeric_value(max)});
    }
    payload["requiredMetrics"] = json!(required);
    payload["typedOracleKinds"] = json!(typed);
    payload["minimumRepetitions"] = repetitions.into();
    payload["seedSchedule"] = json!(seeds);
    payload["metricSpecs"] = compiled_specs;
    payload["evaluatorDescriptorHash"] =
        evaluator["systemBenchmarkEvaluatorDescriptorHash"].clone();
    payload["productionExecutable"] = prod.into();
    payload["runtimeRegistryMutationAllowed"] = false.into();
    seal(
        "AutonomousEmpiricalFamilyPluginProfile",
        payload,
        "autonomousEmpiricalFamilyPluginProfileHash",
    )
}
fn registry(profiles: &Value, evaluators: &Value, oracle_types: &Value) -> Result<Value> {
    ensure(
        profiles.is_array() && !array(profiles).is_empty() && array(profiles).len() <= 128,
        "autonomous_empirical_family_plugin_registry_input_invalid",
    )?;
    let mut values = array(profiles)
        .iter()
        .map(|v| profile(v, evaluators, oracle_types))
        .collect::<Result<Vec<_>>>()?;
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|_| Error("runtime_reproducibility_collation_unavailable".into()))?;
    values.sort_by(|a, b| collator.compare(s(&a["benchmarkFamily"]), s(&b["benchmarkFamily"])));
    ensure(
        values
            .iter()
            .map(|v| s(&v["profileId"]))
            .collect::<BTreeSet<_>>()
            .len()
            == values.len()
            && values
                .iter()
                .map(|v| s(&v["benchmarkFamily"]))
                .collect::<BTreeSet<_>>()
                .len()
                == values.len(),
        "autonomous_empirical_family_plugin_registry_duplicate",
    )?;
    seal(
        "AutonomousEmpiricalFamilyPluginRegistry",
        json!({"version":1,"kind":"AutonomousEmpiricalFamilyPluginRegistry","status":if values.iter().all(|v|v["productionExecutable"]==true){"autonomous_empirical_family_plugin_registry_ready"}else{"autonomous_empirical_family_plugin_registry_partial"},"evaluatorRegistryHash":evaluators["systemBenchmarkEvaluatorRegistryHash"],"profileCount":values.len(),"profiles":values,"runtimeRegistryMutationAllowed":false}),
        "autonomousEmpiricalFamilyPluginRegistryHash",
    )
}
fn abi(evaluators: &Value) -> Result<Value> {
    seal(
        "AutonomousEmpiricalFamilyPluginAbi",
        json!({"version":1,"kind":"AutonomousEmpiricalFamilyPluginAbi","profileContractVersion":1,"evaluatorRegistryHash":evaluators["systemBenchmarkEvaluatorRegistryHash"],"pinnedRuntimeLanguages":["python","r"],"productionExecutionAdapterIds":[ADAPTER],"dataOnly":true,"executablePayloadsAllowed":false,"runtimeRegistryMutationAllowed":false}),
        "autonomousEmpiricalFamilyPluginAbiHash",
    )
}
fn package(package_id: &Value, version: &Value, registry: &Value, abi: &Value) -> Result<Value> {
    let id = plugin_id(package_id)?;
    let ver = s(version);
    let (core, suffix) = ver
        .split_once('-')
        .map_or((ver, None), |(c, s)| (c, Some(s)));
    let nums: Vec<_> = core.split('.').collect();
    ensure(
        nums.len() == 3
            && nums
                .iter()
                .all(|n| !n.is_empty() && n.len() <= 4 && n.bytes().all(|b| b.is_ascii_digit()))
            && suffix.is_none_or(|s| {
                !s.is_empty()
                    && s.len() <= 64
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            }),
        "autonomous_empirical_family_plugin_package_invalid",
    )?;
    seal(
        "AutonomousEmpiricalFamilyPluginPackage",
        json!({"version":1,"kind":"AutonomousEmpiricalFamilyPluginPackage","packageId":id,"packageVersion":version,"pluginAbiHash":abi["autonomousEmpiricalFamilyPluginAbiHash"],"evaluatorRegistryHash":registry["evaluatorRegistryHash"],"registry":registry,"dataOnly":true,"executablePayloadsAllowed":false,"runtimeRegistryMutationAllowed":false}),
        "autonomousEmpiricalFamilyPluginPackageHash",
    )
}
fn trusted_key(v: &Value) -> Result<(VerifyingKey, String)> {
    let pem = s(&v["publicKeyPem"]);
    ensure(
        pem.len() <= 4096 && !pem.contains("PRIVATE KEY"),
        "immutable_signed_json_trust_key_invalid",
    )?;
    let body = pem
        .trim()
        .strip_prefix("-----BEGIN PUBLIC KEY-----")
        .and_then(|s| s.strip_suffix("-----END PUBLIC KEY-----"))
        .ok_or("immutable_signed_json_trust_key_invalid")?;
    let der = Base64::decode_vec(&body.split_ascii_whitespace().collect::<String>())
        .map_err(|_| Error("immutable_signed_json_trust_key_invalid".into()))?;
    ensure(
        der.len() == 44
            && der[..12]
                == [
                    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
                ],
        "immutable_signed_json_trust_key_not_ed25519",
    )?;
    let bytes: [u8; 32] = der[12..]
        .try_into()
        .map_err(|_| Error("immutable_signed_json_trust_key_invalid".into()))?;
    Ok((
        VerifyingKey::from_bytes(&bytes)
            .map_err(|_| Error("immutable_signed_json_trust_key_invalid".into()))?,
        digest(&der),
    ))
}
fn signatures(authority: &Value, trust: &Value, now: &str, builtin: bool) -> Result<Vec<Value>> {
    let now = instant(&now.into()).ok_or("immutable_signed_json_authority_time_window_invalid")?;
    let issued = instant(&authority["signedAt"])
        .ok_or("immutable_signed_json_authority_time_window_invalid")?;
    let expires = instant(&authority["expiresAt"])
        .ok_or("immutable_signed_json_authority_time_window_invalid")?;
    ensure(
        issued <= now
            && expires > now
            && expires > issued
            && (builtin || expires - issued <= 366 * 86_400_000),
        "immutable_signed_json_authority_time_window_invalid",
    )?;
    ensure(
        exact(trust, &["version", "kind", "keys"])
            && trust["version"] == 1
            && trust["kind"] == "AuthorityTrustStore"
            && !array(&trust["keys"]).is_empty()
            && array(&trust["keys"]).len() <= 256,
        "immutable_signed_json_trust_store_invalid",
    )?;
    let mut keys = Vec::new();
    let mut seen = BTreeSet::new();
    for key in array(&trust["keys"]) {
        ensure(
            key.as_object().is_some_and(|o| {
                o.keys().all(|k| {
                    [
                        "keyId",
                        "subjectId",
                        "algorithm",
                        "publicKeyPem",
                        "roles",
                        "status",
                        "effectiveFrom",
                        "expiresAt",
                        "revokedAt",
                    ]
                    .contains(&k.as_str())
                })
            }) && ident(&key["keyId"], 192, b"_.:-", false)
                && (key["subjectId"].is_null() || ident(&key["subjectId"], 192, b"_.:-", false))
                && seen.insert(s(&key["keyId"]))
                && key["algorithm"] == "ed25519"
                && key["status"] == "active",
            "immutable_signed_json_trust_key_invalid",
        )?;
        let _ = strings(&key["roles"], 32, |v| ident(v, 192, b"_.:-", false))?;
        keys.push((key, trusted_key(key)?));
    }
    let sigs = array(&authority["signatures"]);
    ensure(
        !sigs.is_empty() && sigs.len() <= 16,
        "immutable_signed_json_authority_signature_missing",
    )?;
    let payload = serde_json::to_vec(&without(authority, &["signature", "signatures"]))
        .map_err(|_| Error("runtime_reproducibility_json_invalid".into()))?;
    let mut verified = Vec::new();
    let mut seen = BTreeSet::new();
    for sig in sigs {
        ensure(
            exact(sig, &["algorithm", "keyId", "role", "value"])
                && sig["algorithm"] == "ed25519"
                && sig["role"] == "empirical_plugin_authority"
                && seen.insert(s(&sig["keyId"])),
            "immutable_signed_json_authority_signature_invalid",
        )?;
        let (record, (key, spki)) = keys
            .iter()
            .find(|(k, _)| k["keyId"] == sig["keyId"])
            .ok_or("immutable_signed_json_authority_signature_invalid")?;
        ensure(
            array(&record["roles"]).contains(&json!("empirical_plugin_authority")),
            "immutable_signed_json_authority_signature_invalid",
        )?;
        for (field, before) in [
            ("effectiveFrom", true),
            ("expiresAt", false),
            ("revokedAt", false),
        ] {
            if !record[field].is_null() {
                let time =
                    instant(&record[field]).ok_or("immutable_signed_json_trust_key_invalid")?;
                ensure(
                    if before {
                        issued >= time
                    } else {
                        issued < time
                    },
                    "immutable_signed_json_trust_key_outside_window",
                )?;
            }
        }
        let bytes = Base64::decode_vec(s(&sig["value"]))
            .map_err(|_| Error("immutable_signed_json_authority_signature_invalid".into()))?;
        ensure(
            bytes.len() == 64 && Base64::encode_string(&bytes) == s(&sig["value"]),
            "immutable_signed_json_authority_signature_invalid",
        )?;
        let signature = Signature::from_slice(&bytes)
            .map_err(|_| Error("immutable_signed_json_authority_signature_invalid".into()))?;
        key.verify_strict(&payload, &signature)
            .map_err(|_| Error("immutable_signed_json_authority_signature_invalid".into()))?;
        verified.push(json!({"keyId":record["keyId"],"subjectId":if s(&record["subjectId"]).is_empty(){record["keyId"].clone()}else{record["subjectId"].clone()},"publicKeySpkiHash":spki}));
    }
    Ok(verified)
}
fn verify_bundle(
    bundle: &Value,
    trust: &Value,
    now: &str,
    builtin: bool,
    evaluators: &Value,
    oracle_types: &Value,
) -> Result<PluginAuthority> {
    ensure(
        exact(bundle, &["authority", "kind", "package", "version"])
            && bundle["version"] == 1
            && bundle["kind"] == "AutonomousEmpiricalFamilyPluginSignedBundle",
        "autonomous_empirical_family_plugin_signed_bundle_invalid",
    )?;
    let supplied = &bundle["package"];
    let compiled = array(&supplied["registry"]["profiles"]);
    let raw_profiles: Vec<_> = compiled
        .iter()
        .map(|p| {
            without(
                p,
                &[
                    "autonomousEmpiricalFamilyPluginProfileHash",
                    "evaluatorDescriptorHash",
                    "productionExecutable",
                    "runtimeRegistryMutationAllowed",
                ],
            )
        })
        .collect();
    let registry = registry(&json!(raw_profiles), evaluators, oracle_types)?;
    let package = package(
        &supplied["packageId"],
        &supplied["packageVersion"],
        &registry,
        &abi(evaluators)?,
    )?;
    ensure(
        package == *supplied,
        "autonomous_empirical_family_plugin_package_invalid",
    )?;
    let authority = &bundle["authority"];
    ensure(
        exact(
            authority,
            &[
                "evaluatorRegistryHash",
                "expiresAt",
                "kind",
                "packageHash",
                "packageId",
                "packageVersion",
                "pluginAbiHash",
                "signatures",
                "signedAt",
                "version",
            ],
        ) && authority["version"] == 1
            && authority["kind"] == "AutonomousEmpiricalFamilyPluginPackageAuthority"
            && [
                "packageId",
                "packageVersion",
                "pluginAbiHash",
                "evaluatorRegistryHash",
            ]
            .iter()
            .all(|k| authority[*k] == package[*k])
            && authority["packageHash"] == package["autonomousEmpiricalFamilyPluginPackageHash"],
        "autonomous_empirical_family_plugin_signed_bundle_invalid",
    )?;
    let signed = signatures(authority, trust, now, builtin)?;
    let advanced: Vec<_> = array(oracle_types)
        .iter()
        .filter(|v| !["property-oracle-v1", "residual-bound-v1"].contains(&s(v)))
        .cloned()
        .collect();
    let production: Vec<_> = array(&registry["profiles"])
        .iter()
        .filter(|v| v["productionExecutable"] == true)
        .collect();
    let mut families: Vec<_> = production
        .iter()
        .filter(|p| {
            advanced
                .iter()
                .all(|k| array(&p["typedOracleKinds"]).contains(k))
        })
        .map(|p| p["benchmarkFamily"].clone())
        .collect();
    families.sort_by(|a, b| s(a).cmp(s(b)));
    let sorted = |key: &str| {
        let mut values: Vec<_> = signed.iter().map(|v| v[key].clone()).collect();
        values.sort_by(|a, b| s(a).cmp(s(b)));
        values
    };
    let startup = seal(
        "AutonomousEmpiricalFamilyPluginStartupInspection",
        json!({"version":1,"kind":"AutonomousEmpiricalFamilyPluginStartupInspection","status":"autonomous_empirical_family_plugin_startup_ready","source":if builtin{"repository-builtin-signed-bundle-v1"}else{"external-startup-signed-bundle-v1"},"packageId":package["packageId"],"packageVersion":package["packageVersion"],"packageHash":package["autonomousEmpiricalFamilyPluginPackageHash"],"pluginAbiHash":package["pluginAbiHash"],"evaluatorRegistryHash":package["evaluatorRegistryHash"],"registryHash":registry["autonomousEmpiricalFamilyPluginRegistryHash"],"signatureVerified":true,"signerKeyIds":sorted("keyId"),"signerSubjectIds":sorted("subjectId"),"signerPublicKeySpkiHashes":sorted("publicKeySpkiHash"),"signedAt":authority["signedAt"],"expiresAt":authority["expiresAt"],"advancedTypedNumericOracleKinds":advanced,"advancedNumericalAnalysisFamilies":families,"allProductionProfilesAdvancedNumericalAnalysisCovered":!production.is_empty()&&families.len()==production.len(),"dataOnly":true,"executablePayloadsAllowed":false,"runtimeRegistryMutationAllowed":false,"reloadAllowed":false}),
        "autonomousEmpiricalFamilyPluginStartupInspectionHash",
    )?;
    let scope =
        runtime_image_reproducibility_active_plugin_scope_v1(&package, &registry, &startup)?;
    Ok(PluginAuthority {
        package,
        registry,
        startup_inspection: startup,
        scope,
    })
}
/// Resolve builtin or external startup authority using the same complete native
/// compiler and actual Ed25519 verification. Neither cached output nor a caller's
/// asserted startup inspection can establish this authority.
pub fn resolve_runtime_image_plugin_authority_v1(
    environment: &Value,
    now: &str,
) -> Result<PluginAuthority> {
    let source = raw()?;
    let evaluators = evaluator(&source["descriptors"])?;
    let bundle = s(&environment["HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE"]).trim();
    let trust = s(&environment["HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE"]).trim();
    if !bundle.is_empty() || !trust.is_empty() {
        ensure(
            !bundle.is_empty() && !trust.is_empty(),
            "immutable_signed_json_bundle_configuration_incomplete",
        )?;
        return verify_bundle(
            &parse(&read(Path::new(bundle), 4 * 1024 * 1024)?)?,
            &parse(&read(Path::new(trust), 1024 * 1024)?)?,
            now,
            false,
            &evaluators,
            &source["oracleTypes"],
        );
    }
    let registry = registry(&source["profiles"], &evaluators, &source["oracleTypes"])?;
    let package = package(
        &json!("hepta.repository-builtin-empirical-families"),
        &json!("1.0.0"),
        &registry,
        &abi(&evaluators)?,
    )?;
    let authority = json!({"version":1,"kind":"AutonomousEmpiricalFamilyPluginPackageAuthority","packageId":package["packageId"],"packageVersion":package["packageVersion"],"packageHash":package["autonomousEmpiricalFamilyPluginPackageHash"],"pluginAbiHash":package["pluginAbiHash"],"evaluatorRegistryHash":package["evaluatorRegistryHash"],"signedAt":"2026-01-01T00:00:00.000Z","expiresAt":"2100-01-01T00:00:00.000Z","signatures":[{"keyId":"hepta-repository-empirical-plugin-root-2026-v2","role":"empirical_plugin_authority","algorithm":"ed25519","value":"fgs1QnNZWJh2Uv6QPagiX3HkRtrdNRlAjeLVipyTvsZFO+SlGQPGTUjlsfcEI6gYAe/kzYMvds+W5xy93CNIDg=="}]});
    let trust = json!({"version":1,"kind":"AuthorityTrustStore","keys":[{"keyId":"hepta-repository-empirical-plugin-root-2026-v2","subjectId":"hepta-repository-release-authority","algorithm":"ed25519","publicKeyPem":"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEASGAZgPKZB0eA5vgsTYem0plLa6SLbzjvvaw9+Yy8Sr0=\n-----END PUBLIC KEY-----\n","roles":["empirical_plugin_authority"],"status":"active"}]});
    verify_bundle(
        &json!({"version":1,"kind":"AutonomousEmpiricalFamilyPluginSignedBundle","package":package,"authority":authority}),
        &trust,
        now,
        true,
        &evaluators,
        &source["oracleTypes"],
    )
}
/// Check embedded raw data's recorded source provenance during migration. The
/// builtin signature additionally binds every recompiled profile at runtime.
pub fn verify_runtime_image_builtin_plugin_source_binding_v1(root: &Path) -> Result<()> {
    let source = raw()?;
    let hashes = source["sourceHashes"]
        .as_object()
        .ok_or("runtime_reproducibility_builtin_source_invalid")?;
    for (path, expected) in hashes {
        ensure(
            digest(&read_source(&root.join(path), 4 * 1024 * 1024)?) == s(expected),
            "runtime_reproducibility_builtin_source_drift",
        )?;
    }
    Ok(())
}
