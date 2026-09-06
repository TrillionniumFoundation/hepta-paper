# Planning snapshot read session

## 1. Purpose

`paper-application/orchestration/planning-snapshot-session.mjs` acquires every
required planning component through one explicit read-session port and then calls
the existing snapshot builder. It closes the source gap between callers supplying
arbitrary component records and a bounded source path tied to one declared read
transaction and consistency epoch.

It does not create database atomicity, mutate state, hold writer/provider
credentials, qualify source modules or grant production authority. The supplied
read port must itself implement the declared transaction semantics.

## 2. Session ownership

The trusted `PlanningSnapshotReadPortV1.open()` call is synchronous. A successful
return transfers one `PlanningSnapshotReadSessionV1` to the collector. Its
transaction hash and epoch must equal the request before any component read.

Asynchronous session opening is unsupported. This avoids accepting a timeout
while an unresolved open operation later creates an unowned session. A port owns
all resources until it returns a valid synchronous session.

Once accepted, the collector owns the session and calls `close()` exactly once on
all success and failure paths. A snapshot collection receipt is returned only
after close completes. Close failure or timeout denies the result. `sessionClosed:
true` records completion of the port method; it is not independent proof that a
remote database, process or descendant physically stopped.

## 3. Exact request and module coverage

The request binds:

```text
snapshotRequestId
readTransactionHash
consistencyEpoch
deadline
required component IDs and kinds
minimum revisions
maximum age and payload bytes
```

Module bindings are current exact module/version/qualification records with
projection kinds. Every required component kind must resolve to exactly one
binding, and every supplied binding must be used. Missing, ambiguous, duplicate
or unused bindings fail before `open()`.

## 4. Component reads

Each component read receives the same immutable request and request hash, its
exact requirement and module binding, plus a cancellation signal. The response
must be a complete, non-authorizing `PlanningSnapshotComponentResponseV1`.

The contained `PlanningSnapshotComponentV1` is reconstructed and rehashed. It
must bind component ID/kind, source module/version/qualification, transaction,
epoch, revision, generation, capture/expiry times and payload. The existing
snapshot builder then independently checks full coverage, freshness, minimum
revision, payload byte limits, common transaction/epoch and aggregate limits.

No partial component set can form a state snapshot.

## 5. Bounds, failure and cancellation

Defaults and hard maximums are:

```text
component concurrency: 4 / 64
component timeout: 10 seconds / 600 seconds
session close timeout: 10 seconds / 600 seconds
components and module bindings: 256
component payload: 16 MiB before tighter request/builder limits
```

One component failure or timeout aborts sibling reads, waits for their bounded
collection wrappers to settle, closes the session and rejects. Raw port errors and
causes are not exposed. Outer cancellation uses a propagation-resistant abort
subscription.

Timeout or cancellation does not prove an uncooperative in-process read stopped.
The session close contract must reconcile such reads. Untrusted or remote readers
require a process/transport implementation with its own termination and recovery
evidence.

## 6. Receipt

`CollectedPlanningStateSnapshotV1` binds:

- snapshot request, transaction and epoch;
- component count and ordered component payload hashes;
- final state snapshot hash;
- successful session-close method completion;
- authority fields fixed to false;
- the complete immutable `PlanningStateSnapshotV1`;
- a canonical collection hash.

This receipt is content and lifecycle evidence for the supplied port. It is not a
writer lease, module qualification, external authorization or proof of physical
transaction isolation.

## 7. Verification

`paper-core/tests/planning-snapshot-session.test.mjs` covers:

- complete same-session collection and immutable receipt;
- read concurrency;
- one-read failure with sibling abort;
- timeout and propagation-resistant outer cancellation;
- transaction/epoch and component/module/qualification binding;
- unsupported asynchronous open;
- partial/authorizing responses;
- existing builder revision/freshness/payload enforcement;
- ambiguous and unused bindings before open;
- close failure and combined collection/close failure;
- accessor rejection before port execution.

Closed schemas cover component responses and the collection receipt. Runtime
rehashing remains responsible for cross-field equality that JSON Schema cannot
express.

## 8. Remaining work

Before CTL-002/G3 can close, the project still needs:

- an actual readonly-store adapter implementing atomic session semantics;
- crash and transaction-loss recovery evidence;
- integration into the collected bounded planning pipeline;
- current module qualification and revocation checks at port resolution;
- Rust implementation or reviewed compatibility decision;
- target-host concurrency, latency and resource evidence;
- exact-head/merge qualification and independent review.

No module/work-item state or authority changes in this source increment.
