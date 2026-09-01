use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};

use crate::{
    ActivationStateV1, AuthorityClassV1, MAXIMUM_MODULES_V1, MODULE_PROTOCOL_VERSION_V1,
    ModuleDependencyV1, ModuleExecutionV1, ModuleKindV1, ModulePlatformError, QualificationTierV1,
    hash::canonical_hash,
    types::{
        duplicate_dependencies, duplicate_strings, is_strictly_sorted, valid_capability_id,
        valid_module_id, valid_owner, valid_semver,
    },
};

/// Self-description proposed by one module version.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleManifestV1 {
    /// Contract version.
    pub version: u16,
    /// Stable module identifier.
    pub module_id: String,
    /// Exact semantic version.
    pub module_version: String,
    /// Lowest supported protocol version.
    pub protocol_min: u16,
    /// Highest supported protocol version.
    pub protocol_max: u16,
    /// Implementation topology.
    pub module_kind: ModuleKindV1,
    /// Requested authority. Policy must match it exactly.
    pub requested_authority: AuthorityClassV1,
    /// Evidence presented for this version.
    pub qualification: QualificationTierV1,
    /// Requested activation. Policy must match it exactly.
    pub requested_activation: ActivationStateV1,
    /// Capabilities implemented by this version.
    pub capability_ids: Vec<String>,
    /// Exact module dependencies.
    pub dependencies: Vec<ModuleDependencyV1>,
    /// Primary implementation owner.
    pub primary_owner: String,
    /// Secondary implementation owner.
    pub secondary_owner: String,
    /// Independent reviewer identity/domain.
    pub independent_reviewer: String,
    /// Exact rollback version, distinct from current.
    pub rollback_version: String,
    /// Execution identity and boundary.
    pub execution: ModuleExecutionV1,
}

/// Registry-owned grant for one exact module version.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleGrantV1 {
    /// Exact module version.
    pub module_version: String,
    /// Maximum authority granted to this version.
    pub authority: AuthorityClassV1,
    /// Minimum evidence tier.
    pub minimum_qualification: QualificationTierV1,
    /// Activation state selected by the control plane.
    pub activation: ActivationStateV1,
    /// Exact capability allowlist.
    pub capability_ids: BTreeSet<String>,
}

/// Registry policy supplied independently of module manifests.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryPolicyV1 {
    /// Contract version.
    pub version: u16,
    /// Canonical protocol version.
    pub protocol_version: u16,
    /// Stable ID of the only central-state writer.
    pub central_writer_module_id: String,
    /// Exact grants keyed by module ID.
    pub grants: BTreeMap<String, ModuleGrantV1>,
}

/// Canonical registry entry after policy validation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisteredModuleV1 {
    /// Validated manifest.
    pub manifest: ModuleManifestV1,
    /// Canonical manifest hash.
    pub manifest_hash: Sha256Digest,
}

/// Versioned registry artifact consumed by planners and dispatchers.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleRegistryArtifactV1 {
    /// Contract version.
    pub version: u16,
    /// Exact policy whose grants were enforced during registry construction.
    pub policy: RegistryPolicyV1,
    /// Canonical protocol version.
    pub protocol_version: u16,
    /// Registry policy hash.
    pub policy_hash: Sha256Digest,
    /// Registered modules keyed by stable module ID.
    pub modules: BTreeMap<String, RegisteredModuleV1>,
    /// Canonical hash over the complete artifact body.
    pub registry_hash: Sha256Digest,
}

/// In-memory registry builder with no execution or writer authority.
#[derive(Clone, Debug)]
pub struct ModuleRegistryV1 {
    policy: RegistryPolicyV1,
    modules: BTreeMap<String, RegisteredModuleV1>,
}

impl ModuleRegistryV1 {
    /// Creates an empty registry after validating the policy.
    pub fn new(policy: RegistryPolicyV1) -> Result<Self, ModulePlatformError> {
        validate_policy(&policy)?;
        Ok(Self {
            policy,
            modules: BTreeMap::new(),
        })
    }

    /// Registers one exact manifest after enforcing the external grant.
    pub fn register(&mut self, manifest: ModuleManifestV1) -> Result<(), ModulePlatformError> {
        if self.modules.len() == MAXIMUM_MODULES_V1 {
            return Err(ModulePlatformError::ModuleLimitExceeded);
        }
        validate_manifest(&manifest, &self.policy)?;
        if self.modules.contains_key(&manifest.module_id) {
            return Err(ModulePlatformError::DuplicateModule);
        }
        let manifest_hash = canonical_hash(&manifest)?;
        self.modules.insert(
            manifest.module_id.clone(),
            RegisteredModuleV1 {
                manifest,
                manifest_hash,
            },
        );
        Ok(())
    }

