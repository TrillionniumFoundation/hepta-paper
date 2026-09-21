//! Nine-role static installation observation. This never queries a manager,
//! connects a socket, opens SQLite or reads an authority private key. The opaque
//! result records this observation only: it retains no descriptors and has no
//! ongoing-currentness, native build-provenance or activation claim. Invoke before
//! opening any SQLite connection; retained public/executable FDs close on return.
use super::*;
use serde_json::{Value, json};
use std::{fs::File, path::Component};
mod authority;
use authority::ObservedAuthorityPublicInputsV2;
const MAXIMUM_SUPPLEMENTARY_GROUPS: usize = 32;
const AUTHORITY_UNIT: &str = "hepta-paper-state-authority.service";

/// Closed production role set. None is a generic command runner.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductionServiceRoleV2 {
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
    /// Isolated local online-mutation and backup authority daemon.
    StateAuthority,
}

impl ProductionServiceRoleV2 {
    /// Every role required in a complete authoritative deployment inventory.
    pub const ALL: [Self; 9] = [
        Self::ControlPlane,
        Self::CodexAuthorBroker,
        Self::CodexReviewerBroker,
        Self::CodexFormalBroker,
        Self::CodexRepairBroker,
        Self::EvidenceVerifier,
        Self::ReleaseBroker,
        Self::SubmissionBroker,
        Self::StateAuthority,
    ];
}

/// One exact service unit in the production topology.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionServiceUnitV2 {
    /// Stable service-instance identifier.
    pub service_id: String,
    /// Exact service-manager unit name, unique across this complete inventory.
    pub systemd_unit: String,
    /// Closed authority role.
    pub role: ProductionServiceRoleV2,
    /// Dedicated unprivileged process UID.
    pub principal_uid: u32,
    /// Dedicated process GID.
    pub principal_gid: u32,
    /// Bounded distinct additional groups, excluding the principal GID.
    pub supplementary_gids: Vec<u32>,
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

/// One independently pinned public configuration file.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionPublicFileV2 {
    /// Canonical absolute root-owned file, readable by the dedicated IPC group.
    pub path: PathBuf,
    /// Exact raw file bytes, not a reserialized JSON digest.
    pub sha256: Sha256Digest,
}
/// Dedicated authority-owned IPC directory, separate from all private roots.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionAuthorityIpcRootV2 {
    /// Canonical absolute directory; the configured endpoint must be its direct child.
    pub path: PathBuf,
    /// Exact daemon UID.
    pub owner_uid: u32,
    /// Exact daemon effective principal GID and dedicated IPC group.
    pub owner_gid: u32,
    /// Exactly `0750`; the daemon separately enforces socket mode `0660`.
    pub mode: u32,
}
/// Public inputs of the sole authority; private paths are bound, never opened.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionAuthorityInstallationV2 {
    /// Must name the single `StateAuthority` service.
    pub service_id: String,
    /// Must equal that unit's fixed service-manager name.
    pub systemd_unit: String,
    /// Complete daemon configuration, containing private-key path but no key bytes.
    pub daemon_configuration: ProductionPublicFileV2,
    /// Exact online public configuration, also pinned by the backup profile.
    pub online_configuration: ProductionPublicFileV2,
    /// Exact SocketConfiguration V1, never a Process configuration.
    pub backup_socket_configuration: ProductionPublicFileV2,
    /// Declared private writable root containing the configured journal path.
    pub private_state_root: PathBuf,
    /// Declared private writable root containing the configured key path.
    pub private_key_root: PathBuf,
    /// Distinct shared IPC directory. It grants no service-manager association.
    pub ipc_root: ProductionAuthorityIpcRootV2,
}
/// Complete exact-subject active service inventory.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionDeploymentManifestV2 {
    /// Contract version, exactly two.
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
    pub services: Vec<ProductionServiceUnitV2>,
    /// Mandatory public configuration and namespace binding of the sole daemon.
    pub authority: ProductionAuthorityInstallationV2,
}

