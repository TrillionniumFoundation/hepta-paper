use std::{collections::BTreeMap, ffi::OsString, path::Path, str::FromStr};

use hepta_codex_protocol::{SandboxPolicy, Sha256Digest};
use sha2::{Digest, Sha256};

use crate::{
    BoundedProcessRequestV1, CodexRuntimeIdentityV1, RestrictedEnvironmentV1,
    codex_parent_environment_policy_v1, model_child_environment_policy_v1,
};

use super::{
    control::{
        canonical_directory, inspect_bound_control_directory, inspect_bound_control_file,
        inspect_control_directory, inspect_control_file,
    },
    types::{
        CODEX_CLI_SURFACE_ID, CodexInvocationError, CodexInvocationPostflightV1,
        CodexInvocationRequestV1, CodexInvocationV1, ControlDirectoryPolicy, ControlFilePolicy,
        SchemaAuthorityModeV1,
    },
};

const LOCAL_SCHEMA_REQUIRED_MODE: u32 = 0o400;
const LOCAL_SCHEMA_FORBIDDEN_MODE: u32 = 0o7377;
const SEPARATE_SCHEMA_REQUIRED_MODE: u32 = 0o440;
const SEPARATE_SCHEMA_FORBIDDEN_MODE: u32 = 0o7337;
const OUTPUT_REQUIRED_MODE: u32 = 0o600;
const OUTPUT_FORBIDDEN_MODE: u32 = 0o7177;

/// Builds the only Foundation V1 Codex execution surface.
pub fn build_codex_invocation(
    request: CodexInvocationRequestV1<'_>,
) -> Result<CodexInvocationV1, CodexInvocationError> {
    let policy = request.policy.validate()?;
    validate_prompt(&request.prompt, policy.maximum_prompt_bytes)?;
    let workspace = canonical_directory(request.workspace, "workspace")?;

    let schema_parent_path = request
        .output_schema_path
        .parent()
        .ok_or(CodexInvocationError::SchemaParentInvalid)?;
    let (schema_required_mode, schema_forbidden_mode, schema_parent_policy) =
        match policy.schema_authority_mode {
            SchemaAuthorityModeV1::LocalFixtureSameOwner => (
                LOCAL_SCHEMA_REQUIRED_MODE,
                LOCAL_SCHEMA_FORBIDDEN_MODE,
                ControlDirectoryPolicy {
                    subject: "output_schema_parent",
                    expected_uid: policy.schema_owner_uid,
                    expected_gid: policy.schema_owner_gid,
                    forbidden_writer_uid: None,
                    require_group_read_execute: false,
                },
            ),
            SchemaAuthorityModeV1::SeparateOwner => (
                SEPARATE_SCHEMA_REQUIRED_MODE,
                SEPARATE_SCHEMA_FORBIDDEN_MODE,
                ControlDirectoryPolicy {
                    subject: "output_schema_parent",
                    expected_uid: policy.schema_owner_uid,
                    expected_gid: policy.schema_owner_gid,
                    forbidden_writer_uid: Some(policy.execution_uid),
                    require_group_read_execute: true,
                },
            ),
        };
    let output_schema_parent = inspect_control_directory(schema_parent_path, schema_parent_policy)?;
    let output_schema = inspect_control_file(
        request.output_schema_path,
        ControlFilePolicy {
            subject: "output_schema",
            expected_uid: policy.schema_owner_uid,
            expected_gid: policy.schema_owner_gid,
            maximum_bytes: policy.maximum_output_schema_bytes,
            required_mode_bits: schema_required_mode,
            forbidden_mode_bits: schema_forbidden_mode,
            must_be_empty: false,
        },
    )?;
    if output_schema.canonical_path.starts_with(&workspace) {
        return Err(CodexInvocationError::SchemaInsideWorkspace);
    }
    if output_schema.canonical_path.parent() != Some(output_schema_parent.canonical_path.as_path())
    {
        return Err(CodexInvocationError::SchemaParentInvalid);
    }
    if &output_schema.content_hash != request.expected_output_schema_hash {
        return Err(CodexInvocationError::OutputSchemaHashMismatch);
    }

    let output_last_message = inspect_control_file(
        request.output_last_message_path,
        ControlFilePolicy {
            subject: "output_last_message",
            expected_uid: policy.output_owner_uid,
            expected_gid: policy.output_owner_gid,
            maximum_bytes: policy.maximum_output_message_bytes,
            required_mode_bits: OUTPUT_REQUIRED_MODE,
            forbidden_mode_bits: OUTPUT_FORBIDDEN_MODE,
            must_be_empty: true,
        },
    )?;
    if output_last_message.canonical_path.starts_with(&workspace) {
        return Err(CodexInvocationError::OutputInsideWorkspace);
    }

    validate_parent_environment(request.runtime, &request.parent_environment)?;
    validate_model_child_environment(request.runtime, request.model_child_environment)?;

    let arguments = build_arguments(
        request.runtime,
        &workspace,
        request.sandbox_policy,
        &output_schema.canonical_path,
        &output_last_message.canonical_path,
        request.model_child_environment,
    )?;
    let argv_hash = hash_os_strings("CodexExecArgvV1", &arguments)?;
    let prompt_hash = hash_bytes("CodexPromptBytesV1", &request.prompt)?;
    let process = BoundedProcessRequestV1 {
        executable: request.runtime.executable.canonical_path().to_path_buf(),
        arguments,
        working_directory: workspace,
        environment: request.parent_environment,
        stdin: Some(request.prompt),
    };
    Ok(CodexInvocationV1 {
        cli_surface_id: CODEX_CLI_SURFACE_ID,
        process,
        argv_hash,
        prompt_hash,
        output_schema_hash: output_schema.content_hash,
        model_child_environment_hash: request.model_child_environment.environment_hash.clone(),
        schema_authority_mode: policy.schema_authority_mode,
        output_schema_parent_contract: output_schema_parent,
        output_schema_contract: output_schema.contract,
        output_message_contract: output_last_message.contract,
    })
}

