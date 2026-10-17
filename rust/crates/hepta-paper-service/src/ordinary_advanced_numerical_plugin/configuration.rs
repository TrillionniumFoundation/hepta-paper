use super::*;
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::MetadataExt, path::Component};
pub(super) struct Failure {
    pub code: String,
    pub path: Option<PathBuf>,
}
impl Failure {
    pub(super) fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            path: None,
        }
    }
}
impl From<String> for Failure {
    fn from(v: String) -> Self {
        Self::new(v)
    }
}
impl From<&str> for Failure {
    fn from(v: &str) -> Self {
        Self::new(v)
    }
}
pub(super) fn resolve(root: &Path, raw: &str) -> Result<PathBuf, String> {
    if raw.len() > 4096 {
        return Err("advanced_numerical_plugin_path_limit_exceeded".into());
    }
    let input = Path::new(raw);
    let absolute = if input.is_absolute() {
        input.to_owned()
    } else {
        root.join(input)
    };
    let mut path = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                path.pop();
            }
            v => path.push(v.as_os_str()),
        }
    }
    Ok(path)
}
struct Document {
    raw: Json,
    value: Value,
    hash: String,
}
fn read(
    source: &mut StatusInputs<'_>,
    path: &Path,
    limit: u64,
    c: &AtomicBool,
    d: Instant,
) -> Result<Document, Failure> {
    check(c, d)?;
    let meta = source
        .probe(path)
        .map_err(|_| Failure::new("advanced_numerical_plugin_document_integrity_invalid"))?;
    let Some(meta) = meta else {
        return Err(Failure {
            code: "advanced_numerical_plugin_document_missing".into(),
            path: Some(path.to_owned()),
        });
    };
    if meta.directory
        || meta.link_count != 1
        || meta.mode & 0o022 != 0
        || meta.size < 2
        || meta.size > limit
    {
        return Err("advanced_numerical_plugin_document_integrity_invalid".into());
    }
    let named = fs::symlink_metadata(path)
        .map_err(|_| Failure::new("advanced_numerical_plugin_document_integrity_invalid"))?;
    let uid = nix::unistd::geteuid().as_raw();
    if named.uid() != 0 && named.uid() != uid {
        return Err("advanced_numerical_plugin_document_owner_invalid".into());
    }
    source.assert_current()?;
    let bytes = source.document(path, limit)?;
    check(c, d)?;
    let raw = parse_production_json_v1(&bytes)
        .map_err(|_| Failure::new("advanced_numerical_plugin_document_json_invalid"))?;
    let v = value(&raw, c)
        .map_err(|_| Failure::new("advanced_numerical_plugin_document_json_invalid"))?;
    if !v.is_object() {
        return Err("advanced_numerical_plugin_document_json_invalid".into());
    }
    source.assert_current()?;
    Ok(Document {
        raw,
        value: v,
        hash: format!("sha256:{:x}", Sha256::digest(&bytes)),
    })
}
fn configured(base: &Path, v: &Value) -> Result<PathBuf, Failure> {
    let raw = v
        .as_str()
        .ok_or("advanced_numerical_plugin_configuration_path_domain_v1_unaccepted")?;
    let raw = crate::automation_runtime_reconciliation::sqlite_number::trim(raw);
    if raw.is_empty() {
        return Err("advanced_numerical_plugin_configuration_path_required".into());
    }
    resolve(base, raw).map_err(Failure::new)
}
pub(super) struct Prepared {
    pub descriptor: Value,
    pub descriptor_raw: Json,
    pub plugin_root: PathBuf,
    pub output_root: PathBuf,
    pub report: Json,
    pub authority: Value,
    pub trust: Value,
    pub qualification: Option<qualification::QualificationInputs>,
}
pub(super) fn inspect(
    source: &mut StatusInputs<'_>,
    path: &Path,
    c: &AtomicBool,
    d: Instant,
) -> Result<Prepared, Failure> {
    let config = read(source, path, 4 * 1024 * 1024, c, d)?;
    const V1_KEYS: &[&str] = &[
        "kind",
        "outputRoot",
        "pluginRoot",
        "signedBundlePath",
        "trustStorePath",
        "version",
    ];
    const V2_KEYS: &[&str] = &[
        "kind",
        "outputRoot",
        "pluginRoot",
        "qualificationEvidenceFileHash",
        "qualificationEvidencePath",
        "qualificationFileHash",
        "qualificationPath",
        "qualificationTrustStoreFileHash",
        "qualificationTrustStorePath",
        "signedBundleFileHash",
        "signedBundlePath",
        "trustStoreFileHash",
        "trustStorePath",
        "version",
    ];
    const GPU_KEYS: &[&str] = &[
        "containerExecutable",
        "containerImage",
        "containerImageDigest",
        "cpuFallbackPolicy",
        "gpuDeviceIsolationScope",
        "gpuDeviceSelector",
        "gpuMemoryLimitBytes",
        "gpuMemoryLimitEnforced",
        "gpuMemoryLimitScope",
        "requiresGpu",
        "runtimeProfile",
    ];
    let version_two = config.value["version"] == 2;
    let mut all_gpu_keys = V2_KEYS.to_vec();
    all_gpu_keys.extend_from_slice(GPU_KEYS);
    let gpu_configuration = version_two && exact(&config.value, &all_gpu_keys);
    if config.value["kind"] != "AdvancedNumericalPluginRuntimeConfiguration"
        || !(config.value["version"] == 1 && exact(&config.value, V1_KEYS)
            || version_two && (exact(&config.value, V2_KEYS) || gpu_configuration))
    {
        return Err("advanced_numerical_plugin_runtime_configuration_invalid".into());
    }
    if version_two {
        for key in V2_KEYS.iter().filter(|k| k.ends_with("FileHash")) {
            configured_hash(&config.value[*key])?;
        }
    }
    let base = path
        .parent()
        .ok_or("advanced_numerical_plugin_configuration_path_required")?;
    let plugin_root = configured(base, &config.value["pluginRoot"])?;
    let output_root = configured(base, &config.value["outputRoot"])?;
    let bundle = read(
        source,
        &configured(base, &config.value["signedBundlePath"])?,
        4 * 1024 * 1024,
        c,
        d,
    )?;
    let trust = read(
        source,
        &configured(base, &config.value["trustStorePath"])?,
        1024 * 1024,
        c,
        d,
    )?;
    if version_two {
        check_hash(&bundle, &config.value["signedBundleFileHash"])?;
        check_hash(&trust, &config.value["trustStoreFileHash"])?;
    }
    let qualification_documents = if version_two {
        Some((
            dependency(
                source,
                base,
                &config.value,
                "qualification",
                4 * 1024 * 1024,
                c,
                d,
            )?,
            dependency(
                source,
                base,
                &config.value,
                "qualificationEvidence",
                4 * 1024 * 1024,
                c,
                d,
            )?,
            dependency(
                source,
                base,
                &config.value,
                "qualificationTrustStore",
                1024 * 1024,
                c,
                d,
            )?,
        ))
    } else {
        None
    };
    let descriptor_gpu = bundle.value["descriptor"]["version"] == 2;
    if descriptor_gpu && !version_two {
        return Err("advanced_numerical_plugin_gpu_configuration_v2_required".into());
    }
    if !descriptor_gpu && gpu_configuration {
        return Err("advanced_numerical_plugin_gpu_configuration_descriptor_mismatch".into());
    }
    let descriptor =
        descriptor::inspect(field(&bundle.raw, "descriptor"), c, d).map_err(|error| {
            Failure::new(if descriptor_gpu {
                "advanced_numerical_plugin_configuration_descriptor_invalid".to_owned()
            } else {
                error
            })
        })?;
    let gpu_authority = if descriptor_gpu {
        if !gpu_configuration {
            return Err("advanced_numerical_plugin_gpu_configuration_v2_required".into());
        }
        let authority = descriptor::gpu_authority_v2(&descriptor, c, d)?;
        let authority_value = value(&authority, c)?;
        if GPU_KEYS
            .iter()
            .any(|key| config.value[*key] != authority_value[*key])
        {
            return Err("advanced_numerical_plugin_gpu_configuration_binding_invalid".into());
        }
        Some(authority)
    } else {
        None
    };
    let authority = &bundle.value["authority"];
    if bundle.value["version"] != 1
        || bundle.value["kind"] != "AdvancedNumericalPluginSignedBundle"
        || authority["version"] != 1
        || authority["kind"] != "AdvancedNumericalPluginAuthority"
        || authority["pluginId"] != descriptor["pluginId"]
        || authority["pluginVersion"] != descriptor["pluginVersion"]
        || authority["descriptorHash"] != descriptor["advancedNumericalPluginDescriptorHash"]
    {
        return Err("advanced_numerical_plugin_signed_bundle_invalid".into());
    }
    if !exact(
        authority,
        &[
            "version",
            "kind",
            "pluginId",
            "pluginVersion",
            "descriptorHash",
            "signedAt",
            "expiresAt",
            "signatures",
        ],
    ) {
        return Err("advanced_numerical_plugin_authority_data_domain_v1_unaccepted".into());
    }
    crate::native_business::local_submission_preflight::local_submission_values_budget_v1([
        &bundle.value,
        &trust.value,
    ])?;
    crate::runtime_image_reproducibility::numerical_plugin_signatures_v1(
        authority,
        &trust.value,
        c,
        d,
    )
    .map_err(|e| Failure::new(e.to_string()))?;
    let bundle_hash = hash("AdvancedNumericalPluginSignedBundle", &bundle.raw, c)?;
    let qualification_inputs = if let Some((statement, evidence, qualification_trust)) =
        qualification_documents
    {
        // Reserve the complete observed request before the small borrowed
        // descriptor/plugin projections and before signature payload cloning.
        crate::native_business::local_submission_preflight::local_submission_values_budget_v1([
            &bundle.value,
            &trust.value,
            &statement.value,
            &evidence.value,
            &qualification_trust.value,
        ])?;
        Some(qualification::QualificationInputs {
            descriptor: descriptor.clone(),
            bundle_hash: bundle_hash.clone(),
            plugin_authority: authority.clone(),
            plugin_trust: trust.value.clone(),
            statement: statement.value,
            evidence: evidence.value,
            trust: qualification_trust.value,
        })
    } else {
        None
    };
    let qualified = qualification_inputs
        .as_ref()
        .map(|q| q.inspect(c, d))
        .transpose()?;
    // Original runner construction probes its real sandbox before local entrypoints.
    let availability = sandbox::inspect(source, c, d)?;
    for root in [&plugin_root, &output_root] {
        if !source.directory(root)? {
            return Err("advanced_numerical_plugin_local_identity_invalid".into());
        }
    }
    let relative = descriptor["entrypoint"]["relativePath"]
        .as_str()
        .ok_or("advanced_numerical_plugin_signed_bundle_invalid")?;
    let entry = resolve(&plugin_root, relative)?;
    if !entry.starts_with(&plugin_root) {
        return Err("advanced_numerical_plugin_local_identity_invalid".into());
    }
    let observed = source
        .archive(&entry, 4 * 1024 * 1024)
        .map_err(|_| Failure::new("advanced_numerical_plugin_local_identity_invalid"))?;
    if observed.0 != descriptor["entrypoint"]["sha256"] {
        return Err("advanced_numerical_plugin_local_identity_invalid".into());
    }
    let available = field(&availability, "available");
    let available = matches!(available, Json::Bool(true));
    let status = if available {
        if qualified.is_some() {
            "advanced_numerical_plugin_runner_ready_qualified"
        } else {
            "advanced_numerical_plugin_runner_unqualified"
        }
    } else {
        "advanced_numerical_plugin_runner_blocked"
    };
    let blockers = Json::Array(if available && qualified.is_none() {
        vec![text(
            "advanced_numerical_plugin_production_qualification_required",
        )]
    } else {
        vec![]
    });
    let mut capabilities = object([
        ("version", Json::Number(1.0)),
        ("kind", text("AdvancedNumericalPluginRunnerCapabilities")),
        ("analysisFamilies", descriptor::families()),
        ("outOfProcess", Json::Bool(true)),
        ("signedPlugins", Json::Bool(true)),
        ("resourceLimits", Json::Bool(true)),
        ("networkPolicy", text("none")),
        ("productionQualified", Json::Bool(false)),
        (
            "runtimeProfile",
            json_value(&descriptor["runtime"]["runtimeProfile"])?,
        ),
        ("requiresGpu", Json::Bool(descriptor_gpu)),
        (
            "gpuRuntimeAuthorityHash",
            gpu_authority.as_ref().map_or(Json::Null, |a| {
                field(a, "advancedNumericalGpuRuntimeAuthorityHash").clone()
            }),
        ),
        ("qualifiedAnalysisFamilies", Json::Array(vec![])),
        ("qualificationStatementHash", Json::Null),
        ("qualificationEvidenceBundleHash", Json::Null),
        ("qualificationInspectionHash", Json::Null),
        ("pluginAuthoritySubjectIds", Json::Array(vec![])),
        ("pluginAuthorityOrganizations", Json::Array(vec![])),
        ("pluginAuthorityPublicKeySpkiHashes", Json::Array(vec![])),
        ("qualificationAuthoritySubjectIds", Json::Array(vec![])),
        ("qualificationAuthorityOrganizations", Json::Array(vec![])),
        (
            "qualificationAuthorityPublicKeySpkiHashes",
            Json::Array(vec![]),
        ),
        ("qualificationAuthorityRoles", Json::Array(vec![])),
        ("evidenceReceiptHashes", object([])),
        ("qualificationExpiresAt", Json::Null),
        ("referenceExecutionProcessIdentityHash", Json::Null),
        ("replayExecutionProcessIdentityHash", Json::Null),
        ("qualificationResultHash", Json::Null),
        (
            "qualificationRequirement",
            text("signed-reference-replay-oracle-uncertainty-and-scientific-evidence-required"),
        ),
    ]);
    if let Some(qualification) = &qualified {
        replace(&mut capabilities, "productionQualified", Json::Bool(true))?;
        replace(
            &mut capabilities,
            "qualifiedAnalysisFamilies",
            Json::Array(vec![json_value(&descriptor["analysisFamily"])?]),
        )?;
        for (target, source) in [
            ("qualificationStatementHash", "qualificationStatementHash"),
            (
                "qualificationEvidenceBundleHash",
                "qualificationEvidenceBundleHash",
            ),
            (
                "qualificationInspectionHash",
                "advancedNumericalPluginProductionQualificationInspectionHash",
            ),
            ("pluginAuthoritySubjectIds", "pluginAuthoritySubjectIds"),
            (
                "pluginAuthorityOrganizations",
                "pluginAuthorityOrganizations",
            ),
            (
                "pluginAuthorityPublicKeySpkiHashes",
                "pluginAuthorityPublicKeySpkiHashes",
            ),
            (
                "qualificationAuthoritySubjectIds",
                "qualificationAuthoritySubjectIds",
            ),
            (
                "qualificationAuthorityOrganizations",
                "qualificationAuthorityOrganizations",
            ),
            (
                "qualificationAuthorityPublicKeySpkiHashes",
                "qualificationAuthorityPublicKeySpkiHashes",
            ),
            ("qualificationAuthorityRoles", "qualificationAuthorityRoles"),
            ("evidenceReceiptHashes", "evidenceReceiptHashes"),
            ("qualificationExpiresAt", "expiresAt"),
            (
                "referenceExecutionProcessIdentityHash",
                "referenceExecutionProcessIdentityHash",
            ),
            (
                "replayExecutionProcessIdentityHash",
                "replayExecutionProcessIdentityHash",
            ),
            ("qualificationResultHash", "resultHash"),
        ] {
            replace(
                &mut capabilities,
                target,
                field(qualification, source).clone(),
            )?;
        }
        replace(&mut capabilities, "qualificationRequirement", Json::Null)?;
    }
    let mut dependency_hashes = object([
        ("signedBundleFileHash", text(&bundle.hash)),
        ("trustStoreFileHash", text(&trust.hash)),
    ]);
    if version_two {
        let Json::Object(ref mut values) = dependency_hashes else {
            return Err("advanced_numerical_plugin_configuration_invalid".into());
        };
        for key in [
            "qualificationFileHash",
            "qualificationEvidenceFileHash",
            "qualificationTrustStoreFileHash",
        ] {
            values.push((
                key.encode_utf16().collect(),
                text(&configured_hash(&config.value[key])?),
            ));
        }
    }
    let report = object([
        ("version", Json::Number(1.0)),
        ("kind", text("AdvancedNumericalPluginRuntimeInspection")),
        ("status", text(status)),
        ("pluginId", json_value(&descriptor["pluginId"])?),
        ("analysisFamily", json_value(&descriptor["analysisFamily"])?),
        (
            "descriptorHash",
            json_value(&descriptor["advancedNumericalPluginDescriptorHash"])?,
        ),
        ("signedBundleHash", text(&bundle_hash)),
        ("sandboxAvailability", availability),
        ("capabilities", capabilities),
        ("productionQualified", Json::Bool(qualified.is_some())),
        ("blockers", blockers),
        (
            "runtimeConfiguration",
            object([
                ("version", Json::Number(if version_two { 2.0 } else { 1.0 })),
                ("configurationHash", text(&config.hash)),
                ("configurationPinned", Json::Bool(false)),
                ("dependentDocumentsPinned", Json::Bool(version_two)),
                ("dependencyFileHashes", dependency_hashes),
            ]),
        ),
    ]);
    source.assert_current()?;
    check(c, d)?;
    let mut data = bundle.value;
    let authority = data
        .as_object_mut()
        .and_then(|o| o.remove("authority"))
        .ok_or("advanced_numerical_plugin_signed_bundle_invalid")?;
    Ok(Prepared {
        descriptor,
        descriptor_raw: field(&bundle.raw, "descriptor").clone(),
        plugin_root,
        output_root,
        report,
        authority,
        trust: trust.value,
        qualification: qualification_inputs,
    })
}

