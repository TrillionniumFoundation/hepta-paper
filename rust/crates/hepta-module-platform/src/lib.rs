//! Typed module protocol, registry, candidate and prepared-result contracts.
//!
//! Module manifests describe requested capabilities, while a separately
//! supplied registry policy grants authority, qualification, activation and
//! capability sets. Modules return candidates and prepared results; they do
//! not receive a central-state writer from this crate.

#![forbid(unsafe_code)]

mod candidate;
mod conformance;
mod error;
mod hash;
mod lifecycle;
mod protocol;
mod registry;
mod sdk;
mod types;

pub use candidate::{ActionCandidateV1, PreparedResultStatusV1, PreparedResultV1};
pub use conformance::{
    ModuleConformanceReportV1, ModuleContractConformanceReportV1, module_conformance_report_v1,
    module_contract_conformance_report_v1, node_legacy_adapter_manifest_v1,
};
pub use error::ModulePlatformError;
pub use lifecycle::{
    CircuitBreakerStateV1, DeterminismClassV1, ModuleHealthReportV1, ModuleLifecycleProfileV1,
    RegistryChangeClassV1, RegistryChangeDecisionV1, RolloutChannelV1, classify_registry_change_v1,
};
pub use protocol::{
    CancellationAcknowledgementV1, CancellationDispositionV1, CancellationRequestV1,
    ExecutionCommandV1, MAXIMUM_PROTOCOL_ARTIFACTS_V1, MAXIMUM_PROTOCOL_LIFETIME_MS_V1,
    MAXIMUM_PROTOCOL_OBJECT_BYTES_V1, PlanningRequestV1, PlanningResponseV1, ProtocolEnvelopeV1,
    ProtocolObjectKindV1, SideEffectClassV1, decode_canonical_protocol_json_v1,
    module_protocol_hash_v1, to_canonical_protocol_json_v1,
};
pub use registry::{
    ModuleGrantV1, ModuleManifestV1, ModuleRegistryArtifactV1, ModuleRegistryV1,
    RegisteredModuleV1, RegistryPolicyV1,
};
pub use sdk::{CandidateCollectionV1, ModuleSdkV1, pareto_reduce_candidates_v1};
pub use types::{
    ActivationStateV1, AuthorityClassV1, ModuleDependencyV1, ModuleExecutionV1, ModuleKindV1,
    QualificationTierV1, ResourceVectorV1,
};

/// Current module protocol version.
pub const MODULE_PROTOCOL_VERSION_V1: u16 = 1;
/// Maximum accepted manifest collection size.
pub const MAXIMUM_MODULES_V1: usize = 256;
/// Maximum candidates in one bounded planning request.
pub const MAXIMUM_CANDIDATES_V1: usize = 4_096;

#[cfg(test)]
mod tests;
