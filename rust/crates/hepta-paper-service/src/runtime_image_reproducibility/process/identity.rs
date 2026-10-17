use super::*;
use base64ct::{Base64, Encoding};
use std::{collections::BTreeSet, fs, os::unix::fs::MetadataExt};
const USAGE: &str = "exclusive-private-principal-material-only-v1";
const ROLE: &str = "runtime_image_reproducibility_external_verifier";
const BASE_ENV: [&str; 15] = [
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
pub(super) fn private_material(v: &Value) -> bool {
    match v {
        Value::Object(o) => o.iter().any(|(k, v)| {
            let k = k.to_ascii_lowercase();
            (k.contains("private") && k.contains("key")) || private_material(v)
        }),
        Value::Array(a) => a.iter().any(private_material),
        Value::String(s) => s.contains("PRIVATE KEY-----"),
        _ => false,
    }
}
fn resolved(config: &Path, value: &Value, allow_link: bool) -> Result<PathBuf> {
    let value = s(value);
    ensure(
        !value.is_empty() && value.len() <= 4096 && !value.contains('\0'),
        "runtime_reproducibility_path_not_canonical",
    )?;
    let p = if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        config
            .parent()
            .ok_or_else(|| Error("runtime_reproducibility_path_not_canonical".into()))?
            .join(value)
    };
    let real = fs::canonicalize(&p)?;
    ensure(
        allow_link || p == real,
        "runtime_reproducibility_path_not_canonical",
    )?;
    Ok(real)
}
fn credentials(root: &Path) -> Result<Value> {
    let st = fs::symlink_metadata(root)?;
    ensure(
        st.is_dir() && st.mode() & 0o077 == 0 && st.uid() == nix::unistd::geteuid().as_raw(),
        "runtime_reproducibility_credential_root_invalid",
    )?;
    struct Scan {
        entries: Vec<Value>,
        material: Vec<Value>,
        total: u64,
    }
    fn walk(root: &Path, dir: &Path, uid: u32, scan: &mut Scan, depth: u32) -> Result<()> {
        ensure(
            depth <= 64 && scan.entries.len() < 20_000,
            "runtime_reproducibility_credential_root_contents_too_large",
        )?;
        let mut entries = fs::read_dir(dir)?
            .map(|e| e.map(|e| e.path()))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        entries.sort();
        for path in entries {
            let st = fs::symlink_metadata(&path)?;
            ensure(
                !st.file_type().is_symlink() && st.mode() & 0o077 == 0 && st.uid() == uid,
                "runtime_reproducibility_credential_root_contents_invalid",
            )?;
            let rel = path
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .ok_or_else(|| Error("runtime_reproducibility_path_not_canonical".into()))?;
            if st.is_dir() {
                scan.entries.push(json!({"path":format!("{rel}/"),"mode":st.mode()&0o777,"uid":st.uid(),"nlink":st.nlink()}));
                walk(root, &path, uid, scan, depth + 1)?;
            } else {
                ensure(
                    st.is_file() && st.nlink() == 1 && st.len() > 0,
                    "runtime_reproducibility_credential_root_contents_invalid",
                )?;
                ensure(
                    scan.material.len() < 10_000 && scan.total + st.len() <= 256 * 1024 * 1024,
                    "runtime_reproducibility_credential_root_contents_too_large",
                )?;
                let bytes = read(&path, 256 * 1024 * 1024)?;
                let h = digest(&bytes);
                scan.total += bytes.len() as u64;
                scan.entries.push(json!({"path":rel,"mode":st.mode()&0o777,"uid":st.uid(),"nlink":st.nlink(),"bytes":bytes.len(),"contentHash":h}));
                scan.material
                    .push(json!({"bytes":bytes.len(),"contentHash":h}));
            }
        }
        Ok(())
    }
    let mut scan = Scan {
        entries: vec![],
        material: vec![],
        total: 0,
    };
    walk(root, root, st.uid(), &mut scan, 0)?;
    ensure(
        !scan.material.is_empty(),
        "runtime_reproducibility_credential_root_contents_invalid",
    )?;
    scan.material.sort_by(|a, b| {
        s(&a["contentHash"])
            .cmp(s(&b["contentHash"]))
            .then(a["bytes"].as_u64().cmp(&b["bytes"].as_u64()))
    });
    let contents = hash(
        "RuntimeReproducibilityCredentialRootContentsIdentity",
        &json!({"entries":scan.entries,"fileCount":scan.material.len(),"totalBytes":scan.total}),
    )?;
    let material = hash(
        "RuntimeReproducibilityCredentialMaterialIdentity",
        &json!({"materialEntries":scan.material,"fileCount":scan.material.len(),"totalBytes":scan.total}),
    )?;
    let mut v = json!({"realpath":root,"device":st.dev().to_string(),"inode":st.ino().to_string(),"uid":st.uid(),"nlink":st.nlink(),"mode":st.mode()&0o777,"contentsIdentityHash":contents,"materialIdentityHash":material});
    v = seal(
        "RuntimeReproducibilityCredentialRootIdentity",
        v,
        "credentialRootIdentityHash",
    )?;
    v["materialContentHashes"] = json!(
        scan.material
            .iter()
            .map(|e| s(&e["contentHash"]))
            .collect::<BTreeSet<_>>()
    );
    Ok(v)
}
fn interpreter(
    executable: &Path,
    bytes: &[u8],
    environment: &BTreeMap<String, String>,
) -> Result<Value> {
    let first = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
    let first = first.lines().next().unwrap_or("");
    let Some(shebang) = first.strip_prefix("#!") else {
        return Ok(Value::Null);
    };
    let words: Vec<_> = shebang.split_whitespace().collect();
    ensure(
        !words.is_empty(),
        "runtime_reproducibility_interpreter_invalid",
    )?;
    let launcher = fs::canonicalize(words[0])?;
    let mut paths = vec![launcher.clone()];
    if launcher.file_name().is_some_and(|n| n == "env") {
        let program = words
            .iter()
            .skip(1)
            .find(|w| !w.starts_with('-'))
            .ok_or_else(|| Error("runtime_reproducibility_interpreter_invalid".into()))?;
        ensure(
            !program.contains('/'),
            "runtime_reproducibility_interpreter_invalid",
        )?;
        let selected = environment
            .get("PATH")
            .into_iter()
            .flat_map(|p| p.split(':'))
            .filter(|p| !p.is_empty())
            .map(|dir| Path::new(dir).join(program))
            .find(|p| fs::metadata(p).is_ok_and(|st| st.is_file() && st.mode() & 0o111 != 0))
            .ok_or_else(|| Error("runtime_reproducibility_interpreter_not_found".into()))?;
        paths.push(fs::canonicalize(selected)?);
    }
    let mut identities = Vec::new();
    for path in paths {
        ensure(
            path != executable,
            "runtime_reproducibility_interpreter_invalid",
        )?;
        let st = fs::metadata(&path)?;
        let bytes = read(&path, 256 * 1024 * 1024)?;
        identities.push(json!({"realpath":path,"device":st.dev().to_string(),"inode":st.ino().to_string(),"contentHash":digest(&bytes)}));
    }
    Ok(hash(
        "RuntimeReproducibilityInterpreterIdentity",
        &json!(identities),
    )?
    .into())
}
pub(super) fn command(v: &Value, path: &Path, environment: &Value) -> Result<VerifierProcess> {
    let env_key = |k: &str| {
        !k.is_empty()
            && k.len() <= 128
            && (k.as_bytes()[0].is_ascii_uppercase() || k.starts_with('_'))
            && k.bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    };
    ensure(
        exact(
            v,
            &[
                "args",
                "backend",
                "credentialRoot",
                "environmentAllowlist",
                "executable",
                "principalId",
                "protocol",
                "serviceId",
                "timeoutMs",
            ],
        ) && id(&v["serviceId"])
            && id(&v["principalId"])
            && v["protocol"] == "runtime-image-reproducibility-json-stdio-v1"
            && v["args"].is_array()
            && array(&v["args"]).len() <= 64
            && array(&v["args"]).iter().all(|x| {
                x.as_str()
                    .is_some_and(|s| s.len() <= 4096 && !s.contains('\0'))
            })
            && v["environmentAllowlist"].is_array()
            && array(&v["environmentAllowlist"]).len() <= 128
            && array(&v["environmentAllowlist"]).iter().all(|x| {
                env_key(s(x))
                    && !["DOCKER_", "BUILDKIT_", "BUILDX_"]
                        .iter()
                        .any(|p| s(x).starts_with(p))
                    && x != "HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH"
            })
            && v["timeoutMs"]
                .as_u64()
                .is_some_and(|n| (1000..=14_400_000).contains(&n)),
        "runtime_reproducibility_verifier_command_invalid",
    )?;
    let backend = &v["backend"];
    ensure(
        exact(
            backend,
            &[
                "backendId",
                "buildkitVersion",
                "endpointTlsSpkiHash",
                "platform",
                "stateRootIdentityHash",
                "workerId",
            ],
        ) && ["backendId", "buildkitVersion", "workerId"]
            .iter()
            .all(|k| id(&backend[*k]))
            && backend["platform"] == "linux/amd64"
            && sha(&backend["endpointTlsSpkiHash"])
            && sha(&backend["stateRootIdentityHash"]),
        "runtime_reproducibility_backend_identity_invalid",
    )?;
    let backend = seal(
        "RuntimeImageReproducibilityBackendIdentity",
        backend.clone(),
        "backendIdentityHash",
    )?;
    let executable = resolved(path, &v["executable"], true)?;
    let st = fs::metadata(&executable)?;
    let bytes = read(&executable, 256 * 1024 * 1024)?;
    ensure(
        st.mode() & 0o111 != 0 && !bytes.is_empty(),
        "runtime_reproducibility_integrity_file_invalid",
    )?;
    let root = resolved(path, &v["credentialRoot"], false)?;
    let cred = credentials(&root)?;
    let mut allow = Vec::new();
    for k in array(&v["environmentAllowlist"]) {
        if !allow.contains(k) {
            allow.push(k.clone());
        }
    }
    let mut child_env = BTreeMap::new();
    for key in BASE_ENV.into_iter().chain(allow.iter().map(s)) {
        if let Some(value) = environment[key].as_str() {
            child_env.insert(key.to_owned(), value.to_owned());
        }
    }
    child_env.insert(
        "HEPTA_RUNTIME_REPRODUCIBILITY_PRINCIPAL_ID".into(),
        s(&v["principalId"]).into(),
    );
    child_env.insert(
        "HEPTA_RUNTIME_REPRODUCIBILITY_CREDENTIAL_ROOT".into(),
        root.to_string_lossy().into_owned(),
    );
    child_env.insert(
        "HEPTA_RUNTIME_REPRODUCIBILITY_BACKEND_ID".into(),
        s(&backend["backendId"]).into(),
    );
    let mut args = Vec::new();
    for (index, arg) in array(&v["args"]).iter().enumerate() {
        let candidate = if Path::new(s(arg)).is_absolute() {
            PathBuf::from(s(arg))
        } else {
            path.parent()
                .ok_or_else(|| Error("runtime_reproducibility_path_not_canonical".into()))?
                .join(s(arg))
        };
        if !candidate.try_exists()? {
            continue;
        }
        let resolved = fs::canonicalize(candidate)?;
        let st = fs::metadata(&resolved)?;
        if !st.is_file() {
            continue;
        }
        let bytes = read(&resolved, 256 * 1024 * 1024)?;
        args.push(json!({"index":index,"realpath":resolved,"device":st.dev().to_string(),"inode":st.ino().to_string(),"mode":st.mode()&0o777,"bytes":bytes.len(),"contentHash":digest(&bytes)}));
    }
    let c = json!({"serviceId":v["serviceId"],"principalId":v["principalId"],"protocol":v["protocol"],"configurationDirectory":path.parent(),"executable":executable,"executableContentHash":digest(&bytes),"executableDevice":st.dev().to_string(),"executableInode":st.ino().to_string(),"executableUid":st.uid(),"credentialRoot":root,"credentialRootIdentityHash":cred["credentialRootIdentityHash"],"credentialRootContentsIdentityHash":cred["contentsIdentityHash"],"credentialMaterialIdentityHash":cred["materialIdentityHash"],"credentialMaterialContentHashes":cred["materialContentHashes"],"credentialRootUsage":USAGE,"credentialUid":cred["uid"],"args":v["args"],"environmentAllowlist":allow,"timeoutMs":v["timeoutMs"],"backend":backend,"interpreterIdentityHash":interpreter(&executable,&bytes,&child_env)?,"childEnvironmentIdentityHash":hash("RuntimeReproducibilityChildEnvironmentIdentity",&json!(child_env))?,"argumentResourceIdentities":args});
    let pinned_executable = PinnedExecutable::open(&executable, &c)?;
    Ok(VerifierProcess {
        executable: pinned_executable,
        command: seal(
            "RuntimeReproducibilityProcessCommandIdentity",
            c,
            "commandIdentityHash",
        )?,
        environment: child_env,
    })
}
pub(super) fn signer(v: &Value, path: &Path) -> Result<(Value, String, String)> {
    ensure(
        exact(
            v,
            &[
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
            ],
        ) && ["keyId", "keyVersion", "subjectId", "organization"]
            .iter()
            .all(|k| id(&v[*k]))
            && v["role"] == ROLE
            && v["algorithm"] == "ed25519"
            && v["status"] == "active"
            && v["revokedAt"].is_null()
            && instant(&v["effectiveFrom"])
                .zip(instant(&v["expiresAt"]))
                .is_some_and(|(a, b)| a < b),
        "runtime_reproducibility_verifier_attestor_invalid",
    )?;
    let path = resolved(path, &v["publicKeyPath"], false)?;
    let bytes = read(&path, 65536)?;
    let pem = String::from_utf8(bytes)
        .map_err(|_| Error("runtime_reproducibility_verifier_public_key_invalid".into()))?;
    let body = pem
        .trim()
        .strip_prefix("-----BEGIN PUBLIC KEY-----")
        .and_then(|p| p.strip_suffix("-----END PUBLIC KEY-----"))
        .ok_or_else(|| Error("runtime_reproducibility_verifier_public_key_invalid".into()))?;
    let der = Base64::decode_vec(&body.split_ascii_whitespace().collect::<String>())
        .map_err(|_| Error("runtime_reproducibility_verifier_public_key_invalid".into()))?;
    ensure(
        der.len() == 44
            && der[..12]
                == [
                    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
                ],
        "runtime_reproducibility_verifier_public_key_invalid",
    )?;
    let raw: [u8; 32] = der[12..]
        .try_into()
        .map_err(|_| Error("runtime_reproducibility_verifier_public_key_invalid".into()))?;
    ed25519_dalek::VerifyingKey::from_bytes(&raw)
        .map_err(|_| Error("runtime_reproducibility_verifier_public_key_invalid".into()))?;
    Ok((without(v, &["publicKeyPath"]), pem, digest(&der)))
}
pub(super) fn independent(processes: &[VerifierProcess], verifiers: &[Value]) -> Result<()> {
    let (a, b) = (&processes[0].command, &processes[1].command);
    let (x, y) = (&verifiers[0], &verifiers[1]);
    let different = [
        "serviceId",
        "principalId",
        "commandIdentityHash",
        "executable",
        "executableContentHash",
        "credentialRootIdentityHash",
        "credentialRootContentsIdentityHash",
        "credentialMaterialIdentityHash",
    ]
    .iter()
    .all(|k| a[*k] != b[*k])
        && [
            "backendIdentityHash",
            "backendId",
            "workerId",
            "stateRootIdentityHash",
            "endpointTlsSpkiHash",
        ]
        .iter()
        .all(|k| a["backend"][*k] != b["backend"][*k])
        && x["signer"]["subjectId"] != y["signer"]["subjectId"]
        && !s(&x["signer"]["organization"]).eq_ignore_ascii_case(s(&y["signer"]["organization"]))
        && x["signerPublicKeySpkiHash"] != y["signerPublicKeySpkiHash"]
        && array(&a["credentialMaterialContentHashes"])
            .iter()
            .all(|h| !array(&b["credentialMaterialContentHashes"]).contains(h));
    ensure(
        different,
        "runtime_reproducibility_independent_verifiers_required",
    )
}
