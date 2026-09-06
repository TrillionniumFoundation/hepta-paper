# Planning snapshot builder implementation contract

## 1. Scope

`paper-application/orchestration/snapshot-builder.mjs` constructs one immutable
`PlanningStateSnapshotV1` from bounded read-only projection components. It is a
pure in-process consistency and identity boundary for `module.snapshot-builder`.

It does not open a database transaction, authenticate a module, read ambient
state, choose candidates, schedule work, mutate campaign state, execute external
effects, or grant provider, writer, release, submission, or production authority.

## 2. Atomic-read precondition

Every request binds:

```text
snapshotRequestId
readTransactionHash
consistencyEpoch
deadline
required component set
```

Every component must carry the same `readTransactionHash` and
`consistencyEpoch`. This prevents accidental construction from visibly different
read transactions. It does not prove that an upstream database or distributed
system actually created an atomic snapshot. The trusted read-only control/store
must issue the transaction identity and guarantee its semantics; qualification
must test that producer separately.

Two independent endpoint reads that happen to report the same epoch are not
therefore an atomic snapshot. Any producer that cannot provide the required
transaction contract must be rejected or represented by a weaker, separately
versioned snapshot type.

## 3. Component contract

A `PlanningSnapshotComponentV1` contains:

- component ID and projection kind;
- exact source module ID/version and qualification-subject hash;
- read-transaction hash and consistency epoch;
- revision and generation;
- captured/expiry times;
- bounded immutable JSON payload;
- a recomputable component hash.

The request declares one exact requirement for every component: expected ID and
kind, minimum revision, maximum age, and maximum payload bytes. Missing, extra,
duplicate or kind-mismatched components fail closed. Component source identity
must resolve to one explicit unexpired module binding that permits the projection
kind.

The current `payloadHash` name is retained for the source increment, but the
hash domain covers the complete canonical component body, including source and
transaction metadata as well as payload. A later rename or split into separate
payload/record hashes is a protocol change and requires a versioned migration.

## 4. Freshness and bounds

The caller supplies the only clock observation. A component cannot come from the
future, exceed its required maximum age, be expired, expire before capture, or
outlive the snapshot request. A source module binding must also remain current.
The resulting snapshot expires at the earliest request, component, or module
binding deadline.

Payload bytes, complete component bytes, total component bytes and final output
bytes are independent limits. JSON depth, node count, collection size and string
bytes are bounded before the result is returned. Caller limits may narrow but
cannot exceed compiled hard ceilings.

## 5. Determinism and identity

Requirement, module-binding and component input order are not semantic. All are
captured through own enumerable data properties, canonicalized and ordered by
identity. Accessors, inherited fields, symbols, sparse arrays, unknown fields,
NUL text, invalid hashes/timestamps, unsafe integers and non-finite numbers fail
before snapshot construction.

The result binds:

```text
snapshot request hash
read transaction and consistency epoch
module binding set hash
component set hash
component inventory and expiry
authority flags fixed to false
```

`stateSnapshotHash` is the canonical record hash of that complete body. Caller
mutation after invocation cannot alter it.

## 6. Candidate-router composition

The produced `stateSnapshotHash` can be used directly as the snapshot identity in
`PlanningRequestV1`. Candidate routing then rejects any candidate created for a
prior snapshot. This prevents a candidate from being silently replayed after a
revision/requirement/component change.

The composition test exercises this exact path. It does not make the candidate
frontier globally feasible or optimal; scheduler policy and optimizer evidence
remain separate.

## 7. Failure and recovery

Any malformed, stale, incomplete, mixed-transaction or identity-conflicting
input yields a typed non-retryable source error. A caller may retry only after it
opens a new trusted read transaction and creates a new request/component set.
It must not repair mismatched fields or label a partial set as complete.

The implementation has no durable state and no partial write. Failure returns no
snapshot. Cached snapshots must be invalidated when their expiry, source module
binding, read transaction, component generation, policy, schema or implementation
identity changes.

## 8. Evidence and remaining work

`paper-core/tests/snapshot-builder.test.mjs` covers component hash round trips,
order invariance, missing/extra/duplicate components, transaction/epoch splicing,
revision and time bounds, exact source binding, forged hashes, accessors, sparse
and malformed JSON, independent byte limits, immutable capture and composition
with the candidate router.

This is source conformance, not proof of an actual atomic read-only store. Before
`module.snapshot-builder` or `CTL-002` changes state, the project still needs:

- a production composition port from `module.readonly-control` and the module
  registry;
- a named, tested atomic read-transaction implementation;
- machine schema and registry/manifest path alignment;
- exact-head and merge qualification;
- independent protocol/state/evidence review;
- scheduler integration and recovery/revalidation tests.

No static work-item, activation or authority state is upgraded by this source
increment.
