use std::collections::BTreeSet;

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};

use crate::{
    ActivationStateV1, AuthorityClassV1, ModuleManifestV1, ModulePlatformError, ResourceVectorV1,
    SideEffectClassV1,
    hash::canonical_hash,
    types::{
        duplicate_strings, is_strictly_sorted, valid_identifier, valid_module_id, valid_semver,
    },
};

/// Declared determinism of one module version.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeterminismClassV1 {
    /// Same exact inputs produce identical canonical output.
    Deterministic,
    /// Deterministic only after binding an explicit random seed.
    Seeded,
    /// Output depends on an independently observed external system.
    ExternallyObserved,
    /// Model/provider output is nondeterministic and must be independently verified.
    ModelNondeterministic,
}

/// Rollout channel separate from source implementation and qualification state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RolloutChannelV1 {
    /// Not eligible for execution.
    Disabled,
    /// Executes without authoritative integration.
    Shadow,
    /// Executes within a bounded canary.
    Canary,
    /// Current authoritative implementation.
    Authoritative,
    /// Existing work may drain; no new general admission.
    Retiring,
    /// No new execution is accepted.
    Retired,
}

/// Circuit-breaker state observed by the control plane.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CircuitBreakerStateV1 {
    /// New work may be admitted.
    Closed,
    /// New work is denied.
    Open,
    /// A bounded probe may be admitted.
    HalfOpen,
}

/// Complete source-level lifecycle, resource, SLO, and compatibility profile.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleLifecycleProfileV1 {
    /// Contract version.
    pub version: u16,
    /// Exact module identity.
    pub module_id: String,
    /// Exact module version.
    pub module_version: String,
    /// Canonical manifest hash.
    pub manifest_hash: Sha256Digest,
    /// Explicit side-effect classes.
    pub side_effect_classes: BTreeSet<SideEffectClassV1>,
    /// Declared determinism semantics.
    pub determinism_class: DeterminismClassV1,
    /// Maximum running executions.
    pub maximum_inflight: u32,
    /// Maximum queued executions.
    pub maximum_queue_depth: u32,
    /// Hard resource ceiling for one execution.
    pub resource_ceiling: ResourceVectorV1,
    /// Maximum declared end-to-end latency.
    pub maximum_latency_ms: u64,
    /// Maximum canonical prepared-result bytes.
    pub maximum_result_bytes: u64,
    /// Oldest readable protocol version.
    pub readable_protocol_min: u16,
    /// Newest readable protocol version.
    pub readable_protocol_max: u16,
    /// Oldest readable durable-state version.
    pub readable_state_min: u16,
    /// Newest writable durable-state version.
    pub writable_state_version: u16,
    /// Current rollout channel.
    pub rollout_channel: RolloutChannelV1,
    /// Mutual-exclusion group for write/external-effect implementations.
    pub mutual_exclusion_group: Option<String>,
    /// Exact rollback version.
    pub rollback_version: String,
    /// Strictly sorted canonical workload IDs.
    pub canonical_workload_ids: Vec<String>,
}

