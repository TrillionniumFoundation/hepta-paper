use super::{
    Error, Result,
    files::{FileKind, Observations},
    value::*,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

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
const BASE_ENVIRONMENT_KEYS: &[&str] = &[
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

pub(super) fn load(
    value: &Value,
    label: &str,
    configuration: &Path,
    environment: &BTreeMap<String, String>,
    cwd: &Path,
    observed: &mut Observations,
) -> Result<Value> {
    let code = format!("external_qualification_{label}_configuration_invalid");
    ensure(
        exact(value, COMMAND_KEYS)
            && value["protocol"] == "external-qualification-json-stdio-v1"
            && safe_id(&value["serviceId"], 3)
            && safe_id(&value["principalId"], 3)
            && value["args"].as_array().is_some_and(|args| {
                args.len() <= 64
                    && args.iter().all(|arg| {
                        arg.as_str()
                            .is_some_and(|arg| arg.encode_utf16().count() <= 4096)
                    })
            }),
        &code,
    )?;
    let allowlist = match value["environmentAllowlist"].as_array() {
        Some(values) => values,
        // The original calls .some on falsy non-arrays after its `|| []`
        // guard; preserve its stable inspection error rather than claiming
        // those JSON values form an empty allowlist.
        None if !truthy(&value["environmentAllowlist"]) => {
            return Err(Error::new(
                "external_qualification_configuration_inspection_failed",
            ));
        }
        None => return Err(Error::new(&code)),
    };
    ensure(
        allowlist.iter().all(|key| environment_key(&string(key))),
        &code,
    )?;
    ensure(
        number(&value["timeoutMs"])
            .is_some_and(|n| (1000.0..=300_000.0).contains(&n) && n.fract() == 0.0),
        &code,
    )?;
    let mut unique = Vec::<Value>::new();
    for item in allowlist {
        // Set compares JSON arrays/objects by object identity, not contents.
        let duplicate =
            !item.is_array() && !item.is_object() && unique.iter().any(|prior| prior == item);
        if !duplicate {
            unique.push(item.clone());
        }
    }
    let args = value["args"].as_array().ok_or_else(|| Error::new(&code))?;
    let executable = observed.file(
        &relative(&value["executable"], configuration)?,
        FileKind::Executable,
    )?;
    let executable_path = executable.path.clone();
    let executable_hash = executable.hash.clone();
    let executable_device = stat_number(executable.metadata.dev());
    let executable_inode = stat_number(executable.metadata.ino());
    let shebang = executable.bytes.clone();
    let credential = observed.credential(&relative(&value["credentialRoot"], configuration)?)?;
    let mut command = json!({
        "serviceId": string(&value["serviceId"]), "principalId": string(&value["principalId"]),
        "protocol": value["protocol"], "configurationDirectory": path_text(configuration.parent().ok_or_else(|| Error::new(&code))?)?,
        "executable": path_text(&executable_path)?, "executableContentHash": executable_hash,
        "executableDevice": executable_device, "executableInode": executable_inode,
        "credentialRoot": credential["realpath"], "credentialRootIdentityHash": credential["credentialRootIdentityHash"],
        "credentialRootContentsIdentityHash": credential["contentsIdentityHash"],
        "credentialRootRegularFileContentHashes": credential["regularFileContentHashes"],
        "credentialUid": credential["uid"], "args": args, "environmentAllowlist": unique,
        "timeoutMs": number(&value["timeoutMs"]).ok_or_else(|| Error::new(&code))?,
    });
    let mut child_environment = BTreeMap::new();
    for key in BASE_ENVIRONMENT_KEYS
        .iter()
        .map(|key| (*key).to_owned())
        .chain(unique.iter().map(string))
    {
        if let Some(value) = environment.get(&key) {
            child_environment.insert(key, value.clone());
        }
    }
    child_environment.insert(
        "HEPTA_EXTERNAL_QUALIFICATION_PRINCIPAL_ID".to_owned(),
        string(&value["principalId"]),
    );
    child_environment.insert(
        "HEPTA_EXTERNAL_QUALIFICATION_CREDENTIAL_ROOT".to_owned(),
        string(&credential["realpath"]),
    );
    let environment_bytes = child_environment
        .iter()
        .try_fold(0usize, |total, (key, value)| {
            total.checked_add(key.len())?.checked_add(value.len())
        });
    ensure(
        environment_bytes.is_some_and(|bytes| bytes <= 2 * 1024 * 1024),
        "external_qualification_environment_budget_exceeded",
    )?;
    command["interpreterIdentityHash"] =
        interpreter_identity(&shebang, &child_environment, cwd, observed)?;
    command["childEnvironmentIdentityHash"] = json!(hash(
        "ExternalQualificationChildEnvironmentIdentity",
        &json!(child_environment)
    )?);
    let mut resources = Vec::new();
    for (index, argument) in args.iter().enumerate() {
        if let Some(resource) = observed.argument(&relative(argument, configuration)?, index)? {
            resources.push(resource);
        }
    }
    command["argumentResourceIdentities"] = json!(resources);
    command["commandIdentityHash"] = json!(hash(
        "ExternalQualificationProcessCommandIdentity",
        &command
    )?);
    Ok(command)
}

fn environment_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_uppercase() || *byte == b'_')
        && key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn interpreter_identity(
    bytes: &[u8],
    environment: &BTreeMap<String, String>,
    cwd: &Path,
    observed: &mut Observations,
) -> Result<Value> {
    let text = String::from_utf8_lossy(bytes);
    let line = match text.split_once('\n') {
        Some((line, _)) => line.strip_suffix('\r').unwrap_or(line),
        None => text.as_ref(),
    };
    let Some(shebang) = line.strip_prefix("#!") else {
        return Ok(Value::Null);
    };
    let words: Vec<_> = shebang
        .trim_matches(whitespace)
        .split(whitespace)
        .filter(|word| !word.is_empty())
        .collect();
    let launcher = words
        .first()
        .ok_or_else(|| Error::new("external_qualification_interpreter_invalid"))?;
    let requested = resolve(cwd, Path::new(launcher))?;
    let launcher = observed.file(&requested, FileKind::Interpreter)?;
    let is_env = launcher.path.file_name().is_some_and(|name| name == "env");
    let mut identities = vec![interpreter_file(launcher)?];
    if is_env {
        let program = words
            .iter()
            .skip(1)
            .find(|word| !word.starts_with('-'))
            .ok_or_else(|| Error::new("external_qualification_interpreter_invalid"))?;
        let path = program_on_path(program, environment, cwd, observed)?;
        identities.push(interpreter_file(
            observed.file(&path, FileKind::Interpreter)?,
        )?);
    }
    Ok(json!(hash(
        "ExternalQualificationInterpreterIdentity",
        &json!(identities)
    )?))
}

fn interpreter_file(file: &super::files::FileObservation) -> Result<Value> {
    Ok(
        json!({"realpath": path_text(&file.path)?, "device": stat_number(file.metadata.dev()),
        "inode": stat_number(file.metadata.ino()), "contentHash": file.hash}),
    )
}

fn program_on_path(
    program: &str,
    environment: &BTreeMap<String, String>,
    cwd: &Path,
    observed: &mut Observations,
) -> Result<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = environment.get("PATH") {
        for directory in path.split(':').filter(|part| !part.is_empty()) {
            ensure(
                candidates.len() < 4096,
                "external_qualification_interpreter_search_budget_exceeded",
            )?;
            let directory = resolve(cwd, Path::new(directory))?;
            let candidate = resolve(&directory, Path::new(program))?;
            candidates.push(candidate.clone());
            if fs::metadata(&candidate)
                .is_ok_and(|metadata| metadata.is_file() && metadata.mode() & 0o111 != 0)
            {
                observed.interpreter_search(candidates);
                return Ok(candidate);
            }
        }
    }
    Err(Error::new("external_qualification_interpreter_not_found"))
}

pub(super) fn independent(qualifier: &Value, verifier: &Value) -> bool {
    let same = [
        "serviceId",
        "principalId",
        "commandIdentityHash",
        "executable",
        "executableContentHash",
        "credentialRoot",
        "credentialRootIdentityHash",
    ]
    .iter()
    .any(|key| qualifier[*key] == verifier[*key]);
    let inode = qualifier["executableDevice"] == verifier["executableDevice"]
        && qualifier["executableInode"] == verifier["executableInode"];
    let contents = match (
        qualifier["credentialRootRegularFileContentHashes"].as_array(),
        verifier["credentialRootRegularFileContentHashes"].as_array(),
    ) {
        (Some(left), Some(right)) => left.iter().any(|hash| right.contains(hash)),
        _ => true,
    };
    !same && !inode && !contents
}
