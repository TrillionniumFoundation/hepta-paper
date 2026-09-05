# Candidate router implementation contract

## 1. Scope

`paper-application/orchestration/candidate-router.mjs` implements a pure,
bounded source candidate for `module.candidate-router` and `CAP-MOD-CANDIDATES`.
It validates one immutable planning request, an exact set of qualified module
bindings, and a bounded collection of `ActionCandidateV1` values. It returns a
canonical `CandidateFrontierV1` value only; it owns no durable state and receives
no writer, provider, release, submission, workspace, or external-authority
capability.

This source increment contributes to `MOD-002` and `CTL-004`. It does not change
the machine work-item state, static activation, production authority, or source
qualification status. Registry/manifest promotion requires current exact-head
checks and independent review after this implementation is accepted.

## 2. Entry point

```js
routeCandidateFrontier({
  planningRequest,
  moduleBindings,
  candidates,
  observedAt,
  bounds?,
})
```

`observedAt` is an explicit semantic input. The router never reads ambient wall
clock, environment variables, process identity, locale, filesystem, network, or
mutable global state.

The helper:

```js
actionCandidatePayloadHash(semanticCandidate, bounds?)
```

produces the exact payload hash expected by the router after bounded data
capture. It is not a signature or a module qualification receipt.

## 3. Planning request

The required `PlanningRequestV1` data record binds:

- `planningRequestId`;
- `stateSnapshotHash`;
- one capability;
- hard-constraint, objective, and resource-price identities;
- candidate count and byte ceilings;
- an exact expiry;
- the allowed side-effect classes.

Unknown, non-enumerable, accessor, inherited, sparse, duplicate-set, malformed,
expired, or unbounded values fail closed before candidate routing. Plain and
null-prototype data records are accepted. Proxies are not a trusted boundary;
callers must not provide active proxy objects as protocol data.

## 4. Qualified module bindings

Every candidate must match one exact `QualifiedCandidateModuleV1` binding by
module ID and module version. The binding must:

- use protocol version 1;
- contain the requested capability;
- bind source, configuration, and qualification-subject hashes;
- carry one of the explicit qualified states;
- remain current at `observedAt` and not outlive the planning request.

Duplicate module/version identities fail. A binding is an input assertion from
the qualified composition boundary; this router does not authenticate the
producer of that assertion.

## 5. Candidate validation

Every accepted `ActionCandidateV1` must match the planning request's request ID,
snapshot, and capability and the module binding's exact identity. The router
validates:

- closed top-level fields and required fields;
- nonempty bounded identifiers and hash syntax;
- finite, nonnegative resource values, with safe integers for discrete units;
- bounded closed nested data for duration, cost, value, and risk;
- dense, unique, canonical precondition and dependency-effect sets;
- allowed side-effect class;
- exact expiry ordering at nanosecond precision;
- recomputation of `candidatePayloadHash`.

Impossible calendar dates are rejected instead of being normalized by
`Date.parse`. Cancellation and timeout are outside this pure function; a caller
must bind them around candidate collection before invoking the router.

## 6. Canonical encoding and identities

`candidate-router-canonical.mjs` defines the new router-local canonical encoding:

- object keys are ordered by unsigned UTF-8 bytes;
- array order is preserved;
- set-like protocol arrays are captured and UTF-8 sorted first;
- JSON is emitted without whitespace;
- the hash domain is the canonical object `{kind, value}`;
- SHA-256 is represented as lowercase `sha256:<64 hex>`.

This removes host-locale collation from candidate identities. In particular,
`LANG=sv_SE.UTF-8` and `LANG=C` produce the same candidate hash. This does not
retroactively redefine historical hashes produced elsewhere in the repository.
A cross-language SDK must implement this exact router-local encoding before it
claims byte-identical candidate hashes.

## 7. Deduplication and dominance

Exact duplicate records are idempotently removed. Reusing one candidate ID for
different semantics fails. Multiple IDs for one identical semantic payload are
collapsed deterministically to the smallest UTF-8 identifier. A claimed payload
hash whose recomputed body differs fails before deduplication.

The current implementation deliberately performs **no Pareto removal**:

```text
dominanceReductionApplied: false
dominancePolicy: context_replacement_proof_required
```

A candidate that appears locally inferior can be the only globally feasible
choice after dependency effects, shared resources, authority, or downstream
compatibility are considered. Removal is permitted only after a separately
versioned proof establishes context-safe replacement for every feasible global
continuation. Local value/cost comparison alone is insufficient.

## 8. Bounds

Default hard ceilings are:

| Limit | Default |
|---|---:|
| candidate depth | 16 |
| fields per nested object | 128 |
| aggregate nested collection items | 4,096 |
| UTF-8 bytes per string/key | 4,096 |
| module bindings | 512 |
| input candidates | 1,024 |
| canonical candidate bytes | 16 MiB |

The caller may supply a closed bounded override record, within implementation
maxima. The planning request may narrow candidate count and candidate bytes but
cannot exceed the router's configured ceiling.

## 9. Output and authority

`CandidateFrontierV1` binds the planning request hash, module-binding-set hash,
canonical candidate list, candidate-set hash, observed/expiry times, input and
output counts, byte accounting, duplicate count, and the no-dominance decision.
A one-candidate frontier requires an explicit singleton reason; a multi-candidate
frontier forbids singleton claims.

Every authority output is fixed false. A valid frontier is not a selected plan,
resource reservation, execution permission, prepared result, writer command, or
production qualification.

## 10. Failure and recovery

All validation failures are typed non-retryable source errors. A caller may
retry only after receiving a new request/snapshot/module/candidate subject or
correcting transport corruption. It must not silently drop malformed candidates
and call the truncated set complete.

Because the function owns no state, crash recovery means replaying the same
captured inputs. Equal canonical input yields equal output bytes and hashes.
Changing objective, hard constraints, prices, module configuration,
qualification subject, candidate semantics, or expiry changes the bound result.

## 11. Executable evidence

`paper-core/tests/candidate-router-core.test.mjs` and
`candidate-router-hostile.test.mjs` exercise deterministic ordering,
100 seeded permutations, locale-independent hashes, exact request/module
binding, duplicate/conflict behavior, context-dependent dominance counterexample,
strict expiry including sub-millisecond ordering, malformed/accessor/sparse/cycle
inputs, resource and byte/count ceilings, immutable output, singleton semantics,
and fixed-false authority.

These tests use synthetic source-level values. They do not establish real module
qualification, live collection completeness, scheduler optimality, target-host
capacity, or production activation. Full repository checks, current base/head/
merge qualification, and an independent reviewer remain required.
