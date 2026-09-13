//! Node-free production deployment inventory and filesystem verification.
//!
//! Source files and test oracles may remain in the repository. They cannot appear
//! in an accepted production inventory. A verified deployment is an opaque value
//! constructed only after every active executable is a stable, root-owned native
//! Linux binary whose bytes and metadata match the manifest. The inventory also
//! binds the service-manager, mount and legacy-runtime scans independently signed
//! by the target-host qualification package.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
};

use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::canonical_hash_v1;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_DEPLOYMENT_SERVICES: usize = 32;
const MAXIMUM_ARGUMENTS: usize = 64;
const MAXIMUM_ENVIRONMENT_KEYS: usize = 128;
const MAXIMUM_WRITABLE_ROOTS_PER_SERVICE: usize = 16;
const MAXIMUM_TOTAL_WRITABLE_ROOTS: usize = 128;
const MAXIMUM_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;
const REQUIRED_REPOSITORY: &str = "TrillionniumFoundation/hepta-paper";
const ELF_MAGIC: &[u8; 4] = b"\x7fELF";

/// Closed production role set. None is a generic command runner.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductionServiceRoleV1 {
    /// Unique campaign writer and scheduler.
    ControlPlane,
    /// Isolated author-role Codex broker.
    CodexAuthorBroker,
    /// Isolated reviewer-role Codex broker.
    CodexReviewerBroker,
    /// Isolated formal-review Codex broker.
    CodexFormalBroker,
    /// Isolated repair-role Codex broker.
    CodexRepairBroker,
    /// Independent evidence recomputation service.
    EvidenceVerifier,
    /// KMS/HSM/WORM-backed release authority adapter.
    ReleaseBroker,
    /// Portal-bound submission authority adapter.
    SubmissionBroker,
}

impl ProductionServiceRoleV1 {
    /// Every role required in a complete authoritative deployment inventory.
    pub const ALL: [Self; 8] = [
        Self::ControlPlane,
        Self::CodexAuthorBroker,
        Self::CodexReviewerBroker,
        Self::CodexFormalBroker,
        Self::CodexRepairBroker,
        Self::EvidenceVerifier,
        Self::ReleaseBroker,
        Self::SubmissionBroker,
    ];
}

/// Explicit disposition of the old runtime in the active production topology.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyNodeRuntimeDispositionV1 {
    /// Node artifacts may exist only as offline test/reference material.
    RemovedFromProduction,
}

/// One principal-owned writable root in the production topology.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionWritableRootV1 {
    /// Canonical absolute directory.
    pub path: PathBuf,
    /// Exact service-principal owner.
    pub owner_uid: u32,
    /// Exact service-principal group.
    pub owner_gid: u32,
    /// Exact private permission bits; V1 requires `0700`.
    pub mode: u32,
}

/// One exact service unit in the production topology.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionServiceUnitV1 {
    /// Stable service-instance identifier.
    pub service_id: String,
    /// Closed authority role.
    pub role: ProductionServiceRoleV1,
    /// Dedicated unprivileged process UID.
    pub principal_uid: u32,
    /// Dedicated process GID.
    pub principal_gid: u32,
    /// Canonical root-owned executable path.
    pub executable_path: PathBuf,
    /// Exact executable content hash.
    pub executable_hash: Sha256Digest,
    /// Expected executable owner; V1 requires root.
    pub executable_owner_uid: u32,
    /// Expected executable group; V1 requires root.
    pub executable_owner_gid: u32,
    /// Exact executable mode (`0555` or `0755`).
    pub executable_mode: u32,
    /// Closed fixed argument vector; no interpreter or script tokens.
    pub arguments: Vec<String>,
    /// Names of environment variables admitted by the service manager.
    pub environment_keys: Vec<String>,
    /// Principal-private mutable roots.
    pub writable_roots: Vec<ProductionWritableRootV1>,
    /// Whether outbound network access is deliberately declared.
    pub network_declared: bool,
}

