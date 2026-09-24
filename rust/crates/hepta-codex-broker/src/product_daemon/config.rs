use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
};

use hepta_codex_protocol::{AgentRole, Sha256Digest};
use hepta_codex_runtime::ProcessLimitsV1;
use nix::unistd::{Gid, Uid};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::PeerPrincipalV1;

use super::ProductCodexBrokerDaemonError;

const MAXIMUM_CONFIGURATION_BYTES: u64 = 1024 * 1024;
const MAXIMUM_AUTHORITY_KEYS: usize = 64;
const MAXIMUM_PEERS: usize = 64;
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
    pub operation_authority_uid: u32,
    pub operation_directory: PathBuf,
    pub trust_bundle_path: PathBuf,
    pub trust_bundle_authority_uid: u32,
    pub trust_bundle_reader_gid: u32,
    pub trust_bundle_authority_keys: Vec<ProductBundleAuthorityKeyV1>,
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
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub link_count: u64,
    pub size: u64,
    pub content_hash: Sha256Digest,
}

impl ProductCodexBrokerConfigurationIdentityV1 {
    #[must_use]
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoadedProductCodexBrokerConfigurationV1 {
    pub configuration: ProductCodexBrokerConfigurationV1,
    pub identity: ProductCodexBrokerConfigurationIdentityV1,
}

pub fn load_product_codex_broker_configuration(
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
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| ProductCodexBrokerDaemonError::Filesystem("config_open", error.kind()))?;
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
    if Uid::effective().as_raw() != configuration.broker_uid
        || Gid::effective().as_raw() != configuration.broker_gid
    {
        return Err(ProductCodexBrokerDaemonError::BrokerPrincipal);
    }
    let content_hash = sha256_digest(&bytes)?;
    Ok(LoadedProductCodexBrokerConfigurationV1 {
        configuration,
        identity: ProductCodexBrokerConfigurationIdentityV1 {
            canonical_path: path.to_path_buf(),
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
    ] {
        if !path.is_absolute() {
            return Err(ProductCodexBrokerDaemonError::ConfigurationPath);
        }
    }
    Ok(())
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
