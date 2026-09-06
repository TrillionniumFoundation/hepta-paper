# Candidate collection source contract

## Scope

`paper-application/orchestration/candidate-batch-collector.mjs` turns a bounded
set of producer dispositions into either one complete `CandidateFrontierV1` or
an explicit incomplete result. It does not invoke module code, implement process
timeouts, authenticate the execution environment, select a candidate, execute
work, or mutate authoritative state.

A separate bounded execution layer supplies one disposition for each expected
qualified module/version that advertises the requested capability. Dispositions
may report:

```text
candidate_batch_complete
producer_timeout
producer_failed
producer_cancelled
producer_unavailable
```

Missing dispositions are represented as `producer_missing` by the collector.

## No partial-frontier promotion

A complete frontier is produced only when every expected producer has an exact
`candidate_batch_complete` disposition. If any expected producer is missing,
timed out, failed, cancelled, or unavailable:

- result status is `candidate_frontier_incomplete`;
- `frontier` is `null`;
- candidates from successful peers are not accepted, hashed as an accepted set,
  or passed to global selection;
- deterministic incomplete reasons and per-producer metadata are retained;
- every authority flag remains false.

A successful producer returning zero candidates is distinct from a missing or
failed producer. When all expected producers complete, all-zero responses form a
complete, explicit empty frontier.

## Identity and ownership

Each disposition binds:

```text
module ID and version
planning request ID
state snapshot hash
capability ID
completion time
status and typed failure code or candidate array
```

The supplied module/version must be in the exact qualified module set and must
advertise the requested capability. A completed batch may contain only
candidates whose descriptor-backed `moduleId` and `moduleVersion` match the
batch owner. A producer cannot smuggle a candidate for a different qualified
module.

Only after the entire collection is complete are candidate payloads passed to
the strict router. The router then recomputes hashes and enforces request,
snapshot, capability, module qualification, expiry, side-effect and byte/count
constraints. This ordering intentionally avoids evaluating unused candidate
payloads from a partial collection.

## Bounds and determinism

At most 1,024 producer dispositions are accepted. One producer batch may not
exceed the planning request's candidate limit, and the flattened complete
collection remains subject to the router's global candidate-count and byte
limits. Producer and disposition identities are unique and canonically ordered.
Explicit `observedAt` and completion timestamps prevent ambient wall time from
changing the result.

Exact duplicate candidates are deduplicated only by the downstream router.
Conflicting candidate identities fail the complete collection. Local Pareto
pruning remains disabled without a context-safe replacement proof.

## Execution-layer boundary

This source consumes dispositions rather than directly racing in-process
Promises against timers. A timer cannot prove that arbitrary in-process code or
a process tree has stopped. The owning execution layer must provide its own
resource reservation, isolation, cancellation, settlement and typed disposition
contract. It must not mark timeout or cancellation as complete execution.

## Verification

`paper-core/tests/candidate-batch-collector.test.mjs` covers complete/empty
frontiers, producer order, timeout/failure/cancellation/unavailability, missing
and extra producers, subject/time drift, malformed disposition shapes,
cross-module candidate ownership, unused hostile payloads on incomplete paths,
full payload validation on complete paths, global count limits, exact duplicate
handling, identity conflicts, no-qualified-producer handling, accessors, sparse
arrays and immutable non-authorizing output.

These source controls do not constitute producer execution qualification,
registry authentication, scheduler integration, current exact-head acceptance,
or MOD-002/CTL-004 closure. The machine status remains unchanged until the full
producer, consumer, qualification and independent-review chain succeeds.