/// Complete exact-subject active service inventory.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionDeploymentManifestV1 {
    /// Contract version, exactly one.
    pub version: u16,
    /// Canonical repository full name.
    pub repository: String,
    /// Exact forty-character source commit.
    pub commit: String,
    /// Exact forty-character source tree.
    pub tree: String,
    /// Hash of the complete service-manager unit and enablement inventory.
    pub service_manager_inventory_hash: Sha256Digest,
    /// Hash of the target mount/namespace/cgroup topology inventory.
    pub mount_topology_hash: Sha256Digest,
    /// Hash of the complete negative scan for active Node/script entrypoints.
    pub legacy_runtime_scan_hash: Sha256Digest,
    /// Closed legacy-runtime disposition.
    pub legacy_node_runtime: LegacyNodeRuntimeDispositionV1,
    /// Every active first-party production service.
    pub services: Vec<ProductionServiceUnitV1>,
}

/// Filesystem-verified, Node-free deployment identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedProductionDeploymentV1 {
    repository: String,
    commit: String,
    tree: String,
    identity_hash: Sha256Digest,
    control_executable_path: PathBuf,
    control_executable_hash: Sha256Digest,
    service_count: usize,
}

impl VerifiedProductionDeploymentV1 {
    /// Canonical repository full name.
    #[must_use]
    pub fn repository(&self) -> &str {
        &self.repository
    }

    /// Exact source commit.
    #[must_use]
    pub fn commit(&self) -> &str {
        &self.commit
    }

    /// Exact source tree.
    #[must_use]
    pub fn tree(&self) -> &str {
        &self.tree
    }

    /// Canonical deployment identity consumed by external host evidence.
    #[must_use]
    pub fn identity_hash(&self) -> &Sha256Digest {
        &self.identity_hash
    }

    /// Canonical control-plane executable path.
    #[must_use]
    pub fn control_executable_path(&self) -> &Path {
        &self.control_executable_path
    }

    /// Recomputed control-plane executable content hash.
    #[must_use]
    pub fn control_executable_hash(&self) -> &Sha256Digest {
        &self.control_executable_hash
    }

    /// Number of active service instances in the verified topology.
    #[must_use]
    pub const fn service_count(&self) -> usize {
        self.service_count
    }
}

/// Validates the complete manifest, checks every private root and rehashes every
/// executable from a stable descriptor before constructing an opaque identity.
pub fn verify_production_deployment_v1(
    manifest: &ProductionDeploymentManifestV1,
) -> Result<VerifiedProductionDeploymentV1, ProductionDeploymentError> {
    validate_manifest(manifest)?;
    let mut control = None;
    let mut executable_observations = BTreeMap::<PathBuf, ExecutableObservationV1>::new();
    let mut roots = Vec::new();
    for service in &manifest.services {
        let observed = stable_executable_observation(service)?;
        if observed.content_hash != service.executable_hash {
            return Err(ProductionDeploymentError::ExecutableHashMismatch(
                service.service_id.clone(),
            ));
        }
        if let Some(previous) =
            executable_observations.insert(service.executable_path.clone(), observed.clone())
            && previous != observed
        {
            return Err(ProductionDeploymentError::ExecutableIdentityConflict(
                service.service_id.clone(),
            ));
        }
        for root in &service.writable_roots {
            verify_writable_root(service, root)?;
            roots.push((service.service_id.as_str(), root.path.as_path()));
        }
        if service.role == ProductionServiceRoleV1::ControlPlane {
            control = Some((service.executable_path.clone(), observed.content_hash));
        }
    }
    reject_overlapping_roots(&roots)?;
    for service in &manifest.services {
        if roots
            .iter()
            .any(|(_, root)| service.executable_path.starts_with(root))
        {
            return Err(ProductionDeploymentError::ExecutableInWritableRoot(
                service.service_id.clone(),
            ));
        }
    }
    let (control_executable_path, control_executable_hash) =
        control.ok_or(ProductionDeploymentError::ControlPlaneMissing)?;
    let identity_hash = canonical_hash_v1(&DeploymentIdentityBodyV1 {
        domain: "HeptaProductionDeploymentV1",
        manifest,
        node_runtime_present: false,
        production_only_native_binaries: true,
        filesystem_verified: true,
    })
    .map_err(|_| ProductionDeploymentError::EncodingInvalid)?;
    Ok(VerifiedProductionDeploymentV1 {
        repository: manifest.repository.clone(),
        commit: manifest.commit.clone(),
        tree: manifest.tree.clone(),
        identity_hash,
        control_executable_path,
        control_executable_hash,
        service_count: manifest.services.len(),
    })
}

