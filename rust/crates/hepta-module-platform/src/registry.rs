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
    /// Stable ID of the only possible central-state writer.
    pub central_writer_module_id: String,
    /// Exact grants keyed by module ID.
    pub grants: BTreeMap<String, ModuleGrantV1>,
}

impl RegistryPolicyV1 {
    /// Returns the canonical policy identity that a trusted composition must pin.
    pub fn policy_hash(&self) -> Result<Sha256Digest, ModulePlatformError> {
        validate_policy(self)?;
        canonical_hash(self)
    }
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
///
/// The type intentionally does not implement `Deserialize`. Callers must use
/// [`ModuleRegistryArtifactV1::decode_json`] and provide the policy hash that
/// was independently selected by the composition root.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleRegistryArtifactV1 {
    version: u16,
    protocol_version: u16,
    policy: RegistryPolicyV1,
    policy_hash: Sha256Digest,
    modules: BTreeMap<String, RegisteredModuleV1>,
    registry_hash: Sha256Digest,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModuleRegistryArtifactWireV1 {
    version: u16,
    protocol_version: u16,
    policy: RegistryPolicyV1,
    policy_hash: Sha256Digest,
    modules: BTreeMap<String, RegisteredModuleV1>,
    registry_hash: Sha256Digest,
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

    /// Validates dependency closure and emits a policy-authenticated artifact.
    pub fn finish(self) -> Result<ModuleRegistryArtifactV1, ModulePlatformError> {
        validate_policy_coverage(&self.policy, &self.modules)?;
        validate_graph(&self.modules)?;
        let policy_hash = self.policy.policy_hash()?;
        let body = ArtifactBodyV1 {
            version: MODULE_PROTOCOL_VERSION_V1,
            protocol_version: self.policy.protocol_version,
            policy: self.policy,
            policy_hash: policy_hash.clone(),
            modules: self.modules,
        };
        let registry_hash = canonical_hash(&body)?;
        let artifact = ModuleRegistryArtifactV1 {
            version: body.version,
            protocol_version: body.protocol_version,
            policy: body.policy,
            policy_hash: body.policy_hash,
            modules: body.modules,
            registry_hash,
        };
        artifact.validate(&policy_hash)?;
        Ok(artifact)
    }
}

impl ModuleRegistryArtifactV1 {
    /// Decodes and validates an artifact against an independently pinned policy.
    pub fn decode_json(
        bytes: &[u8],
        expected_policy_hash: &Sha256Digest,
    ) -> Result<Self, ModulePlatformError> {
        let wire: ModuleRegistryArtifactWireV1 = serde_json::from_slice(bytes)
            .map_err(|_| ModulePlatformError::RegistryDecodeInvalid)?;
        let canonical = serde_json::to_vec(&wire)
            .map_err(|_| ModulePlatformError::RegistryDecodeInvalid)?;
        if canonical.as_slice() != bytes {
            return Err(ModulePlatformError::RegistryDecodeInvalid);
        }
        let artifact = Self {
            version: wire.version,
            protocol_version: wire.protocol_version,
            policy: wire.policy,
            policy_hash: wire.policy_hash,
            modules: wire.modules,
            registry_hash: wire.registry_hash,
        };
        artifact.validate(expected_policy_hash)?;
        Ok(artifact)
    }

    /// Returns one exact registered module.
    pub fn module(&self, module_id: &str) -> Result<&RegisteredModuleV1, ModulePlatformError> {
        self.modules
            .get(module_id)
            .ok_or(ModulePlatformError::UnknownModule)
    }

    /// Returns the policy authenticated into this artifact.
    #[must_use]
    pub fn policy(&self) -> &RegistryPolicyV1 {
        &self.policy
    }

    /// Returns the independently pinnable policy hash.
    #[must_use]
    pub fn policy_hash(&self) -> &Sha256Digest {
        &self.policy_hash
    }

    /// Returns the complete registry hash.
    #[must_use]
    pub fn registry_hash(&self) -> &Sha256Digest {
        &self.registry_hash
    }

    /// Returns all validated modules.
    #[must_use]
    pub fn modules(&self) -> &BTreeMap<String, RegisteredModuleV1> {
        &self.modules
    }

    /// Returns the registered module count.
    #[must_use]
    pub fn module_count(&self) -> usize {
        self.modules.len()
    }

    /// Emits canonical compact JSON for transport or retained evidence.
    pub fn to_canonical_json(&self) -> Result<Vec<u8>, ModulePlatformError> {
        serde_json::to_vec(self).map_err(|_| ModulePlatformError::EncodingInvalid)
    }

