//! Read-only verifier for content-pinned nested-container qualification,
//! current-Pod startup conformance, and independent authority attestations.
//!
//! No provider, Kubernetes, key generation, network, or write operation occurs.
//! `ready` means the supplied package verified against the caller's pinned trust
//! inputs and explicit clock; it does not grant production activation.

mod authority;
mod subjects;
mod support;

use serde_json::{Value, json};
use support::*;
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{0}")]
pub struct NestedRuntimeQualificationError(String);
impl From<&str> for NestedRuntimeQualificationError {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}
type Result<T> = std::result::Result<T, NestedRuntimeQualificationError>;
const REPORT: &str = "NestedRuntimePlatformQualificationVerificationReport";

struct Loaded {
    config: Value,
    config_hash: String,
    trust: authority::Trust,
    trust_content_hash: String,
    bundles: [Value; 3],
    bundle_hashes: [String; 3],
}
fn load(request: &Value) -> Result<Loaded> {
    ensure(
        id(&request["profileId"])
            && id(&request["runtimeClassName"])
            && sha(&request["planHash"])
            && [
                "parentPodCpuMillis",
                "parentPodMemoryBytes",
                "parentPodPids",
            ]
            .iter()
            .all(|k| positive(&request[*k])),
        "nested_runtime_platform_current_binding_invalid",
    )?;
    ensure(
        sha(&request["expectedConfigContentHash"]),
        "nested_runtime_platform_configuration_content_hash_missing",
    )?;
    let cwd = std::env::current_dir().map_err(|_| {
        NestedRuntimeQualificationError::from("nested_runtime_platform_evidence_path_not_canonical")
    })?;
    let path = resolve(&cwd, &request["configPath"])?;
    let (config, config_hash) = read_json(&path, 256 * 1024)?;
    ensure(
        request["expectedConfigContentHash"] == config_hash,
        "nested_runtime_platform_configuration_content_hash_mismatch",
    )?;
    authority::configuration(&config)?;
    for (request_key, config_key, field, hashed) in [
        (
            "qualificationKeyId",
            "qualificationAuthority",
            "keyIds",
            false,
        ),
        (
            "qualificationSubjectId",
            "qualificationAuthority",
            "subjectIds",
            false,
        ),
        (
            "qualificationPublicKeySpkiHash",
            "qualificationAuthority",
            "publicKeySpkiHashes",
            true,
        ),
        ("conformanceKeyId", "conformanceAuthority", "keyIds", false),
        (
            "conformanceSubjectId",
            "conformanceAuthority",
            "subjectIds",
            false,
        ),
        (
            "conformancePublicKeySpkiHash",
            "conformanceAuthority",
            "publicKeySpkiHashes",
            true,
        ),
    ] {
        ensure(
            request[request_key] == config[config_key][field][0]
                && if hashed {
                    sha(&request[request_key])
                } else {
                    id(&request[request_key])
                },
            "nested_runtime_platform_deployment_authority_binding_mismatch",
        )?;
    }
    let base = path.parent().unwrap_or(std::path::Path::new("/"));
    let (trust_value, trust_content_hash) =
        read_json(&resolve(base, &config["trustStorePath"])?, 1024 * 1024)?;
    ensure(
        config["expectedTrustStoreContentHash"] == trust_content_hash,
        "nested_runtime_platform_trust_store_content_hash_mismatch",
    )?;
    let trust = authority::trust(&trust_value)?;
    ensure(
        config["expectedTrustStoreHash"] == trust.hash,
        "nested_runtime_platform_trust_store_identity_mismatch",
    )?;
    for field in authority::AUTHORITY_FIELDS {
        authority::binding(&trust, &config[field])?;
    }
    let mut bundles = Vec::new();
    let mut hashes = Vec::new();
    for (path_field, hash_field, kind) in [
        (
            "qualificationBundlePath",
            "expectedQualificationBundleContentHash",
            "NestedRuntimePlatformQualificationBundle",
        ),
        (
            "conformanceBundlePath",
            "expectedConformanceBundleContentHash",
            "NestedRuntimeStartupConformanceBundle",
        ),
        (
            "authorityIndependenceBundlePath",
            "expectedAuthorityIndependenceBundleContentHash",
            "NestedRuntimeAuthorityIndependenceBundle",
        ),
    ] {
        ensure(
            sha(&request[hash_field]),
            "nested_runtime_platform_bundle_content_hash_missing",
        )?;
        let (value, digest) = read_json(&resolve(base, &config[path_field])?, 4 * 1024 * 1024)?;
        ensure(
            request[hash_field] == digest,
            "nested_runtime_platform_bundle_content_hash_mismatch",
        )?;
        ensure(
            exact(&value, &["envelope", "kind", "subject", "version"])
                && value["version"] == 1
                && value["kind"] == kind,
            "nested_runtime_platform_bundle_invalid",
        )?;
        bundles.push(value);
        hashes.push(digest);
    }
    Ok(Loaded {
        config,
        config_hash,
        trust,
        trust_content_hash,
        bundles: bundles.try_into().map_err(|_| {
            NestedRuntimeQualificationError::from("nested_runtime_platform_bundle_set_invalid")
        })?,
        bundle_hashes: hashes.try_into().map_err(|_| {
            NestedRuntimeQualificationError::from("nested_runtime_platform_bundle_set_invalid")
        })?,
    })
}
fn finish(mut report: Value) -> Result<Value> {
    let h = hash(REPORT, &report)?;
    report["nestedRuntimePlatformQualificationVerificationReportHash"] = h.into();
    Ok(report)
}
fn blocked(now: &Value, blockers: Vec<String>, observations: Option<Value>) -> Result<Value> {
    let mut report = json!({"version":1,"kind":REPORT,"status":"nested_runtime_platform_qualification_blocked","ready":false,"cryptographicAuthorityReady":false,"externallyQualified":false,"startupConformanceReady":false,"authorityIndependenceReady":false,"verifiedAt":now,"externalActionPerformed":false,"blockers":unique(blockers)});
    if let Some(Value::Object(o)) = observations {
        report
            .as_object_mut()
            .ok_or("nested_runtime_platform_report_shape_invalid")?
            .extend(o);
    }
    finish(report)
}

