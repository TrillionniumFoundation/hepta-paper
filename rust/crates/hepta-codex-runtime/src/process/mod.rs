mod gate;
mod io;
mod types;
mod unix;

pub use types::{
    BoundedProcessError, BoundedProcessRequestV1, BoundedProcessResultV1, ProcessLimitsV1,
    ProcessTerminationReason,
};
pub use unix::{run_bounded_process, run_bounded_process_with_spawn_hook};

#[cfg(test)]
mod tests;

pub use gate::{
    BlockedPreExecGateV1, DurableGateError, DurableGatePolicyV1, GateAuthorityModeV1,
    GateEnvelopeIdentityV1, GateExecutableIdentityV1, GateProcessObservationV1,
    PreExecGateIdentityV1, ReleasedPreExecGateV1, observe_preexec_gate_process,
    spawn_blocked_preexec_gate, terminate_journaled_preexec_gate,
};
