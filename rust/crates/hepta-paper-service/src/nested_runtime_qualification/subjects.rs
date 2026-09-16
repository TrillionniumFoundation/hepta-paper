use super::*;

pub(super) const CONTRACT: &str = "hepta-nested-container-runtime-v1";
#[derive(Clone)]
pub(super) struct Inspection {
    pub value: Option<Value>,
    pub subject_hash: Option<String>,
    pub blockers: Vec<String>,
}
impl Inspection {
    pub fn ready(&self) -> bool {
        self.value.is_some() && self.blockers.is_empty()
    }
    fn from_result(result: Result<Value>, kind: &str, now: i64, max: u64, prefix: &str) -> Self {
        match result {
            Ok(value) => {
                let h = hash(kind, &value);
                match h {
                    Ok(subject_hash) => Self {
                        blockers: window(&value, now, max, prefix),
                        value: Some(value),
                        subject_hash: Some(subject_hash),
                    },
                    Err(e) => Self::blocked(e.to_string()),
                }
            }
            Err(e) => Self::blocked(e.to_string()),
        }
    }
    fn blocked(reason: String) -> Self {
        Self {
            value: None,
            subject_hash: None,
            blockers: vec![reason],
        }
    }
}
fn gpu(v: &Value) -> Result<()> {
    let fields = ["devicePluginId", "driverVersion", "toolkitVersion"];
    ensure(
        exact(
            v,
            &[
                "declared",
                "devicePluginId",
                "driverVersion",
                "toolkitVersion",
            ],
        ) && v["declared"].is_boolean()
            && if v["declared"] == true {
                fields.iter().all(|k| id(&v[*k]))
            } else {
                fields.iter().all(|k| v[*k].is_null())
            },
        "nested_runtime_platform_gpu_profile_invalid",
    )
}
fn platform(v: &Value) -> Result<()> {
    let checks = exact(
        v,
        &[
            "architecture",
            "cgroup",
            "cri",
            "gpu",
            "kernel",
            "nodeImage",
            "os",
            "runtime",
            "runtimeClass",
            "security",
        ],
    ) && id(&v["os"])
        && id(&v["architecture"])
        && exact(&v["cri"], &["endpointIdentityHash", "name", "version"])
        && id(&v["cri"]["name"])
        && id(&v["cri"]["version"])
        && sha(&v["cri"]["endpointIdentityHash"])
        && exact(&v["runtimeClass"], &["handler", "name"])
        && id(&v["runtimeClass"]["name"])
        && id(&v["runtimeClass"]["handler"])
        && exact(&v["runtime"], &["configurationHash", "name", "version"])
        && id(&v["runtime"]["name"])
        && id(&v["runtime"]["version"])
        && sha(&v["runtime"]["configurationHash"])
        && exact(&v["kernel"], &["release", "securityPolicyHash"])
        && id(&v["kernel"]["release"])
        && sha(&v["kernel"]["securityPolicyHash"])
        && exact(&v["nodeImage"], &["contentHash", "id"])
        && id(&v["nodeImage"]["id"])
        && sha(&v["nodeImage"]["contentHash"])
        && exact(&v["cgroup"], &["delegationPolicyHash", "driver", "mode"])
        && v["cgroup"]["mode"] == "v2"
        && id(&v["cgroup"]["driver"])
        && sha(&v["cgroup"]["delegationPolicyHash"])
        && exact(
            &v["security"],
            &[
                "allowPrivilegeEscalation",
                "appArmorProfile",
                "privileged",
                "seccompProfile",
                "selinuxType",
                "userNamespaceMode",
            ],
        )
        && v["security"]["privileged"] == false
        && v["security"]["allowPrivilegeEscalation"] == false
        && [
            "seccompProfile",
            "appArmorProfile",
            "selinuxType",
            "userNamespaceMode",
        ]
        .iter()
        .all(|k| id(&v["security"][*k]));
    ensure(checks, "nested_runtime_platform_profile_invalid")?;
    gpu(&v["gpu"])
}
fn profile(v: &Value) -> Result<()> {
    let image = s(&v["fixedDigestWorkerImage"]);
    let image_valid = image.rsplit_once('@').is_some_and(|(name, digest)| {
        !name.is_empty()
            && !name.contains('@')
            && !name.chars().any(char::is_whitespace)
            && sha(&Value::String(digest.to_owned()))
    }) && no_placeholder(image)
        && image.len() <= 4096;
    ensure(
        exact(
            v,
            &[
                "fixedDigestWorkerImage",
                "parentPodResourceCeiling",
                "platform",
                "sharedScratchRoot",
                "workerIdentity",
            ],
        ) && image_valid
            && absolute(&v["sharedScratchRoot"])
            && exact(&v["workerIdentity"], &["gid", "uid"])
            && positive(&v["workerIdentity"]["uid"])
            && positive(&v["workerIdentity"]["gid"])
            && exact(
                &v["parentPodResourceCeiling"],
                &["cpuMillis", "memoryBytes", "pids"],
            )
            && ["cpuMillis", "memoryBytes", "pids"]
                .iter()
                .all(|k| positive(&v["parentPodResourceCeiling"][*k])),
        "nested_runtime_platform_execution_profile_invalid",
    )?;
    platform(&v["platform"])
}
pub(super) fn qualification(v: &Value, now: i64, max: u64) -> Inspection {
    let validate = || -> Result<Value> {
        ensure(
            exact(
                v,
                &[
                    "contractVersion",
                    "expiresAt",
                    "issuedAt",
                    "kind",
                    "profile",
                    "profileHash",
                    "profileId",
                    "validFrom",
                    "version",
                ],
            ) && v["version"] == 1
                && v["kind"] == "NestedRuntimePlatformQualification"
                && v["contractVersion"] == CONTRACT
                && id(&v["profileId"]),
            "nested_runtime_platform_qualification_subject_invalid",
        )?;
        profile(&v["profile"])?;
        ensure(
            v["profileHash"] == hash("NestedRuntimePlatformProfile", &v["profile"])?
                && ["issuedAt", "validFrom", "expiresAt"]
                    .iter()
                    .all(|k| instant(&v[*k]).is_some()),
            "nested_runtime_platform_qualification_subject_invalid",
        )?;
        Ok(v.clone())
    };
    Inspection::from_result(
        validate(),
        "NestedRuntimePlatformQualification",
        now,
        max,
        "nested_runtime_platform_qualification",
    )
}
fn proofs(v: &Value, p: &Value) -> Result<()> {
    let ceiling = &p["parentPodResourceCeiling"];
    let bind = &v["bindReadWrite"];
    let r = &v["resources"];
    let root = format!("{}/", s(&p["sharedScratchRoot"]));
    ensure(
        exact(
            v,
            &[
                "bindReadWrite",
                "fixedDigestWorker",
                "gpu",
                "network",
                "resources",
            ],
        ) && exact(&v["fixedDigestWorker"], &["image", "launched"])
            && v["fixedDigestWorker"]["launched"] == true
            && v["fixedDigestWorker"]["image"] == p["fixedDigestWorkerImage"]
            && exact(
                bind,
                &[
                    "readBackHash",
                    "resultGid",
                    "resultPath",
                    "resultPathWithinSharedScratch",
                    "resultUid",
                    "sourcePath",
                    "writable",
                ],
            )
            && bind["writable"] == true
            && bind["resultPathWithinSharedScratch"] == true
            && bind["resultUid"] == p["workerIdentity"]["uid"]
            && bind["resultGid"] == p["workerIdentity"]["gid"]
            && absolute(&bind["sourcePath"])
            && absolute(&bind["resultPath"])
            && s(&bind["sourcePath"]).starts_with(&root)
            && s(&bind["resultPath"]).starts_with(&root)
            && sha(&bind["readBackHash"])
            && exact(&v["network"], &["dnsBlocked", "mode", "outboundBlocked"])
            && v["network"]["mode"] == "none"
            && v["network"]["outboundBlocked"] == true
            && v["network"]["dnsBlocked"] == true
            && exact(
                r,
                &[
                    "cpuLimitEnforced",
                    "cpuMillis",
                    "memoryBytes",
                    "memoryLimitEnforced",
                    "parentPodCeilingEnforced",
                    "parentPodCpuMillis",
                    "parentPodMemoryBytes",
                    "parentPodPids",
                    "pids",
                    "pidsLimitEnforced",
                ],
            )
            && [
                "memoryLimitEnforced",
                "cpuLimitEnforced",
                "pidsLimitEnforced",
                "parentPodCeilingEnforced",
            ]
            .iter()
            .all(|k| r[*k] == true)
            && ["memoryBytes", "cpuMillis", "pids"]
                .iter()
                .all(|k| positive(&r[*k]) && r[*k].as_u64() <= ceiling[*k].as_u64())
            && r["parentPodMemoryBytes"] == ceiling["memoryBytes"]
            && r["parentPodCpuMillis"] == ceiling["cpuMillis"]
            && r["parentPodPids"] == ceiling["pids"],
        "nested_runtime_startup_conformance_proofs_invalid",
    )?;
    let g = &v["gpu"];
    let pg = &p["platform"]["gpu"];
    ensure(
        exact(
            g,
            &[
                "declared",
                "deviceCount",
                "devicePluginId",
                "driverVersion",
                "toolkitVersion",
            ],
        ) && g["declared"] == pg["declared"]
            && if pg["declared"] == false {
                g["deviceCount"] == 0
                    && ["devicePluginId", "driverVersion", "toolkitVersion"]
                        .iter()
                        .all(|k| g[*k].is_null())
            } else {
                positive(&g["deviceCount"])
                    && ["devicePluginId", "driverVersion", "toolkitVersion"]
                        .iter()
                        .all(|k| g[*k] == pg[*k])
            },
        "nested_runtime_startup_conformance_gpu_proof_invalid",
    )
}
pub(super) fn conformance(
    v: &Value,
    q: &Inspection,
    request: &Value,
    now: i64,
    max: u64,
    age: u64,
) -> Inspection {
    if !q.ready() {
        return Inspection::blocked("nested_runtime_platform_qualification_required".to_owned());
    }
    let Some(qv) = q.value.as_ref() else {
        return Inspection::blocked("nested_runtime_platform_qualification_required".to_owned());
    };
    let validate = || -> Result<Value> {
        ensure(
            exact(
                v,
                &[
                    "contractVersion",
                    "expiresAt",
                    "issuedAt",
                    "kind",
                    "observedAt",
                    "planHash",
                    "podUid",
                    "profileHash",
                    "profileId",
                    "proofs",
                    "qualificationSubjectHash",
                    "validFrom",
                    "version",
                ],
            ) && v["version"] == 1
                && v["kind"] == "NestedRuntimeStartupConformance"
                && v["contractVersion"] == CONTRACT
                && v["profileId"] == qv["profileId"]
                && v["profileHash"] == qv["profileHash"]
                && v["qualificationSubjectHash"].as_str() == q.subject_hash.as_deref()
                && pod(&v["podUid"])
                && sha(&v["planHash"])
                && ["observedAt", "issuedAt", "validFrom", "expiresAt"]
                    .iter()
                    .all(|k| instant(&v[*k]).is_some()),
            "nested_runtime_startup_conformance_subject_invalid",
        )?;
        proofs(&v["proofs"], &qv["profile"])?;
        Ok(v.clone())
    };
    let mut out = Inspection::from_result(
        validate(),
        "NestedRuntimeStartupConformance",
        now,
        max,
        "nested_runtime_startup_conformance",
    );
    if out.value.is_some() {
        let (
            Some(observed),
            Some(issued),
            Some(valid),
            Some(expires),
            Some(qvalid),
            Some(qexpires),
        ) = (
            instant(&v["observedAt"]),
            instant(&v["issuedAt"]),
            instant(&v["validFrom"]),
            instant(&v["expiresAt"]),
            instant(&qv["validFrom"]),
            instant(&qv["expiresAt"]),
        )
        else {
            return Inspection::blocked(
                "nested_runtime_startup_conformance_subject_invalid".to_owned(),
            );
        };
        if observed > issued || now - observed > age as i64 || observed > now {
            out.blockers
                .push("nested_runtime_startup_conformance_observation_stale_or_invalid".into());
        }
        if observed < qvalid || issued < qvalid || valid < qvalid || expires > qexpires {
            out.blockers
                .push("nested_runtime_startup_conformance_outside_qualification_window".into());
        }
        for (key, code) in [
            (
                "podUid",
                "nested_runtime_startup_conformance_pod_uid_mismatch",
            ),
            (
                "planHash",
                "nested_runtime_startup_conformance_plan_hash_mismatch",
            ),
            (
                "profileId",
                "nested_runtime_startup_conformance_profile_id_mismatch",
            ),
        ] {
            if v[key] != request[key] {
                out.blockers.push(code.into());
            }
        }
        if qv["profile"]["platform"]["runtimeClass"]["name"] != request["runtimeClassName"] {
            out.blockers
                .push("nested_runtime_startup_conformance_runtime_class_mismatch".into());
        }
    }
    out
}
fn identity(v: &Value, now: Option<i64>, max: u64) -> bool {
    let keys = [
        "assuranceProfile",
        "attestedAt",
        "challengeHash",
        "credentialRootIdentityHash",
        "expiresAt",
        "hostIdentityHash",
        "kind",
        "principalId",
        "processIdentityHash",
        "provider",
        "providerAccountIdentityHash",
        "serviceId",
        "signerPublicKeySpkiHash",
        "trustDomainIdentityHash",
        "version",
        "externalPrincipalIdentityAttestationSubjectHash",
    ];
    if !exact(v, &keys)
        || v["version"] != 1
        || v["kind"] != "ExternalPrincipalIdentityAttestationSubject"
        || v["assuranceProfile"] != "pinned-provider-account-and-platform-attestation-v1"
        || !["serviceId", "principalId", "provider"]
            .iter()
            .all(|k| key_id(&v[*k]))
        || ![
            "providerAccountIdentityHash",
            "credentialRootIdentityHash",
            "hostIdentityHash",
            "processIdentityHash",
            "trustDomainIdentityHash",
            "signerPublicKeySpkiHash",
            "challengeHash",
            "externalPrincipalIdentityAttestationSubjectHash",
        ]
        .iter()
        .all(|k| sha(&v[*k]))
    {
        return false;
    }
    let (Some(start), Some(end)) = (instant(&v["attestedAt"]), instant(&v["expiresAt"])) else {
        return false;
    };
    if end <= start || end - start > max as i64 || now.is_some_and(|n| n < start || n >= end) {
        return false;
    }
    let mut payload = v.clone();
    let Some(object) = payload.as_object_mut() else {
        return false;
    };
    object.remove("externalPrincipalIdentityAttestationSubjectHash");
    hash("ExternalPrincipalIdentityAttestationSubject", &payload)
        .is_ok_and(|h| v["externalPrincipalIdentityAttestationSubjectHash"] == h)
}
fn independent(v: &Value) -> Result<()> {
    let identities = [
        &v["qualificationPrincipalIdentity"],
        &v["conformancePrincipalIdentity"],
        &v["deploymentOperatorPrincipalIdentity"],
    ];
    ensure(
        identities.iter().all(|x| identity(x, None, 86_400_000)),
        "nested_runtime_authority_principal_identity_invalid",
    )?;
    let organizations = &v["controlDomainOrganizations"];
    ensure(
        exact(
            organizations,
            &["conformance", "deploymentOperator", "qualification"],
        ) && ["qualification", "conformance", "deploymentOperator"]
            .iter()
            .all(|k| org(&organizations[*k]))
            && {
                let a = org_identity(&organizations["qualification"]);
                let b = org_identity(&organizations["conformance"]);
                let c = org_identity(&organizations["deploymentOperator"]);
                a != b && a != c && b != c
            },
        "nested_runtime_authority_control_domain_organization_invalid",
    )?;
    let fields = [
        "signerPublicKeySpkiHash",
        "providerAccountIdentityHash",
        "credentialRootIdentityHash",
        "hostIdentityHash",
        "processIdentityHash",
        "trustDomainIdentityHash",
        "principalId",
        "provider",
        "serviceId",
    ];
    let distinct = fields.iter().all(|field| {
        let vals = identities.map(|v| s(&v[*field]).to_ascii_lowercase());
        vals[0] != vals[1] && vals[0] != vals[2] && vals[1] != vals[2]
    });
    ensure(
        distinct
            && identities[0]["challengeHash"] == v["qualificationSubjectHash"]
            && identities[1]["challengeHash"] == v["conformanceSubjectHash"]
            && identities[2]["challengeHash"] == v["planHash"]
            && identities.iter().all(|x| {
                instant(&v["validFrom"]) >= instant(&x["attestedAt"])
                    && instant(&v["expiresAt"]) <= instant(&x["expiresAt"])
            }),
        "nested_runtime_authority_control_domain_independence_invalid",
    )
}
pub(super) fn independence(
    v: &Value,
    q: &Inspection,
    c: &Inspection,
    config: &Value,
    request: &Value,
    now: i64,
    max: u64,
) -> Inspection {
    let validate = || -> Result<Value> {
        ensure(
            exact(
                v,
                &[
                    "conformancePrincipalIdentity",
                    "conformanceSubjectHash",
                    "contractVersion",
                    "controlDomainOrganizations",
                    "deploymentOperatorPrincipalIdentity",
                    "expiresAt",
                    "issuedAt",
                    "kind",
                    "planHash",
                    "podUid",
                    "profileId",
                    "qualificationPrincipalIdentity",
                    "qualificationSubjectHash",
                    "validFrom",
                    "version",
                ],
            ) && v["version"] == 1
                && v["kind"] == "NestedRuntimeAuthorityIndependenceAttestation"
                && v["contractVersion"] == CONTRACT
                && id(&v["profileId"])
                && pod(&v["podUid"])
                && [
                    "planHash",
                    "qualificationSubjectHash",
                    "conformanceSubjectHash",
                ]
                .iter()
                .all(|k| sha(&v[*k]))
                && ["issuedAt", "validFrom", "expiresAt"]
                    .iter()
                    .all(|k| instant(&v[*k]).is_some()),
            "nested_runtime_authority_independence_subject_invalid",
        )?;
        independent(v)?;
        Ok(v.clone())
    };
    let mut out = Inspection::from_result(
        validate(),
        "NestedRuntimeAuthorityIndependenceAttestation",
        now,
        max,
        "nested_runtime_authority_independence",
    );
    if out.value.is_some() {
        let qi = &v["qualificationPrincipalIdentity"];
        let ci = &v["conformancePrincipalIdentity"];
        let di = &v["deploymentOperatorPrincipalIdentity"];
        let qa = &config["qualificationAuthority"];
        let ca = &config["conformanceAuthority"];
        let deploy = &config["deploymentOperator"];
        let orgs = &v["controlDomainOrganizations"];
        if ![qi, ci, di].iter().all(|x| identity(x, Some(now), max)) {
            out.blockers
                .push("nested_runtime_authority_principal_identity_invalid".into());
        }
        if ["profileId", "podUid", "planHash"]
            .iter()
            .any(|k| v[*k] != request[*k])
            || v["qualificationSubjectHash"].as_str() != q.subject_hash.as_deref()
            || v["conformanceSubjectHash"].as_str() != c.subject_hash.as_deref()
        {
            out.blockers
                .push("nested_runtime_authority_independence_runtime_binding_mismatch".into());
        }
        if qi["principalId"] != qa["subjectIds"][0]
            || qi["signerPublicKeySpkiHash"] != qa["publicKeySpkiHashes"][0]
            || org_identity(&orgs["qualification"]) != org_identity(&qa["organizations"][0])
            || ci["principalId"] != ca["subjectIds"][0]
            || ci["signerPublicKeySpkiHash"] != ca["publicKeySpkiHashes"][0]
            || org_identity(&orgs["conformance"]) != org_identity(&ca["organizations"][0])
        {
            out.blockers
                .push("nested_runtime_authority_independence_signer_binding_mismatch".into());
        }
        if di["principalId"] != deploy["principalId"]
            || di["provider"] != deploy["provider"]
            || di["trustDomainIdentityHash"] != deploy["trustDomainIdentityHash"]
            || di["externalPrincipalIdentityAttestationSubjectHash"]
                != deploy["identitySubjectHash"]
            || org_identity(&orgs["deploymentOperator"]) != org_identity(&deploy["organization"])
        {
            out.blockers
                .push("nested_runtime_deployment_operator_identity_binding_mismatch".into());
        }
    }
    out
}