impl ModuleLifecycleProfileV1 {
    /// Validates the profile against the exact module manifest and hash.
    pub fn validate(&self, manifest: &ModuleManifestV1) -> Result<(), ModulePlatformError> {
        let expected_manifest_hash = canonical_hash(manifest)?;
        let rollout_matches = matches!(
            (manifest.requested_activation, self.rollout_channel),
            (ActivationStateV1::Disabled, RolloutChannelV1::Disabled)
                | (ActivationStateV1::Shadow, RolloutChannelV1::Shadow)
                | (ActivationStateV1::Canary, RolloutChannelV1::Canary)
                | (
                    ActivationStateV1::Authoritative,
                    RolloutChannelV1::Authoritative
                )
                | (ActivationStateV1::Retired, RolloutChannelV1::Retired)
        );
        let authority_side_effect_valid = match manifest.requested_authority {
            AuthorityClassV1::Pure | AuthorityClassV1::ReadOnly => {
                self.side_effect_classes == BTreeSet::from([SideEffectClassV1::NoSideEffect])
            }
            AuthorityClassV1::WorkspaceLocalWrite => self.side_effect_classes.iter().all(|class| {
                matches!(
                    class,
                    SideEffectClassV1::NoSideEffect | SideEffectClassV1::WorkspaceLocal
                )
            }),
            AuthorityClassV1::PreparedResultOnly => self.side_effect_classes.iter().all(|class| {
                matches!(
                    class,
                    SideEffectClassV1::NoSideEffect
                        | SideEffectClassV1::WorkspaceLocal
                        | SideEffectClassV1::PreparedResult
                )
            }),
            AuthorityClassV1::CentralStateWrite => self
                .side_effect_classes
                .contains(&SideEffectClassV1::CentralStateCommit),
            AuthorityClassV1::ExternalEffect => self.side_effect_classes.iter().any(|class| {
                matches!(
                    class,
                    SideEffectClassV1::ExternalReversible | SideEffectClassV1::ExternalIrreversible
                )
            }),
        };
        let mutual_exclusion_required = matches!(
            manifest.requested_authority,
            AuthorityClassV1::CentralStateWrite | AuthorityClassV1::ExternalEffect
        );
        if self.version != 1
            || !valid_module_id(&self.module_id)
            || self.module_id != manifest.module_id
            || !valid_semver(&self.module_version)
            || self.module_version != manifest.module_version
            || self.manifest_hash != expected_manifest_hash
            || self.side_effect_classes.is_empty()
            || self.maximum_inflight == 0
            || self.maximum_queue_depth == 0
            || self.maximum_latency_ms == 0
            || self.maximum_result_bytes == 0
            || self.readable_protocol_min == 0
            || self.readable_protocol_min > self.readable_protocol_max
            || self.readable_protocol_min != manifest.protocol_min
            || self.readable_protocol_max != manifest.protocol_max
            || self.readable_state_min == 0
            || self.readable_state_min > self.writable_state_version
            || !rollout_matches
            || !authority_side_effect_valid
            || mutual_exclusion_required != self.mutual_exclusion_group.is_some()
            || self
                .mutual_exclusion_group
                .as_deref()
                .is_some_and(|group| !valid_identifier(group))
            || self.rollback_version != manifest.rollback_version
            || duplicate_strings(&self.canonical_workload_ids)
            || !is_strictly_sorted(&self.canonical_workload_ids)
            || self
                .canonical_workload_ids
                .iter()
                .any(|workload| !valid_identifier(workload))
        {
            return Err(ModulePlatformError::LifecycleInvalid);
        }
        Ok(())
    }

    /// Returns the canonical lifecycle-profile hash.
    pub fn profile_hash(&self) -> Result<Sha256Digest, ModulePlatformError> {
        canonical_hash(self)
    }
}

/// Bounded operational health observation; it never grants authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleHealthReportV1 {
    /// Contract version.
    pub version: u16,
    /// Exact module identity.
    pub module_id: String,
    /// Exact module version.
    pub module_version: String,
    /// Exact manifest hash.
    pub manifest_hash: Sha256Digest,
    /// Exact lifecycle profile hash.
    pub lifecycle_profile_hash: Sha256Digest,
    /// Observation time.
    pub observed_at_unix_ms: u64,
    /// Expiry time.
    pub expires_at_unix_ms: u64,
    /// Current circuit-breaker state.
    pub circuit_breaker: CircuitBreakerStateV1,
    /// Current running execution count.
    pub inflight: u32,
    /// Current queued execution count.
    pub queue_depth: u32,
    /// Stable blocker codes; strictly sorted.
    pub blocker_codes: Vec<String>,
    /// Explicit non-authority assertion.
    pub grants_authority: bool,
    /// Canonical report hash.
    pub report_hash: Sha256Digest,
}

