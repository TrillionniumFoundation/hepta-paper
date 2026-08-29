//! Security-critical local runtime primitives for the Codex broker.
//!
//! The crate deliberately has no campaign database, network, release, or
//! submission authority. It inspects a qualified local runtime, constructs
//! default-deny child environments, supervises one bounded process group, and
//! verifies that runtime identity did not change across execution.

#![forbid(unsafe_code)]

pub use hepta_cgroup_containment::{
    CgroupAuthorityModeV1, CgroupV2Error, CgroupV2OperationV1, CgroupV2PolicyV1,
    ProcessContainmentModeV1,
};

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
    CredentialMaterialStatus, DirectoryIdentityV1, ExecutableIdentityV1, FileSystemIdentityV1,
    RuntimeIdentityError, RuntimeIdentityPolicyV1, inspect_codex_runtime_identity,
};
pub use invocation::{
    CodexControlDirectoryContractV1, CodexControlFileContractV1, CodexInvocationError,
    CodexInvocationPolicyV1, CodexInvocationPostflightV1, CodexInvocationRequestV1,
    CodexInvocationV1, SchemaAuthorityModeV1, build_codex_invocation,
    inspect_codex_invocation_postflight,
};
pub use process::{
    BlockedPreExecGateV1, BoundedProcessError, BoundedProcessRequestV1, BoundedProcessResultV1,
    DurableGateError, DurableGatePolicyV1, GateAuthorityModeV1, GateEnvelopeIdentityV1,
    GateExecutableIdentityV1, GateProcessObservationV1, PreExecGateIdentityV1, ProcessLimitsV1,
    ProcessTerminationReason, ReleasedPreExecGateV1, observe_preexec_gate_process,
    run_bounded_process, run_bounded_process_with_spawn_hook, spawn_blocked_preexec_gate,
    terminate_journaled_preexec_gate,
};
pub use qualification::{
    QualifiedRuntimeExecutionRequestV1, QualifiedRuntimeExecutionResultV1, RuntimeExecutionError,
    RuntimeIdentityDrift, RuntimeQualificationError, run_qualified_runtime_execution,
    verify_runtime_identity_unchanged,
};