/// Opaque result of one complete static filesystem/public-input observation.
/// It has no ongoing currentness, running-process or production authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedProductionDeploymentV2 {
    manifest: ProductionDeploymentManifestV2,
    identity_hash: Sha256Digest,
    authority_binding: Value,
}
impl VerifiedProductionDeploymentV2 {
    /// Exact immutable source repository.
    pub fn repository(&self) -> &str {
        &self.manifest.repository
    }
    /// Exact source commit.
    pub fn commit(&self) -> &str {
        &self.manifest.commit
    }
    /// Exact source tree.
    pub fn tree(&self) -> &str {
        &self.manifest.tree
    }
    /// Complete domain-separated nine-role static identity.
    pub fn identity_hash(&self) -> &Sha256Digest {
        &self.identity_hash
    }
    /// The full manifest actually observed; not a running-unit inventory proof.
    pub fn manifest(&self) -> &ProductionDeploymentManifestV2 {
        &self.manifest
    }
    /// Read-only derived public binding, never private-key material or permission.
    pub fn authority_binding(&self) -> &Value {
        &self.authority_binding
    }
    /// Number of declared, statically observed service instances.
    pub fn service_count(&self) -> usize {
        self.manifest.services.len()
    }
}

/// Verify the complete nine-role static subject before any caller-owned SQLite
/// connection exists. Captured public files and executables are rechecked before
/// return. Private key/journal contents and live manager/socket state are excluded.
pub fn verify_production_deployment_v2(
    manifest: &ProductionDeploymentManifestV2,
) -> Result<VerifiedProductionDeploymentV2, ProductionDeploymentError> {
    validate_manifest_v2(manifest)?;
    let ipc = &manifest.authority.ipc_root;
    let mut directories = Vec::new();
    let mut executables = Vec::new();
    let mut executable_hashes = BTreeMap::new();
    let mut roots = Vec::new();
    for service in &manifest.services {
        let executable = RetainedExecutableV2::capture(service)?;
        if executable.hash != service.executable_hash {
            return Err(ProductionDeploymentError::ExecutableHashMismatch(
                service.service_id.clone(),
            ));
        }
        if let Some(previous) =
            executable_hashes.insert(&service.executable_path, executable.hash.clone())
            && previous != executable.hash
        {
            return Err(ProductionDeploymentError::ExecutableIdentityConflict(
                service.service_id.clone(),
            ));
        }
        executables.push(executable);
        let groups = declared_groups(service);
        for root in &service.writable_roots {
            directories.push(ObservedDirectoryV2::capture(
                &root.path,
                root.owner_uid,
                root.owner_gid,
                0o700,
                &groups,
            )?);
            roots.push((service.service_id.as_str(), root.path.as_path()));
        }
    }
    let ipc_groups = BTreeSet::from([ipc.owner_gid]);
    directories.push(ObservedDirectoryV2::capture(
        &ipc.path,
        ipc.owner_uid,
        ipc.owner_gid,
        0o750,
        &ipc_groups,
    )?);
    roots.push((manifest.authority.service_id.as_str(), ipc.path.as_path()));
    reject_overlapping_roots(&roots)?;
    let mut directory_identities = BTreeSet::new();
    for directory in &directories {
        record_directory_identity_v2(&mut directory_identities, &directory.metadata)?;
    }
    let forbidden_roots = roots.iter().map(|(_, path)| *path).collect::<Vec<_>>();
    let public = ObservedAuthorityPublicInputsV2::load(&manifest.authority, &forbidden_roots)?;
    let mut public_namespaces = Vec::new();
    for file in public.files() {
        if roots.iter().any(|(_, root)| file.path.starts_with(root)) {
            return Err(ProductionDeploymentError::AuthorityInstallationInvalid);
        }
        let metadata = file.file.metadata().map_err(filesystem)?;
        if metadata.uid() != 0
            || metadata.gid() != ipc.owner_gid
            || !matches!(metadata.mode() & 0o7777, 0o440 | 0o640)
        {
            return Err(ProductionDeploymentError::AuthorityInstallationInvalid);
        }
        public_namespaces.push(ObservedAncestorsV2::capture(&file.path, &ipc_groups)?);
    }
    // Recheck all earlier observations after the final public file was captured.
    public.assert_current()?;
    for namespace in &public_namespaces {
        namespace.assert_current()?;
    }
    for directory in &directories {
        directory.assert_current()?;
    }
    for executable in &executables {
        executable.assert_current()?;
    }
    let identity_hash = deployment_identity_hash_v2(manifest, &public)?;
    Ok(VerifiedProductionDeploymentV2 {
        manifest: manifest.clone(),
        identity_hash,
        authority_binding: public.binding().clone(),
    })
}