impl ModuleHealthReportV1 {
    /// Builds and hashes a bounded health report.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        manifest: &ModuleManifestV1,
        profile: &ModuleLifecycleProfileV1,
        observed_at_unix_ms: u64,
        expires_at_unix_ms: u64,
        circuit_breaker: CircuitBreakerStateV1,
        inflight: u32,
        queue_depth: u32,
        blocker_codes: Vec<String>,
    ) -> Result<Self, ModulePlatformError> {
        profile.validate(manifest)?;
        let body = HealthBodyV1 {
            version: 1,
            module_id: manifest.module_id.clone(),
            module_version: manifest.module_version.clone(),
            manifest_hash: canonical_hash(manifest)?,
            lifecycle_profile_hash: profile.profile_hash()?,
            observed_at_unix_ms,
            expires_at_unix_ms,
            circuit_breaker,
            inflight,
            queue_depth,
            blocker_codes,
            grants_authority: false,
        };
        let report_hash = canonical_hash(&body)?;
        let report = Self {
            version: body.version,
            module_id: body.module_id,
            module_version: body.module_version,
            manifest_hash: body.manifest_hash,
            lifecycle_profile_hash: body.lifecycle_profile_hash,
            observed_at_unix_ms: body.observed_at_unix_ms,
            expires_at_unix_ms: body.expires_at_unix_ms,
            circuit_breaker: body.circuit_breaker,
            inflight: body.inflight,
            queue_depth: body.queue_depth,
            blocker_codes: body.blocker_codes,
            grants_authority: body.grants_authority,
            report_hash,
        };
        report.validate(manifest, profile, observed_at_unix_ms)?;
        Ok(report)
    }

    /// Revalidates freshness, exact identities, bounds, and the report hash.
    pub fn validate(
        &self,
        manifest: &ModuleManifestV1,
        profile: &ModuleLifecycleProfileV1,
        now_unix_ms: u64,
    ) -> Result<(), ModulePlatformError> {
        profile.validate(manifest)?;
        let body = HealthBodyV1 {
            version: self.version,
            module_id: self.module_id.clone(),
            module_version: self.module_version.clone(),
            manifest_hash: self.manifest_hash.clone(),
            lifecycle_profile_hash: self.lifecycle_profile_hash.clone(),
            observed_at_unix_ms: self.observed_at_unix_ms,
            expires_at_unix_ms: self.expires_at_unix_ms,
            circuit_breaker: self.circuit_breaker,
            inflight: self.inflight,
            queue_depth: self.queue_depth,
            blocker_codes: self.blocker_codes.clone(),
            grants_authority: self.grants_authority,
        };
        if self.version != 1
            || self.module_id != manifest.module_id
            || self.module_version != manifest.module_version
            || self.manifest_hash != canonical_hash(manifest)?
            || self.lifecycle_profile_hash != profile.profile_hash()?
            || self.observed_at_unix_ms > now_unix_ms
            || now_unix_ms >= self.expires_at_unix_ms
            || self
                .expires_at_unix_ms
                .saturating_sub(self.observed_at_unix_ms)
                > 300_000
            || self.inflight > profile.maximum_inflight
            || self.queue_depth > profile.maximum_queue_depth
            || duplicate_strings(&self.blocker_codes)
            || !is_strictly_sorted(&self.blocker_codes)
            || self
                .blocker_codes
                .iter()
                .any(|blocker| !valid_identifier(blocker))
            || self.grants_authority
            || canonical_hash(&body)? != self.report_hash
        {
            return Err(ModulePlatformError::HealthInvalid);
        }
        if self.circuit_breaker == CircuitBreakerStateV1::Closed && !self.blocker_codes.is_empty() {
            return Err(ModulePlatformError::HealthInvalid);
        }
        Ok(())
    }

    /// Returns whether new work is eligible for admission at `now_unix_ms`.
    pub fn admission_available(
        &self,
        manifest: &ModuleManifestV1,
        profile: &ModuleLifecycleProfileV1,
        now_unix_ms: u64,
    ) -> Result<bool, ModulePlatformError> {
        self.validate(manifest, profile, now_unix_ms)?;
        Ok(self.circuit_breaker == CircuitBreakerStateV1::Closed
            && self.inflight < profile.maximum_inflight
            && self.queue_depth < profile.maximum_queue_depth
            && !matches!(
                profile.rollout_channel,
                RolloutChannelV1::Disabled | RolloutChannelV1::Retiring | RolloutChannelV1::Retired
            ))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthBodyV1 {
    version: u16,
    module_id: String,
    module_version: String,
    manifest_hash: Sha256Digest,
    lifecycle_profile_hash: Sha256Digest,
    observed_at_unix_ms: u64,
    expires_at_unix_ms: u64,
    circuit_breaker: CircuitBreakerStateV1,
    inflight: u32,
    queue_depth: u32,
    blocker_codes: Vec<String>,
    grants_authority: bool,
}

/// Highest-impact semantic class of a registry change.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryChangeClassV1 {
    /// Documentation or descriptive metadata only.
    MetadataOnly,
    /// Compatible implementation/profile addition.
    CompatibleImplementation,
    /// Resource or SLO envelope changed.
    ResourceOrSlo,
    /// Protocol or durable-state compatibility changed.
    ProtocolOrState,
    /// Rollout or rollback state changed.
    RolloutOrRollback,
    /// Capability ownership changed.
    CapabilityOwnership,
    /// Authority or side-effect class changed.
    AuthorityOrSideEffect,
    /// Module is retiring or retired.
    Retirement,
}

