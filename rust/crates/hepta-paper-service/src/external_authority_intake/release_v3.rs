//! Passive V3 configuration and independent hardware evidence verification.
//! Command descriptors are inspected and hashed; no command is executed.
use super::{
    Control, author, blocked_release, bytes_hash, check_control, resolve_path, same_identity,
};
use ed25519_dalek::{
    VerifyingKey,
    pkcs8::{DecodePublicKey, EncodePublicKey},
};
use hepta_legacy_compatibility::{ProductionCollationV1, production_hash_record_v1};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, &'static str>;
const ROLE: &str = "research_execution_release_attestor";
const PROBE_ROLE: &str = "research_execution_release_signer_backend_probe_attestor";
const HARDWARE_ROLE: &str = "research_execution_release_kms_hardware_attestor";
const HARDWARE_KIND: &str = "ResearchExecutionReleaseKmsHardwareAttestationSubject";
const MATERIAL: &str = "research_execution_release_attestor_configuration_material_invalid";
const INTEGRITY: &str = "research_execution_release_attestor_integrity_file_invalid";
const INDEPENDENCE: &str = "research_execution_release_attestor_independent_backend_probe_required";
const HARDWARE_BUNDLE: &str =
    "research_execution_release_attestor_kms_hardware_authority_bundle_invalid";
const CONFIG_KEYS: &[&str] = &[
    "attestationLifetimeSeconds",
    "backend",
    "kind",
    "status",
    "trustSet",
    "version",
    "hardwareAuthorityAttestation",
];
const KEY_KEYS: &[&str] = &[
    "algorithm",
    "effectiveFrom",
    "expiresAt",
    "keyId",
    "keyVersion",
    "organization",
    "publicKeyPath",
    "revokedAt",
    "role",
    "status",
    "subjectId",
];
const BACKEND_KEYS: &[&str] = &[
    "activeKeyId",
    "activeKeyVersion",
    "algorithm",
    "backendId",
    "backendVersion",
    "externalSignerProcess",
    "hardwareProtected",
    "kind",
    "privateKeyExportable",
    "probeAttestor",
    "probeCommand",
    "signerCommand",
    "credentialGenerationIdentityHash",
    "keyResourceIdentityHash",
    "kmsProvider",
    "providerAccountIdentityHash",
];
const COMMAND_KEYS: &[&str] = &[
    "args",
    "credentialRoot",
    "environmentAllowlist",
    "executable",
    "principalId",
    "protocol",
    "serviceId",
    "timeoutMs",
];
pub const PASSIVE_RELEASE_ATTESTOR_ENVIRONMENT_KEYS: [&str; 15] = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
];

fn exact(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
fn safe(v: &Value, min: usize, max: usize, organization: bool) -> bool {
    let Some(s) = v.as_str() else {
        return false;
    };
    s.len() >= min
        && s.len() <= max
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || (if organization {
                    b" ._():-" as &[u8]
                } else {
                    b"._:@/-"
                })
                .contains(&b)
        })
}
fn safe_coerced(v: &Value, min: usize, max: usize, organization: bool) -> bool {
    string(v).is_ok_and(|s| safe(&json!(s), min, max, organization))
}

