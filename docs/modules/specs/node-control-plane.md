# module.node-control-plane

Status: normative module specification  
Manifest: [`../manifests/node-control-plane.v1.json`](../manifests/node-control-plane.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.node-control-plane
implementationKind: legacy_in_process
staticImplementationState: source_implemented
staticActivation: authoritative
authorityClass: central_state_write
qualificationRequirement: target_host
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-KERNEL
secondaryOwnerTeam: TEAM-STATE
independentReviewerTeam: TEAM-EVIDENCE
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Operate the current authoritative Node campaign, automation, preparation, verification, and integration graph under existing gates during migration.

It does not perform long-running scientific/provider work or own release/submission credentials. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- campaign commands and external triggers
- current Node configuration
- qualified runtime and store adapters

Outputs:

- campaign events and projections
- prepared/integrated results
- operator and external-action receipts

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `central_state_write`. Current static activation: `authoritative`. The registry declaration is a ceiling and request, not an authority grant. It is a logical single-writer boundary for its state domain. Raw writable handles are never exposed; writer generation, expected revision, idempotency, and fencing are mandatory.

Declared side-effect classes: `central_commit`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- No hard module dependency.

Current implementation and contract roots:

- `paper-application/automation/campaign-engine.mjs`
- `paper-application/automation/campaign-prepared-result-integration.mjs`
- `workflow-kernel`
- `paper-domain`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Uses the incumbent Node runtime's bounded worker, storage, and provider controls. Migration/shadow work has separate quotas and cannot starve authoritative traffic or create hidden child concurrency. Resource use is reported in the common settlement format.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Preserve existing campaign fencing, prepared-result integration, external-action journals, startup reconciliation, and fail-closed release gates. Migration failures cannot weaken the incumbent path.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Retain current least-privilege composition, role separation, workspace fencing, release/submission gates, and no Rust authority before accepted cutover.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Node behavior remains the compatibility oracle until each capability's parity class, shadow/canary evidence, cutover, and retirement are accepted.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-STATE-COMMIT`, `CAP-STATE-READ`, `CAP-EXE-DISPATCH`, `CAP-AUTHOR`, `CAP-REVIEW`, `CAP-FORMAL`, `CAP-EMPIRICAL`, `CAP-NUMERICAL`, `CAP-BUILD`, `CAP-SUBMIT`. Related work identifiers: `NODE-001`. Implementation/contract roots: `workflow-kernel`, `paper-domain`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The current engine's explicit `resourceEnvelopePolicy` integration reserves
both global and campaign-local child capacity before a selected parent starts.
`campaign-resource-envelope-scope.mjs` supplies restricted nested-agent ports and
tracks outstanding calls; `campaign-prepared-result-integration.mjs` retains the
existing prepare/integration fence. A parent cannot prepare or commit success
until all registered children settle successfully, including calls the executor
did not await. Parent failure or cancellation joins those calls before releasing
its resource reservation, and a failed peer cannot make an enabled dispatch batch
return while another admitted node is still executing. Supervisor and early-exit
cleanup do not bypass the existing attempt, writer, budget or external-action
checks. The policy hash is correlation data, not independent authority.

The closed policy, compatibility impact, limits and opt-in semantics are specified
in [`RESOURCE_MODEL.md`](../../control-plane/RESOURCE_MODEL.md#15-explicit-node-campaign-engine-integration-and-nested-result-barrier).
`paper-core/tests/campaign-resource-envelope-integration.test.mjs` exercises the
actual engine and SQLite state transitions with explicitly local executor
operations. Null policy and unselected kinds retain legacy mode; no CLI/service
default, multiprocess governor, scientific verifier or writer authority changes.
Registration of these exact source paths updates ownership traceability only,
not NODE-001 acceptance, target-host qualification or rollout state.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

## Rollout and rollback

Current channel is `authoritative`. Promotion follows disabled → shadow/read-only comparison → bounded canary → authoritative, with an exact rollback version and atomic mutual-exclusion fencing. A failed or ambiguous canary stops admission and invokes reconciliation before rollback; dual authority is forbidden.

## Open blockers

- `NODE-001` — `source_implemented`
- Effective `target_host` evidence remains deployment/external-subject specific and cannot be committed as static success.
- No additional repository-local implementation blocker is asserted by this specification; qualification, activation, and operation remain separate.