fn validate_manifest(
    manifest: &ProductionDeploymentManifestV1,
) -> Result<(), ProductionDeploymentError> {
    if manifest.version != 1
        || manifest.repository != REQUIRED_REPOSITORY
        || !valid_git_sha(&manifest.commit)
        || !valid_git_sha(&manifest.tree)
        || manifest.services.len() < ProductionServiceRoleV1::ALL.len()
        || manifest.services.len() > MAXIMUM_DEPLOYMENT_SERVICES
    {
        return Err(ProductionDeploymentError::ManifestInvalid);
    }
    let mut service_ids = BTreeSet::new();
    let mut roles = BTreeSet::new();
    let mut role_principals = BTreeMap::new();
    let mut principal_roles = BTreeMap::new();
    let mut total_roots = 0usize;
    let mut control_count = 0usize;
    for service in &manifest.services {
        if !valid_identifier(&service.service_id)
            || !service_ids.insert(service.service_id.clone())
            || service.principal_uid == 0
            || service.principal_gid == 0
            || service.executable_owner_uid != 0
            || service.executable_owner_gid != 0
            || !matches!(service.executable_mode, 0o555 | 0o755)
            || service.arguments.len() > MAXIMUM_ARGUMENTS
            || service.environment_keys.len() > MAXIMUM_ENVIRONMENT_KEYS
            || service.writable_roots.len() > MAXIMUM_WRITABLE_ROOTS_PER_SERVICE
            || !service.executable_path.is_absolute()
            || service.executable_path.file_name().is_none()
        {
            return Err(ProductionDeploymentError::ServiceInvalid(
                service.service_id.clone(),
            ));
        }
        roles.insert(service.role);
        let principal = (service.principal_uid, service.principal_gid);
        if let Some(previous) = role_principals.insert(service.role, principal)
            && previous != principal
        {
            return Err(ProductionDeploymentError::PrincipalScopeViolation(
                service.service_id.clone(),
            ));
        }
        if let Some(previous) = principal_roles.insert(principal, service.role)
            && previous != service.role
        {
            return Err(ProductionDeploymentError::PrincipalScopeViolation(
                service.service_id.clone(),
            ));
        }
        total_roots = total_roots
            .checked_add(service.writable_roots.len())
            .ok_or(ProductionDeploymentError::ManifestInvalid)?;
        if total_roots > MAXIMUM_TOTAL_WRITABLE_ROOTS {
            return Err(ProductionDeploymentError::ManifestInvalid);
        }
        validate_executable_name(service)?;
        validate_arguments(service)?;
        validate_environment(service)?;
        validate_network(service)?;
        let mut local_roots = BTreeSet::new();
        for root in &service.writable_roots {
            if root.owner_uid != service.principal_uid
                || root.owner_gid != service.principal_gid
                || root.mode != 0o700
                || !root.path.is_absolute()
                || !local_roots.insert(root.path.clone())
            {
                return Err(ProductionDeploymentError::WritableRootInvalid(
                    service.service_id.clone(),
                ));
            }
        }
        if service.role == ProductionServiceRoleV1::ControlPlane {
            control_count += 1;
        }
    }
    if control_count != 1 {
        return Err(ProductionDeploymentError::ControlPlaneMissing);
    }
    let required = ProductionServiceRoleV1::ALL
        .into_iter()
        .collect::<BTreeSet<_>>();
    if roles != required {
        return Err(ProductionDeploymentError::RequiredRoleMissing);
    }
    Ok(())
}

fn validate_executable_name(
    service: &ProductionServiceUnitV1,
) -> Result<(), ProductionDeploymentError> {
    let file_name = service
        .executable_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| ProductionDeploymentError::ServiceInvalid(service.service_id.clone()))?;
    let lower = file_name.to_ascii_lowercase();
    if is_forbidden_runtime(&lower)
        || lower.ends_with(".js")
        || lower.ends_with(".mjs")
        || lower.ends_with(".cjs")
        || lower.ends_with(".ts")
        || lower.ends_with(".sh")
        || lower.ends_with(".py")
    {
        return Err(ProductionDeploymentError::LegacyRuntimePresent(
            service.service_id.clone(),
        ));
    }
    let valid_role_binary = match service.role {
        ProductionServiceRoleV1::ControlPlane => file_name == "hepta-paper-rust",
        ProductionServiceRoleV1::CodexAuthorBroker
        | ProductionServiceRoleV1::CodexReviewerBroker
        | ProductionServiceRoleV1::CodexFormalBroker
        | ProductionServiceRoleV1::CodexRepairBroker => file_name == "hepta-codex-broker",
        ProductionServiceRoleV1::EvidenceVerifier => file_name == "hepta-evidence-verifier",
        ProductionServiceRoleV1::ReleaseBroker => file_name == "hepta-release-broker",
        ProductionServiceRoleV1::SubmissionBroker => file_name == "hepta-submission-broker",
    };
    if !valid_role_binary {
        return Err(ProductionDeploymentError::RoleBinaryMismatch(
            service.service_id.clone(),
        ));
    }
    Ok(())
}