fn deployment_identity_hash_v2(
    manifest: &ProductionDeploymentManifestV2,
    authority: &ObservedAuthorityPublicInputsV2,
) -> Result<Sha256Digest, ProductionDeploymentError> {
    canonical_hash_v1(
        &json!({"domain":"HeptaProductionDeploymentV2", "manifest":manifest,
        "authorityPublicBinding":authority.binding()}),
    )
    .map_err(|_| ProductionDeploymentError::EncodingInvalid)
}

fn strict_path(path: &Path) -> bool {
    path.to_str().is_some_and(|v| {
        v.starts_with('/')
            && v.len() > 1
            && !v.contains('\0')
            && v[1..]
                .split('/')
                .all(|p| !p.is_empty() && p != "." && p != "..")
    }) && path
        .components()
        .all(|p| matches!(p, Component::RootDir | Component::Normal(_)))
}
fn strict_descendant(path: &Path, root: &Path) -> bool {
    strict_path(path) && path != root && path.starts_with(root)
}
fn valid_unit(name: &str) -> bool {
    name.len() <= 128
        && name.ends_with(".service")
        && name.len() > ".service".len()
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
}
fn legacy_unit(service: &ProductionServiceUnitV2) -> ProductionServiceUnitV1 {
    let role = match service.role {
        ProductionServiceRoleV2::ControlPlane => ProductionServiceRoleV1::ControlPlane,
        ProductionServiceRoleV2::CodexAuthorBroker => ProductionServiceRoleV1::CodexAuthorBroker,
        ProductionServiceRoleV2::CodexReviewerBroker => {
            ProductionServiceRoleV1::CodexReviewerBroker
        }
        ProductionServiceRoleV2::CodexFormalBroker => ProductionServiceRoleV1::CodexFormalBroker,
        ProductionServiceRoleV2::CodexRepairBroker => ProductionServiceRoleV1::CodexRepairBroker,
        ProductionServiceRoleV2::EvidenceVerifier | ProductionServiceRoleV2::StateAuthority => {
            ProductionServiceRoleV1::EvidenceVerifier
        }
        ProductionServiceRoleV2::ReleaseBroker => ProductionServiceRoleV1::ReleaseBroker,
        ProductionServiceRoleV2::SubmissionBroker => ProductionServiceRoleV1::SubmissionBroker,
    };
    ProductionServiceUnitV1 {
        service_id: service.service_id.clone(),
        role,
        principal_uid: service.principal_uid,
        principal_gid: service.principal_gid,
        executable_path: service.executable_path.clone(),
        executable_hash: service.executable_hash.clone(),
        executable_owner_uid: service.executable_owner_uid,
        executable_owner_gid: service.executable_owner_gid,
        executable_mode: service.executable_mode,
        arguments: service.arguments.clone(),
        environment_keys: service.environment_keys.clone(),
        writable_roots: service.writable_roots.clone(),
        network_declared: service.network_declared,
    }
}