/// Deterministic review and requalification obligations for a change.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistryChangeDecisionV1 {
    /// Contract version.
    pub version: u16,
    /// Classified change.
    pub change_class: RegistryChangeClassV1,
    /// Whether primary/secondary/reviewer domains must all approve.
    pub requires_cross_team_review: bool,
    /// Whether source conformance must be regenerated.
    pub requires_fresh_conformance: bool,
    /// Whether target-host evidence must be regenerated.
    pub requires_target_host_requalification: bool,
    /// Whether existing activation must stop before the change.
    pub requires_activation_stop: bool,
}

/// Classifies a change without allowing a manifest to authorize itself.
pub fn classify_registry_change_v1(
    previous_manifest: &ModuleManifestV1,
    previous_profile: &ModuleLifecycleProfileV1,
    next_manifest: &ModuleManifestV1,
    next_profile: &ModuleLifecycleProfileV1,
) -> Result<RegistryChangeDecisionV1, ModulePlatformError> {
    previous_profile.validate(previous_manifest)?;
    next_profile.validate(next_manifest)?;
    if previous_manifest.module_id != next_manifest.module_id {
        return Err(ModulePlatformError::LifecycleInvalid);
    }
    let change_class = if matches!(
        next_profile.rollout_channel,
        RolloutChannelV1::Retiring | RolloutChannelV1::Retired
    ) {
        RegistryChangeClassV1::Retirement
    } else if previous_manifest.requested_authority != next_manifest.requested_authority
        || previous_profile.side_effect_classes != next_profile.side_effect_classes
    {
        RegistryChangeClassV1::AuthorityOrSideEffect
    } else if previous_manifest.capability_ids != next_manifest.capability_ids
        || previous_manifest.primary_owner != next_manifest.primary_owner
        || previous_manifest.secondary_owner != next_manifest.secondary_owner
        || previous_manifest.independent_reviewer != next_manifest.independent_reviewer
    {
        RegistryChangeClassV1::CapabilityOwnership
    } else if previous_manifest.protocol_min != next_manifest.protocol_min
        || previous_manifest.protocol_max != next_manifest.protocol_max
        || previous_profile.readable_state_min != next_profile.readable_state_min
        || previous_profile.writable_state_version != next_profile.writable_state_version
    {
        RegistryChangeClassV1::ProtocolOrState
    } else if previous_profile.rollout_channel != next_profile.rollout_channel
        || previous_profile.rollback_version != next_profile.rollback_version
    {
        RegistryChangeClassV1::RolloutOrRollback
    } else if previous_profile.resource_ceiling != next_profile.resource_ceiling
        || previous_profile.maximum_latency_ms != next_profile.maximum_latency_ms
        || previous_profile.maximum_result_bytes != next_profile.maximum_result_bytes
        || previous_profile.maximum_inflight != next_profile.maximum_inflight
        || previous_profile.maximum_queue_depth != next_profile.maximum_queue_depth
    {
        RegistryChangeClassV1::ResourceOrSlo
    } else if previous_manifest != next_manifest || previous_profile != next_profile {
        RegistryChangeClassV1::CompatibleImplementation
    } else {
        RegistryChangeClassV1::MetadataOnly
    };
    let high_risk = matches!(
        change_class,
        RegistryChangeClassV1::AuthorityOrSideEffect
            | RegistryChangeClassV1::CapabilityOwnership
            | RegistryChangeClassV1::ProtocolOrState
            | RegistryChangeClassV1::RolloutOrRollback
            | RegistryChangeClassV1::Retirement
    );
    Ok(RegistryChangeDecisionV1 {
        version: 1,
        change_class,
        requires_cross_team_review: high_risk,
        requires_fresh_conformance: change_class != RegistryChangeClassV1::MetadataOnly,
        requires_target_host_requalification: matches!(
            change_class,
            RegistryChangeClassV1::AuthorityOrSideEffect
                | RegistryChangeClassV1::ProtocolOrState
                | RegistryChangeClassV1::RolloutOrRollback
                | RegistryChangeClassV1::Retirement
        ),
        requires_activation_stop: matches!(
            change_class,
            RegistryChangeClassV1::AuthorityOrSideEffect
                | RegistryChangeClassV1::ProtocolOrState
                | RegistryChangeClassV1::Retirement
        ),
    })
}