fn sha(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.strip_prefix("sha256:").is_some_and(|h| {
            h.len() == 64
                && h.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    })
}
fn hash(kind: &str, v: &Value) -> Result<String> {
    production_hash_record_v1(kind, v)
        .map(|h| h.as_str().to_owned())
        .map_err(|_| MATERIAL)
}
fn string(v: &Value) -> Result<String> {
    if matches!(v, Value::Null | Value::Bool(false)) || v.as_f64() == Some(0.0) {
        Ok(String::new())
    } else {
        crate::native_research_claims::raw_string(v).map_err(|_| MATERIAL)
    }
}
fn number(v: &Value) -> Result<f64> {
    crate::native_research_claims::number(v).map_err(|_| MATERIAL)
}
fn relative(v: &Value, config: &Path) -> Result<PathBuf> {
    let p = PathBuf::from(string(v)?);
    let p = if p.is_absolute() {
        p
    } else {
        config.parent().ok_or(MATERIAL)?.join(p)
    };
    resolve_path(&p).ok_or(MATERIAL)
}
fn public_metadata(p: &Path, maximum: u64, executable: bool) -> Result<Metadata> {
    let m = fs::symlink_metadata(p).map_err(|_| INTEGRITY)?;
    let uid = nix::unistd::Uid::current().as_raw();
    if fs::canonicalize(p).map_err(|_| INTEGRITY)? != p
        || !m.is_file()
        || m.file_type().is_symlink()
        || m.nlink() != 1
        || m.len() == 0
        || m.len() > maximum
        || (m.uid() != 0 && m.uid() != uid)
        || m.mode() & 0o022 != 0
        || (executable && m.mode() & 0o111 == 0)
    {
        return Err(INTEGRITY);
    }
    Ok(m)
}
struct PublicFile {
    bytes: Vec<u8>,
    hash: String,
    metadata: Metadata,
}
fn read_public(
    p: &Path,
    maximum: u64,
    executable: bool,
    control: Option<&Control<'_>>,
) -> Result<PublicFile> {
    check_control(control).map_err(|_| INTEGRITY)?;
    let before = public_metadata(p, maximum, executable)?;
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(p)
        .map_err(|_| INTEGRITY)?;
    let opened = f.metadata().map_err(|_| INTEGRITY)?;
    if !same_identity(&before, &opened) {
        return Err(INTEGRITY);
    }
    let mut bytes = Vec::new();
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut total = 0_u64;
    loop {
        check_control(control).map_err(|_| INTEGRITY)?;
        let n = f.read(&mut buffer).map_err(|_| INTEGRITY)?;
        if n == 0 {
            break;
        }
        total = total.checked_add(n as u64).ok_or(INTEGRITY)?;
        if total > maximum {
            return Err(INTEGRITY);
        }
        digest.update(&buffer[..n]);
        if !executable {
            bytes.extend_from_slice(&buffer[..n]);
        }
    }
    let after = f.metadata().map_err(|_| INTEGRITY)?;
    let named = fs::symlink_metadata(p).map_err(|_| INTEGRITY)?;
    if total != before.len() || !same_identity(&before, &after) || !same_identity(&after, &named) {
        return Err(INTEGRITY);
    }
    check_control(control).map_err(|_| INTEGRITY)?;
    Ok(PublicFile {
        bytes,
        hash: format!("sha256:{:x}", digest.finalize()),
        metadata: before,
    })
}
fn organization(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    if s.is_empty()
        || s.len() > 192
        || !s.as_bytes()[0].is_ascii_alphanumeric()
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b" ._():/-".contains(&b))
    {
        return None;
    }
    Some(
        s.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase(),
    )
}
fn key(
    v: &Value,
    config: &Path,
    role: &str,
    probe: bool,
    control: Option<&Control<'_>>,
) -> Result<Value> {
    const BAD_KEY: &str = "research_execution_release_attestor_trusted_signer_invalid";
    if !exact(v, KEY_KEYS)
        || !safe_coerced(&v["keyId"], 3, 160, false)
        || !safe_coerced(&v["keyVersion"], 1, 160, false)
        || !safe_coerced(&v["subjectId"], 3, 160, false)
        || !safe_coerced(&v["organization"], 1, 160, true)
        || v["algorithm"] != "ed25519"
        || v["role"] != role
    {
        return Err(BAD_KEY);
    }
    let file = read_public(
        &relative(&v["publicKeyPath"], config)?,
        64 * 1024,
        false,
        control,
    )?;
    let pem = std::str::from_utf8(&file.bytes)
        .map_err(|_| "research_execution_release_attestor_public_key_invalid")?;
    if pem.contains("PRIVATE KEY") {
        return Err("research_execution_release_attestor_public_key_invalid");
    }
    let vk = VerifyingKey::from_public_key_pem(pem)
        .map_err(|_| "research_execution_release_attestor_public_key_invalid")?;
    let der = vk
        .to_public_key_der()
        .map_err(|_| "research_execution_release_attestor_public_key_invalid")?;
    let start = author::instant_millis(&v["effectiveFrom"]);
    let end = author::instant_millis(&v["expiresAt"]);
    if (if probe {
        v["status"] != "active"
    } else {
        v["status"] != "active" && v["status"] != "retiring"
    }) || start.zip(end).is_none_or(|(a, b)| a >= b)
        || (!v["revokedAt"].is_null() && author::instant_millis(&v["revokedAt"]).is_none())
    {
        return Err("research_execution_release_attestor_trust_key_window_invalid");
    }
    if probe && !v["revokedAt"].is_null() {
        return Err("research_execution_release_attestor_probe_attestor_revoked");
    }
    Ok(
        json!({"keyId":string(&v["keyId"])?,"keyVersion":string(&v["keyVersion"])?,"subjectId":string(&v["subjectId"])?,"organization":string(&v["organization"])?,
        "role":role,"algorithm":"ed25519","status":v["status"],"publicKeySpkiHash":bytes_hash(der.as_bytes()),
        "effectiveFrom":v["effectiveFrom"],"expiresAt":v["expiresAt"],"revokedAt":v["revokedAt"]}),
    )
}
fn disclosed(v: &Value) -> bool {
    match v {
        Value::String(s) => {
            s.contains("-----BEGIN PRIVATE KEY-----")
                || s.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----")
        }
        Value::Array(a) => a.iter().any(disclosed),
        Value::Object(o) => o.iter().any(|(k, v)| {
            [
                "privatekey",
                "privatekeypath",
                "privatekeypem",
                "privatekeymaterial",
            ]
            .contains(&k.to_ascii_lowercase().as_str())
                || disclosed(v)
        }),
        _ => false,
    }
}
fn credential(p: &Path) -> Result<Value> {
    const BAD: &str = "research_execution_release_attestor_backend_credential_root_invalid";
    let a = fs::symlink_metadata(p).map_err(|_| BAD)?;
    if fs::canonicalize(p).map_err(|_| BAD)? != p
        || !a.is_dir()
        || a.file_type().is_symlink()
        || a.mode() & 0o077 != 0
    {
        return Err(BAD);
    }
    let mut payload = json!({"realpath":p.to_str().ok_or(BAD)?,"device":a.dev().to_string(),"inode":a.ino().to_string(),"uid":a.uid(),"mode":a.mode()&0o777});
    let identity = hash(
        "ResearchExecutionReleaseSignerCredentialRootIdentity",
        &payload,
    )?;
    let b = fs::symlink_metadata(p).map_err(|_| BAD)?;
    if !same_identity(&a, &b) {
        return Err(BAD);
    }
    payload["identityHash"] = json!(identity);
    Ok(payload)
}
fn command(
    v: &Value,
    config: &Path,
    environment: &BTreeMap<String, String>,
    protocol: &str,
    signer: bool,
    control: Option<&Control<'_>>,
) -> Result<Value> {
    let bad = if signer {
        "research_execution_release_attestor_signer_command_configuration_invalid"
    } else {
        "research_execution_release_attestor_probe_command_configuration_invalid"
    };
    let timeout = number(&v["timeoutMs"])?;
    if !exact(v, COMMAND_KEYS)
        || v["protocol"] != protocol
        || !safe_coerced(&v["serviceId"], 3, 160, false)
        || !safe_coerced(&v["principalId"], 3, 160, false)
        || !v["args"].as_array().is_some_and(Vec::is_empty)
        || !v["environmentAllowlist"]
            .as_array()
            .is_some_and(Vec::is_empty)
        || !timeout.is_finite()
        || timeout.fract() != 0.0
        || !(1000.0..=300000.0).contains(&timeout)
    {
        return Err(bad);
    }
    let path = relative(&v["executable"], config)?;
    let file = read_public(&path, 1024 * 1024 * 1024, true, control)?;
    let root = relative(&v["credentialRoot"], config)?;
    let credential = credential(&root)?;
    let mut child = BTreeMap::new();
    for k in PASSIVE_RELEASE_ATTESTOR_ENVIRONMENT_KEYS {
        if let Some(v) = environment.get(k) {
            child.insert(k.to_owned(), v.clone());
        }
    }
    child.insert(
        "HEPTA_RELEASE_SIGNER_SERVICE_ID".into(),
        string(&v["serviceId"])?,
    );
    child.insert(
        "HEPTA_RELEASE_SIGNER_PRINCIPAL_ID".into(),
        string(&v["principalId"])?,
    );
    child.insert(
        "HEPTA_RELEASE_SIGNER_CREDENTIAL_ROOT".into(),
        root.to_str().ok_or(bad)?.to_owned(),
    );
    let child_hash = hash(
        "ResearchExecutionReleaseSignerChildEnvironmentIdentity",
        &json!(child),
    )?;
    let mut base = json!({"serviceId":string(&v["serviceId"])?,"principalId":string(&v["principalId"])?,"protocol":protocol,
        "executable":path.to_str().ok_or(bad)?,"executableContentHash":file.hash,"executableDevice":file.metadata.dev().to_string(),
        "executableInode":file.metadata.ino().to_string(),"credentialRoot":root.to_str().ok_or(bad)?,"credentialRootIdentityHash":credential["identityHash"],
        "args":[],"environmentAllowlist":[],"timeoutMs":timeout as u64,"configurationDirectory":config.parent().and_then(Path::to_str).ok_or(bad)?,
        "childEnvironmentIdentityHash":child_hash});
    let identity = hash("ResearchExecutionReleaseSignerCommandIdentity", &base)?;
    base["commandIdentityHash"] = json!(identity);
    Ok(base)
}
struct Configuration {
    identity: String,
    descriptor: Value,
    active: Value,
    keys: Vec<Value>,
    bundle: Value,
    evidence: author::PassiveEvidenceInspection,
}
fn configured(
    raw: &[u8],
    config: &Path,
    environment: &BTreeMap<String, String>,
    now: i64,
    control: Option<&Control<'_>>,
) -> Result<Configuration> {
    let mut v: Value = serde_json::from_slice(raw).map_err(|_| MATERIAL)?;
    author::normalize_numbers(&mut v);
    if disclosed(&v) {
        return Err("research_execution_release_attestor_private_key_disclosure_forbidden");
    }
    let lifetime = number(&v["attestationLifetimeSeconds"])? * 1000.0;
    if !exact(&v, CONFIG_KEYS)
        || v["version"] != 3
        || v["kind"] != "ResearchExecutionReleaseAttestorConfiguration"
        || v["status"] != "active"
        || !exact(&v["trustSet"], &["keys", "kind", "version"])
        || v["trustSet"]["version"] != 1
        || v["trustSet"]["kind"] != "ResearchExecutionReleaseAttestorTrustSet"
        || !v["trustSet"]["keys"]
            .as_array()
            .is_some_and(|a| (1..=32).contains(&a.len()))
        || !exact(&v["backend"], BACKEND_KEYS)
        || !exact(&v["backend"]["signerCommand"], COMMAND_KEYS)
        || !exact(&v["backend"]["probeCommand"], COMMAND_KEYS)
        || !exact(&v["backend"]["probeAttestor"], KEY_KEYS)
        || !lifetime.is_finite()
        || lifetime.fract() != 0.0
        || !(60000.0..=2678400000.0).contains(&lifetime)
    {
        return Err(MATERIAL);
    }
    let mut keys = v["trustSet"]["keys"]
        .as_array()
        .ok_or(MATERIAL)?
        .iter()
        .map(|v| key(v, config, ROLE, false, control))
        .collect::<Result<Vec<_>>>()?;
    let collation = ProductionCollationV1::load().map_err(|_| MATERIAL)?;
    keys.sort_by(|a, b| {
        collation.compare(
            &format!(
                "{}:{}",
                a["keyId"].as_str().unwrap_or_default(),
                a["keyVersion"].as_str().unwrap_or_default()
            ),
            &format!(
                "{}:{}",
                b["keyId"].as_str().unwrap_or_default(),
                b["keyVersion"].as_str().unwrap_or_default()
            ),
        )
    });
    let mut tuples = BTreeSet::new();
    let mut spkis = BTreeSet::new();
    if keys.iter().any(|k| {
        !tuples.insert((
            k["keyId"].clone().to_string(),
            k["keyVersion"].clone().to_string(),
        )) || !spkis.insert(k["publicKeySpkiHash"].clone().to_string())
    }) {
        return Err("research_execution_release_attestor_trust_set_key_identity_collision");
    }
    let active = keys
        .iter()
        .filter(|k| k["status"] == "active" && k["revokedAt"].is_null())
        .cloned()
        .collect::<Vec<_>>();
    if active.len() != 1 {
        return Err("research_execution_release_attestor_exactly_one_active_key_required");
    }
    let active = active.into_iter().next().ok_or(MATERIAL)?;
    let trust_hash = hash(
        "ResearchExecutionReleaseAttestorTrustSet",
        &json!({"version":1,"keys":keys}),
    )?;
    let probe = key(
        &v["backend"]["probeAttestor"],
        config,
        PROBE_ROLE,
        true,
        control,
    )?;
    if probe["subjectId"] == active["subjectId"]
        || organization(&probe["organization"]) == organization(&active["organization"])
    {
        return Err(INDEPENDENCE);
    }
    let b = &v["backend"];
    if b["kind"] != "external-kms-command"
        || !safe_coerced(&b["backendId"], 3, 160, false)
        || !safe_coerced(&b["backendVersion"], 1, 160, false)
        || b["algorithm"] != "ed25519"
        || b["externalSignerProcess"] != true
        || b["hardwareProtected"] != true
        || b["privateKeyExportable"] != false
        || !safe_coerced(&b["kmsProvider"], 3, 160, false)
        || ![
            "providerAccountIdentityHash",
            "keyResourceIdentityHash",
            "credentialGenerationIdentityHash",
        ]
        .iter()
        .all(|k| {
            b[k].as_str()
                .is_some_and(|s| sha(&json!(s.to_ascii_lowercase())))
        })
        || b["activeKeyId"] != active["keyId"]
        || b["activeKeyVersion"] != active["keyVersion"]
        || !b["signerCommand"]["args"]
            .as_array()
            .is_some_and(Vec::is_empty)
        || !b["probeCommand"]["args"]
            .as_array()
            .is_some_and(Vec::is_empty)
        || !b["signerCommand"]["environmentAllowlist"]
            .as_array()
            .is_some_and(Vec::is_empty)
        || !b["probeCommand"]["environmentAllowlist"]
            .as_array()
            .is_some_and(Vec::is_empty)
    {
        return Err("research_execution_release_attestor_backend_descriptor_invalid");
    }
    let signer = command(
        &b["signerCommand"],
        config,
        environment,
        "hepta-release-signer-json-stdio-v2",
        true,
        control,
    )?;
    let probe_command = command(
        &b["probeCommand"],
        config,
        environment,
        "hepta-release-signer-probe-json-stdio-v1",
        false,
        control,
    )?;
    if [
        "serviceId",
        "principalId",
        "commandIdentityHash",
        "executableContentHash",
        "credentialRootIdentityHash",
    ]
    .iter()
    .any(|k| signer[k] == probe_command[k])
        || keys
            .iter()
            .any(|k| k["publicKeySpkiHash"] == probe["publicKeySpkiHash"])
    {
        return Err(INDEPENDENCE);
    }
    let mut descriptor = json!({"version":1,"kind":"ResearchExecutionReleaseSignerBackendDescriptor","backendKind":"external-kms-command",
        "backendId":string(&b["backendId"])?,"backendVersion":string(&b["backendVersion"])?,"algorithm":"ed25519","hardwareProtected":true,
        "privateKeyExportable":false,"externalSignerProcess":true,"productionEligible":true,
        "assuranceProfile":"external-hardware-kms-control-plane-bindable-v2","threatBoundary":"external-kms-control-plane",
        "kmsProvider":string(&b["kmsProvider"])?,"providerAccountIdentityHash":string(&b["providerAccountIdentityHash"])?.to_ascii_lowercase(),
        "keyResourceIdentityHash":string(&b["keyResourceIdentityHash"])?.to_ascii_lowercase(),"credentialGenerationIdentityHash":string(&b["credentialGenerationIdentityHash"])?.to_ascii_lowercase(),
        "activeKeyId":active["keyId"],"activeKeyVersion":active["keyVersion"],"activePublicKeySpkiHash":active["publicKeySpkiHash"],
        "trustSetHash":trust_hash,"commandIdentityHash":signer["commandIdentityHash"],"probeCommandIdentityHash":probe_command["commandIdentityHash"],
        "probeAttestorPublicKeySpkiHash":probe["publicKeySpkiHash"],"credentialMaterialReadByMainProcess":false});
    let descriptor_hash = hash(
        "ResearchExecutionReleaseSignerBackendDescriptor",
        &descriptor,
    )?;
    descriptor["researchExecutionReleaseSignerBackendDescriptorHash"] = json!(descriptor_hash);
    let h = &v["hardwareAuthorityAttestation"];
    let ids = h["signerKeyIds"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        })
        .ok_or(
            "research_execution_release_attestor_kms_hardware_authority_configuration_invalid",
        )?;
    let mut ordered = ids.clone();
    ordered.sort();
    ordered.dedup();
    if !exact(
        h,
        &[
            "bundlePath",
            "challengeHash",
            "signerKeyIds",
            "trustStoreHash",
        ],
    ) || ids != ordered
        || !(1..=4).contains(&ids.len())
        || ids.iter().any(|s| !safe(&json!(s), 3, 160, false))
        || !["challengeHash", "trustStoreHash"].iter().all(|k| {
            h[k].as_str()
                .is_some_and(|s| sha(&json!(s.to_ascii_lowercase())))
        })
    {
        return Err(
            "research_execution_release_attestor_kms_hardware_authority_configuration_invalid",
        );
    }
    let bundle_path = relative(&h["bundlePath"], config)?;
    let bundle_file = read_public(&bundle_path, 1024 * 1024, false, control)
        .map_err(|_| "research_execution_release_attestor_kms_hardware_authority_file_invalid")?;
    let mut bundle: Value =
        serde_json::from_slice(&bundle_file.bytes).map_err(|_| HARDWARE_BUNDLE)?;
    author::normalize_numbers(&mut bundle);
    if !author::hardware_bundle_order(&bundle_file.bytes)
        || !exact(
            &bundle,
            &[
                "authorityEnvelope",
                "bundleHash",
                "kind",
                "maximumLifetimeMs",
                "signerKeyIds",
                "signerRole",
                "subject",
                "trustStore",
                "trustStoreHash",
                "version",
            ],
        )
        || bundle["version"] != 1
        || bundle["kind"] != "ResearchExecutionReleaseKmsHardwareAttestationBundle"
        || bundle["signerRole"] != HARDWARE_ROLE
        || bundle["signerKeyIds"] != json!(ids)
        || bundle["trustStoreHash"] != json!(string(&h["trustStoreHash"])?.to_ascii_lowercase())
        || bundle["subject"]["challengeHash"]
            != json!(string(&h["challengeHash"])?.to_ascii_lowercase())
        || !bundle["maximumLifetimeMs"]
            .as_u64()
            .is_some_and(|n| (1000..=900000).contains(&n))
    {
        return Err(HARDWARE_BUNDLE);
    }
    let subject = &bundle["subject"];
    let subject_hash = subject["researchExecutionReleaseKmsHardwareAttestationSubjectHash"]
        .as_str()
        .ok_or(HARDWARE_BUNDLE)?;
    let mut subject_payload = subject.clone();
    subject_payload
        .as_object_mut()
        .ok_or(HARDWARE_BUNDLE)?
        .remove("researchExecutionReleaseKmsHardwareAttestationSubjectHash");
    if hash(HARDWARE_KIND, &subject_payload)? != subject_hash
        || subject["version"] != 1
        || subject["kind"] != HARDWARE_KIND
        || ["kmsProvider", "backendId", "activeKeyId"]
            .iter()
            .any(|k| !safe(&subject[k], 3, 192, false))
        || ["backendVersion", "activeKeyVersion"]
            .iter()
            .any(|k| !safe(&subject[k], 1, 192, false))
        || [
            "providerAccountIdentityHash",
            "keyResourceIdentityHash",
            "credentialGenerationIdentityHash",
            "backendDescriptorHash",
            "activePublicKeySpkiHash",
            "trustSetHash",
            "challengeHash",
        ]
        .iter()
        .any(|k| !sha(&subject[k]))
        || subject["algorithm"] != "ed25519"
        || subject["assuranceProfile"] != "external-kms-control-plane-hardware-attested-v1"
        || subject["hardwareProtected"] != true
        || subject["privateKeyExportable"] != false
        || subject["keyOrigin"] != "hardware-generated"
        || subject["keyUsage"] != "sign-verify-only"
        || author::instant_millis(&subject["attestedAt"])
            .zip(author::instant_millis(&subject["expiresAt"]))
            .is_none_or(|(a, b)| {
                b <= a || b - a > bundle["maximumLifetimeMs"].as_u64().unwrap_or_default() as i64
            })
    {
        return Err(HARDWARE_BUNDLE);
    }
    let mut payload = bundle.clone();
    payload
        .as_object_mut()
        .ok_or(HARDWARE_BUNDLE)?
        .remove("bundleHash");
    if hash(
        "ResearchExecutionReleaseKmsHardwareAttestationBundle",
        &payload,
    )? != bundle["bundleHash"]
    {
        return Err(HARDWARE_BUNDLE);
    }
    let evidence =
        author::inspect_passive_evidence(&bundle, HARDWARE_KIND, subject_hash, HARDWARE_ROLE, now)
            .ok_or(HARDWARE_BUNDLE)?;
    let identity = hash(
        "ResearchExecutionReleaseAttestorConfigurationIdentity",
        &json!({"version":3,"lifetimeMs":lifetime as u64,
        "trustSetVersion":1,"trustSetHash":trust_hash,"backendDescriptorHash":descriptor_hash,"probeAttestor":probe,
        "kmsHardwareAuthorityPolicy":{"verificationPolicy":"pinned-independent-kms-control-plane-ed25519-v1",
            "bundlePath":bundle_path.to_str().ok_or(MATERIAL)?,"trustStoreHash":string(&h["trustStoreHash"])?.to_ascii_lowercase(),
            "signerKeyIds":ids,"challengeHash":string(&h["challengeHash"])?.to_ascii_lowercase()}}),
    )?;
    Ok(Configuration {
        identity,
        descriptor,
        active,
        keys: keys.into_iter().chain([probe]).collect(),
        bundle,
        evidence,
    })
}