/// Read a bounded, duplicate-free JSON request from a canonical absolute path.
/// The same descriptor-relative, no-symlink, single-link and mode checks used
/// for evidence files apply before the request can select any evidence paths.
pub fn verify_nested_runtime_platform_qualification_file_v1(
    path: &std::path::Path,
) -> Result<Value> {
    ensure(
        path.is_absolute() && path.to_str().is_some(),
        "nested_runtime_platform_request_path_invalid",
    )?;
    let normalized = resolve(
        std::path::Path::new("/"),
        &Value::String(
            path.to_str()
                .ok_or("nested_runtime_platform_request_path_invalid")?
                .to_owned(),
        ),
    )?;
    ensure(
        normalized.as_os_str() == path.as_os_str(),
        "nested_runtime_platform_request_path_invalid",
    )?;
    let (request, _) = read_json(&normalized, 256 * 1024)?;
    verify_nested_runtime_platform_qualification_v1(&request)
}

/// Verify one closed camelCase request mirroring the Node verifier options.
/// `now` must be a canonical millisecond UTC instant. Numeric resource limits
/// follow the original Node `Number(...)` conversion and safe-positive-integer bound.
/// Missing/invalid evidence returns a hashed blocked report; malformed request
/// shape or clock returns an error. File reads reject aliases and duplicate keys.
pub fn verify_nested_runtime_platform_qualification_v1(input: &Value) -> Result<Value> {
    let allowed = [
        "configPath",
        "expectedConfigContentHash",
        "expectedQualificationBundleContentHash",
        "expectedConformanceBundleContentHash",
        "expectedAuthorityIndependenceBundleContentHash",
        "podUid",
        "planHash",
        "profileId",
        "runtimeClassName",
        "parentPodCpuMillis",
        "parentPodMemoryBytes",
        "parentPodPids",
        "qualificationKeyId",
        "qualificationSubjectId",
        "qualificationPublicKeySpkiHash",
        "conformanceKeyId",
        "conformanceSubjectId",
        "conformancePublicKeySpkiHash",
        "now",
    ];
    ensure(
        input
            .as_object()
            .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str()))),
        "nested_runtime_platform_request_invalid",
    )?;
    let now = instant(&input["now"]).ok_or_else(|| {
        NestedRuntimeQualificationError::from("nested_runtime_platform_verification_clock_invalid")
    })?;
    let mut request = input.clone();
    for key in [
        "parentPodCpuMillis",
        "parentPodMemoryBytes",
        "parentPodPids",
    ] {
        if let Some(n) = request_integer(&request[key]) {
            request[key] = n.into();
        }
    }
    let loaded = match load(&request) {
        Ok(v) => v,
        Err(error) => return blocked(&request["now"], vec![error.to_string()], None),
    };
    let config = &loaded.config;
    let limits = [
        config["qualificationMaximumLifetimeMs"]
            .as_u64()
            .ok_or("nested_runtime_platform_configuration_invalid")?,
        config["conformanceMaximumLifetimeMs"]
            .as_u64()
            .ok_or("nested_runtime_platform_configuration_invalid")?,
        config["authorityIndependenceMaximumLifetimeMs"]
            .as_u64()
            .ok_or("nested_runtime_platform_configuration_invalid")?,
    ];
    let qualification = subjects::qualification(&loaded.bundles[0]["subject"], now, limits[0]);
    let mut blockers = qualification.blockers.clone();
    if qualification.ready() {
        let q = qualification
            .value
            .as_ref()
            .ok_or("nested_runtime_platform_qualification_required")?;
        if q["profileId"] != request["profileId"] {
            blockers.push("nested_runtime_platform_qualification_profile_id_mismatch".into());
        }
        if q["profile"]["platform"]["runtimeClass"]["name"] != request["runtimeClassName"] {
            blockers.push("nested_runtime_platform_qualification_runtime_class_mismatch".into());
        }
        if [
            ("cpuMillis", "parentPodCpuMillis"),
            ("memoryBytes", "parentPodMemoryBytes"),
            ("pids", "parentPodPids"),
        ]
        .iter()
        .any(|(a, b)| q["profile"]["parentPodResourceCeiling"][*a] != request[*b])
        {
            blockers.push("nested_runtime_platform_parent_pod_ceiling_mismatch".into());
        }
    }
    let q_auth = match authority::envelope(
        &loaded.bundles[0]["envelope"],
        &qualification,
        &loaded.trust,
        &config[authority::AUTHORITY_FIELDS[0]],
        authority::ROLES[0],
        now,
        limits[0],
    ) {
        Ok(v) => v,
        Err(e) => {
            blockers.push(e.to_string());
            false
        }
    };
    let conformance = subjects::conformance(
        &loaded.bundles[1]["subject"],
        &qualification,
        &request,
        now,
        limits[1],
        config["conformanceMaximumObservationAgeMs"]
            .as_u64()
            .ok_or("nested_runtime_platform_configuration_invalid")?,
    );
    blockers.extend(conformance.blockers.clone());
    let c_auth = match authority::envelope(
        &loaded.bundles[1]["envelope"],
        &conformance,
        &loaded.trust,
        &config[authority::AUTHORITY_FIELDS[1]],
        authority::ROLES[1],
        now,
        limits[1],
    ) {
        Ok(v) => v,
        Err(e) => {
            blockers.push(e.to_string());
            false
        }
    };
    let independence = subjects::independence(
        &loaded.bundles[2]["subject"],
        &qualification,
        &conformance,
        config,
        &request,
        now,
        limits[2],
    );
    blockers.extend(independence.blockers.clone());
    let i_auth = match authority::envelope(
        &loaded.bundles[2]["envelope"],
        &independence,
        &loaded.trust,
        &config[authority::AUTHORITY_FIELDS[2]],
        authority::ROLES[2],
        now,
        limits[2],
    ) {
        Ok(v) => v,
        Err(e) => {
            blockers.push(e.to_string());
            false
        }
    };
    let observations = json!({"configurationContentHash":loaded.config_hash,"trustStoreContentHash":loaded.trust_content_hash,"qualificationBundleContentHash":loaded.bundle_hashes[0],"conformanceBundleContentHash":loaded.bundle_hashes[1],"authorityIndependenceBundleContentHash":loaded.bundle_hashes[2],"qualificationSubjectHash":qualification.subject_hash,"conformanceSubjectHash":conformance.subject_hash,"authorityIndependenceSubjectHash":independence.subject_hash});
    if !blockers.is_empty() || !q_auth || !c_auth || !i_auth {
        if blockers.is_empty() {
            blockers.push("nested_runtime_platform_authority_missing".into());
        }
        return blocked(&request["now"], blockers, Some(observations));
    }
    let mut report = json!({"version":1,"kind":REPORT,"status":"nested_runtime_platform_qualification_verified","ready":true,"cryptographicAuthorityReady":true,"externallyQualified":true,"startupConformanceReady":true,"authorityIndependenceReady":true,"verifiedAt":request["now"],"profileId":request["profileId"],"profileHash":qualification.value.as_ref().ok_or("nested_runtime_platform_qualification_required")?["profileHash"],"podUid":request["podUid"],"planHash":request["planHash"],"runtimeClassName":request["runtimeClassName"],"trustStoreHash":loaded.trust.hash,"externalActionPerformed":false,"blockers":[]});
    report
        .as_object_mut()
        .ok_or("nested_runtime_platform_report_shape_invalid")?
        .extend(
            observations
                .as_object()
                .ok_or("nested_runtime_platform_report_shape_invalid")?
                .clone(),
        );
    for (index, prefix) in ["qualification", "conformance", "authorityIndependence"]
        .iter()
        .enumerate()
    {
        let a = &config[authority::AUTHORITY_FIELDS[index]];
        for (suffix, field) in [
            ("VerifiedKeyIds", "keyIds"),
            ("VerifiedSubjectIds", "subjectIds"),
            ("VerifiedPublicKeySpkiHashes", "publicKeySpkiHashes"),
        ] {
            report[format!("{prefix}{suffix}")] = a[field].clone();
        }
        report[format!("{prefix}ExpiresAt")] =
            loaded.bundles[index]["envelope"]["expiresAt"].clone();
    }
    report["qualificationAuthorityOrganization"] =
        config["qualificationAuthority"]["organizations"][0].clone();
    report["conformanceAuthorityOrganization"] =
        config["conformanceAuthority"]["organizations"][0].clone();
    report["authorityIndependenceAttestorOrganization"] =
        config["authorityIndependenceAuthority"]["organizations"][0].clone();
    for (suffix, field) in [
        ("PrincipalId", "principalId"),
        ("Organization", "organization"),
        ("Provider", "provider"),
        ("TrustDomainIdentityHash", "trustDomainIdentityHash"),
    ] {
        report[format!("deploymentOperator{suffix}")] = config["deploymentOperator"][field].clone();
    }
    finish(report)
}
