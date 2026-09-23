# module.rust-control-plane-service

Status: normative module specification  
Manifest: [`../manifests/rust-control-plane-service.v1.json`](../manifests/rust-control-plane-service.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.rust-control-plane-service
implementationKind: host_service
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: prepared_result_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-KERNEL
secondaryOwnerTeam: TEAM-RUNTIME
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Compose the production Rust control-plane process around qualified registry, snapshot, policy, planning, admission, dispatch, verification, commit, and observability ports.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- qualified service configuration
- registry and policy artifacts
- read-only state
- module health and resource observations

Outputs:

- plan/dispatch/verification/commit orchestration
- run receipt
- bounded events and readiness state

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

## Dependencies

Hard registered module dependencies:

- `module.scheduler-core`
- `module.execution-dispatcher`
- `module.commit-sequencer`

Current implementation and contract roots:

- `docs/control-plane/COMPOSITION_ROOT.md`
- `rust/crates/hepta-paper-service`
- `docs/rust/RUNTIME_MIGRATION_IMPLEMENTATION.md`

## Concurrency and resources

Runs as a role-specific service with bounded listeners/workers, queue depth, file descriptors, CPU, memory, storage, and deadlines. Startup/recovery capacity is reserved separately. Backpressure is machine-readable, and every accepted operation is linked to a reservation or a documented control-plane exemption.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Startup fails before readiness on identity, schema, registry, qualification, reconciliation, writer-generation, or dependency failure. Runtime failure fences new dispatch, preserves prepared work, and requires deterministic recovery before restart.

## Security and privacy

Run under a dedicated principal with read-only policy/registry inputs and narrow broker/sequencer ports. It holds no provider, KMS/HSM, WORM, portal, or submission secrets.

## Compatibility and migration

Service upgrades require protocol/state compatibility, reconciliation of in-flight work, exact rollback target, and no dual-writer/external-effect reachability.

## SLO, capacity, and observability

Track p50/p95/p99 latency, maximum queue age/depth, throughput, timeout/fallback rate, recovery time, and all zero-tolerance safety counters. Canonical workload and threshold versions are bound in the deployment evidence; source documents do not invent production numbers.

## Operational runbook

The runnable operator surface is `hepta-paper-rust autonomous-research`;
the owning execution chain is documented in [local workflow execution and
recovery](../LOCAL_WORKFLOW_HANDOFF.md). The guarded library APIs and the
separate state-authority daemon do not establish a production service launcher.
Build the current checkout, then operate only an explicitly selected disposable
or admitted local workflow:

```sh
cargo build --manifest-path rust/Cargo.toml --locked -p hepta-paper-service
rust/target/debug/hepta-paper-rust autonomous-research --campaign-id "$CAMPAIGN" --workflow-file "$DEFINITION" --action prepare
rust/target/debug/hepta-paper-rust autonomous-research --campaign-id "$CAMPAIGN" --workflow-file "$DEFINITION" --action launch --through-steps 1
rust/target/debug/hepta-paper-rust autonomous-research --campaign-id "$CAMPAIGN" --workflow-root "$STATE" --definition-hash "$HASH" --action status
```

`DEFINITION` is a private absolute-path `LocalWorkflowV1`; `STATE` and `HASH`
come from its actual owner/result, not fabricated examples. With a custom
`CARGO_TARGET_DIR`, use that build directory instead of `rust/target`.
Prepare performs no state creation. Launch mutates the selected local state;
it does not enable a production writer. The current CLI samples the system
clock, rejects backwards observations and revalidates the lease at dispatch
and commit; it does not establish trusted or monotonic host time.

| Observed condition | Operator action | Required postcondition |
|---|---|---|
| Busy owner | Let the owning operation finish or interrupt that operation; do not remove its lock. | A fresh read-only status succeeds under the existing owner. |
| Paused or ready for cancellation | Read the current revision; issue pause/resume/cancel with that exact `--expected-revision`. | Re-read persisted lifecycle and committed prefix. |
| Started without durable prepared output | Preserve attempts, CAS and SQLite. Do not relaunch, delete markers or refund uncertain usage. | An owning reconciliation supplies a definite result; cancel alone does not settle it. |
| Complete prepared output, commit interrupted | Use `hepta-local-maintenance prepared-plan STATE HASH`; inspect its exact plan/hash before `prepared-commit`. | The same verified bytes commit once, without worker re-execution. |
| Missing/corrupt CAS, foreign definition or stale lease | Stop new admission and preserve the complete private state for its owner. | Correctly bound evidence/recovery, not edited JSON flags or an old backup over new commits. |

The full maintenance argument contract is in the [actual maintenance
CLI](../../../rust/crates/hepta-paper-service/src/bin/hepta-local-maintenance.rs).
A signal to the autonomous CLI interrupts its supervised process group;
it cannot erase a completed COMMIT or prove absence of remote effects.

## Verification and evidence

Capability bindings: `CAP-CTL-SNAPSHOT`, `CAP-CTL-POLICY`, `CAP-EXE-DISPATCH`. Related work identifiers: `CTL-001`, `CTL-008`. Implementation/contract roots: `docs/control-plane/COMPOSITION_ROOT.md`, `rust/crates/hepta-paper-service`, `docs/rust/RUNTIME_MIGRATION_IMPLEMENTATION.md`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Runtime migration implementation details

The [local state authority handoff](../LOCAL_STATE_AUTHORITY_HANDOFF.md) documents
the separate native authority client/daemon, its supplied-key signing and private
journal. Its source lives in the same crate for shared contracts; that does not
grant this control-plane role the daemon's key custody or change this module's
`prepared_result_only` ceiling. Installed principal/topology separation, old Node
journal migration and independent host acceptance remain required.

The [automation reconciliation execution handoff](../AUTOMATION_RECONCILIATION_EXECUTION_HANDOFF.md)
specifies the schema-25 offline transaction, private receipt issuer, shared Node
package lock, local cutover admission, live/default-root passive CLI, exact signed
online callbacks, post-reservation precommit hook, rollback/recovery behavior and
remaining production/online activation gaps.

The executable source is now in `rust/crates/hepta-paper-service`. See [runtime migration implementation and commands](../../rust/RUNTIME_MIGRATION_IMPLEMENTATION.md), the [control-plane contract](../../../rust/crates/hepta-control-plane/README.md), and the [durable campaign writer contract](../../../rust/crates/hepta-campaign-writer/README.md) for concrete request fields, persisted state, exact replay, shadow inspection, local execution and verification commands.

The static module state is `source_implemented`, matching the Identity section and module registry; activation remains `disabled`. Implemented local/shadow and guarded production API source do not establish accepted production composition. `CTL-001` source implementation and its separate effective qualification must not be conflated. Real runtime identity, independent host/evidence authority, complete Node business coverage and rollout acceptance remain required. No local command generates production qualification or activation.

The [native business handoff](../NATIVE_BUSINESS_HANDOFF.md) defines the seven bounded kernels, actual wire examples, output contracts and executable documentation tests. These kernels must not be counted as full Node business-role parity. The [full replacement acceptance contract](../../migration/FULL_REPLACEMENT_ACCEPTANCE.md) defines the remaining command, capability, branch and operational evidence chain.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `CTL-001` — `source_implemented`
- `CTL-008` — `source_implemented`


The online mutation composition now includes a sealed initial evidence stage:
actual process pins, ten-database startup/finalized proof ownership, the concrete
recovery fence shared with the coordinator, and a final common time boundary.
See [the composition handoff](../ONLINE_MUTATION_COMPOSITION_HANDOFF.md) for
ordering and remaining native writer/cutover/transaction requirements. Historical
schema checkpoint loading authenticates the original full inventory and copied
bytes; a separate internal bridge now proves current-state equivalence by
actual registered replay and all-table comparison against fresh signed heads.
The owning constructor explicitly retains this historical branch and the actual
post-startup inventory, including recovered finalizations, while preserving the
original pre-startup subject for the startup proof. See
[the schema readiness handoff](../ONLINE_SCHEMA_TRANSITION_READINESS_HANDOFF.md).
Both are prerequisites and leave production activation and Node retirement false.


The fixed-native-store transaction inventory observer preserves non-target
content and namespace checks without opening/closing target SQLite descriptors.
It is constructed before opening the owning connection. Actual durable state is
now available inside the same held writer lock. The crate-private native
admission and consuming one-shot execution owner bind the exact phase, scope,
epoch and genuine signatures there; the signed transfer owner carries that
admission into the fixed reconciliation operations. These source paths do not
expose a general writer or complete writable CLI. See the actual
[execution owner](../../../rust/crates/hepta-paper-service/src/online_mutation_composition/activation/execution.rs)
and [transfer owner](../../../rust/crates/hepta-paper-service/src/online_mutation_composition/activation/transfer.rs).


Retained transaction evidence now composes complete source/cache pins, actual
startup post-inventory, initial or historical schema/replay, active/finalized
signatures and the concrete recovery token. Recovery evidence retains its raw
file owners across invalidation and blocks full re-observation while the token
exists. The caller must close SQLite before releasing all scopes. This remains
an internal ownership boundary used by the implemented source admission and
one-shot owner. Complete installed native authority provenance, direct-socket
owning composition, V2 deployment/qualification consumption, the writable CLI
and independent production acceptance remain open. The
[nine-role deployment contract](../../../rust/crates/hepta-paper-service/src/deployment/HANDOFF.md)
registers the state authority as a separate daemon/principal; sharing the Rust
crate does not add its signing journal or private key to the control-plane role.
