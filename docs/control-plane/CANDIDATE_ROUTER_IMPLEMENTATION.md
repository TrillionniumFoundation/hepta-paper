# Candidate router implementation contract

## 1. Scope

`paper-application/orchestration/candidate-router.mjs` implements a bounded,
deterministic, in-process candidate-frontier constructor for the existing
`PlanningRequestV1` and `ActionCandidateV1` protocol concepts. It validates and
captures candidate data before the global scheduler sees it.

It does not execute a candidate, choose a global plan, grant credentials, mutate
campaign state, qualify a module, verify external evidence, or authorize a
provider, writer, release, submission, or production activation.

## 2. Trusted inputs

The router receives:

- one planning request bound to a state snapshot, capability, hard-constraint
  set, objective version, resource-price snapshot, deadline, candidate limit,
  allowed side-effect classes, and optional immutable input-artifact hashes;
- an explicit set of module-version bindings produced by trusted composition;
- zero or more `ActionCandidateV1` records;
- an explicit integer clock observation;
- optional limits that may narrow, but cannot exceed, compiled hard ceilings.

A module binding contains exact module/version/capability identity, a
qualification-subject hash and validity deadline. The router checks consistency
with that binding. It does not authenticate or independently qualify the
binding; callers must construct it from current accepted evidence.

## 3. Capture and validation

Input records must be plain or null-prototype objects containing enumerable data
properties only. Accessors, inherited fields, symbols, sparse arrays, unknown
fields, non-finite values, unsafe integers, invalid hashes, NUL-containing text,
invalid timestamps, duplicate semantic sets and excessive collection or byte
sizes fail before frontier construction.

Candidate request ID, snapshot hash and capability must exactly match the
planning request. Module ID/version/capability must resolve to one unexpired
binding. Candidate expiry must be after the explicit clock and no later than the
planning-request deadline. Side-effect class must be in the request allowlist.

`duration`, `cost`, `value` and `risk` remain bounded immutable JSON objects in
this implementation version. Their scientific calibration and objective
interpretation belong to the scheduler and evidence modules, not the router.

## 4. Candidate payload identity

`createActionCandidate(payload)` canonicalizes optional fields and semantic set
arrays, then computes:

```text
hashRecord("ActionCandidateV1", canonical payload without candidatePayloadHash)
```

The router recomputes this value for every candidate. A conflicting reuse of a
candidate ID is rejected. Exact byte-equivalent duplicates are collapsed and
counted. A payload-hash collision with different canonical candidate bytes is
also rejected.

The frontier binds the canonical planning request and sorted module-binding set,
then hashes the complete non-authorizing frontier body as
`CandidateFrontierV1`. Caller mutation after invocation cannot change the
captured result.

## 5. Empty and singleton frontiers

An empty frontier requires an explicit bounded reason such as
`no_feasible_candidate`. A single candidate requires an explicit singleton
reason such as `only_feasible_candidate` or
`protocol_does_not_support_alternatives`. These strings are dispositions, not
proof of global feasibility or optimality.

## 6. Dominance policy

This implementation deliberately reports:

```text
dominanceReductionApplied: false
```

A candidate that has higher local value and lower local cost may still impose a
dependency, authority, compatibility or resource effect that makes another
candidate the only globally feasible choice. Local Pareto reduction is therefore
unsafe unless a versioned replacement proof establishes that every feasible
context containing the removed candidate can substitute the retained candidate
without violating any dependency, resource, policy, evidence, authority,
consumer or output-semantic constraint.

Until that proof and its executable conformance suite exist, the router retains
all distinct valid candidates and leaves selection to the global scheduler.

## 7. Determinism and bounds

Candidate input order and set order do not affect the frontier. Candidate and
module bindings use deterministic identity ordering. The explicit clock is the
only time observation.

Defaults are 256 candidates, 1 MiB per candidate, 8 MiB total frontier input,
JSON depth 16, 4,096 JSON nodes/items and 64 KiB strings. Caller limits may
narrow these values. Compiled hard maxima prevent a caller from configuring an
unbounded parser or frontier.

The implementation is synchronous and performs no I/O. Complexity is bounded by
captured input bytes plus deterministic sorting. Hash computation uses the
repository's existing canonical record-hash implementation and is consequently
part of the exact runtime/source qualification subject.

## 8. Evidence and remaining work

`paper-core/tests/candidate-router.test.mjs` covers exact hash verification,
order invariance, unsafe local-dominance counterexamples, duplicate/conflict
handling, request/module/expiry/side-effect binding, malformed and accessor
inputs, count/byte limits, explicit empty/singleton dispositions and immutable
capture.

These tests are source conformance only. Before changing
`module.candidate-router` or `MOD-002`/`CTL-004` status, the exact head and merge
candidate require complete hosted checks, an independent review, registry and
manifest path alignment, protocol compatibility review, scheduler integration
and current qualification evidence. No production activation follows from this
file or from a locally successful test run.