fn validate_manifest_v2(
    manifest: &ProductionDeploymentManifestV2,
) -> Result<(), ProductionDeploymentError> {
    if manifest.version != 2
        || manifest.repository != REQUIRED_REPOSITORY
        || !valid_git_sha(&manifest.commit)
        || !valid_git_sha(&manifest.tree)
        || !(9..=MAXIMUM_DEPLOYMENT_SERVICES).contains(&manifest.services.len())
    {
        return Err(ProductionDeploymentError::ManifestInvalid);
    }
    let binding = &manifest.authority;
    let ipc = &binding.ipc_root;
    if binding.systemd_unit != AUTHORITY_UNIT
        || ipc.mode != 0o750
        || ipc.owner_uid == 0
        || ipc.owner_gid == 0
        || !strict_path(&ipc.path)
        || !strict_path(&binding.private_state_root)
        || !strict_path(&binding.private_key_root)
        || [
            &binding.daemon_configuration,
            &binding.online_configuration,
            &binding.backup_socket_configuration,
        ]
        .iter()
        .any(|file| !strict_path(&file.path))
    {
        return Err(ProductionDeploymentError::AuthorityInstallationInvalid);
    }
    let mut ids = BTreeSet::new();
    let mut units = BTreeSet::new();
    let mut roles = BTreeSet::new();
    let mut role_principals = BTreeMap::new();
    let mut uid_roles = BTreeMap::new();
    let mut roots = Vec::new();
    let mut control_count = 0;
    let mut authority_count = 0;
    for service in &manifest.services {
        if !valid_identifier(&service.service_id)
            || !ids.insert(&service.service_id)
            || !valid_unit(&service.systemd_unit)
            || !units.insert(&service.systemd_unit)
            || service.principal_uid == 0
            || service.principal_gid == 0
            || service.executable_owner_uid != 0
            || service.executable_owner_gid != 0
            || !matches!(service.executable_mode, 0o555 | 0o755)
            || !strict_path(&service.executable_path)
            || service.arguments.len() > MAXIMUM_ARGUMENTS
            || service.environment_keys.len() > MAXIMUM_ENVIRONMENT_KEYS
            || service.writable_roots.len() > MAXIMUM_WRITABLE_ROOTS_PER_SERVICE
            || service.supplementary_gids.len() > MAXIMUM_SUPPLEMENTARY_GROUPS
        {
            return Err(ProductionDeploymentError::ServiceInvalid(
                service.service_id.clone(),
            ));
        }
        let groups = service
            .supplementary_gids
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        if groups.len() != service.supplementary_gids.len()
            || groups.contains(&0)
            || groups.contains(&service.principal_gid)
        {
            return Err(ProductionDeploymentError::PrincipalScopeViolation(
                service.service_id.clone(),
            ));
        }
        let principal = (service.principal_uid, service.principal_gid, groups.clone());
        if role_principals
            .insert(service.role, principal.clone())
            .is_some_and(|old| old != principal)
            || uid_roles
                .insert(service.principal_uid, service.role)
                .is_some_and(|old| old != service.role)
        {
            return Err(ProductionDeploymentError::PrincipalScopeViolation(
                service.service_id.clone(),
            ));
        }
        roles.insert(service.role);
        let original = legacy_unit(service);
        validate_arguments(&original)?;
        validate_environment(&original)?;
        validate_network(&original)?;
        if service.role == ProductionServiceRoleV2::StateAuthority {
            authority_count += 1;
            if service.service_id != binding.service_id
                || service.systemd_unit != binding.systemd_unit
                || service.principal_uid != ipc.owner_uid
                || service.principal_gid != ipc.owner_gid
                || service.executable_path.file_name().and_then(|v| v.to_str())
                    != Some("hepta-paper-state-authority-daemon")
                || service.arguments
                    != [
                        "--configuration".to_owned(),
                        binding
                            .daemon_configuration
                            .path
                            .to_string_lossy()
                            .into_owned(),
                    ]
                || !service.environment_keys.is_empty()
                || service.network_declared
                || [&binding.private_state_root, &binding.private_key_root]
                    .iter()
                    .any(|path| {
                        !service
                            .writable_roots
                            .iter()
                            .any(|root| &root.path == *path)
                    })
            {
                return Err(ProductionDeploymentError::AuthorityInstallationInvalid);
            }
        } else {
            validate_executable_name(&original)?;
            if service.role == ProductionServiceRoleV2::ControlPlane {
                control_count += 1;
                if service.principal_gid != ipc.owner_gid && !groups.contains(&ipc.owner_gid) {
                    return Err(ProductionDeploymentError::PrincipalScopeViolation(
                        service.service_id.clone(),
                    ));
                }
            } else if service.principal_gid == ipc.owner_gid || groups.contains(&ipc.owner_gid) {
                return Err(ProductionDeploymentError::PrincipalScopeViolation(
                    service.service_id.clone(),
                ));
            }
        }
        for root in &service.writable_roots {
            if !strict_path(&root.path)
                || root.owner_uid != service.principal_uid
                || root.owner_gid != service.principal_gid
                || root.mode != 0o700
            {
                return Err(ProductionDeploymentError::WritableRootInvalid(
                    service.service_id.clone(),
                ));
            }
            roots.push((service.service_id.as_str(), root.path.as_path()));
            if roots.len() > MAXIMUM_TOTAL_WRITABLE_ROOTS {
                return Err(ProductionDeploymentError::ManifestInvalid);
            }
        }
    }
    if control_count != 1 {
        return Err(ProductionDeploymentError::ControlPlaneMissing);
    }
    if authority_count != 1 {
        return Err(ProductionDeploymentError::AuthorityInstallationInvalid);
    }
    if roles != ProductionServiceRoleV2::ALL.into_iter().collect() {
        return Err(ProductionDeploymentError::RequiredRoleMissing);
    }
    roots.push((binding.service_id.as_str(), ipc.path.as_path()));
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
    for file in [
        &binding.daemon_configuration,
        &binding.online_configuration,
        &binding.backup_socket_configuration,
    ] {
        if roots.iter().any(|(_, root)| file.path.starts_with(root)) {
            return Err(ProductionDeploymentError::AuthorityInstallationInvalid);
        }
    }
    Ok(())
}

