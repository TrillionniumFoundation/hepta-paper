# module.candidate-router

Status: normative module specification  
Manifest: [`../manifests/candidate-router.v1.json`](../manifests/candidate-router.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.candidate-router
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: pure
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-KERNEL
secondaryOwnerTeam: TEAM-SCHEDULER
independentReviewerTeam: TEAM-EVIDENCE
```

The executable source digest, configuration, deployment generation, host identity,
current qualification evidence, and rollback version belong to an exact deployment
subject. This static document cannot grant qualification, activation, writer,
provider, release, submission, or external authority.

## Mission and non-goals

Request, capture, validate, canonicalize, and deterministically deduplicate module
planning candidates against one immutable planning request and one exact qualified
module-registry snapshot before global selection.

It does not optimize the global plan, execute candidates, hold credentials, mutate
state, perform external effects, or promote evidence. It owns no durable state and
cannot grant authority. A locally preferred candidate is not global priority, and
source tests are not production qualification.

## Inputs and outputs

The executable entrypoint is:

```text
routeActionCandidates({ planningRequest, moduleRegistry, candidates, nowEpochMs })
```

`PlanningRequestV1` binds the request ID, state-snapshot hash, qualified registry
snapshot hash, capability, hard-constraint-set hash, objective version,
resource-price snapshot hash, candidate count/byte limits, canonical deadline,
allowed side-effect classes, and optional immutable goal, policy, and input-artifact
references.

`QualifiedModuleRegistrySnapshotV1` contains at most 256 exact module bindings.
Each binding carries module/version, protocol range, capability set, accepted
qualification class, and qualification-evidence hash. Its snapshot hash is
recomputed before candidates are inspected.

Inputs contain no writer handle, provider credential, release credential, private
key, unbounded manuscript, unrestricted prompt, or opaque executable payload.
Accessor properties, sparse arrays, unknown fields, invalid prototypes, non-finite
numbers, malformed canonical timestamps, and ambiguous hashes fail before routing.

The output is one immutable `CandidateFrontierV1` containing the exact request and
registry bindings, the qualified module bindings used, canonical candidates,
deduplication receipts, submitted/canonical counts, byte accounting, and a
`candidateSetHash`. Every authority field is explicitly false.

## State and authority

Maximum authority class: `pure`. Current static activation: `disabled`. The module
has no durable state and returns values only. It cannot grant writer, provider,
release, submission, activation, or external authority.

Declared side-effect classes: `none`.

The router accepts a candidate side-effect class only when the planning request
explicitly permits that class; acceptance means only that the candidate may remain
in the frontier. It is not execution authorization. Candidate IDs and hashes are
correlation identities, not capabilities.

## Dependencies

Hard registered module dependencies:

- `module.module-registry`

Current implementation and contract roots:

- `docs/modules/MODULE_PROTOCOL.md`
- `docs/control-plane/COMPOSITION_ROOT.md`
- `paper-application/orchestration/candidate-router.mjs`

The runtime receives a frozen qualified-registry projection rather than importing
another module's private implementation. Module source, qualification evidence,
protocol range, capability, and version must match the projection exactly.

## Concurrency and resources

The implementation is synchronous, side-effect free, and allocates only bounded
in-memory canonical records. V1 hard ceilings are:

| Dimension | Maximum |
|---|---:|
| candidate submissions | 4,096 and no more than the request limit |
| canonical submitted bytes | 4 MiB and no more than the request limit |
| qualified registry modules | 256 |
| strings in ordinary identity fields | 2,048 UTF-8 bytes |
| one nested candidate string budget | 16 KiB |
| nested collection entries | 1,024 |
| nested depth | 16 |
| nested visited values | 8,192 |

Count and byte limits include retransmissions. The router creates no worker pool,
timer, filesystem write, process, network request, GPU request, or provider call.
A future asynchronous producer fan-out belongs to a separate bounded orchestration
layer and must return a typed incomplete-frontier disposition on timeout.

## Determinism and optimization contract

Declared class: `deterministic`. For the same canonical request, qualified registry,
candidate multiset, and explicit integer clock, the output is byte-stable under the
repository canonical hash implementation. Candidate input order and unordered set
order do not affect the frontier.

Exact retransmissions collapse idempotently. Reuse of one candidate ID with
different bytes is rejected. Semantically equal candidates that differ only in
candidate identity/hash select the lexicographically smallest candidate ID and
emit a deduplication receipt; conflicting singleton metadata fails instead of
being chosen arbitrarily.

V1 deliberately sets:

```text
dominanceReductionApplied: false
dominanceReductionReason: context_substitutability_not_proven
```

Local cost/value/resource dominance is insufficient when candidates have different
preconditions, dependency effects, output semantics, authority requirements, or
future composition costs. Removing candidate `b` is safe only when every feasible
global context containing `b` remains feasible after replacing it with `a`, with
no worse global objective and identical required semantics. The current router
does not receive or prove that universal replacement condition, so it preserves
contextually distinct candidates for the central optimizer.

A module that contributes exactly one canonical candidate must state either
`only_feasible_candidate` or `protocol_does_not_support_alternatives`. Multiple
canonical candidates from the same module must not carry a singleton reason.

## Failure, recovery, and idempotency

The router fails closed on malformed records, unknown fields, count or byte excess,
expired requests/candidates, candidates outliving their request, registry drift,
request/snapshot/capability mismatch, unqualified or wrong-version modules,
undeclared side effects, conflicting IDs/hashes, and inconsistent singleton data.

No partial frontier is returned after a failure. The router mutates no input and
holds no recovery journal. Retrying the exact same captured inputs produces the
same result. A changed clock, snapshot, registry, policy, objective, price, module
qualification, or candidate set is a new subject and must not reuse an earlier
frontier as current evidence.

## Security and privacy

All untrusted records are captured from own enumerable data descriptors. Getters,
setters, class instances, symbols, sparse arrays, inherited properties, functions,
BigInts, non-finite numbers, and unknown fields are rejected before hashing or
module lookup. Nested records are bounded and copied into frozen plain values.

Only immutable hashes or bounded references should identify confidential input.
Credentials, private keys, unrestricted prompts/provider responses, developer home
paths, and environment dumps are prohibited. Errors are bounded symbolic codes and
do not echo candidate payloads.

## Compatibility and migration

This implementation accepts only protocol V1 and exact V1 object kinds. Readers
reject unknown required semantics. Changes to candidate feasibility, units,
semantic-dedup identity, singleton rules, dominance policy, or hash domains require
a new version and fresh downstream qualification.

The executable module is additive while static activation remains disabled. Existing
document-only callers are unaffected until composition explicitly invokes the
router. Rollback is a reviewed source revert followed by re-derivation of any
frontier whose source, registry, or policy binding changed.

## SLO, capacity, and observability

Source evidence records deterministic replay, accepted/rejected candidate counts,
canonical bytes, deduplication classes, rejection codes, and bound identities.
Production p50/p95/p99 latency and memory thresholds require named canonical
workloads and target-host evidence; this document does not invent values.

Zero-tolerance source counters include accepted unknown fields, accepted
unqualified modules, accepted expired candidates, conflicting-ID acceptance,
authority escalation, input mutation, and unproved dominance deletion.

## Operational runbook

No long-lived service lifecycle is assumed. Before invocation, composition captures
an exact state snapshot, qualified module registry, constraint/objective/price
identities, candidate and byte limits, allowed side-effect classes, deadline, and
explicit clock. It then calls the pure router once and passes only the returned
immutable frontier to the central optimizer.

On rejection, record the symbolic error and exact non-secret subject hashes, then
fix or regenerate the offending producer data. Do not repair candidate semantics,
change hashes, widen permissions, or drop candidates inside the router. Any source,
schema, registry, qualification, objective, or policy change invalidates cached
frontiers and requires fresh conformance.

## Verification and evidence

`paper-core/tests/candidate-router.test.mjs` exercises deterministic order,
context-safe candidate preservation, exact and semantic duplicate handling,
conflicting identity rejection, strict descriptor capture, request/snapshot/
capability/module bindings, expiry, side-effect policy, numeric and structural
limits, singleton rules, immutable output, explicit-clock requirements, and
planning identity changes.

The tests include the critical counterexample in which one candidate is locally
cheaper and higher value but introduces an unavailable dependency, while a locally
weaker candidate is globally feasible. Both remain in the frontier. This is an
executable non-deletion control, not a proof that the downstream optimizer is
correct.

Capability binding: `CAP-MOD-CANDIDATES`. Related work identifiers: `CTL-004` and
`MOD-002`. This increment implements the bounded in-process routing kernel and
updates module structural truth. It does not close those complete work items,
G2/G3/G6, producer fan-out, global optimization, target-host performance, or
independent qualification.

The module documentation validator continues to prove registry/spec/manifest
coverage, required sections, field parity, source-path existence, and authority
language. Source conformance does not substitute for current exact-head/merge CI,
independent review, deployment evidence, or production activation.

## Rollout and rollback

Current channel is `disabled`. An exact version progresses through registered,
contract-ready, source-implemented, conformance-qualified, shadow, canary, and only
then authoritative where applicable. Activation must bind the exact router source,
request/frontier contract, qualified-registry producer, central optimizer consumer,
configuration, workload evidence, and rollback version.

Rollback must invalidate frontiers produced by the reverted hash or semantic rules.
No rollback may widen accepted fields, restore unsafe local dominance deletion, or
remove qualification and authority boundaries.

## Open blockers

- `CTL-004` — `design_ready`: complete producer orchestration, incomplete-frontier/replan behavior, and central composition evidence remain open.
- `MOD-002` — `design_ready`: full multi-module candidate protocol, cross-language conformance, version migration, and independent acceptance remain open.
