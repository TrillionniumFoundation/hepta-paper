# Single-writer commit sequencer

## 1. Purpose

The commit sequencer is the only path by which a verified prepared result becomes
authoritative campaign state. It preserves global ordering and exactly-once
integration while allowing expensive module work to run concurrently.

## 2. Interface

The sequencer accepts typed commands such as:

```text
CreateCampaign
ClaimNode
RecordPlan
RecordExecutionRelease
IntegratePreparedResult
SettleResources
PauseOrCancel
RecordExternalReconciliation
CompleteCampaign
```

No caller receives a raw writable database connection.

## 3. Commit subject

Every command binds:

```text
command/idempotency ID
control-plane instance and generation
writer lease generation/token
campaign and expected revision
node, attempt, lease generation
plan and snapshot hash
candidate and verified prepared-result hash
resource reservation/settlement identity
policy/objective/module registry versions
current time/deadline rule
```

## 4. Transaction rules

A commit transaction:

1. verifies writer and control-plane generations;
2. loads the exact expected campaign/node state;
3. rejects stale revision, attempt, lease, plan, or reservation;
4. verifies idempotency and prior terminal effects;
5. applies the minimum state/event/projection changes;
6. settles or links resource accounting;
7. appends a hash-linked event/receipt;
8. commits durably;
9. returns a canonical receipt.

Long artifact verification, provider calls, build work, or solver execution never
occurs inside this transaction.

## 5. Idempotency

An exact duplicate returns the original receipt. Same idempotency ID with any
subject difference is a hard conflict. Terminal commands cannot be reopened.

## 6. Batching

Batching is allowed only when commands are independently validated and batching
does not alter visible order or failure semantics. Limits include maximum
commands, bytes, transaction time, and fsync latency.

A batch failure must identify whether zero or all commands committed. Partial
per-command commit requires separate transactions and receipts.

## 7. Writer actor

The initial implementation should own one SQLite connection in a dedicated
thread/actor with a bounded typed queue. This preserves the writer crate's
single-connection semantics without blocking the asynchronous control executor.

Queue overload returns a controlled disposition and triggers planner
backpressure. It does not create a second writer.

## 8. Recovery

Startup audits:

- database identity/schema/integrity;
- writer lease and activation subject;
- idempotency/command journal;
- prepared results awaiting integration;
- resource settlement linkage;
- incomplete external reconciliation;
- event/projection consistency.

Unknown residue disables admission until classified. Restore never adopts a
foreign or partially initialized database.

## 9. Cutover

Node-to-Rust writer transfer requires:

1. stop and prove absence of the Node writer;
2. bind exact database preimage;
3. issue short-lived exact-subject cutover authorization;
4. acquire the first Rust writer lease matching the authorization;
5. run a bounded canary and read-back audit;
6. retain rollback and no-dual-write evidence.

A source implementation or ordinary merge does not activate the writer.