fn authority_error(
    error: crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError,
) -> ProductionDeploymentError {
    ProductionDeploymentError::AuthorityInput(Box::new(error))
}
fn filesystem(error: std::io::Error) -> ProductionDeploymentError {
    ProductionDeploymentError::Filesystem(error.kind())
}
fn declared_groups(service: &ProductionServiceUnitV2) -> BTreeSet<u32> {
    std::iter::once(service.principal_gid)
        .chain(service.supplementary_gids.iter().copied())
        .collect()
}
// Root ownership of an ancestor does not mean an unprivileged declared service
// can traverse it. Snapshot traversal needs read and search, not audit-user access.
fn directory_accessible_v2(mode: u32, owner_gid: u32, readable_groups: &BTreeSet<u32>) -> bool {
    let access = if readable_groups.contains(&owner_gid) {
        mode >> 3
    } else {
        mode
    };
    access & 0o5 == 0o5
}
fn directory_same(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    b.is_dir()
        && !b.is_symlink()
        && a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.mode() == b.mode()
}
fn record_directory_identity_v2(
    seen: &mut BTreeSet<(u64, u64)>,
    metadata: &fs::Metadata,
) -> Result<(), ProductionDeploymentError> {
    if !seen.insert((metadata.dev(), metadata.ino())) {
        return Err(ProductionDeploymentError::NamespaceInvalid);
    }
    Ok(())
}
struct ObservedAncestorsV2 {
    directories: Vec<(PathBuf, fs::Metadata)>,
}
impl ObservedAncestorsV2 {
    fn capture(
        path: &Path,
        readable_groups: &BTreeSet<u32>,
    ) -> Result<Self, ProductionDeploymentError> {
        if !strict_path(path) {
            return Err(ProductionDeploymentError::NamespaceInvalid);
        }
        let parent = path
            .parent()
            .ok_or(ProductionDeploymentError::NamespaceInvalid)?;
        let mut paths = parent.ancestors().collect::<Vec<_>>();
        paths.reverse();
        let mut directories = Vec::new();
        for path in paths {
            let metadata = fs::symlink_metadata(path).map_err(filesystem)?;
            if !metadata.is_dir()
                || metadata.is_symlink()
                || metadata.uid() != 0
                || !matches!(metadata.mode() & 0o7777, 0o555 | 0o550 | 0o750 | 0o755)
                || !directory_accessible_v2(metadata.mode(), metadata.gid(), readable_groups)
            {
                return Err(ProductionDeploymentError::NamespaceInvalid);
            }
            directories.push((path.to_owned(), metadata));
        }
        let result = Self { directories };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<(), ProductionDeploymentError> {
        for (path, original) in &self.directories {
            if !directory_same(original, &fs::symlink_metadata(path).map_err(filesystem)?) {
                return Err(ProductionDeploymentError::NamespaceInvalid);
            }
        }
        Ok(())
    }
}
struct ObservedDirectoryV2 {
    path: PathBuf,
    metadata: fs::Metadata,
    ancestors: ObservedAncestorsV2,
}
impl ObservedDirectoryV2 {
    fn capture(
        path: &Path,
        uid: u32,
        gid: u32,
        mode: u32,
        readable_groups: &BTreeSet<u32>,
    ) -> Result<Self, ProductionDeploymentError> {
        let ancestors = ObservedAncestorsV2::capture(path, readable_groups)?;
        let metadata = fs::symlink_metadata(path).map_err(filesystem)?;
        if !metadata.is_dir()
            || metadata.is_symlink()
            || metadata.nlink() < 2
            || metadata.uid() != uid
            || metadata.gid() != gid
            || metadata.mode() & 0o7777 != mode
        {
            return Err(ProductionDeploymentError::NamespaceInvalid);
        }
        let result = Self {
            path: path.to_owned(),
            metadata,
            ancestors,
        };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<(), ProductionDeploymentError> {
        self.ancestors.assert_current()?;
        if !directory_same(
            &self.metadata,
            &fs::symlink_metadata(&self.path).map_err(filesystem)?,
        ) {
            return Err(ProductionDeploymentError::NamespaceInvalid);
        }
        Ok(())
    }
}
struct RetainedExecutableV2 {
    path: PathBuf,
    file: File,
    metadata: fs::Metadata,
    ancestors: ObservedAncestorsV2,
    hash: Sha256Digest,
}
impl RetainedExecutableV2 {
    fn capture(service: &ProductionServiceUnitV2) -> Result<Self, ProductionDeploymentError> {
        let path = &service.executable_path;
        let ancestors = ObservedAncestorsV2::capture(path, &declared_groups(service))?;
        let before = fs::symlink_metadata(path).map_err(filesystem)?;
        if !before.is_file()
            || before.is_symlink()
            || before.nlink() != 1
            || before.uid() != 0
            || before.gid() != 0
            || before.mode() & 0o7777 != service.executable_mode
            || before.len() < 4
            || before.len() > MAXIMUM_EXECUTABLE_BYTES
        {
            return Err(ProductionDeploymentError::ExecutableInvalid);
        }
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC | nix::libc::O_NONBLOCK)
            .open(path)
            .map_err(filesystem)?;
        let metadata = file.metadata().map_err(filesystem)?;
        if !same_file(&before, &metadata) {
            return Err(ProductionDeploymentError::ExecutableChanged);
        }
        let mut magic = [0u8; 4];
        file.read_exact(&mut magic).map_err(filesystem)?;
        if &magic != ELF_MAGIC {
            return Err(ProductionDeploymentError::ExecutableInvalid);
        }
        let mut hasher = Sha256::new();
        hasher.update(magic);
        let mut remaining = metadata.len() - 4;
        let mut buffer = [0u8; 64 * 1024];
        while remaining > 0 {
            let size = usize::try_from(remaining.min(buffer.len() as u64))
                .map_err(|_| ProductionDeploymentError::ExecutableInvalid)?;
            file.read_exact(&mut buffer[..size]).map_err(filesystem)?;
            hasher.update(&buffer[..size]);
            remaining -= size as u64;
        }
        match file.read_exact(&mut [0u8; 1]) {
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {}
            Ok(()) => return Err(ProductionDeploymentError::ExecutableChanged),
            Err(e) => return Err(filesystem(e)),
        }
        let result = Self {
            path: path.clone(),
            file,
            metadata,
            ancestors,
            hash: Sha256Digest::from_digest_bytes(hasher.finalize().into()),
        };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<(), ProductionDeploymentError> {
        self.ancestors.assert_current()?;
        if !same_file(&self.metadata, &self.file.metadata().map_err(filesystem)?)
            || !same_file(
                &self.metadata,
                &fs::symlink_metadata(&self.path).map_err(filesystem)?,
            )
        {
            return Err(ProductionDeploymentError::ExecutableChanged);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
