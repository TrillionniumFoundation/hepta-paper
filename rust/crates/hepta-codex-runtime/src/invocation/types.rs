use std::{
    io,
    path::{Path, PathBuf},
};

use hepta_codex_protocol::{SandboxPolicy, Sha256Digest};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{BoundedProcessRequestV1, CodexRuntimeIdentityV1, RestrictedEnvironmentV1};

pub(super) const MAXIMUM_PROMPT_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAXIMUM_OUTPUT_SCHEMA_BYTES: u64 = 1024 * 1024;
pub(super) const MAXIMUM_OUTPUT_MESSAGE_BYTES: u64 = 16 * 1024 * 1024;
pub(super) const CODEX_CLI_SURFACE_ID: &str =
    "codex-exec-jsonl-v1-openai-codex-6be2a6ca";

/// Deployment-bound control-file and prompt policy for one Codex invocation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexInvocationPolicyV1 {
    pub version: u16,
    pub control_owner_uid: u32,
    pub control_owner_gid: Option<u32>,
    pub maximum_prompt_bytes: usize,
    pub maximum_output_schema_bytes: u64,
    pub maximum_output_message_bytes: u64,
}

impl CodexInvocationPolicyV1 {
    /// Strict Foundation V1 policy for files owned by the broker principal.
    #[must_use]
    pub const fn strict(control_owner_uid: u32) -> Self {
        Self {
            version: 1,
            control_owner_uid,
            control_owner_gid: None,
            maximum_prompt_bytes: MAXIMUM_PROMPT_BYTES,
            maximum_output_schema_bytes: MAXIMUM_OUTPUT_SCHEMA_BYTES,
            maximum_output_message_bytes: MAXIMUM_OUTPUT_MESSAGE_BYTES,
        }
    }

    pub(super) fn validate(self) -> Result<Self, CodexInvocationError> {
        if self.version != 1 {
            return Err(CodexInvocationError::UnsupportedPolicyVersion(self.version));
        }
        if self.maximum_prompt_bytes == 0
            || self.maximum_prompt_bytes > MAXIMUM_PROMPT_BYTES
            || self.maximum_output_schema_bytes == 0
            || self.maximum_output_schema_bytes > MAXIMUM_OUTPUT_SCHEMA_BYTES
            || self.maximum_output_message_bytes == 0
            || self.maximum_output_message_bytes > MAXIMUM_OUTPUT_MESSAGE_BYTES
        {
            return Err(CodexInvocationError::InvalidPolicyLimits);
        }
        Ok(self)
    }
}

/// Inputs bound into the exact noninteractive Codex CLI invocation.
pub struct CodexInvocationRequestV1<'a> {
    pub runtime: &'a CodexRuntimeIdentityV1,
    pub workspace: &'a Path,
    pub sandbox_policy: SandboxPolicy,
    pub output_schema_path: &'a Path,
    pub expected_output_schema_hash: &'a Sha256Digest,
    pub output_last_message_path: &'a Path,
    pub parent_environment: RestrictedEnvironmentV1,
    pub model_child_environment: &'a RestrictedEnvironmentV1,
    pub prompt: Vec<u8>,
    pub policy: CodexInvocationPolicyV1,
}

/// Exact process request and hashes required by the execution receipt.
#[derive(Clone, Debug)]
pub struct CodexInvocationV1 {
    pub cli_surface_id: &'static str,
    pub process: BoundedProcessRequestV1,
    pub argv_hash: Sha256Digest,
    pub prompt_hash: Sha256Digest,
    pub output_schema_hash: Sha256Digest,
    pub model_child_environment_hash: Sha256Digest,
    pub output_schema_contract: CodexControlFileContractV1,
    pub output_message_contract: CodexControlFileContractV1,
}

/// Immutable file-object contract captured before the provider process starts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexControlFileContractV1 {
    pub canonical_path: PathBuf,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub link_count: u64,
    pub maximum_bytes: u64,
}

/// Postflight hashes and sizes for the immutable schema and final output message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexInvocationPostflightV1 {
    pub output_schema_hash: Sha256Digest,
    pub output_message_hash: Sha256Digest,
    pub output_message_bytes: u64,
}

#[derive(Clone, Copy)]
pub(super) struct ControlFilePolicy {
    pub(super) subject: &'static str,
    pub(super) expected_uid: u32,
    pub(super) expected_gid: Option<u32>,
    pub(super) maximum_bytes: u64,
    pub(super) owner_write_required: bool,
    pub(super) must_be_empty: bool,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum CodexInvocationError {
    #[error("unsupported Codex invocation policy version: {0}")]
    UnsupportedPolicyVersion(u16),
    #[error("Codex invocation policy limits are invalid")]
    InvalidPolicyLimits,
    #[error("prompt must be nonempty bounded UTF-8")]
    PromptInvalid,
    #[error("{0} path must be absolute")]
    ControlPathMustBeAbsolute(&'static str),
    #[error("{0} path is noncanonical or contains a symlink component")]
    ControlPathNonCanonical(&'static str),
    #[error("workspace is not a real directory")]
    WorkspaceInvalid,
    #[error("{0} must be a real regular file")]
    ControlFileInvalid(&'static str),
    #[error("{0} owner does not match the broker policy")]
    ControlOwnerMismatch(&'static str),
    #[error("{subject} permissions are invalid: {mode:o}")]
    ControlPermissionsInvalid {
        subject: &'static str,
        mode: u32,
    },
    #[error("{subject} link count is invalid: {link_count}")]
    ControlLinkCountInvalid {
        subject: &'static str,
        link_count: u64,
    },
    #[error("{subject} is too large: observed {observed}, maximum {maximum}")]
    ControlFileTooLarge {
        subject: &'static str,
        observed: u64,
        maximum: u64,
    },
    #[error("output message file must be empty before execution")]
    OutputMessageFileNotEmpty,
    #[error("output message is missing after successful execution")]
    OutputMessageMissing,
    #[error("output schema changed during execution")]
    OutputSchemaChangedDuringExecution,
    #[error("{0} changed during inspection")]
    ControlPathChanged(&'static str),
    #[error("output schema hash does not match the bound request hash")]
    OutputSchemaHashMismatch,
    #[error("parent environment policy hash does not match runtime identity")]
    ParentEnvironmentPolicyMismatch,
    #[error("parent environment does not match the qualified Codex parent policy")]
    ParentEnvironmentSurfaceMismatch,
    #[error("HOME is missing from the parent environment")]
    ParentHomeMissing,
    #[error("CODEX_HOME is missing from the parent environment")]
    ParentCodexHomeMissing,
    #[error("HOME or CODEX_HOME does not match the qualified runtime home")]
    ParentHomeMismatch,
    #[error("CODEX_HOME is forbidden in the model-child environment")]
    ModelChildCodexHomeForbidden,
    #[error("model-child environment does not match the qualified child policy")]
    ModelChildEnvironmentSurfaceMismatch,
    #[error("model-child directory is missing: {0}")]
    ModelChildDirectoryMissing(&'static str),
    #[error("model-child directory aliases the private Codex home: {0}")]
    ModelChildDirectoryAliasesCodexHome(&'static str),
    #[error("failed to encode a TOML string override")]
    TomlStringEncoding,
    #[error("Codex argv contains a non-UTF-8 value")]
    ArgumentNotUtf8,
    #[error("filesystem operation failed for {0}: {1:?}")]
    Filesystem(&'static str, io::ErrorKind),
    #[error("file size arithmetic overflowed")]
    SizeOverflow,
    #[error("failed to construct canonical invocation digest")]
    DigestConstruction,
}