/// Re-inspects provider control files after child cleanup and before result integration.
pub fn inspect_codex_invocation_postflight(
    invocation: &CodexInvocationV1,
    require_output_message: bool,
) -> Result<CodexInvocationPostflightV1, CodexInvocationError> {
    inspect_bound_control_directory(&invocation.output_schema_parent_contract)?;
    let schema = inspect_bound_control_file(&invocation.output_schema_contract)?;
    if schema.content_hash != invocation.output_schema_hash {
        return Err(CodexInvocationError::OutputSchemaChangedDuringExecution);
    }
    let output = inspect_bound_control_file(&invocation.output_message_contract)?;
    if require_output_message && output.bytes == 0 {
        return Err(CodexInvocationError::OutputMessageMissing);
    }
    Ok(CodexInvocationPostflightV1 {
        output_schema_hash: schema.content_hash,
        output_message_hash: output.content_hash,
        output_message_bytes: output.bytes,
    })
}

fn build_arguments(
    runtime: &CodexRuntimeIdentityV1,
    workspace: &Path,
    sandbox_policy: SandboxPolicy,
    output_schema: &Path,
    output_last_message: &Path,
    model_child_environment: &RestrictedEnvironmentV1,
) -> Result<Vec<OsString>, CodexInvocationError> {
    let sandbox = match sandbox_policy {
        SandboxPolicy::ReadOnly => "read-only",
        SandboxPolicy::WorkspaceWrite => "workspace-write",
    };
    let mut arguments = vec![
        OsString::from("exec"),
        OsString::from("--strict-config"),
        OsString::from("--skip-git-repo-check"),
        OsString::from("--ephemeral"),
        OsString::from("--ignore-user-config"),
        OsString::from("--ignore-rules"),
        OsString::from("--json"),
        OsString::from("--color"),
        OsString::from("never"),
        OsString::from("--sandbox"),
        OsString::from(sandbox),
        OsString::from("--cd"),
        workspace.as_os_str().to_os_string(),
        OsString::from("--model"),
        OsString::from(&runtime.model_selector),
        OsString::from("--output-schema"),
        output_schema.as_os_str().to_os_string(),
        OsString::from("--output-last-message"),
        output_last_message.as_os_str().to_os_string(),
    ];
    for override_value in [
        "approval_policy=\"never\"".to_owned(),
        "sandbox_workspace_write.network_access=false".to_owned(),
        "web_search=\"disabled\"".to_owned(),
        "shell_environment_policy.inherit=\"none\"".to_owned(),
        "shell_environment_policy.ignore_default_excludes=false".to_owned(),
    ] {
        push_config_override(&mut arguments, override_value);
    }
    for (key, value) in model_child_environment.iter() {
        let encoded =
            serde_json::to_string(value).map_err(|_| CodexInvocationError::TomlStringEncoding)?;
        push_config_override(
            &mut arguments,
            format!("shell_environment_policy.set.{key}={encoded}"),
        );
    }
    arguments.push(OsString::from("-"));
    Ok(arguments)
}