    /// Revalidates policy identity, grants, manifests, graph, and all hashes.
    pub fn validate(
        &self,
        expected_policy_hash: &Sha256Digest,
    ) -> Result<(), ModulePlatformError> {
        if self.version != MODULE_PROTOCOL_VERSION_V1
            || self.protocol_version != MODULE_PROTOCOL_VERSION_V1
            || self.protocol_version != self.policy.protocol_version
            || self.modules.is_empty()
            || self.modules.len() > MAXIMUM_MODULES_V1
        {
            return Err(ModulePlatformError::RegistryInvalid);
        }
        validate_policy(&self.policy)?;
        let recomputed_policy_hash = canonical_hash(&self.policy)?;
        if self.policy_hash != recomputed_policy_hash
            || self.policy_hash != *expected_policy_hash
        {
            return Err(ModulePlatformError::RegistryPolicyIdentityMismatch);
        }
        validate_policy_coverage(&self.policy, &self.modules)?;
        for (module_id, registered) in &self.modules {
            if module_id != &registered.manifest.module_id {
                return Err(ModulePlatformError::RegistryInvalid);
            }
            validate_manifest(&registered.manifest, &self.policy)?;
            if canonical_hash(&registered.manifest)? != registered.manifest_hash {
                return Err(ModulePlatformError::RegistryInvalid);
            }
        }
        validate_graph(&self.modules)?;
        let body = ArtifactBodyV1 {
            version: self.version,
            protocol_version: self.protocol_version,
            policy: self.policy.clone(),
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
    protocol_version: u16,
    policy: RegistryPolicyV1,
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
    let mut central_writers = 0_usize;
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
        if grant.authority == AuthorityClassV1::CentralStateWrite {
            central_writers = central_writers
                .checked_add(1)
                .ok_or(ModulePlatformError::RegistryPolicyInvalid)?;
            if module_id != &policy.central_writer_module_id {
                return Err(ModulePlatformError::RegistryPolicyInvalid);
            }
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
    if central_writers > 1 {
        return Err(ModulePlatformError::RegistryPolicyInvalid);
    }
    if policy
        .grants
        .get(&policy.central_writer_module_id)
        .is_some_and(|grant| grant.authority != AuthorityClassV1::CentralStateWrite)
    {
        return Err(ModulePlatformError::RegistryPolicyInvalid);
    }
    Ok(())
}

fn validate_policy_coverage(
    policy: &RegistryPolicyV1,
    modules: &BTreeMap<String, RegisteredModuleV1>,
) -> Result<(), ModulePlatformError> {
    if policy.grants.len() != modules.len()
        || !policy.grants.keys().eq(modules.keys())
    {
        return Err(ModulePlatformError::RegistryInvalid);
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

#[cfg(test)]
mod hostile_decode_tests {
    use std::str::FromStr;

    use super::*;

    fn digest(marker: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
            .expect("test digest")
    }

    fn valid_artifact() -> ModuleRegistryArtifactV1 {
        let capabilities = BTreeSet::from(["CAP-SCH-PLAN".to_owned()]);
        let policy = RegistryPolicyV1 {
            version: 1,
            protocol_version: 1,
            central_writer_module_id: "module.commit-sequencer".to_owned(),
            grants: BTreeMap::from([(
                "module.planner".to_owned(),
                ModuleGrantV1 {
                    module_version: "1.0.0".to_owned(),
                    authority: AuthorityClassV1::Pure,
                    minimum_qualification: QualificationTierV1::Source,
                    activation: ActivationStateV1::Shadow,
                    capability_ids: capabilities.clone(),
                },
            )]),
        };
        let mut registry = ModuleRegistryV1::new(policy).expect("policy");
        registry
            .register(ModuleManifestV1 {
                version: 1,
                module_id: "module.planner".to_owned(),
                module_version: "1.0.0".to_owned(),
                protocol_min: 1,
                protocol_max: 1,
                module_kind: ModuleKindV1::PureLibrary,
                requested_authority: AuthorityClassV1::Pure,
                qualification: QualificationTierV1::Source,
                requested_activation: ActivationStateV1::Shadow,
                capability_ids: capabilities.into_iter().collect(),
                dependencies: Vec::new(),
                primary_owner: "TEAM-KERNEL".to_owned(),
                secondary_owner: "TEAM-PROTOCOL".to_owned(),
                independent_reviewer: "TEAM-EVIDENCE".to_owned(),
                rollback_version: "0.9.0".to_owned(),
                execution: ModuleExecutionV1::InProcess {
                    implementation_hash: digest('a'),
                },
            })
            .expect("manifest");
        registry.finish().expect("artifact")
    }

    fn wire(artifact: &ModuleRegistryArtifactV1) -> ModuleRegistryArtifactWireV1 {
        serde_json::from_slice(&artifact.to_canonical_json().expect("json")).expect("wire")
    }

    fn rehash(wire: &mut ModuleRegistryArtifactWireV1) {
        for registered in wire.modules.values_mut() {
            registered.manifest_hash = canonical_hash(&registered.manifest).expect("manifest hash");
        }
        wire.policy_hash = canonical_hash(&wire.policy).expect("policy hash");
        wire.registry_hash = canonical_hash(&ArtifactBodyV1 {
            version: wire.version,
            protocol_version: wire.protocol_version,
            policy: wire.policy.clone(),
            policy_hash: wire.policy_hash.clone(),
            modules: wire.modules.clone(),
        })
        .expect("registry hash");
    }

    fn decode(
        wire: &ModuleRegistryArtifactWireV1,
        expected: &Sha256Digest,
    ) -> Result<ModuleRegistryArtifactV1, ModulePlatformError> {
        ModuleRegistryArtifactV1::decode_json(
            &serde_json::to_vec(wire).expect("wire json"),
            expected,
        )
    }

    #[test]
    fn chosen_policy_cannot_promote_authority_activation_or_capabilities() {
        let artifact = valid_artifact();
        let expected = artifact.policy_hash().clone();

        let mut authority = wire(&artifact);
        authority.policy.central_writer_module_id = "module.planner".to_owned();
        let authority_grant = authority
            .policy
            .grants
            .get_mut("module.planner")
            .expect("grant");
        authority_grant.authority = AuthorityClassV1::CentralStateWrite;
        authority_grant.minimum_qualification = QualificationTierV1::TargetHost;
        let authority_manifest = &mut authority
            .modules
            .get_mut("module.planner")
            .expect("module")
            .manifest;
        authority_manifest.requested_authority = AuthorityClassV1::CentralStateWrite;
        authority_manifest.qualification = QualificationTierV1::TargetHost;
        authority_manifest.module_kind = ModuleKindV1::HostService;
        authority_manifest.execution = ModuleExecutionV1::IsolatedProcess {
            executable_hash: digest('b'),
            configuration_hash: digest('c'),
            network_declared: false,
        };
        rehash(&mut authority);
        assert_eq!(
            decode(&authority, &expected),
            Err(ModulePlatformError::RegistryPolicyIdentityMismatch)
        );

        let mut activation = wire(&artifact);
        activation
            .policy
            .grants
            .get_mut("module.planner")
            .expect("grant")
            .activation = ActivationStateV1::Authoritative;
        activation
            .modules
            .get_mut("module.planner")
            .expect("module")
            .manifest
            .requested_activation = ActivationStateV1::Authoritative;
        rehash(&mut activation);
        assert_eq!(
            decode(&activation, &expected),
            Err(ModulePlatformError::RegistryPolicyIdentityMismatch)
        );

        let mut capability = wire(&artifact);
        capability
            .policy
            .grants
            .get_mut("module.planner")
            .expect("grant")
            .capability_ids = BTreeSet::from(["CAP-OTHER".to_owned()]);
        capability
            .modules
            .get_mut("module.planner")
            .expect("module")
            .manifest
            .capability_ids = vec!["CAP-OTHER".to_owned()];
        rehash(&mut capability);
        assert_eq!(
            decode(&capability, &expected),
            Err(ModulePlatformError::RegistryPolicyIdentityMismatch)
        );
    }

    #[test]
    fn noncanonical_or_duplicate_key_wire_is_rejected() {
        let artifact = valid_artifact();
        let expected = artifact.policy_hash().clone();
        let canonical = artifact.to_canonical_json().expect("canonical json");

        let mut whitespace = Vec::with_capacity(canonical.len() + 1);
        whitespace.extend_from_slice(&canonical);
        whitespace.push(b'\n');
        assert_eq!(
            ModuleRegistryArtifactV1::decode_json(&whitespace, &expected),
            Err(ModulePlatformError::RegistryDecodeInvalid)
        );

        let canonical_text = String::from_utf8(canonical).expect("utf8 json");
        let duplicate = canonical_text.replacen(
            "{\"version\":1,",
            "{\"version\":1,\"version\":1,",
            1,
        );
        assert_eq!(
            ModuleRegistryArtifactV1::decode_json(duplicate.as_bytes(), &expected),
            Err(ModulePlatformError::RegistryDecodeInvalid)
        );
    }

    #[test]
    fn manifest_and_policy_hash_tampering_fail_closed() {
        let artifact = valid_artifact();
        let expected = artifact.policy_hash().clone();

        let mut manifest = wire(&artifact);
        manifest
            .modules
            .get_mut("module.planner")
            .expect("module")
            .manifest
            .capability_ids = vec!["CAP-OTHER".to_owned()];
        rehash(&mut manifest);
        manifest.policy_hash = expected.clone();
        manifest.registry_hash = canonical_hash(&ArtifactBodyV1 {
            version: manifest.version,
            protocol_version: manifest.protocol_version,
            policy: manifest.policy.clone(),
            policy_hash: manifest.policy_hash.clone(),
            modules: manifest.modules.clone(),
        })
        .expect("registry hash");
        assert_eq!(
            decode(&manifest, &expected),
            Err(ModulePlatformError::CapabilityInvalid)
        );

        let mut arbitrary_hash = wire(&artifact);
        arbitrary_hash.policy_hash = digest('f');
        arbitrary_hash.registry_hash = canonical_hash(&ArtifactBodyV1 {
            version: arbitrary_hash.version,
            protocol_version: arbitrary_hash.protocol_version,
            policy: arbitrary_hash.policy.clone(),
            policy_hash: arbitrary_hash.policy_hash.clone(),
            modules: arbitrary_hash.modules.clone(),
        })
        .expect("registry hash");
        assert_eq!(
            decode(&arbitrary_hash, &expected),
            Err(ModulePlatformError::RegistryPolicyIdentityMismatch)
        );
    }
}