fn validate_arguments(service: &ProductionServiceUnitV1) -> Result<(), ProductionDeploymentError> {
    for argument in &service.arguments {
        if argument.is_empty()
            || argument.len() > 4096
            || argument.contains('\0')
            || argument.chars().any(char::is_control)
            || contains_legacy_runtime_token(argument)
        {
            return Err(ProductionDeploymentError::LegacyRuntimePresent(
                service.service_id.clone(),
            ));
        }
    }
    Ok(())
}

fn validate_environment(
    service: &ProductionServiceUnitV1,
) -> Result<(), ProductionDeploymentError> {
    let mut keys = BTreeSet::new();
    let mut has_codex_home = false;
    for key in &service.environment_keys {
        if !valid_environment_key(key) || !keys.insert(key.clone()) || is_node_environment_key(key)
        {
            return Err(ProductionDeploymentError::LegacyRuntimePresent(
                service.service_id.clone(),
            ));
        }
        has_codex_home |= key == "CODEX_HOME";
        if !credential_key_allowed(service.role, key) {
            return Err(ProductionDeploymentError::CredentialScopeViolation(
                service.service_id.clone(),
            ));
        }
    }
    let codex_role = matches!(
        service.role,
        ProductionServiceRoleV1::CodexAuthorBroker
            | ProductionServiceRoleV1::CodexReviewerBroker
            | ProductionServiceRoleV1::CodexFormalBroker
            | ProductionServiceRoleV1::CodexRepairBroker
    );
    if codex_role != has_codex_home {
        return Err(ProductionDeploymentError::CredentialScopeViolation(
            service.service_id.clone(),
        ));
    }
    Ok(())
}

fn validate_network(service: &ProductionServiceUnitV1) -> Result<(), ProductionDeploymentError> {
    let may_use_network = matches!(
        service.role,
        ProductionServiceRoleV1::CodexAuthorBroker
            | ProductionServiceRoleV1::CodexReviewerBroker
            | ProductionServiceRoleV1::CodexFormalBroker
            | ProductionServiceRoleV1::CodexRepairBroker
            | ProductionServiceRoleV1::ReleaseBroker
            | ProductionServiceRoleV1::SubmissionBroker
    );
    if service.network_declared && !may_use_network {
        return Err(ProductionDeploymentError::NetworkScopeViolation(
            service.service_id.clone(),
        ));
    }
    Ok(())
}

