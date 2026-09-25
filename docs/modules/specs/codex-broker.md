# module.codex-broker

Status: normative module specification  
Manifest: [`../manifests/codex-broker.v1.json`](../manifests/codex-broker.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.codex-broker
implementationKind: host_service
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: prepared_result_only
qualificationRequirement: target_host
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-RUNTIME
secondaryOwnerTeam: TEAM-SRE
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Mediate bounded role-separated Codex execution through authenticated local admission, durable journaling, pre-exec gating, containment, and prepared-result recovery.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- bounded authenticated local frame
- role capability
- qualified runtime and schema identity
- deadline and idempotency key

Outputs:

- reservation/admission disposition
- bounded execution events
- durable prepared result and recovery receipt

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

## Dependencies

Hard registered module dependencies:

- `module.protocol-kernel`

Current implementation and contract roots:

- `rust/crates/hepta-codex-broker`
- `rust/crates/hepta-codex-journal`
- `rust/crates/hepta-cgroup-containment`
- `rust/crates/hepta-codex-event-stream`
- `rust/crates/hepta-codex-runtime`
- `rust/crates/hepta-codex-testkit`

## Concurrency and resources

Runs as a role-specific service with bounded listeners/workers, queue depth, file descriptors, CPU, memory, storage, and deadlines. Startup/recovery capacity is reserved separately. Backpressure is machine-readable, and every accepted operation is linked to a reservation or a documented control-plane exemption.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Fail closed on peer, capability, socket, runtime, schema, journal, gate,
containment, stream, workspace or prepared-result mismatch. Dispatch persists the
pre-release workspace inventory before provider release. Local finalization
recomputes the descriptor-bound post-execution inventory and cross-checks the
stream, output and schema-validation identities against the journal before
publishing a prepared receipt. Restart re-enters only missing local transitions;
it never repeats a released provider call.

## Security and privacy

Use role-separated Unix principals, private sockets/homes/journals, peer credentials, expiring capabilities, non-writable schema/gate identities, and cgroup containment.

## Compatibility and migration

Broker request, journal, event, trust-bundle, and prepared-result versions remain independently migratable with exact restart/rollback rules.

## SLO, capacity, and observability

Track readiness, admission/dispatch latency, busy and rejection rates, queue depth, crash/restart reconciliation, prepared-result durability, cleanup time, and identity/security violations. Identity violations and duplicate effects are zero-tolerance.

## Operational runbook

The canonical executable is `hepta-codex-broker <absolute-config.json>`, matching
both deployment manifest versions. `--help` and `-h` print usage without loading
configuration, starting signal watchers, opening a listener or touching journals.
The former unpublished `hepta-codex-product-broker` target is removed rather than
kept as another product launcher.

`load_product_codex_broker_configuration` returns an inspectable but externally
immutable `LoadedProductCodexBrokerConfigurationV1`. Callers use `configuration()`
and `identity()`; direct field mutation is no longer supported. The composer
reopens the original configuration through that same bounded owner/principal
loader and compares the full captured identity and policy before opening the
runtime, journal or listener. This is a startup revalidation boundary, not a
lifetime configuration-revocation feed or protection against every later race.

The installed adapter is `ProductCodexDispatcherV1`, supplied through
`BrokerServerV1::with_dispatcher`. It requires a canonical operation descriptor
owned by a principal distinct from the broker. The dispatcher retains the operation-directory device/inode and refuses path replacement while allowing new descriptors in the original directory. That descriptor binds the exact
campaign attempt, role/task, lease/revision, prompt and input-manifest bytes,
initial workspace inventory, output schema, mutation policy, validity window and
resource/cost ceilings. These authority inputs are revalidated before provider
release and again before accepting provider output; the postflight check permits
only workspace changes subsequently accepted by the durable mutation owner. The
descriptor digest is carried into the durable prepared receipt.
Without this adapter, admission/reservation is not provider execution. The
[dispatch operations contract](../../../rust/crates/hepta-codex-broker/DISPATCH.md)
is the executable API runbook; credential and installed daemon composition remain
separate deployment inputs.

The normal authenticated RPC now exposes the original journal-bound prepared
and acknowledged receipt digests using the existing V1 response kinds. Exact
request retries do not redispatch. Exact signed acknowledgement replay retains
its original subject/time/signature checks and returns the durable terminal
without appending again; conflicting acknowledgements remain rejected. See the
[consumer recovery contract](../../../rust/crates/hepta-codex-broker/DISPATCH.md#consumer-visible-results-and-acknowledgement-recovery)
for lost-response/restart behavior and actual test commands. The explicit
`HEPTAQX1` read-only query now transports the journal-bound original receipt and
actual output through the existing role broker without reservation or dispatch.
The normal execution wire stays unchanged. The consumer checks the expected
broker peer and exact request/receipt/output; current authority is rechecked
before output chunks. Expired-request recovery authority, the full
campaign consumer and commit-bound ACK transport remain separate.

Before listener readiness call `recover_codex_dispatch_containment`, then the
normal journal reconciliation. A replaced cgroup or unresolved released
operation blocks admission; do not adopt a numeric PID or synthesize success.
For a journal at `SchemaValidated`, `WorkspaceSnapshotted` or
`MutationValidated`, invoke `finalize_codex_prepared_result` with the same bound
workspace and mutation policy. It reuses the original evidence and advances only
missing local transitions; it must not dispatch the provider again. On shutdown
stop admission and join the existing bounded workers. A provider timeout remains
unknown until its original operation is reconciled.

For a backup, use `create_quiesced_codex_dispatch_backup` under its exclusive
dispatch lock. Retain its manifest hash separately. Restore only with
`restore_quiesced_codex_dispatch_backup` into a fresh destination; the bundle
contains `journal.sqlite` and `state/`, not credentials, cgroups or permission
to restart a provider call. Requalification and normal pre-readiness recovery
still apply. Missing result sidecars or active journaled processes refuse backup;
never substitute the older journal-only backup for provider-action history.

## Verification and evidence

Capability bindings: `CAP-EXE-BROKER`. Related work identifiers: `GAP-CODEX-001`, `GAP-HOST-001`, `GAP-KEY-001`. Implementation/contract roots: `rust/crates/hepta-codex-broker`, `rust/crates/hepta-codex-journal`, `rust/crates/hepta-cgroup-containment`, `rust/crates/hepta-codex-event-stream`, `rust/crates/hepta-codex-runtime`, `rust/crates/hepta-codex-testkit`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Runtime migration implementation details

See the [Codex dispatch implementation and operations contract](../../../rust/crates/hepta-codex-broker/DISPATCH.md). It describes external execution-authority verification, permit and deadline binding, bounded stdin/stdout/stderr, cancellation, cgroup attachment and cleanup, output-schema validation, event journaling, provider ambiguity, descriptor-bound mutation validation and crash-reentrant prepared-result publication. Its quiesced dispatch backup/restore contract binds shared/exclusive locking, journal and all three sidecar hash manifests, fresh restore destinations and rejection of active PID/cgroup authority recovery. The implementation roots explicitly include containment, event-stream, workspace, runtime and testkit crates. Local protocol tests cannot establish target-host cgroup, namespace, process-gate or real credential qualification.

The ordinary service and local workflow can now import an existing broker result
through the [broker-prepared consumer](../LOCAL_WORKFLOW_HANDOFF.md#broker-prepared-result-consumption).
It uses the existing CAS, verifier and SQLite sequencer without dispatching a
provider or sending an ACK. This closes the local result-consumer slice only;
request issuance, live role canaries and production activation remain separate.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `GAP-CODEX-001` — `blocked_external`
- `GAP-HOST-001` — `blocked_external`
- `GAP-KEY-001` — `blocked_external`
- Effective `target_host` evidence remains deployment/external-subject specific and cannot be committed as static success.
