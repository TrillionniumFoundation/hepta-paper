use std::collections::BTreeSet;

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};

use crate::ModulePlatformError;

/// Authority available to a module implementation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityClassV1 {
    /// Pure deterministic computation.
    Pure,
    /// Read-only access to an immutable snapshot or projection.
    ReadOnly,
    /// Writes confined to a private attempt workspace.
    WorkspaceLocalWrite,
    /// May return a prepared result but cannot commit central state.
    PreparedResultOnly,
    /// The unique commit sequencer may write central state.
    CentralStateWrite,
    /// Separately authorized irreversible external action.
    ExternalEffect,
}

/// Effective evidence tier required by a registry policy.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QualificationTierV1 {
    /// No accepted evidence.
    Unqualified,
    /// Source and deterministic test evidence.
    Source,
    /// Installed disposable-host evidence.
    HostedInstalled,
    /// Separately controlled target-host evidence.
    TargetHost,
    /// Independently controlled external-authority evidence.
    ExternalAuthority,
}

/// Runtime activation state of one module version.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivationStateV1 {
    /// Not eligible for execution.
    Disabled,
    /// Executes without authoritative integration.
    Shadow,
    /// Executes with a bounded canary policy.
    Canary,
    /// Current authoritative implementation for its capability.
    Authoritative,
    /// No new execution is permitted.
    Retired,
}

/// Module implementation topology.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleKindV1 {
    /// Pure in-process library.
    PureLibrary,
    /// Trusted in-process component with no direct writer.
    TrustedInProcess,
    /// Isolated process reached through a versioned protocol.
    IsolatedProcess,
    /// Host service with an operating-system principal.
    HostService,
    /// Bounded adapter around the current Node implementation.
    LegacyNodeAdapter,
}

/// Bound execution descriptor for a module version.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModuleExecutionV1 {
    /// No process is launched.
    InProcess {
        /// Hash of the linked implementation subject.
        implementation_hash: Sha256Digest,
    },
    /// A canonical process and configuration are independently bound.
    IsolatedProcess {
        /// Canonical executable hash.
        executable_hash: Sha256Digest,
        /// Canonical configuration hash.
        configuration_hash: Sha256Digest,
        /// Whether network use is declared by the module contract.
        network_declared: bool,
    },
    /// Adapter around the existing Node capability boundary.
    LegacyNodeAdapter {
        /// Exact adapter contract hash.
        adapter_contract_hash: Sha256Digest,
        /// Exact Node source-contract hash.
        node_contract_hash: Sha256Digest,
        /// The adapter cannot receive a central writer.
        prepared_result_only: bool,
    },
}

/// Exact version dependency of a module manifest.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleDependencyV1 {
    /// Stable module ID.
    pub module_id: String,
    /// Exact required module version.
    pub module_version: String,
}

/// Integer multi-resource request or usage vector.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceVectorV1 {
    /// CPU milliseconds.
    pub cpu_millis: u64,
    /// GPU milliseconds.
    pub gpu_millis: u64,
    /// Peak memory bytes.
    pub memory_bytes: u64,
    /// Durable and temporary storage bytes.
    pub storage_bytes: u64,
    /// Model/provider token units.
    pub tokens: u64,
    /// Provider-call count.
    pub provider_calls: u64,
    /// Irreversible external-action count.
    pub external_actions: u64,
    /// Central-writer turns.
    pub central_writer_turns: u64,
}

impl ResourceVectorV1 {
    /// Checked component-wise addition.
    pub fn checked_add(self, other: Self) -> Result<Self, ModulePlatformError> {
        Ok(Self {
            cpu_millis: add(self.cpu_millis, other.cpu_millis)?,
            gpu_millis: add(self.gpu_millis, other.gpu_millis)?,
            memory_bytes: add(self.memory_bytes, other.memory_bytes)?,
            storage_bytes: add(self.storage_bytes, other.storage_bytes)?,
            tokens: add(self.tokens, other.tokens)?,
            provider_calls: add(self.provider_calls, other.provider_calls)?,
            external_actions: add(self.external_actions, other.external_actions)?,
            central_writer_turns: add(self.central_writer_turns, other.central_writer_turns)?,
        })
    }

    /// Checked component-wise subtraction.
    pub fn checked_sub(self, other: Self) -> Result<Self, ModulePlatformError> {
        if !other.fits_within(self) {
            return Err(ModulePlatformError::ResourceUnderflow);
        }
        Ok(Self {
            cpu_millis: self.cpu_millis - other.cpu_millis,
            gpu_millis: self.gpu_millis - other.gpu_millis,
            memory_bytes: self.memory_bytes - other.memory_bytes,
            storage_bytes: self.storage_bytes - other.storage_bytes,
            tokens: self.tokens - other.tokens,
            provider_calls: self.provider_calls - other.provider_calls,
            external_actions: self.external_actions - other.external_actions,
            central_writer_turns: self.central_writer_turns - other.central_writer_turns,
        })
    }

    /// Returns true when every component is within `limit`.
    #[must_use]
    pub fn fits_within(self, limit: Self) -> bool {
        self.cpu_millis <= limit.cpu_millis
            && self.gpu_millis <= limit.gpu_millis
            && self.memory_bytes <= limit.memory_bytes
            && self.storage_bytes <= limit.storage_bytes
            && self.tokens <= limit.tokens
            && self.provider_calls <= limit.provider_calls
            && self.external_actions <= limit.external_actions
            && self.central_writer_turns <= limit.central_writer_turns
    }

    /// Returns true when all components are zero.
    #[must_use]
    pub fn is_zero(self) -> bool {
        self == Self::default()
    }
}

fn add(left: u64, right: u64) -> Result<u64, ModulePlatformError> {
    left.checked_add(right)
        .ok_or(ModulePlatformError::ResourceOverflow)
}

pub(crate) fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
        })
}

pub(crate) fn valid_module_id(value: &str) -> bool {
    value.starts_with("module.") && valid_identifier(value)
}

pub(crate) fn valid_capability_id(value: &str) -> bool {
    value.starts_with("CAP-")
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
}

pub(crate) fn valid_owner(value: &str) -> bool {
    value.starts_with("TEAM-")
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
}

pub(crate) fn valid_semver(value: &str) -> bool {
    let mut parts = value.split('.');
    let valid_part = |part: Option<&str>| {
        part.is_some_and(|candidate| {
            !candidate.is_empty()
                && (candidate == "0" || !candidate.starts_with('0'))
                && candidate.bytes().all(|byte| byte.is_ascii_digit())
        })
    };
    valid_part(parts.next())
        && valid_part(parts.next())
        && valid_part(parts.next())
        && parts.next().is_none()
}

pub(crate) fn duplicate_strings(values: &[String]) -> bool {
    values.iter().collect::<BTreeSet<_>>().len() != values.len()
}

pub(crate) fn duplicate_digests(values: &[Sha256Digest]) -> bool {
    values.iter().collect::<BTreeSet<_>>().len() != values.len()
}

pub(crate) fn duplicate_dependencies(values: &[ModuleDependencyV1]) -> bool {
    values.iter().collect::<BTreeSet<_>>().len() != values.len()
}

pub(crate) fn is_strictly_sorted<T: Ord>(values: &[T]) -> bool {
    values.windows(2).all(|window| window[0] < window[1])
}
