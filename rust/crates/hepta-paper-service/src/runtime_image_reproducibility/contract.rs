use super::*;
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use std::collections::BTreeSet;

/// Compute scope from validated plugin records. This performs the hash layer;
/// package signature/startup authority validation remains the resolver's job.
pub fn runtime_image_reproducibility_active_plugin_scope_v1(
    package: &Value,
    registry: &Value,
    startup: &Value,
) -> Result<Value> {
    ensure(
        rehash(
            "AutonomousEmpiricalFamilyPluginPackage",
            package,
            "autonomousEmpiricalFamilyPluginPackageHash",
        ) && rehash(
            "AutonomousEmpiricalFamilyPluginRegistry",
            registry,
            "autonomousEmpiricalFamilyPluginRegistryHash",
        ) && rehash(
            "AutonomousEmpiricalFamilyPluginStartupInspection",
            startup,
            "autonomousEmpiricalFamilyPluginStartupInspectionHash",
        ),
        "runtime_reproducibility_plugin_record_hash_invalid",
    )?;
    ensure(
        package["registry"] == *registry
            && startup["packageHash"] == package["autonomousEmpiricalFamilyPluginPackageHash"]
            && startup["registryHash"] == registry["autonomousEmpiricalFamilyPluginRegistryHash"]
            && startup["pluginAbiHash"] == package["pluginAbiHash"]
            && startup["evaluatorRegistryHash"] == registry["evaluatorRegistryHash"],
        "runtime_reproducibility_plugin_registry_binding_invalid",
    )?;
    let profiles = array(&registry["profiles"]);
    ensure(
        !profiles.is_empty() && profiles.len() <= 128,
        "runtime_reproducibility_active_plugin_profile_scope_invalid",
    )?;
    let active: Vec<_> = profiles
        .iter()
        .filter(|p| p["productionExecutable"] == true)
        .collect();
    let mut languages = BTreeSet::from(["pythonGpu"]);
    for p in &active {
        ensure(
            rehash(
                "AutonomousEmpiricalFamilyPluginProfile",
                p,
                "autonomousEmpiricalFamilyPluginProfileHash",
            ) && p["executionProfile"]["requiresGpu"] == false
                && ["python", "r"].contains(&s(&p["executionProfile"]["language"])),
            "runtime_reproducibility_active_plugin_profile_scope_invalid",
        )?;
        languages.insert(s(&p["executionProfile"]["language"]));
    }
    let required_profiles: Vec<_> = languages.into_iter().collect();
    seal(
        "RuntimeImageReproducibilityActivePluginScope",
        json!({"version":1,"kind":"RuntimeImageReproducibilityActivePluginScope","empiricalFamilyPluginPackageHash":package["autonomousEmpiricalFamilyPluginPackageHash"],"empiricalFamilyPluginRegistryHash":registry["autonomousEmpiricalFamilyPluginRegistryHash"],"empiricalFamilyPluginStartupInspectionHash":startup["autonomousEmpiricalFamilyPluginStartupInspectionHash"],"activeProductionProfileHashes":active.iter().map(|p|p["autonomousEmpiricalFamilyPluginProfileHash"].clone()).collect::<Vec<_>>(),"requiredProfiles":required_profiles,"requiredScientificRuntimeProfiles":["pythonGpu"],"productionGpuProfileCount":0}),
        "runtimeImageReproducibilityActivePluginScopeHash",
    )
}
pub(super) fn input_valid(v: &Value) -> bool {
    if !exact(
        v,
        &[
            "baseImageReferences",
            "buildArgs",
            "cachePolicy",
            "contextManifest",
            "contextManifestHash",
            "contextPath",
            "contextTarMetadataPolicy",
            "contextTarMetadataPolicyHash",
            "definitionManifestHash",
            "dockerfile",
            "dockerfileContentHash",
            "dockerfileFrontend",
            "dockerfileFrontendDigest",
            "image",
            "kind",
            "networkPolicy",
            "ociExporter",
            "outputFormat",
            "platform",
            "profile",
            "registeredImageDigest",
            "reproducibleOciMetadataRequired",
            "runtimeImageCanonicalBuildInputClosureHash",
            "sourceDateEpoch",
            "version",
        ],
    ) || v["version"] != 1
        || v["kind"] != "RuntimeImageCanonicalBuildInputClosure"
        || !PROFILES.contains(&s(&v["profile"]))
        || s(&v["image"]).trim().is_empty()
        || [
            "registeredImageDigest",
            "definitionManifestHash",
            "contextManifestHash",
            "dockerfileContentHash",
            "dockerfileFrontendDigest",
            "contextTarMetadataPolicyHash",
        ]
        .iter()
        .any(|k| !sha(&v[*k]))
        || v["dockerfileFrontend"] != FRONTEND
        || v["dockerfileFrontendDigest"] != FRONTEND.split('@').nth(1).unwrap_or("")
        || v["platform"] != "linux/amd64"
        || v["sourceDateEpoch"] != SOURCE_DATE_EPOCH
        || v["buildArgs"] != json!({})
        || v["contextTarMetadataPolicy"] != tar_policy()
        || v["ociExporter"] != exporter()
        || v["cachePolicy"] != "cache-disabled"
        || v["outputFormat"] != "oci-layout-v1"
        || v["reproducibleOciMetadataRequired"] != true
    {
        return false;
    }
    let entries = array(&v["contextManifest"]);
    if entries.is_empty()
        || entries.len() > 100_000
        || entries
            .windows(2)
            .any(|w| s(&w[0]["path"]) > s(&w[1]["path"]))
        || entries.iter().any(|e| {
            let mode = e["mode"].as_u64().is_some_and(|m| m <= 0o777);
            !mode
                || match s(&e["type"]) {
                    "directory" => {
                        !exact(e, &["mode", "path", "type"]) || !s(&e["path"]).ends_with('/')
                    }
                    "file" => {
                        !exact(e, &["bytes", "contentHash", "mode", "path", "type"])
                            || e["bytes"].as_u64().is_none()
                            || !sha(&e["contentHash"])
                    }
                    "symlink" => {
                        !exact(e, &["mode", "path", "target", "type"]) || s(&e["target"]).is_empty()
                    }
                    _ => true,
                }
        })
    {
        return false;
    }
    let refs = array(&v["baseImageReferences"]);
    !refs.is_empty()
        && refs.len() <= 128
        && refs.iter().all(|x| {
            s(x).rsplit_once('@')
                .is_some_and(|(_, h)| sha(&Value::String(h.to_ascii_lowercase())))
        })
        && hash(
            "RuntimeImageCanonicalDockerContextManifest",
            &v["contextManifest"],
        )
        .is_ok_and(|h| v["contextManifestHash"] == h)
        && hash(
            "RuntimeImageCanonicalContextTarMetadataPolicy",
            &v["contextTarMetadataPolicy"],
        )
        .is_ok_and(|h| v["contextTarMetadataPolicyHash"] == h)
        && rehash(
            "RuntimeImageCanonicalBuildInputClosure",
            v,
            "runtimeImageCanonicalBuildInputClosureHash",
        )
}
fn request_valid(v: &Value, scope: &Value) -> bool {
    exact(
        v,
        &[
            "activeProductionProfileHashes",
            "codeProvenanceHash",
            "configurationIdentityHash",
            "empiricalFamilyPluginPackageHash",
            "empiricalFamilyPluginRegistryHash",
            "empiricalFamilyPluginStartupInspectionHash",
            "expiresAt",
            "inputs",
            "kind",
            "nonce",
            "releaseIdentityHash",
            "requestHash",
            "requestedAt",
            "requiredProfiles",
            "runtimeImageReproducibilityActivePluginScopeHash",
            "trustIdentityHash",
            "version",
        ],
    ) && v["version"] == 2
        && v["kind"] == "RuntimeImageReproducibilityVerificationRequest"
        && id(&v["nonce"])
        && instant(&v["requestedAt"])
            .zip(instant(&v["expiresAt"]))
            .is_some_and(|(a, b)| a < b)
        && [
            "configurationIdentityHash",
            "trustIdentityHash",
            "codeProvenanceHash",
            "releaseIdentityHash",
        ]
        .iter()
        .all(|k| sha(&v[*k]))
        && scope_valid(scope)
        && scope_fields(v) == scope_fields(scope)
        && v["requiredProfiles"] == scope["requiredProfiles"]
        && array(&v["inputs"]).len() == array(&scope["requiredProfiles"]).len()
        && array(&v["inputs"])
            .iter()
            .zip(array(&scope["requiredProfiles"]))
            .all(|(i, p)| i["profile"] == *p && input_valid(i))
        && rehash(
            "RuntimeImageReproducibilityVerificationRequest",
            v,
            "requestHash",
        )
}
pub fn build_runtime_image_reproducibility_request_v2(
    options: &Value,
    scope: &Value,
) -> Result<Value> {
    ensure(
        exact(
            options,
            &[
                "nonce",
                "requestedAt",
                "expiresAt",
                "configurationIdentityHash",
                "trustIdentityHash",
                "codeProvenanceHash",
                "releaseIdentityHash",
                "inputs",
            ],
        ),
        "runtime_reproducibility_request_invalid",
    )?;
    let mut v = options.clone();
    v["version"] = 2.into();
    v["kind"] = "RuntimeImageReproducibilityVerificationRequest".into();
    v["requiredProfiles"] = scope["requiredProfiles"].clone();
    for k in SCOPE_FIELDS {
        v[k] = scope[k].clone();
    }
    v = seal(
        "RuntimeImageReproducibilityVerificationRequest",
        v,
        "requestHash",
    )?;
    ensure(
        request_valid(&v, scope),
        "runtime_reproducibility_request_invalid",
    )?;
    Ok(v)
}
fn oci_valid(v: &Value) -> bool {
    if !exact(
        v,
        &[
            "allBlobDigests",
            "configDigest",
            "indexDigest",
            "layerBlobDigests",
            "manifestDigest",
            "ociDigestSetHash",
        ],
    ) || ["configDigest", "indexDigest", "manifestDigest"]
        .iter()
        .any(|k| !sha(&v[*k]))
        || array(&v["layerBlobDigests"]).is_empty()
        || array(&v["layerBlobDigests"]).len() > 4096
        || array(&v["layerBlobDigests"]).iter().any(|h| !sha(h))
    {
        return false;
    }
    let set: BTreeSet<_> = array(&v["layerBlobDigests"])
        .iter()
        .chain([&v["manifestDigest"], &v["configDigest"]])
        .map(s)
        .collect();
    v["allBlobDigests"] == json!(set) && rehash("RuntimeImageOciDigestSet", v, "ociDigestSetHash")
}
fn profile_result_valid(v: &Value, input: &Value, backend: &Value) -> bool {
    exact(
        v,
        &[
            "backendIdentityHash",
            "buildExecutionClosureHash",
            "cacheDisabled",
            "inputClosureHash",
            "contextTarMetadataPolicy",
            "contextTarMetadataPolicyApplied",
            "contextTarMetadataPolicyHash",
            "dockerfileFrontend",
            "dockerfileFrontendDigest",
            "oci",
            "ociExporter",
            "platform",
            "profile",
            "registeredImage",
            "registeredImageDigest",
            "sourceDateEpoch",
            "sourceDateEpochAppliedToBuildkit",
        ],
    ) && [
        "profile",
        "registeredImageDigest",
        "dockerfileFrontend",
        "dockerfileFrontendDigest",
        "contextTarMetadataPolicyHash",
        "contextTarMetadataPolicy",
        "platform",
        "sourceDateEpoch",
        "ociExporter",
    ]
    .iter()
    .all(|k| v[*k] == input[*k])
        && v["registeredImage"] == input["image"]
        && v["inputClosureHash"] == input["runtimeImageCanonicalBuildInputClosureHash"]
        && v["contextTarMetadataPolicyApplied"] == true
        && v["cacheDisabled"] == true
        && v["sourceDateEpochAppliedToBuildkit"] == true
        && v["backendIdentityHash"] == *backend
        && oci_valid(&v["oci"])
        && v["oci"]["manifestDigest"] == input["registeredImageDigest"]
        && hash(
            "RuntimeImageExternalBuildExecutionClosure",
            &json!({"inputClosureHash":v["inputClosureHash"],"backendIdentityHash":backend}),
        )
        .is_ok_and(|h| v["buildExecutionClosureHash"] == h)
}
fn signature_valid(response: &Value, key_pem: &str, verifier: &Value) -> bool {
    if key_pem.len() > 4096 {
        return false;
    }
    let Some(body) = key_pem
        .trim()
        .strip_prefix("-----BEGIN PUBLIC KEY-----")
        .and_then(|p| p.strip_suffix("-----END PUBLIC KEY-----"))
    else {
        return false;
    };
    let Ok(der) = Base64::decode_vec(&body.split_ascii_whitespace().collect::<String>()) else {
        return false;
    };
    if der.len() != 44
        || der[..12]
            != [
                0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
            ]
    {
        return false;
    }
    let Ok(raw) = <&[u8; 32]>::try_from(&der[12..]) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(raw) else {
        return false;
    };
    // Bind the configured key bytes as well as its signer tuple.
    let der_prefix = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    let mut der = der_prefix.to_vec();
    der.extend_from_slice(key.as_bytes());
    if verifier["signerPublicKeySpkiHash"] != digest(&der) {
        return false;
    }
    let Ok(bytes) = Base64::decode_vec(s(&response["signature"])) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&bytes) else {
        return false;
    };
    let Ok(payload) = hash(
        "RuntimeImageReproducibilityVerifierResponseSigningPayload",
        &without(response, &["signature", "responseHash"]),
    ) else {
        return false;
    };
    key.verify_strict(payload.as_bytes(), &signature).is_ok()
}
pub fn verify_runtime_image_reproducibility_response_v1(
    response: &Value,
    request: &Value,
    verifier: &Value,
    key_pem: &str,
    scope: &Value,
) -> bool {
    let r = response;
    if !request_valid(request, scope)
        || !exact(
            r,
            &[
                "backend",
                "backendIdentityHash",
                "completedAt",
                "kind",
                "nonce",
                "profileResults",
                "requestHash",
                "responseHash",
                "signature",
                "signer",
                "startedAt",
                "status",
                "verifierId",
                "verifierServiceIdentityHash",
                "version",
            ],
        )
        || r["version"] != 1
        || r["kind"] != "RuntimeImageReproducibilityVerifierResponse"
        || r["status"] != "runtime_image_oci_bitwise_rebuild_attested"
        || r["verifierId"] != verifier["serviceId"]
        || r["verifierServiceIdentityHash"] != verifier["serviceIdentityHash"]
        || r["requestHash"] != request["requestHash"]
        || r["nonce"] != request["nonce"]
        || r["backendIdentityHash"] != verifier["backend"]["backendIdentityHash"]
        || r["backend"] != verifier["backend"]
        || !rehash(
            "RuntimeImageReproducibilityBackendIdentity",
            &r["backend"],
            "backendIdentityHash",
        )
        || !exact(
            &r["signer"],
            &[
                "algorithm",
                "effectiveFrom",
                "expiresAt",
                "keyId",
                "keyVersion",
                "organization",
                "revokedAt",
                "role",
                "status",
                "subjectId",
            ],
        )
        || r["signer"] != verifier["signer"]
        || r["signer"]["algorithm"] != "ed25519"
        || !r["signer"]["revokedAt"].is_null()
        || array(&r["profileResults"]).len() != array(&request["inputs"]).len()
        || !array(&r["profileResults"])
            .iter()
            .zip(array(&request["inputs"]))
            .all(|(p, i)| profile_result_valid(p, i, &r["backendIdentityHash"]))
    {
        return false;
    }
    let times = [
        &r["startedAt"],
        &r["completedAt"],
        &request["requestedAt"],
        &request["expiresAt"],
        &r["signer"]["effectiveFrom"],
        &r["signer"]["expiresAt"],
    ]
    .map(instant);
    let [
        Some(start),
        Some(end),
        Some(req),
        Some(exp),
        Some(effective),
        Some(key_exp),
    ] = times
    else {
        return false;
    };
    start >= req
        && end >= start
        && end < exp
        && end >= effective
        && end < key_exp
        && hash(
            "RuntimeImageReproducibilityVerifierResponse",
            &without(r, &["signature", "responseHash"]),
        )
        .is_ok_and(|h| r["responseHash"] == h)
        && signature_valid(r, key_pem, verifier)
}
pub fn build_runtime_image_reproducibility_receipt_v2(
    request: &Value,
    responses: &Value,
    issued_at: &str,
    expires_at: &str,
    scope: &Value,
) -> Result<Value> {
    ensure(
        request_valid(request, scope)
            && array(responses).len() == 2
            && instant(&issued_at.into()).is_some()
            && instant(&expires_at.into()).is_some(),
        "runtime_reproducibility_receipt_input_invalid",
    )?;
    seal(
        "RuntimeImageReproducibilityReceipt",
        json!({"version":2,"kind":"RuntimeImageReproducibilityReceipt","status":"runtime_image_reproducibility_external_attestations_recorded","request":request,"contextTarMetadataPolicyHashes":profile_map(&request["inputs"],"contextTarMetadataPolicyHash"),"responseHashes":array(responses).iter().map(|r|r["responseHash"].clone()).collect::<Vec<_>>(),"responses":responses,"issuedAt":issued_at,"expiresAt":expires_at,"externalActionPerformed":true,"privateSigningKeyLoadedByController":false,"assurance":"two-independent-ed25519-attested-oci-layout-rebuilds-v1"}),
        "runtimeImageReproducibilityReceiptHash",
    )
}
fn agree(responses: &[Value]) -> bool {
    let (a, b) = (&responses[0], &responses[1]);
    let org = |v: &Value| {
        s(v).split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    };
    [
        "verifierId",
        "verifierServiceIdentityHash",
        "backendIdentityHash",
    ]
    .iter()
    .all(|k| a[*k] != b[*k])
        && a["signer"]["subjectId"] != b["signer"]["subjectId"]
        && org(&a["signer"]["organization"]) != org(&b["signer"]["organization"])
        && array(&a["profileResults"])
            .iter()
            .zip(array(&b["profileResults"]))
            .all(|(a, b)| a["oci"] == b["oci"])
}
pub fn verify_runtime_image_reproducibility_receipt_v2(
    receipt: &Value,
    c: &ReceiptVerificationContext<'_>,
) -> Result<Value> {
    ensure(
        scope_valid(c.active_plugin_scope),
        "runtime_reproducibility_active_plugin_scope_invalid",
    )?;
    let mut blockers = BTreeSet::<String>::new();
    let r = receipt;
    let request = &r["request"];
    let responses = array(&r["responses"]);
    if !exact(
        r,
        &[
            "assurance",
            "contextTarMetadataPolicyHashes",
            "expiresAt",
            "externalActionPerformed",
            "issuedAt",
            "kind",
            "privateSigningKeyLoadedByController",
            "request",
            "responseHashes",
            "responses",
            "runtimeImageReproducibilityReceiptHash",
            "status",
            "version",
        ],
    ) || r["version"] != 2
        || r["kind"] != "RuntimeImageReproducibilityReceipt"
        || r["status"] != "runtime_image_reproducibility_external_attestations_recorded"
        || r["externalActionPerformed"] != true
        || r["privateSigningKeyLoadedByController"] != false
        || r["assurance"] != "two-independent-ed25519-attested-oci-layout-rebuilds-v1"
        || r["contextTarMetadataPolicyHashes"]
            != profile_map(&request["inputs"], "contextTarMetadataPolicyHash")
        || !rehash(
            "RuntimeImageReproducibilityReceipt",
            r,
            "runtimeImageReproducibilityReceiptHash",
        )
    {
        blockers.insert("runtime_reproducibility_receipt_shape_or_hash_invalid".into());
    }
    let now = instant(&c.now.into());
    let issued = instant(&r["issuedAt"]);
    let expires = instant(&r["expiresAt"]);
    let max_age = c.configuration["maximumReceiptAgeMs"].as_i64();
    let request_exp = instant(&request["expiresAt"]);
    let completions: Option<Vec<_>> = responses
        .iter()
        .map(|r| instant(&r["completedAt"]))
        .collect();
    let latest = completions.and_then(|v| v.into_iter().max());
    let valid_time = match (now, issued, expires, max_age, request_exp, latest) {
        (Some(n), Some(i), Some(e), Some(m), Some(q), Some(l)) => {
            (60_000..=86_400_000).contains(&m)
                && e > i
                && e - i == m
                && i >= l
                && i - l <= 60_000
                && i < q
                && n >= i
                && n < e
        }
        _ => false,
    };
    if !valid_time {
        blockers.insert("runtime_reproducibility_receipt_outside_time_window".into());
    }
    if !request_valid(request, c.active_plugin_scope) {
        blockers.insert("runtime_reproducibility_request_invalid".into());
    } else {
        if request["configurationIdentityHash"] != c.configuration["configurationIdentityHash"]
            || request["trustIdentityHash"] != c.configuration["trustIdentityHash"]
        {
            blockers.insert("runtime_reproducibility_configuration_or_trust_drift".into());
        }
        if request["codeProvenanceHash"] != c.current_code_provenance_hash
            || request["releaseIdentityHash"] != c.current_release_identity_hash
        {
            blockers.insert("runtime_reproducibility_code_or_release_drift".into());
        }
        if request["inputs"] != *c.current_inputs {
            blockers.insert("runtime_reproducibility_build_input_closure_drift".into());
        }
    }
    if responses.len() != 2
        || r["responseHashes"]
            != json!(
                responses
                    .iter()
                    .map(|r| r["responseHash"].clone())
                    .collect::<Vec<_>>()
            )
    {
        blockers.insert("runtime_reproducibility_external_response_set_invalid".into());
    } else if c.public_keys.len() != 2
        || array(&c.configuration["verifiers"]).len() != 2
        || responses.iter().enumerate().any(|(i, r)| {
            !verify_runtime_image_reproducibility_response_v1(
                r,
                request,
                &c.configuration["verifiers"][i],
                &c.public_keys[i],
                c.active_plugin_scope,
            )
        })
    {
        blockers.insert("runtime_reproducibility_external_signature_or_binding_invalid".into());
    } else if !agree(responses) {
        blockers.insert("runtime_reproducibility_independent_oci_outputs_mismatch".into());
    }
    for profile in array(&c.active_plugin_scope["requiredProfiles"]) {
        let p = s(profile);
        if c.profile_policies[p]["dependencyArtifactsContentHashed"] != true
            || c.profile_policies[p]["sourceArchivesContentHashed"] != true
        {
            blockers.insert(format!(
                "runtime_reproducibility_source_content_hashes_incomplete:{p}"
            ));
        }
    }
    let ready = blockers.is_empty();
    let mut report = json!({"version":2,"kind":"RuntimeImageReproducibilityReceiptInspection","status":if ready{"runtime_image_reproducibility_verified"}else{"runtime_image_reproducibility_blocked"},"ready":ready,"receiptAccepted":ready,"receiptHash":if ready{r["runtimeImageReproducibilityReceiptHash"].clone()}else{Value::Null},"issuedAt":if ready{r["issuedAt"].clone()}else{Value::Null},"expiresAt":if ready{r["expiresAt"].clone()}else{Value::Null},"remainingValidityMs":if ready{expires.unwrap_or(0)-now.unwrap_or(0)}else{0},"requiredProfiles":c.active_plugin_scope["requiredProfiles"],"definitionManifestHashes":if ready{profile_map(&request["inputs"],"definitionManifestHash")}else{Value::Null},"inputClosureHashes":if ready{profile_map(&request["inputs"],"runtimeImageCanonicalBuildInputClosureHash")}else{Value::Null},"registeredImageDigests":if ready{profile_map(&request["inputs"],"registeredImageDigest")}else{Value::Null},"privateSigningKeyLoadedByController":false,"twoIndependentExternalVerifiersRequired":true,"ociIndexManifestConfigAndLayerBlobDigestsCompared":true,"canonicalContextTarMetadataPolicyRequired":true,"canonicalContextTarMetadataAttested":ready,"blockers":blockers});
    for k in SCOPE_FIELDS {
        report[k] = c.active_plugin_scope[k].clone();
    }
    Ok(report)
}