fn invalid_configuration(code: &str, expected_hash: Option<&str>) -> Value {
    let mut report = blocked_release(code);
    report["configurationVersion"] = json!(3);
    // The original passive inspection treats an absent backend descriptor as exportable.
    report["privateKeyExportable"] = json!(true);
    let mut blockers = vec![
        code,
        if expected_hash.is_none() {
            "research_execution_release_attestor_config_pin_required"
        } else {
            "research_execution_release_attestor_config_pin_mismatch"
        },
        "research_execution_release_attestor_external_kms_v3_configuration_required",
        "research_execution_release_attestor_full_production_hardware_kms_required",
        "research_execution_release_attestor_kms_hardware_authority_attestation_required",
    ];
    let mut seen = BTreeSet::new();
    blockers.retain(|v| seen.insert(*v));
    report["blockers"] = json!(blockers);
    report
}
pub(super) fn inspect_release_v3(
    raw: &[u8],
    config: &Path,
    expected_hash: Option<&str>,
    environment: &BTreeMap<String, String>,
    now: &str,
    control: Option<&Control<'_>>,
) -> Value {
    let Some(timestamp) = author::instant_millis(&json!(now)) else {
        return blocked_release("research_execution_release_attestor_inspection_time_invalid");
    };
    let selected = match configured(raw, config, environment, timestamp, control) {
        Ok(c) => c,
        Err(code) => return invalid_configuration(code, expected_hash),
    };
    let c = selected;
    let d = &c.descriptor;
    let s = &c.bundle["subject"];
    let mut blockers = Vec::<&str>::new();
    if author::instant_millis(&c.active["effectiveFrom"]).is_none_or(|a| timestamp < a)
        || author::instant_millis(&c.active["expiresAt"]).is_none_or(|a| timestamp >= a)
        || author::instant_millis(&c.active["revokedAt"]).is_some_and(|a| timestamp >= a)
    {
        blockers.push("research_execution_release_attestor_key_not_currently_valid");
    }
    let mut hardware = Vec::new();
    if author::instant_millis(&s["attestedAt"]).is_none_or(|a| timestamp < a)
        || author::instant_millis(&s["expiresAt"]).is_none_or(|a| timestamp >= a)
    {
        hardware.push("research_execution_release_kms_hardware_attestation_subject_invalid");
    }
    if [
        "kmsProvider",
        "providerAccountIdentityHash",
        "keyResourceIdentityHash",
        "credentialGenerationIdentityHash",
        "backendId",
        "backendVersion",
        "activeKeyId",
        "activeKeyVersion",
        "activePublicKeySpkiHash",
        "trustSetHash",
    ]
    .iter()
    .any(|k| s[k] != d[k])
        || s["backendDescriptorHash"] != d["researchExecutionReleaseSignerBackendDescriptorHash"]
    {
        hardware.push("research_execution_release_kms_hardware_attestation_binding_invalid");
    }
    if !c.evidence.cryptographic_ready {
        hardware.push("research_execution_release_kms_hardware_attestation_signature_invalid");
    }
    if c.evidence.verified_keys.is_empty()
        || c.evidence.verified_keys.iter().any(|k| {
            organization(&k["organization"]).is_none()
                || c.keys.iter().any(|p| {
                    k["publicKeySpkiHash"] == p["publicKeySpkiHash"]
                        || k["subjectId"] == p["subjectId"]
                        || organization(&k["organization"]) == organization(&p["organization"])
                })
        })
    {
        hardware.push(
            "research_execution_release_kms_hardware_attestation_authority_independence_invalid",
        );
    }
    let authority = hardware.is_empty();
    blockers.extend(hardware);
    let pinned = expected_hash.is_some_and(|h| h == c.identity);
    blockers.extend(match expected_hash {
        None => Some("research_execution_release_attestor_config_pin_required"),
        Some(_) if !pinned => Some("research_execution_release_attestor_config_pin_mismatch"),
        Some(_) => None,
    });
    if !authority {
        blockers.push(
            "research_execution_release_attestor_kms_hardware_authority_attestation_required",
        );
    }
    let mut seen = BTreeSet::new();
    blockers.retain(|b| seen.insert(*b));
    let ready = blockers.is_empty();
    json!({"status":if ready {"production_external_release_attestor_input_ready_for_live_verification"} else {"production_external_release_attestor_input_blocked"},
        "readyForLiveVerification":ready,"configured":true,"configurationVersion":3,"configurationPinned":pinned,
        "observedConfigurationFileHash":bytes_hash(raw),"observedConfigurationIdentityHash":c.identity,
        "configurationIdentityProfile":"stable-kms-authority-policy-and-rotating-bundle-v3","backendKind":"external-kms-command",
        "backendDescriptorHash":d["researchExecutionReleaseSignerBackendDescriptorHash"],"hardwareProtected":true,"privateKeyExportable":false,
        "externalSignerProcess":true,"kmsHardwareAuthorityReady":authority,"kmsHardwareAuthorityIndependent":authority,
        "kmsHardwareAuthorityBundleHash":c.bundle["bundleHash"],"kmsHardwareAuthorityExpiresAt":s["expiresAt"],
        "liveProbeRequired":ready,"liveSignerChallengeRequired":ready,"externalActionPerformed":false,"blockers":blockers})
}