    /// Validates dependency closure and emits a canonical artifact.
    pub fn finish(self) -> Result<ModuleRegistryArtifactV1, ModulePlatformError> {
        validate_registry_membership(&self.policy, &self.modules)?;
        validate_graph(&self.modules)?;
        let policy_hash = canonical_hash(&self.policy)?;
        let body = ArtifactBodyV1 {
            version: MODULE_PROTOCOL_VERSION_V1,
            policy: self.policy.clone(),
            protocol_version: self.policy.protocol_version,
            policy_hash: policy_hash.clone(),
            modules: self.modules.clone(),
        };
        let registry_hash = canonical_hash(&body)?;
        Ok(ModuleRegistryArtifactV1 {
            version: body.version,
            policy: body.policy,
            protocol_version: body.protocol_version,
            policy_hash,
            modules: body.modules,
            registry_hash,
        })
    }
}

impl ModuleRegistryArtifactV1 {
    /// Returns one exact registered module.
    pub fn module(&self, module_id: &str) -> Result<&RegisteredModuleV1, ModulePlatformError> {
        self.modules
            .get(module_id)
            .ok_or(ModulePlatformError::UnknownModule)
    }

    /// Recomputes manifest, graph and artifact hashes.
    pub fn validate(&self) -> Result<(), ModulePlatformError> {
        if self.version != MODULE_PROTOCOL_VERSION_V1
            || self.protocol_version != MODULE_PROTOCOL_VERSION_V1
            || self.protocol_version != self.policy.protocol_version
            || self.modules.is_empty()
            || self.modules.len() > MAXIMUM_MODULES_V1
        {
            return Err(ModulePlatformError::RegistryInvalid);
        }
        validate_policy(&self.policy)?;
        if canonical_hash(&self.policy)? != self.policy_hash {
            return Err(ModulePlatformError::RegistryInvalid);
        }
        validate_registry_membership(&self.policy, &self.modules)?;
        for (module_id, registered) in &self.modules {
            if module_id != &registered.manifest.module_id
                || canonical_hash(&registered.manifest)? != registered.manifest_hash
            {
                return Err(ModulePlatformError::RegistryInvalid);
            }
            validate_manifest(&registered.manifest, &self.policy)?;
        }
        validate_graph(&self.modules)?;
        let body = ArtifactBodyV1 {
            version: self.version,
            policy: self.policy.clone(),
            protocol_version: self.protocol_version,
            policy_hash: self.policy_hash.clone(),
            modules: self.modules.clone(),
        };
        if canonical_hash(&body)? != self.registry_hash {
            return Err(ModulePlatformError::RegistryInvalid);
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactBodyV1 {
    version: u16,
    policy: RegistryPolicyV1,
    protocol_version: u16,
    policy_hash: Sha256Digest,
    modules: BTreeMap<String, RegisteredModuleV1>,
}

fn validate_policy(policy: &RegistryPolicyV1) -> Result<(), ModulePlatformError> {
    if policy.version != MODULE_PROTOCOL_VERSION_V1
        || policy.protocol_version != MODULE_PROTOCOL_VERSION_V1
        || !valid_module_id(&policy.central_writer_module_id)
        || policy.grants.is_empty()
        || policy.grants.len() > MAXIMUM_MODULES_V1
    {
        return Err(ModulePlatformError::RegistryPolicyInvalid);
    }
    for (module_id, grant) in &policy.grants {
        if !valid_module_id(module_id)
            || !valid_semver(&grant.module_version)
            || grant.capability_ids.is_empty()
            || grant
                .capability_ids
                .iter()
                .any(|capability| !valid_capability_id(capability))
        {
            return Err(ModulePlatformError::RegistryPolicyInvalid);
        }
        if grant.authority == AuthorityClassV1::CentralStateWrite
            && module_id != &policy.central_writer_module_id
        {
            return Err(ModulePlatformError::RegistryPolicyInvalid);
        }
        if grant.authority == AuthorityClassV1::ExternalEffect
            && grant.minimum_qualification != QualificationTierV1::ExternalAuthority
        {
            return Err(ModulePlatformError::RegistryPolicyInvalid);
        }
        if matches!(
            grant.activation,
            ActivationStateV1::Canary | ActivationStateV1::Authoritative
        ) && grant.authority >= AuthorityClassV1::CentralStateWrite
            && grant.minimum_qualification < QualificationTierV1::TargetHost
        {
            return Err(ModulePlatformError::RegistryPolicyInvalid);
        }
    }
    Ok(())
}

fn validate_manifest(
    manifest: &ModuleManifestV1,
    policy: &RegistryPolicyV1,
) -> Result<(), ModulePlatformError> {
    if manifest.version != MODULE_PROTOCOL_VERSION_V1
        || !valid_module_id(&manifest.module_id)
        || !valid_semver(&manifest.module_version)
        || !valid_semver(&manifest.rollback_version)
        || manifest.module_version == manifest.rollback_version
        || manifest.protocol_min == 0
        || manifest.protocol_min > manifest.protocol_max
        || !(manifest.protocol_min..=manifest.protocol_max).contains(&policy.protocol_version)
        || manifest.capability_ids.is_empty()
        || duplicate_strings(&manifest.capability_ids)
        || !is_strictly_sorted(&manifest.capability_ids)
        || manifest
            .capability_ids
            .iter()
            .any(|capability| !valid_capability_id(capability))
        || !valid_owner(&manifest.primary_owner)
        || !valid_owner(&manifest.secondary_owner)
        || !valid_owner(&manifest.independent_reviewer)
        || manifest.primary_owner == manifest.secondary_owner
        || manifest.primary_owner == manifest.independent_reviewer
        || manifest.secondary_owner == manifest.independent_reviewer
        || manifest.dependencies.len() > MAXIMUM_MODULES_V1
        || manifest.dependencies.iter().any(|dependency| {
            dependency.module_id == manifest.module_id
                || !valid_module_id(&dependency.module_id)
                || !valid_semver(&dependency.module_version)
        })
        || duplicate_dependencies(&manifest.dependencies)
        || !is_strictly_sorted(&manifest.dependencies)
        || !execution_matches(manifest)
    {
        return Err(ModulePlatformError::ManifestInvalid);
    }
    let grant = policy
        .grants
        .get(&manifest.module_id)
        .ok_or(ModulePlatformError::AuthorityEscalation)?;
    if grant.module_version != manifest.module_version
        || grant.authority != manifest.requested_authority
    {
        return Err(ModulePlatformError::AuthorityEscalation);
    }
    if manifest.qualification < grant.minimum_qualification {
        return Err(ModulePlatformError::QualificationInsufficient);
    }
    if grant.activation != manifest.requested_activation {
        return Err(ModulePlatformError::ActivationInvalid);
    }
    let capabilities = manifest
        .capability_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if capabilities != grant.capability_ids {
        return Err(ModulePlatformError::CapabilityInvalid);
    }
    if manifest.requested_authority == AuthorityClassV1::CentralStateWrite
        && manifest.module_id != policy.central_writer_module_id
    {
        return Err(ModulePlatformError::AuthorityEscalation);
    }
    Ok(())
}

fn execution_matches(manifest: &ModuleManifestV1) -> bool {
    match (&manifest.module_kind, &manifest.execution) {
        (ModuleKindV1::PureLibrary, ModuleExecutionV1::InProcess { .. }) => {
            manifest.requested_authority == AuthorityClassV1::Pure
        }
        (ModuleKindV1::TrustedInProcess, ModuleExecutionV1::InProcess { .. }) => {
            manifest.requested_authority <= AuthorityClassV1::PreparedResultOnly
        }
        (
            ModuleKindV1::IsolatedProcess | ModuleKindV1::HostService,
            ModuleExecutionV1::IsolatedProcess {
                network_declared, ..
            },
        ) => {
            (*network_declared
                && manifest.requested_authority >= AuthorityClassV1::PreparedResultOnly)
                || (!*network_declared
                    && manifest.requested_authority <= AuthorityClassV1::CentralStateWrite)
        }
        (
            ModuleKindV1::LegacyNodeAdapter,
            ModuleExecutionV1::LegacyNodeAdapter {
                prepared_result_only,
                ..
            },
        ) => {
            *prepared_result_only
                && manifest.requested_authority == AuthorityClassV1::PreparedResultOnly
        }
        _ => false,
    }
}

fn validate_registry_membership(
    policy: &RegistryPolicyV1,
    modules: &BTreeMap<String, RegisteredModuleV1>,
) -> Result<(), ModulePlatformError> {
    if policy.grants.keys().ne(modules.keys()) {
        return Err(ModulePlatformError::RegistryInvalid);
    }
    Ok(())
}

fn validate_graph(
    modules: &BTreeMap<String, RegisteredModuleV1>,
) -> Result<(), ModulePlatformError> {
    for registered in modules.values() {
        for dependency in &registered.manifest.dependencies {
            let resolved = modules
                .get(&dependency.module_id)
                .ok_or(ModulePlatformError::DependencyMissing)?;
            if resolved.manifest.module_version != dependency.module_version {
                return Err(ModulePlatformError::DependencyMissing);
            }
        }
    }
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for module_id in modules.keys() {
        visit(module_id, modules, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn visit(
    module_id: &str,
    modules: &BTreeMap<String, RegisteredModuleV1>,
    visiting: &mut BTreeSet<String>,
    visited: &mut BTreeSet<String>,
) -> Result<(), ModulePlatformError> {
    if visited.contains(module_id) {
        return Ok(());
    }
    if !visiting.insert(module_id.to_owned()) {
        return Err(ModulePlatformError::DependencyCycle);
    }
    let registered = modules
        .get(module_id)
        .ok_or(ModulePlatformError::DependencyMissing)?;
    for dependency in &registered.manifest.dependencies {
        visit(&dependency.module_id, modules, visiting, visited)?;
    }
    visiting.remove(module_id);
    visited.insert(module_id.to_owned());
    Ok(())
}
