//! Immutable diagnostic association for one prepared CPU attempt; never execution authority.
use super::*;
use std::os::unix::fs::MetadataExt;

pub(super) const NAME: &str = "numerical-cpu-execution-association.v1.json";
const MAXIMUM_BYTES: u64 = 64 * 1024;
const FAILURE: &str = "advanced_numerical_plugin_execution_association_invalid_or_changed";

pub(super) struct HeldAssociation {
    sandbox: Directory,
    output: Directory,
}
impl HeldAssociation {
    pub(super) fn assert_current(&self) -> Result<(), String> {
        self.sandbox.assert_current().map_err(|e| e.to_string())?;
        self.output.assert_current().map_err(|e| e.to_string())
    }
}
pub(super) struct Recovered {
    pub observation: Json,
    pub facts: Value,
    pub held: HeldAssociation,
}
fn identity(directory: &Directory) -> Result<Value, String> {
    directory.assert_current().map_err(|e| e.to_string())?;
    let m = directory.held.metadata().map_err(|_| FAILURE)?;
    Ok(
        serde_json::json!({"dev":m.dev().to_string(),"ino":m.ino().to_string(),
        "mode":m.mode().to_string(),"uid":m.uid().to_string(),"gid":m.gid().to_string(),
        "nlink":m.nlink().to_string()}),
    )
}
fn subject(
    prepared: &configuration::Prepared,
    request: &Json,
    output: &Directory,
    c: &AtomicBool,
) -> Result<Value, String> {
    Ok(serde_json::json!({
        "pluginRoot":prepared.plugin_root,"outputRoot":prepared.output_root,"target":output.path,
        "descriptorHash":prepared.descriptor["advancedNumericalPluginDescriptorHash"],
        "signedBundleHash":value(field(&prepared.report,"signedBundleHash"),c)?,
        "requestHash":value(field(request,"advancedNumericalPluginRequestHash"),c)?,
        "sourceMerkleHash":prepared.descriptor["sourceIdentity"]["merkleHash"],
        "sourceWorkspaceManifestHash":prepared.descriptor["sourceIdentity"]["workspaceManifestHash"],
        "runtimeExecutableHash":prepared.descriptor["runtime"]["executableHash"],
    }))
}
fn parsed(v: &Value, c: &AtomicBool, d: Instant) -> Result<(Vec<u8>, Json), String> {
    check(c, d)?;
    let bytes = serde_json::to_vec(v).map_err(|_| FAILURE)?;
    if bytes.len() as u64 > MAXIMUM_BYTES {
        return Err(FAILURE.into());
    }
    let raw = parse_production_json_v1(&bytes).map_err(|_| FAILURE)?;
    check(c, d)?;
    Ok((bytes, raw))
}
pub(super) fn persist(
    prepared: &configuration::Prepared,
    request: &Json,
    workspace: &workspace::CpuWorkspace<'_>,
    output: &Directory,
    observed: &mut StatusInputs<'_>,
    c: &AtomicBool,
    d: Instant,
) -> Result<Value, String> {
    observed.require_control(c, d)?;
    workspace.assert_current()?;
    output.assert_current().map_err(|e| e.to_string())?;
    let mut v = serde_json::json!({
        "version":1,"kind":"NativeCpuExecutionAssociation",
        "purpose":"diagnostic_recovery_only_no_execution_authority",
        "state":"prepared_before_worker_spawn_outcome_unknown",
        "subject":subject(prepared,request,output,c)?,
        "sandboxPath":workspace.sandbox.path,"sandboxIdentity":identity(&workspace.sandbox)?,
        "privateOutputPath":workspace.output.path,"privateOutputIdentity":identity(&workspace.output)?,
        "privateResultPath":workspace.output.path.join("result.json"),
        "executionAuthority":false,
    });
    let (_, raw) = parsed(&v, c, d)?;
    let digest = hash("NativeCpuExecutionAssociation", &raw, c)?;
    v["associationHash"] = digest.clone().into();
    let (bytes, _) = parsed(&v, c, d)?;
    check(c, d)?;
    let mut facts = serde_json::json!({"path":output.path.join(NAME),"associationHash":digest,
        "privateResultPath":workspace.output.path.join("result.json"),
        "associationOutcome":"attempted_unknown","executionAuthority":false});
    output
        .write_new(NAME, &bytes)
        .map_err(|e| context(e.to_string(), &facts))?;
    // Record known durable write before subsequent checks can fail.
    facts["associationOutcome"] = "saved_prepared_outcome_unknown".into();
    let path = output.path.join(NAME);
    let held = observed
        .document(&path, MAXIMUM_BYTES)
        .map_err(|e| context(e, &facts))?;
    if held != bytes {
        return Err(context(FAILURE.into(), &facts));
    }
    observed.assert_current().map_err(|e| context(e, &facts))?;
    output
        .assert_current()
        .map_err(|e| context(e.to_string(), &facts))?;
    check(c, d).map_err(|e| context(e, &facts))?;
    Ok(facts)
}
fn validate(
    v: &Value,
    prepared: &configuration::Prepared,
    request: &Json,
    output: &Directory,
    c: &AtomicBool,
    d: Instant,
) -> Result<(Directory, Directory), String> {
    check(c, d)?;
    let mut payload = v.clone();
    let observed_hash = payload
        .as_object_mut()
        .ok_or(FAILURE)?
        .remove("associationHash")
        .ok_or(FAILURE)?;
    let (_, raw) = parsed(&payload, c, d)?;
    if payload.as_object().is_none_or(|v| v.len() != 11)
        || observed_hash != hash("NativeCpuExecutionAssociation", &raw, c)?
        || payload["version"] != 1
        || payload["kind"] != "NativeCpuExecutionAssociation"
        || payload["purpose"] != "diagnostic_recovery_only_no_execution_authority"
        || payload["state"] != "prepared_before_worker_spawn_outcome_unknown"
        || payload["executionAuthority"] != false
        || payload["subject"] != subject(prepared, request, output, c)?
    {
        return Err(FAILURE.into());
    }
    let raw_path = payload["sandboxPath"].as_str().ok_or(FAILURE)?;
    let sandbox_path = Path::new(raw_path);
    let leaf = sandbox_path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or(FAILURE)?;
    let suffix = leaf
        .strip_prefix(".hepta-native-numerical-")
        .ok_or(FAILURE)?;
    if suffix.len() != 32
        || !suffix
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        || prepared.output_root.join(leaf) != sandbox_path
        || payload["privateOutputPath"] != sandbox_path.join("output").to_string_lossy().as_ref()
        || payload["privateResultPath"]
            != sandbox_path
                .join("output/result.json")
                .to_string_lossy()
                .as_ref()
    {
        return Err(FAILURE.into());
    }
    let sandbox = Directory::open_or_create(sandbox_path, false).map_err(|_| FAILURE)?;
    let private_output =
        Directory::open_or_create(&sandbox_path.join("output"), false).map_err(|_| FAILURE)?;
    if identity(&sandbox)? != payload["sandboxIdentity"]
        || identity(&private_output)? != payload["privateOutputIdentity"]
    {
        return Err(FAILURE.into());
    }
    check(c, d)?;
    Ok((sandbox, private_output))
}
pub(super) fn recover(
    prepared: &configuration::Prepared,
    request: &Json,
    output: &Directory,
    observed: &mut StatusInputs<'_>,
    limits: &limits::CpuExecutionLimits,
    c: &AtomicBool,
    d: Instant,
) -> Result<Option<Recovered>, String> {
    observed.require_control(c, d)?;
    let path = output.path.join(NAME);
    let Some(m) = observed.probe(&path)? else {
        return Ok(None);
    };
    if m.directory || m.link_count != 1 || m.mode & 0o7777 != 0o600 || m.size > MAXIMUM_BYTES {
        return Err(FAILURE.into());
    }
    let bytes = observed.document(&path, MAXIMUM_BYTES)?;
    let raw = parse_production_json_v1(&bytes).map_err(|_| FAILURE)?;
    let v = value(&raw, c)?;
    let (sandbox, private_output) = validate(&v, prepared, request, output, c, d)?;
    let result_path = private_output.path.join("result.json");
    let mut result_observation = object([
        ("path", text(&result_path.to_string_lossy())),
        ("status", text("no_result_observed_outcome_unknown")),
        ("executionAuthority", Json::Bool(false)),
    ]);
    if let Some(m) = observed.probe(&result_path)? {
        if m.directory
            || m.link_count != 1
            || m.mode & 0o002 != 0
            || m.size > limits.maximum_output_bytes
        {
            return Err(FAILURE.into());
        }
        let raw_bytes = observed.document(&result_path, limits.maximum_output_bytes)?;
        let digest = format!("sha256:{:x}", Sha256::digest(&raw_bytes));
        let result = parse_production_json_v1(&raw_bytes).unwrap_or(Json::Null);
        let valid =
            execution_contract::result_valid_v1(&result, &prepared.descriptor_raw, request, c, d)?;
        result_observation = object([
            ("path", text(&result_path.to_string_lossy())),
            ("sha256", text(&digest)),
            ("bytes", Json::Number(raw_bytes.len() as f64)),
            ("resultContractMatchesCurrentRequest", Json::Bool(valid)),
            (
                "status",
                text("retained_private_result_outcome_unknown_no_overwrite"),
            ),
            ("executionAuthority", Json::Bool(false)),
        ]);
    }
    let held = HeldAssociation {
        sandbox,
        output: private_output,
    };
    held.assert_current()?;
    observed.assert_current()?;
    output.assert_current().map_err(|e| e.to_string())?;
    check(c, d)?;
    let facts = serde_json::json!({"path":path,"associationHash":v["associationHash"],
        "privateResultPath":result_path,"associationOutcome":"preexisting_held_observed_outcome_unknown",
        "executionAuthority":false});
    Ok(Some(Recovered {
        observation: object([
            ("version", Json::Number(1.0)),
            ("kind", text("NativeCpuExecutionAssociationObservation")),
            ("associationPath", text(&path.to_string_lossy())),
            (
                "associationHash",
                text(v["associationHash"].as_str().ok_or(FAILURE)?),
            ),
            (
                "status",
                text("retained_attempt_outcome_not_success_no_automatic_reexecution"),
            ),
            ("privateResultObservation", result_observation),
            ("executionAuthority", Json::Bool(false)),
        ]),
        facts,
        held,
    }))
}
pub(super) fn context(error: String, facts: &Value) -> String {
    let marker = ";cpuExecutionFacts=";
    if let Some(index) = error.find(marker)
        && let Ok(mut original) = serde_json::from_str::<Value>(&error[index + marker.len()..])
        && let Some(fields) = original.as_object_mut()
    {
        if fields.contains_key("executionAssociation") {
            return error;
        }
        fields.insert("executionAssociation".into(), facts.clone());
        if let Ok(wire) = serde_json::to_string(&original) {
            return format!("{}{marker}{wire}", &error[..index]);
        }
    }
    if error.contains(";cpuExecutionAssociation=") {
        return error;
    }
    match serde_json::to_string(facts) {
        Ok(wire) => format!("{error};cpuExecutionAssociation={wire}"),
        Err(_) => format!("{error};cpuExecutionAssociation_encoding_refused"),
    }
}