fn push_config_override(arguments: &mut Vec<OsString>, value: String) {
    arguments.push(OsString::from("--config"));
    arguments.push(OsString::from(value));
}

fn validate_parent_environment(
    runtime: &CodexRuntimeIdentityV1,
    environment: &RestrictedEnvironmentV1,
) -> Result<(), CodexInvocationError> {
    if environment.policy_hash != runtime.environment_policy_hash {
        return Err(CodexInvocationError::ParentEnvironmentPolicyMismatch);
    }
    let rebuilt = codex_parent_environment_policy_v1()
        .build(environment_source(environment), &BTreeMap::new())
        .map_err(|_| CodexInvocationError::ParentEnvironmentSurfaceMismatch)?;
    if &rebuilt != environment {
        return Err(CodexInvocationError::ParentEnvironmentSurfaceMismatch);
    }
    let home = runtime.home.canonical_path();
    let configured_home = environment
        .get("HOME")
        .map(Path::new)
        .ok_or(CodexInvocationError::ParentHomeMissing)?;
    let configured_codex_home = environment
        .get("CODEX_HOME")
        .map(Path::new)
        .ok_or(CodexInvocationError::ParentCodexHomeMissing)?;
    if configured_home != home || configured_codex_home != home {
        return Err(CodexInvocationError::ParentHomeMismatch);
    }
    Ok(())
}

fn validate_model_child_environment(
    runtime: &CodexRuntimeIdentityV1,
    environment: &RestrictedEnvironmentV1,
) -> Result<(), CodexInvocationError> {
    if environment.get("CODEX_HOME").is_some() {
        return Err(CodexInvocationError::ModelChildCodexHomeForbidden);
    }
    let rebuilt = model_child_environment_policy_v1()
        .build(environment_source(environment), &BTreeMap::new())
        .map_err(|_| CodexInvocationError::ModelChildEnvironmentSurfaceMismatch)?;
    if &rebuilt != environment {
        return Err(CodexInvocationError::ModelChildEnvironmentSurfaceMismatch);
    }
    for key in ["HOME", "TMPDIR"] {
        let value = environment
            .get(key)
            .ok_or(CodexInvocationError::ModelChildDirectoryMissing(key))?;
        let path = canonical_directory(Path::new(value), key)?;
        if path == runtime.home.canonical_path() {
            return Err(CodexInvocationError::ModelChildDirectoryAliasesCodexHome(
                key,
            ));
        }
    }
    Ok(())
}

fn environment_source(
    environment: &RestrictedEnvironmentV1,
) -> impl Iterator<Item = (OsString, OsString)> + '_ {
    environment
        .iter()
        .map(|(key, value)| (OsString::from(key), OsString::from(value)))
}

fn validate_prompt(prompt: &[u8], maximum: usize) -> Result<(), CodexInvocationError> {
    if prompt.is_empty() || prompt.len() > maximum || std::str::from_utf8(prompt).is_err() {
        return Err(CodexInvocationError::PromptInvalid);
    }
    Ok(())
}

fn hash_os_strings(
    domain: &str,
    values: &[OsString],
) -> Result<Sha256Digest, CodexInvocationError> {
    let mut hasher = Sha256::new();
    update_length_prefixed(&mut hasher, domain.as_bytes());
    for value in values {
        let encoded = value
            .to_str()
            .ok_or(CodexInvocationError::ArgumentNotUtf8)?;
        update_length_prefixed(&mut hasher, encoded.as_bytes());
    }
    digest_from_hasher(hasher)
}

fn hash_bytes(domain: &str, value: &[u8]) -> Result<Sha256Digest, CodexInvocationError> {
    let mut hasher = Sha256::new();
    update_length_prefixed(&mut hasher, domain.as_bytes());
    update_length_prefixed(&mut hasher, value);
    digest_from_hasher(hasher)
}

fn update_length_prefixed(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(bytes);
}

fn digest_from_hasher(hasher: Sha256) -> Result<Sha256Digest, CodexInvocationError> {
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value).map_err(|_| CodexInvocationError::DigestConstruction)
}

#[cfg(test)]
pub(super) fn raw_sha256_for_test(bytes: &[u8]) -> Sha256Digest {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    digest_from_hasher(hasher).expect("test SHA-256 digest")
}
