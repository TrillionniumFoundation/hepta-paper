use thiserror::Error;

/// Module-platform validation failure.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum ModulePlatformError {
    /// JSON serialization or digest conversion failed.
    #[error("canonical module-platform encoding failed")]
    EncodingInvalid,
    /// Registry policy shape or authority grants are invalid.
    #[error("module registry policy is invalid")]
    RegistryPolicyInvalid,
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
    /// Resource arithmetic overflowed.
    #[error("resource arithmetic overflow")]
    ResourceOverflow,
    /// Resource subtraction would underflow.
    #[error("resource arithmetic underflow")]
    ResourceUnderflow,
}