fn configured_hash(v: &Value) -> Result<String, Failure> {
    let normalized = v
        .as_str()
        .map(str::to_lowercase)
        .ok_or("advanced_numerical_plugin_configuration_file_hash_invalid")?;
    if !sha(&normalized) {
        return Err("advanced_numerical_plugin_configuration_file_hash_invalid".into());
    }
    Ok(normalized)
}
fn check_hash(doc: &Document, v: &Value) -> Result<(), Failure> {
    if doc.hash != configured_hash(v)? {
        return Err("advanced_numerical_plugin_document_hash_mismatch".into());
    }
    Ok(())
}
fn dependency(
    source: &mut StatusInputs<'_>,
    base: &Path,
    config: &Value,
    name: &str,
    max: u64,
    c: &AtomicBool,
    d: Instant,
) -> Result<Document, Failure> {
    let doc = read(
        source,
        &configured(base, &config[format!("{name}Path")])?,
        max,
        c,
        d,
    )?;
    check_hash(&doc, &config[format!("{name}FileHash")])?;
    Ok(doc)
}
fn replace(v: &mut Json, key: &str, value: Json) -> Result<(), Failure> {
    let Json::Object(fields) = v else {
        return Err("advanced_numerical_plugin_configuration_invalid".into());
    };
    let field = fields
        .iter_mut()
        .find(|(k, _)| k.iter().copied().eq(key.encode_utf16()))
        .ok_or("advanced_numerical_plugin_configuration_invalid")?;
    field.1 = value;
    Ok(())
}

pub(super) fn read_cpu_request_v1(
    source: &mut StatusInputs<'_>,
    path: &Path,
    c: &AtomicBool,
    d: Instant,
) -> Result<Json, Failure> {
    Ok(read(source, path, 64 * 1024, c, d)?.raw)
}
