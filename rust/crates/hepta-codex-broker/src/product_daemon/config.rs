use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use hepta_codex_protocol::{AgentRole, Sha256Digest};
use hepta_codex_runtime::ProcessLimitsV1;
use nix::{
    fcntl::{OFlag, openat},
    sys::stat::Mode,
    unistd::{Gid, Uid},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::os::fd::AsFd;

use crate::{CommitBindingDatabaseScopeV2, PeerPrincipalV1};

use super::ProductCodexBrokerDaemonError;

const MAXIMUM_CONFIGURATION_BYTES: u64 = 1024 * 1024;
const MAXIMUM_AUTHORITY_KEYS: usize = 64;
const MAXIMUM_PEERS: usize = 64;
const HARD_MAXIMUM_ACKNOWLEDGEMENT_AGE_MS: u64 = 24 * 60 * 60 * 1000;
const EXPECTED_CONFIGURATION_MODE: u32 = 0o440;
const EXPECTED_CONFIGURATION_PARENT_MODE: u32 = 0o750;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductBundleAuthorityKeyV1 {
    pub key_id: String,
    pub public_key_base64: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductCommitBindingSourceV2 {
    pub version: u16,
    pub database_path: PathBuf,
    pub database_owner_uid: u32,
    pub busy_timeout_ms: u64,
    pub maximum_database_bytes: u64,
    pub scope: CommitBindingDatabaseScopeV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductCommitAcknowledgementConfigurationV2 {
    pub version: u16,
    pub authority_domain_id: String,
    pub trust_store_generation: u64,
    pub maximum_age_ms: u64,
    pub authority_keys: Vec<ProductBundleAuthorityKeyV1>,
    pub commit_binding_source: ProductCommitBindingSourceV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductRuntimeConfigurationV1 {
    pub executable: PathBuf,
    pub executable_owner_uid: u32,
    pub executable_owner_gid: Option<u32>,
    pub codex_home: PathBuf,
    pub model_selector: String,
    pub credential_material_paths: Vec<String>,
    pub parent_environment: BTreeMap<String, String>,
    pub model_child_environment_base: BTreeMap<String, String>,
    pub transport_profile_hash: Sha256Digest,
    pub maximum_executable_bytes: u64,
    pub maximum_config_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductCgroupConfigurationV1 {
    pub delegated_root: PathBuf,
    pub pids_max: u64,
    pub memory_max: u64,
    pub cpu_quota_us: u64,
    pub cpu_period_us: u64,
    pub cleanup_timeout_ms: u64,
    pub poll_interval_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductProcessLimitsConfigurationV1 {
    pub timeout_ms: u64,
    pub termination_grace_ms: u64,
    pub cleanup_timeout_ms: u64,
    pub poll_interval_ms: u64,
    pub maximum_stdin_bytes: usize,
    pub maximum_stdout_bytes: u64,
    pub maximum_stderr_bytes: u64,
    pub maximum_tail_bytes: usize,
}

impl From<ProductProcessLimitsConfigurationV1> for ProcessLimitsV1 {
    fn from(value: ProductProcessLimitsConfigurationV1) -> Self {
        Self {
            timeout_ms: value.timeout_ms,
            termination_grace_ms: value.termination_grace_ms,
            cleanup_timeout_ms: value.cleanup_timeout_ms,
            poll_interval_ms: value.poll_interval_ms,
            maximum_stdin_bytes: value.maximum_stdin_bytes,
            maximum_stdout_bytes: value.maximum_stdout_bytes,
            maximum_stderr_bytes: value.maximum_stderr_bytes,
            maximum_tail_bytes: value.maximum_tail_bytes,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductServerConfigurationV1 {
    pub worker_threads: usize,
    pub queue_capacity: usize,
    pub accept_poll_ms: u64,
    pub write_timeout_ms: u64,
    pub busy_retry_after_ms: u64,
    pub maximum_connections: u64,
    pub maximum_response_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductJournalConfigurationV1 {
    pub path: PathBuf,
    pub busy_timeout_ms: u64,
    pub maximum_database_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductListenerConfigurationV1 {
    pub socket_path: PathBuf,
    pub parent_owner_uid: u32,
    pub parent_group_gid: u32,
    pub instance_generation: u64,
    pub listen_backlog: i32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductCodexBrokerConfigurationV1 {
    pub version: u16,
    pub configuration_authority_uid: u32,
    pub configuration_reader_gid: u32,
    pub broker_uid: u32,
    pub broker_gid: u32,
    pub role: AgentRole,
    #[serde(
        default,
        skip_serializing_if = "crate::ProductCodexOperationPurposeV1::is_business"
    )]
    pub purpose: crate::ProductCodexOperationPurposeV1,
    pub operation_authority_uid: u32,
    pub operation_directory: PathBuf,
    pub trust_bundle_path: PathBuf,
    pub trust_bundle_authority_uid: u32,
    pub trust_bundle_reader_gid: u32,
    pub trust_bundle_authority_keys: Vec<ProductBundleAuthorityKeyV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_acknowledgement: Option<ProductCommitAcknowledgementConfigurationV2>,
    pub allowed_peers: Vec<PeerPrincipalV1>,
    pub listener: ProductListenerConfigurationV1,
    pub journal: ProductJournalConfigurationV1,
    pub runtime: ProductRuntimeConfigurationV1,
    pub gate_executable: PathBuf,
    pub gate_authority_uid: u32,
    pub gate_state_directory: PathBuf,
    pub cgroup: ProductCgroupConfigurationV1,
    pub process_limits: ProductProcessLimitsConfigurationV1,
    pub server: ProductServerConfigurationV1,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductCodexBrokerConfigurationIdentityV1 {
    canonical_path: PathBuf,
    pub(super) parent: ConfigurationParentIdentityV1,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub link_count: u64,
    pub size: u64,
    pub content_hash: Sha256Digest,
}

/// Stable directory identity; sibling churn cannot revoke the configuration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ConfigurationParentIdentityV1 {
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    gid: u32,
}

impl ConfigurationParentIdentityV1 {
    fn capture(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode(),
            uid: metadata.uid(),
            gid: metadata.gid(),
        }
    }

    pub(super) fn matches(&self, metadata: &fs::Metadata) -> bool {
        metadata.is_dir() && *self == Self::capture(metadata)
    }
}

impl ProductCodexBrokerConfigurationIdentityV1 {
    #[must_use]
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }

    pub(super) fn matches_file(&self, metadata: &fs::Metadata) -> bool {
        metadata.is_file()
            && self.device == metadata.dev()
            && self.inode == metadata.ino()
            && self.mode == metadata.mode() & 0o7777
            && self.uid == metadata.uid()
            && self.gid == metadata.gid()
            && self.link_count == metadata.nlink()
            && self.size == metadata.size()
            && self.modified_seconds == metadata.mtime()
            && self.modified_nanoseconds == metadata.mtime_nsec()
            && self.changed_seconds == metadata.ctime()
            && self.changed_nanoseconds == metadata.ctime_nsec()
    }
}

/// Configuration captured by the installed-principal loader. Callers may inspect
/// it but cannot replace its policy while retaining a previously checked identity.
/// Clones share held file/parent descriptors and permanent source revocation.
///
/// ```compile_fail
/// use hepta_codex_broker::{LoadedProductCodexBrokerConfigurationV1, ProductCodexBrokerConfigurationV1};
/// fn substitute(loaded: &mut LoadedProductCodexBrokerConfigurationV1,
///               replacement: ProductCodexBrokerConfigurationV1) {
///     loaded.configuration = replacement;
/// }
/// ```
#[derive(Clone, Debug)]
pub struct LoadedProductCodexBrokerConfigurationV1 {
    pub(super) configuration: ProductCodexBrokerConfigurationV1,
    pub(super) identity: ProductCodexBrokerConfigurationIdentityV1,
    source: Arc<ConfigurationSourceV1>,
}

#[derive(Debug)]
struct ConfigurationSourceV1 {
    parent: File,
    file: File,
    revoked: AtomicBool,
}

impl PartialEq for LoadedProductCodexBrokerConfigurationV1 {
    fn eq(&self, other: &Self) -> bool {
        self.configuration == other.configuration && self.identity == other.identity
    }
}
impl Eq for LoadedProductCodexBrokerConfigurationV1 {}

impl LoadedProductCodexBrokerConfigurationV1 {
    #[must_use]
    pub fn configuration(&self) -> &ProductCodexBrokerConfigurationV1 {
        &self.configuration
    }

    #[must_use]
    pub fn identity(&self) -> &ProductCodexBrokerConfigurationIdentityV1 {
        &self.identity
    }

    /// Recheck the captured file and principal before opening a runtime, journal
    /// or listener. This is a bounded preflight, not a lifetime revocation feed.
    pub(super) fn into_current_configuration(
        self,
    ) -> Result<ProductCodexBrokerConfigurationV1, ProductCodexBrokerDaemonError> {
        self.assert_current()?;
        Ok(self.configuration)
    }

    pub(super) fn assert_current(&self) -> Result<(), ProductCodexBrokerDaemonError> {
        if let Err(error) = assert_configuration_principal(&self.configuration) {
            self.source.revoked.store(true, Ordering::Release);
            return Err(error);
        }
        self.assert_source_current()
    }

    pub(super) fn assert_source_current(&self) -> Result<(), ProductCodexBrokerDaemonError> {
        if self.source.revoked.load(Ordering::Acquire) {
            return Err(ProductCodexBrokerDaemonError::ConfigurationChanged);
        }
        let checked = self.check_source();
        if checked.is_err() {
            self.source.revoked.store(true, Ordering::Release);
        }
        checked?;
        if self.source.revoked.load(Ordering::Acquire) {
            return Err(ProductCodexBrokerDaemonError::ConfigurationChanged);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn revoke_for_test(&self) {
        self.source.revoked.store(true, Ordering::Release);
    }

    fn check_source(&self) -> Result<(), ProductCodexBrokerDaemonError> {
        let parent = self.source.parent.metadata().map_err(|error| {
            ProductCodexBrokerDaemonError::Filesystem("retained_parent", error.kind())
        })?;
        let file = self.source.file.metadata().map_err(|error| {
            ProductCodexBrokerDaemonError::Filesystem("retained_config", error.kind())
        })?;
        if !self.identity.parent.matches(&parent) || !self.identity.matches_file(&file) {
            return Err(ProductCodexBrokerDaemonError::ConfigurationChanged);
        }
        // The fresh read has its own cursor; shared clones never seek/read the
        // retained descriptor. Held descriptors prevent inode-reuse substitution.
        let current = load_configuration_source(self.identity.canonical_path())?;
        if current != *self {
            return Err(ProductCodexBrokerDaemonError::ConfigurationChanged);
        }
        Ok(())
    }
}

pub fn load_product_codex_broker_configuration(
    path: &Path,
) -> Result<LoadedProductCodexBrokerConfigurationV1, ProductCodexBrokerDaemonError> {
    let loaded = load_configuration_source(path)?;
    assert_configuration_principal(&loaded.configuration)?;
    Ok(loaded)
}

fn assert_configuration_principal(
    configuration: &ProductCodexBrokerConfigurationV1,
) -> Result<(), ProductCodexBrokerDaemonError> {
    if Uid::effective().as_raw() != configuration.broker_uid
        || Gid::effective().as_raw() != configuration.broker_gid
    {
        return Err(ProductCodexBrokerDaemonError::BrokerPrincipal);
    }
    Ok(())
}

// Source inspection is separate only for internal filesystem tests. Public loading
// and retained production checks always also verify the actual installed principal.
pub(super) fn load_configuration_source(
    path: &Path,
) -> Result<LoadedProductCodexBrokerConfigurationV1, ProductCodexBrokerDaemonError> {
    if !path.is_absolute() || fs::canonicalize(path).ok().as_deref() != Some(path) {
        return Err(ProductCodexBrokerDaemonError::ConfigurationPath);
    }
    let parent = path
        .parent()
        .ok_or(ProductCodexBrokerDaemonError::ConfigurationPath)?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|error| {
        ProductCodexBrokerDaemonError::Filesystem("config_parent", error.kind())
    })?;
    let first = fs::symlink_metadata(path)
        .map_err(|error| ProductCodexBrokerDaemonError::Filesystem("config", error.kind()))?;
    if !parent_metadata.is_dir()
        || parent_metadata.file_type().is_symlink()
        || !first.is_file()
        || first.file_type().is_symlink()
        || first.nlink() != 1
        || first.permissions().mode() & 0o7777 != EXPECTED_CONFIGURATION_MODE
        || first.size() == 0
        || first.size() > MAXIMUM_CONFIGURATION_BYTES
    {
        return Err(ProductCodexBrokerDaemonError::ConfigurationFile);
    }
    let parent_file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(parent)
        .map_err(|error| ProductCodexBrokerDaemonError::Filesystem("parent_open", error.kind()))?;
    let held_parent = parent_file.metadata().map_err(|error| {
        ProductCodexBrokerDaemonError::Filesystem("parent_metadata", error.kind())
    })?;
    if !ConfigurationParentIdentityV1::capture(&parent_metadata).matches(&held_parent) {
        return Err(ProductCodexBrokerDaemonError::ConfigurationChanged);
    }
    let mut file = File::from(
        openat(
            parent_file.as_fd(),
            path.file_name()
                .ok_or(ProductCodexBrokerDaemonError::ConfigurationPath)?,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| ProductCodexBrokerDaemonError::ConfigurationFile)?,
    );
    let opened = file.metadata().map_err(|error| {
        ProductCodexBrokerDaemonError::Filesystem("config_metadata", error.kind())
    })?;
    if !same_file(&first, &opened) {
        return Err(ProductCodexBrokerDaemonError::ConfigurationChanged);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(first.size()).unwrap_or(0));
    file.by_ref()
        .take(MAXIMUM_CONFIGURATION_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| ProductCodexBrokerDaemonError::Filesystem("config_read", error.kind()))?;
    let after = fs::symlink_metadata(path).map_err(|error| {
        ProductCodexBrokerDaemonError::Filesystem("config_recheck", error.kind())
    })?;
    if bytes.is_empty()
        || bytes.len() as u64 > MAXIMUM_CONFIGURATION_BYTES
        || !same_file(&opened, &after)
    {
        return Err(ProductCodexBrokerDaemonError::ConfigurationChanged);
    }
    let configuration: ProductCodexBrokerConfigurationV1 = serde_json::from_slice(&bytes)
        .map_err(|_| ProductCodexBrokerDaemonError::ConfigurationJson)?;
    validate_configuration_shape(&configuration)?;
    if first.uid() != configuration.configuration_authority_uid
        || first.gid() != configuration.configuration_reader_gid
        || parent_metadata.uid() != configuration.configuration_authority_uid
        || parent_metadata.gid() != configuration.configuration_reader_gid
        || parent_metadata.permissions().mode() & 0o7777 != EXPECTED_CONFIGURATION_PARENT_MODE
    {
        return Err(ProductCodexBrokerDaemonError::ConfigurationAuthority);
    }
    let parent_after = fs::symlink_metadata(parent).map_err(|error| {
        ProductCodexBrokerDaemonError::Filesystem("config_parent_recheck", error.kind())
    })?;
    let parent_identity = ConfigurationParentIdentityV1::capture(&parent_metadata);
    if !parent_identity.matches(&parent_after)
        || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err(ProductCodexBrokerDaemonError::ConfigurationChanged);
    }
    let content_hash = sha256_digest(&bytes)?;
    Ok(LoadedProductCodexBrokerConfigurationV1 {
        configuration,
        source: Arc::new(ConfigurationSourceV1 {
            parent: parent_file,
            file,
            revoked: AtomicBool::new(false),
        }),
        identity: ProductCodexBrokerConfigurationIdentityV1 {
            canonical_path: path.to_path_buf(),
            parent: parent_identity,
            modified_seconds: first.mtime(),
            modified_nanoseconds: first.mtime_nsec(),
            changed_seconds: first.ctime(),
            changed_nanoseconds: first.ctime_nsec(),
            device: first.dev(),
            inode: first.ino(),
            mode: first.mode() & 0o7777,
            uid: first.uid(),
            gid: first.gid(),
            link_count: first.nlink(),
            size: first.size(),
            content_hash,
        },
    })
}

pub(super) fn validate_configuration_shape(
    configuration: &ProductCodexBrokerConfigurationV1,
) -> Result<(), ProductCodexBrokerDaemonError> {
    if configuration.version != 1
        || !configuration.purpose.permits_role(configuration.role)
        || configuration.configuration_authority_uid == configuration.broker_uid
        || configuration.operation_authority_uid == configuration.broker_uid
        || configuration.trust_bundle_authority_uid == configuration.broker_uid
        || configuration.gate_authority_uid == configuration.broker_uid
        || configuration.allowed_peers.is_empty()
        || configuration.allowed_peers.len() > MAXIMUM_PEERS
        || configuration.trust_bundle_authority_keys.is_empty()
        || configuration.trust_bundle_authority_keys.len() > MAXIMUM_AUTHORITY_KEYS
        || configuration.listener.parent_owner_uid != configuration.broker_uid
        || configuration.listener.parent_group_gid != configuration.broker_gid
        || configuration.listener.instance_generation == 0
        || configuration.listener.listen_backlog <= 0
        || configuration.runtime.maximum_executable_bytes == 0
        || configuration.runtime.maximum_config_bytes == 0
        || configuration.runtime.model_selector.trim().is_empty()
        || configuration.server.maximum_response_bytes == 0
    {
        return Err(ProductCodexBrokerDaemonError::ConfigurationPolicy);
    }
    if let Some(acknowledgement) = &configuration.commit_acknowledgement
        && (acknowledgement.version != 2
            || !valid_identifier(&acknowledgement.authority_domain_id)
            || acknowledgement.trust_store_generation == 0
            || acknowledgement.maximum_age_ms == 0
            || acknowledgement.maximum_age_ms > HARD_MAXIMUM_ACKNOWLEDGEMENT_AGE_MS
            || acknowledgement.authority_keys.is_empty()
            || acknowledgement.authority_keys.len() > MAXIMUM_AUTHORITY_KEYS
            || acknowledgement.commit_binding_source.version != 2
            || !acknowledgement
                .commit_binding_source
                .database_path
                .is_absolute()
            || acknowledgement.commit_binding_source.busy_timeout_ms == 0
            || acknowledgement.commit_binding_source.busy_timeout_ms > 30_000
            || acknowledgement.commit_binding_source.maximum_database_bytes == 0
            || acknowledgement.commit_binding_source.maximum_database_bytes
                > 16 * 1024 * 1024 * 1024)
    {
        return Err(ProductCodexBrokerDaemonError::ConfigurationPolicy);
    }
    for path in [
        &configuration.operation_directory,
        &configuration.trust_bundle_path,
        &configuration.listener.socket_path,
        &configuration.journal.path,
        &configuration.runtime.executable,
        &configuration.runtime.codex_home,
        &configuration.gate_executable,
        &configuration.gate_state_directory,
        &configuration.cgroup.delegated_root,
    ]
    .into_iter()
    .chain(
        configuration
            .commit_acknowledgement
            .iter()
            .map(|value| &value.commit_binding_source.database_path),
    ) {
        if !path.is_absolute() {
            return Err(ProductCodexBrokerDaemonError::ConfigurationPath);
        }
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn sha256_digest(bytes: &[u8]) -> Result<Sha256Digest, ProductCodexBrokerDaemonError> {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
        .map_err(|_| ProductCodexBrokerDaemonError::Digest)
}

fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
        && left.size() == right.size()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

#[cfg(test)]
mod tests;
