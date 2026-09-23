use thiserror::Error;

/// Module-platform validation failure.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ModulePlatformError {
    /// JSON serialization or digest conversion failed.
    #[error("canonical module-platform encoding failed")]
    EncodingInvalid,
    /// A serialized registry artifact could not be decoded.
    #[error("module registry artifact decoding failed")]
    RegistryDecodeInvalid,
    /// Registry policy shape or authority grants are invalid.
    #[error("module registry policy is invalid")]
    RegistryPolicyInvalid,
    /// The registry policy is not the independently expected policy.
    #[error("module registry policy identity mismatch")]
    RegistryPolicyIdentityMismatch,
    /// Module collection exceeded the hard limit.
    #[error("module registry limit exceeded")]
    ModuleLimitExceeded,
    /// Module identity already exists.
    #[error("duplicate module identity")]
    DuplicateModule,
    /// Manifest shape or owner/version fields are invalid.
    #[error("module manifest is invalid")]
    ManifestInvalid,
    /// Manifest requested authority not granted by policy.
    #[error("module authority escalation rejected")]
    AuthorityEscalation,
    /// Manifest qualification is below the registry floor.
    #[error("module qualification is insufficient")]
    QualificationInsufficient,
    /// Manifest activation differs from the registry decision.
    #[error("module activation is not authorized")]
    ActivationInvalid,
    /// Capability declaration is not granted.
    #[error("module capability declaration is not authorized")]
    CapabilityInvalid,
    /// A required module/version is absent.
    #[error("module dependency is missing")]
    DependencyMissing,
    /// Module dependencies contain a cycle.
    #[error("module dependency cycle detected")]
    DependencyCycle,
    /// Registry artifact is malformed or has a stale hash.
    #[error("module registry artifact is invalid")]
    RegistryInvalid,
    /// Module ID is not registered.
    #[error("unknown module")]
    UnknownModule,
    /// Candidate shape is invalid.
    #[error("module candidate is invalid")]
    CandidateInvalid,
    /// Candidate does not bind the exact registry module and snapshot.
    #[error("module candidate binding is invalid")]
    CandidateBindingInvalid,
    /// Prepared result binding or ceiling is invalid.
    #[error("prepared result is invalid")]
    PreparedResultInvalid,
    /// A bounded protocol object, identity, or time window is invalid.
    #[error("module protocol object is invalid")]
    ProtocolInvalid,
    /// A protocol object exceeded its hard wire-size ceiling.
    #[error("module protocol object exceeds size limit")]
    ProtocolSizeExceeded,
    /// Cancellation request or acknowledgement is invalid.
    #[error("module cancellation contract is invalid")]
    CancellationInvalid,
    /// Lifecycle, compatibility, rollout, resource, or SLO profile is invalid.
    #[error("module lifecycle profile is invalid")]
    LifecycleInvalid,
    /// Module health observation is stale, malformed, or exceeds its profile.
    #[error("module health report is invalid")]
    HealthInvalid,
    /// Resource arithmetic overflowed.
    #[error("resource arithmetic overflow")]
    ResourceOverflow,
    /// Resource subtraction would underflow.
    #[error("resource arithmetic underflow")]
    ResourceUnderflow,
}
