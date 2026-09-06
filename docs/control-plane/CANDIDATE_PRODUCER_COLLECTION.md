# Candidate producer collection

## 1. Purpose

`paper-application/orchestration/candidate-producer-collection.mjs` closes the
source gap between a `PlanningRequestV1` and the existing deterministic candidate
router. It invokes every exact module binding through a separately supplied
trusted planning port, requires one complete response from each binding, and only
then constructs a `CandidateFrontierV1`.

It does not discover modules, qualify a runtime, execute a candidate, mutate
state, hold credentials, or grant provider, writer, release, submission or
production authority.

## 2. Exact coverage

The input contains:

- one closed planning request;
- the exact qualified module-binding set;
- one producer port for every `(moduleId,moduleVersion)` binding;
- one explicit clock;
- bounded concurrency, timeout, candidate-count and response-byte policy.

Bindings and producer ports are sorted by exact identity. Missing, additional,
duplicate or version-mismatched ports reject the whole collection before any
candidate frontier is returned.

Before producer invocation, the existing router performs an empty-frontier
preflight. This validates the planning request and module bindings and produces
the canonical planning-request and module-binding-set hashes. Every producer
receives the same immutable request, its own exact binding, the request hash and
a cancellation signal.

## 3. Module response

Each `ModuleCandidateResponseV1` must be a complete, closed response containing:

```text
moduleId and moduleVersion
planningRequestHash
canonical ActionCandidateV1 records
emptyReason iff no candidate exists
authority fields fixed to false
```

Candidates are independently reconstructed and rehashed before collection. Each
candidate must bind the producer module/version, planning request, snapshot and
capability. The final router then repeats request/binding/resource/expiry and
conflict validation over the complete combined candidate set.

Identical candidates may be deduplicated by the router. Reuse of a candidate ID
or candidate payload hash with different semantic content fails. An all-empty
complete response set yields one explicit empty frontier; it is not converted to
an implicit fallback candidate.

## 4. Failure and cancellation

Producer calls run under a bounded worker count. One producer failure, malformed
or partial response, timeout, outer cancellation, response limit, or total
candidate limit aborts the collection and prevents a partial frontier from being
returned. Raw producer exception text and causes are not propagated into the
collector error.

Cancellation uses Node's propagation-resistant abort subscription. An earlier
ordinary listener calling `stopImmediatePropagation()` cannot suppress collection
cancellation.

Timeout aborts the planning signal and rejects this collection. It cannot prove
that arbitrary in-process code or work it spawned has physically stopped. For
that reason candidate producer ports are required to be planning-only ports with
no writer/provider/release credentials and no external effects. A producer that
needs process isolation requires a separate bounded transport profile.

## 5. Bounds

Default bounds are:

```text
maximum producer concurrency: 4 (hard maximum 64)
producer timeout: 10,000 ms (hard maximum 600,000 ms)
maximum candidates per producer: 256 (hard maximum 4,096)
maximum retained producer response: 2 MiB (hard maximum 16 MiB)
maximum raw candidates across producers: 4,096
```

The candidate router's own count, byte, depth, string and resource constraints
remain independently enforced. A producer can allocate an oversized object
before returning it; an in-process collector cannot prevent that allocation, but
it rejects and does not retain or publish the response.

## 6. Determinism and receipt

Producer completion order does not affect output order. Producer receipts are
ordered by exact module identity and bind candidate payload hashes, candidate
count, explicit empty reason and response hash. The collection receipt binds all
producer response hashes and the final candidate-set hash.

The collection receipt and frontier are immutable. Their authority flags are
fixed false. Hashes establish content identity, not runtime qualification or
external authority.

## 7. Tests

`paper-core/tests/candidate-producer-collection.test.mjs` covers:

- deterministic output under reverse completion order;
- maximum concurrency;
- one-failure full rejection and sibling cancellation;
- timeout and propagation-resistant outer cancellation;
- exact producer/binding coverage;
- response status, identity, request and authority binding;
- candidate module/request/snapshot/capability binding;
- per-producer, total-candidate and response-byte limits;
- exact duplicate collapse and conflicting candidate rejection;
- explicit all-empty frontier;
- accessor/sparse-array rejection without producer execution;
- immutability after producer-owned input mutation.

These source tests use local callbacks. They do not qualify real modules or prove
process termination, host performance or production readiness.

## 8. Remaining work

Before MOD-002/CTL-004 or G2/G6 can close, the project still needs:

- a production registry-to-port resolver with current qualification checks;
- process/transport adapters for untrusted or isolated producers;
- integration into the bounded planning pipeline so candidates are produced from
  the pipeline-created request rather than supplied by a caller;
- cancellation/recovery and target-host load evidence;
- Rust implementation or a reviewed compatibility decision;
- exact-head/merge qualification and independent review.

No machine work-item state or authority is changed by this source increment.