fn stable_executable_observation(
    service: &ProductionServiceUnitV1,
) -> Result<ExecutableObservationV1, ProductionDeploymentError> {
    let path = &service.executable_path;
    if !path.is_absolute() || fs::canonicalize(path).ok().as_deref() != Some(path.as_path()) {
        return Err(ProductionDeploymentError::ExecutableInvalid);
    }
    let before = fs::symlink_metadata(path)
        .map_err(|error| ProductionDeploymentError::Filesystem(error.kind()))?;
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.nlink() != 1
        || before.uid() != service.executable_owner_uid
        || before.gid() != service.executable_owner_gid
        || before.permissions().mode() & 0o7777 != service.executable_mode
        || before.size() == 0
        || before.size() > MAXIMUM_EXECUTABLE_BYTES
    {
        return Err(ProductionDeploymentError::ExecutableInvalid);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits())
        .open(path)
        .map_err(|error| ProductionDeploymentError::Filesystem(error.kind()))?;
    let opened = file
        .metadata()
        .map_err(|error| ProductionDeploymentError::Filesystem(error.kind()))?;
    if !same_file(&before, &opened) {
        return Err(ProductionDeploymentError::ExecutableChanged);
    }
    let capacity =
        usize::try_from(opened.size()).map_err(|_| ProductionDeploymentError::ExecutableInvalid)?;
    let mut bytes = Vec::with_capacity(capacity);
    (&mut file)
        .take(MAXIMUM_EXECUTABLE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| ProductionDeploymentError::Filesystem(error.kind()))?;
    let after_open = file
        .metadata()
        .map_err(|error| ProductionDeploymentError::Filesystem(error.kind()))?;
    let after_path = fs::symlink_metadata(path)
        .map_err(|error| ProductionDeploymentError::Filesystem(error.kind()))?;
    if u64::try_from(bytes.len()).map_err(|_| ProductionDeploymentError::ExecutableInvalid)?
        != opened.size()
        || !bytes.starts_with(ELF_MAGIC)
        || !same_file(&opened, &after_open)
        || !same_file(&after_open, &after_path)
    {
        return Err(ProductionDeploymentError::ExecutableChanged);
    }
    let content_hash =
        Sha256Digest::from_str(&format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
            .map_err(|_| ProductionDeploymentError::EncodingInvalid)?;
    Ok(ExecutableObservationV1 {
        content_hash,
        owner_uid: opened.uid(),
        owner_gid: opened.gid(),
        mode: opened.permissions().mode() & 0o7777,
        byte_count: opened.size(),
    })
}

fn verify_writable_root(
    service: &ProductionServiceUnitV1,
    root: &ProductionWritableRootV1,
) -> Result<(), ProductionDeploymentError> {
    if fs::canonicalize(&root.path).ok().as_deref() != Some(root.path.as_path()) {
        return Err(ProductionDeploymentError::WritableRootInvalid(
            service.service_id.clone(),
        ));
    }
    let metadata = fs::symlink_metadata(&root.path)
        .map_err(|error| ProductionDeploymentError::Filesystem(error.kind()))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.nlink() < 2
        || metadata.uid() != root.owner_uid
        || metadata.gid() != root.owner_gid
        || metadata.permissions().mode() & 0o7777 != root.mode
    {
        return Err(ProductionDeploymentError::WritableRootInvalid(
            service.service_id.clone(),
        ));
    }
    Ok(())
}

fn reject_overlapping_roots(roots: &[(&str, &Path)]) -> Result<(), ProductionDeploymentError> {
    for (index, (service_id, left)) in roots.iter().enumerate() {
        for (_, right) in roots.iter().skip(index + 1) {
            if left.starts_with(right) || right.starts_with(left) {
                return Err(ProductionDeploymentError::WritableRootInvalid(
                    (*service_id).to_owned(),
                ));
            }
        }
    }
    Ok(())
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

fn is_forbidden_runtime(value: &str) -> bool {
    matches!(
        value,
        "node"
            | "nodejs"
            | "npm"
            | "npx"
            | "pnpm"
            | "yarn"
            | "bun"
            | "deno"
            | "bash"
            | "sh"
            | "dash"
            | "zsh"
            | "python"
            | "python3"
    )
}

fn contains_legacy_runtime_token(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.ends_with(".js")
        || lower.ends_with(".mjs")
        || lower.ends_with(".cjs")
        || lower.ends_with(".ts")
        || lower.ends_with(".sh")
        || lower
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(is_forbidden_runtime)
}

fn is_node_environment_key(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    upper == "NODE"
        || upper.starts_with("NODE_")
        || upper.starts_with("NPM_")
        || upper.starts_with("PNPM_")
        || upper.starts_with("YARN_")
        || upper.starts_with("BUN_")
        || upper.starts_with("DENO_")
}

fn credential_key_allowed(role: ProductionServiceRoleV1, value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    let codex =
        upper == "CODEX_HOME" || upper.starts_with("CODEX_") || upper.starts_with("OPENAI_");
    let release = ["KMS", "HSM", "WORM", "RELEASE_KEY"]
        .iter()
        .any(|needle| upper.contains(needle));
    let submission = ["SUBMISSION", "PORTAL"]
        .iter()
        .any(|needle| upper.contains(needle));
    let generic_secret = [
        "API_KEY",
        "ACCESS_TOKEN",
        "CLIENT_SECRET",
        "PRIVATE_KEY",
        "CREDENTIAL",
    ]
    .iter()
    .any(|needle| upper.contains(needle));
    if !(codex || release || submission || generic_secret) {
        return true;
    }
    match role {
        ProductionServiceRoleV1::CodexAuthorBroker
        | ProductionServiceRoleV1::CodexReviewerBroker
        | ProductionServiceRoleV1::CodexFormalBroker
        | ProductionServiceRoleV1::CodexRepairBroker => codex && !release && !submission,
        ProductionServiceRoleV1::ReleaseBroker => release && !codex && !submission,
        ProductionServiceRoleV1::SubmissionBroker => submission && !codex && !release,
        ProductionServiceRoleV1::ControlPlane | ProductionServiceRoleV1::EvidenceVerifier => false,
    }
}

fn valid_environment_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase() || byte == b'_')
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn valid_git_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ExecutableObservationV1 {
    content_hash: Sha256Digest,
    owner_uid: u32,
    owner_gid: u32,
    mode: u32,
    byte_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentIdentityBodyV1<'a> {
    domain: &'static str,
    manifest: &'a ProductionDeploymentManifestV1,
    node_runtime_present: bool,
    production_only_native_binaries: bool,
    filesystem_verified: bool,
}

/// Deployment topology or filesystem rejection.
#[derive(Debug, Error)]
pub enum ProductionDeploymentError {
    /// Subject, bounds or top-level manifest shape is invalid.
    #[error("production deployment manifest is invalid")]
    ManifestInvalid,
    /// One service record is malformed or duplicated.
    #[error("production service is invalid: {0}")]
    ServiceInvalid(String),
    /// Exactly one control-plane service is required.
    #[error("production control-plane service is missing or duplicated")]
    ControlPlaneMissing,
    /// One or more mandatory isolated authority roles is absent.
    #[error("production deployment is missing a required service role")]
    RequiredRoleMissing,
    /// A script interpreter, JavaScript entrypoint or Node environment is active.
    #[error("legacy or generic runtime appears in production service: {0}")]
    LegacyRuntimePresent(String),
    /// A service role points at the wrong Rust binary.
    #[error("production role and executable do not match: {0}")]
    RoleBinaryMismatch(String),
    /// Different authority roles share a principal or replicas disagree on it.
    #[error("production principal scope is invalid: {0}")]
    PrincipalScopeViolation(String),
    /// A mutable root is absent, shared, nested, aliased or incorrectly owned.
    #[error("production writable root is invalid or shared: {0}")]
    WritableRootInvalid(String),
    /// A supposedly immutable executable is reachable under a mutable root.
    #[error("production executable is inside a writable root: {0}")]
    ExecutableInWritableRoot(String),
    /// An environment credential can cross its owning authority boundary.
    #[error("production service received a credential outside its authority scope: {0}")]
    CredentialScopeViolation(String),
    /// A non-network role declares network access.
    #[error("production service network scope is invalid: {0}")]
    NetworkScopeViolation(String),
    /// Executable path, type, owner, mode, size or native format is invalid.
    #[error("production executable is invalid")]
    ExecutableInvalid,
    /// Executable identity changed while it was read.
    #[error("production executable changed while being hashed")]
    ExecutableChanged,
    /// Repeated references to one executable disagree on observed identity.
    #[error("production executable identity conflicts across services: {0}")]
    ExecutableIdentityConflict(String),
    /// Observed bytes do not match the manifest digest.
    #[error("production executable hash mismatch: {0}")]
    ExecutableHashMismatch(String),
    /// Canonical deployment receipt encoding failed.
    #[error("production deployment encoding failed")]
    EncodingInvalid,
    /// Filesystem inspection failed without exposing a sensitive path.
    #[error("production deployment filesystem failure: {0:?}")]
    Filesystem(std::io::ErrorKind),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(byte: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64))).expect("digest")
    }

    fn unit(
        role: ProductionServiceRoleV1,
        service_id: &str,
        executable: &str,
        principal: u32,
    ) -> ProductionServiceUnitV1 {
        let environment_keys = if matches!(
            role,
            ProductionServiceRoleV1::CodexAuthorBroker
                | ProductionServiceRoleV1::CodexReviewerBroker
                | ProductionServiceRoleV1::CodexFormalBroker
                | ProductionServiceRoleV1::CodexRepairBroker
        ) {
            vec!["LANG".into(), "CODEX_HOME".into()]
        } else {
            vec!["LANG".into()]
        };
        ProductionServiceUnitV1 {
            service_id: service_id.into(),
            role,
            principal_uid: principal,
            principal_gid: principal,
            executable_path: PathBuf::from(executable),
            executable_hash: digest('1'),
            executable_owner_uid: 0,
            executable_owner_gid: 0,
            executable_mode: 0o755,
            arguments: vec!["serve".into()],
            environment_keys,
            writable_roots: vec![],
            network_declared: !matches!(
                role,
                ProductionServiceRoleV1::ControlPlane | ProductionServiceRoleV1::EvidenceVerifier
            ),
        }
    }

    fn manifest() -> ProductionDeploymentManifestV1 {
        ProductionDeploymentManifestV1 {
            version: 1,
            repository: REQUIRED_REPOSITORY.into(),
            commit: "a".repeat(40),
            tree: "b".repeat(40),
            service_manager_inventory_hash: digest('2'),
            mount_topology_hash: digest('3'),
            legacy_runtime_scan_hash: digest('4'),
            legacy_node_runtime: LegacyNodeRuntimeDispositionV1::RemovedFromProduction,
            services: vec![
                unit(
                    ProductionServiceRoleV1::ControlPlane,
                    "control-plane",
                    "/opt/hepta/hepta-paper-rust",
                    1001,
                ),
                unit(
                    ProductionServiceRoleV1::CodexAuthorBroker,
                    "codex-author",
                    "/opt/hepta/hepta-codex-broker",
                    1002,
                ),
                unit(
                    ProductionServiceRoleV1::CodexReviewerBroker,
                    "codex-reviewer",
                    "/opt/hepta/hepta-codex-broker",
                    1003,
                ),
                unit(
                    ProductionServiceRoleV1::CodexFormalBroker,
                    "codex-formal",
                    "/opt/hepta/hepta-codex-broker",
                    1004,
                ),
                unit(
                    ProductionServiceRoleV1::CodexRepairBroker,
                    "codex-repair",
                    "/opt/hepta/hepta-codex-broker",
                    1005,
                ),
                unit(
                    ProductionServiceRoleV1::EvidenceVerifier,
                    "evidence",
                    "/opt/hepta/hepta-evidence-verifier",
                    1006,
                ),
                unit(
                    ProductionServiceRoleV1::ReleaseBroker,
                    "release",
                    "/opt/hepta/hepta-release-broker",
                    1007,
                ),
                unit(
                    ProductionServiceRoleV1::SubmissionBroker,
                    "submission",
                    "/opt/hepta/hepta-submission-broker",
                    1008,
                ),
            ],
        }
    }

    #[test]
    fn structural_manifest_rejects_node_and_shell_entrypoints() {
        for executable in ["/usr/bin/node", "/opt/hepta/start.mjs", "/bin/bash"] {
            let mut value = manifest();
            value.services[0].executable_path = PathBuf::from(executable);
            assert!(matches!(
                validate_manifest(&value),
                Err(ProductionDeploymentError::LegacyRuntimePresent(_))
                    | Err(ProductionDeploymentError::RoleBinaryMismatch(_))
            ));
        }
    }

    #[test]
    fn structural_manifest_rejects_control_plane_credentials_and_network() {
        let mut value = manifest();
        value.services[0].environment_keys = vec!["OPENAI_API_KEY".into()];
        assert!(matches!(
            validate_manifest(&value),
            Err(ProductionDeploymentError::CredentialScopeViolation(_))
        ));
        value.services[0].environment_keys = vec!["LANG".into()];
        value.services[0].network_declared = true;
        assert!(matches!(
            validate_manifest(&value),
            Err(ProductionDeploymentError::NetworkScopeViolation(_))
        ));
    }

    #[test]
    fn structural_manifest_rejects_missing_role_and_cross_role_principal() {
        let mut missing = manifest();
        missing.services.pop();
        assert!(validate_manifest(&missing).is_err());

        let mut shared = manifest();
        shared.services[1].principal_uid = shared.services[0].principal_uid;
        shared.services[1].principal_gid = shared.services[0].principal_gid;
        assert!(matches!(
            validate_manifest(&shared),
            Err(ProductionDeploymentError::PrincipalScopeViolation(_))
        ));
    }

    #[test]
    fn structurally_valid_inventory_remains_non_authoritative_until_files_are_verified() {
        assert!(validate_manifest(&manifest()).is_ok());
    }
}
