//! Security-critical local runtime primitives for the Codex broker.
//!
//! The crate deliberately has no campaign database, network, release, or
//! submission authority. It inspects a qualified local runtime, constructs
//! default-deny child environments, supervises one bounded process group, and
//! verifies that runtime identity did not change across execution.

#![forbid(unsafe_code)]

#[cfg(not(unix))]
compile_error!("hepta-codex-runtime Foundation V1 supports Unix targets only");

mod environment;
mod identity;
mod invocation;
mod process;
mod qualification;

pub use environment::{
    EnvironmentBuildError, EnvironmentPolicyV1, RestrictedEnvironmentV1,
    codex_parent_environment_policy_v1, model_child_environment_policy_v1,
};
pub use identity::{
    CodexHomeIdentityV1, CodexRuntimeIdentityV1, CredentialMaterialIdentityV1,
    CredentialMaterialStatus, DirectoryIdentityV1, ExecutableIdentityV1,
    FileSystemIdentityV1, RuntimeIdentityError, RuntimeIdentityPolicyV1,
    inspect_codex_runtime_identity,
};
pub use invocation::{
    CodexControlDirectoryContractV1, CodexControlFileContractV1, CodexInvocationError,
    CodexInvocationPolicyV1, CodexInvocationPostflightV1, CodexInvocationRequestV1,
    CodexInvocationV1, SchemaAuthorityModeV1, build_codex_invocation,
    inspect_codex_invocation_postflight,
};
pub use process::{
    BoundedProcessError, BoundedProcessRequestV1, BoundedProcessResultV1,
    ProcessLimitsV1, ProcessTerminationReason, run_bounded_process,
};
pub use qualification::{
    QualifiedRuntimeExecutionRequestV1, QualifiedRuntimeExecutionResultV1,
    RuntimeExecutionError, RuntimeIdentityDrift, RuntimeQualificationError,
    run_qualified_runtime_execution, verify_runtime_identity_unchanged,
};
