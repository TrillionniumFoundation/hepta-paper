# Codex external-operation journal

## Purpose

A Codex call is not a normal function call. It may consume provider resources,
incur cost, mutate an attempt workspace, outlive its parent process and finish
while the campaign core is unavailable. The journal answers whether an
operation was reserved, spawned, observed, validated, prepared and acknowledged.

The journal is broker-owned and separate from the campaign database. It cannot
grant campaign authority.

## State graph

```text
reserved
  -> request_bound
  -> process_spawned
  -> event_stream_started
  -> terminal_event_observed
  -> final_output_captured
  -> schema_validated
  -> workspace_snapshotted
  -> mutation_validated
  -> result_prepared
  -> acknowledged
```

Terminal failure states:

```text
rejected_preflight
failed_before_spawn
cancelled_before_spawn
failed_after_spawn
timed_out_after_spawn
terminal_failure
event_stream_invalid
output_schema_invalid
mutation_policy_violated
result_ambiguous
```

The Rust `hepta-codex-journal` crate is the normative transition table. The
future SQLite adapter may persist it but may not invent additional transitions
without a version change.

## Operation, attempt and recovery identity

Three identities must not be conflated:

- an **operation** is one immutable broker journal and one idempotency identity;
- an **attempt** is one campaign-node execution attempt and may contain a new
  operation only when provider action and workspace side effects were ruled out;
- a **campaign revision/generation** fences whether a prepared result may still
  be integrated.

A terminal operation is never reopened. Retrying after a terminal pre-spawn
failure allocates a new operation ID in the same campaign attempt. Once provider
action may have started, recovery allocates a new campaign attempt unless a
future versioned reconciliation protocol proves a stronger result.

## Persistence schema v1

Recommended tables:

```sql
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  current_state TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  provider_action_may_have_started INTEGER NOT NULL,
  prepared_receipt_hash TEXT,
  CHECK (provider_action_may_have_started IN (0, 1))
);

CREATE TABLE operation_transitions (
  operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  recorded_at_unix_ms INTEGER NOT NULL,
  evidence_hash TEXT,
  reason_code TEXT,
  PRIMARY KEY (operation_id, sequence),
  FOREIGN KEY (operation_id) REFERENCES operations(operation_id)
);
```

Production schema adds strict application validation, SQLite integrity checks,
WAL policy, synchronous durability policy and migration receipts. Secrets,
prompts and raw manuscript content are excluded.

## Transaction rules

- reservation and idempotency insertion are one transaction;
- process spawn is preceded by a durable `request_bound` state;
- `process_spawned` records process-start identity immediately after spawn;
- each transition uses compare-and-swap on current state;
- successful milestone transitions carry a bound evidence hash;
- failure terminal transitions carry a bounded lowercase reason code;
- prepared receipt bytes are durably stored before `result_prepared` commits;
- campaign acknowledgement is recorded only after the campaign writer confirms
  integration;
- no transition is deleted, rewritten or appended after a terminal state.

## Recovery

| Persisted state | Recovery |
|---|---|
| `reserved`, `request_bound` | resume the same nonterminal operation if capability/deadline remain valid |
| pre-spawn terminal failure | allocate a new operation ID in the same campaign attempt |
| `process_spawned`, `event_stream_started` | reconcile process; absent trustworthy terminal means a new campaign attempt |
| `terminal_event_observed` through `mutation_validated` | resume deterministic local validation, never call provider again |
| `result_prepared` | integrate the existing receipt/result without provider re-execution |
| `acknowledged` | complete; duplicate request returns the same result identity |
| post-spawn terminal failure or ambiguity | start a new campaign attempt under policy |

Recovery never changes an ambiguous post-spawn operation into “not started,”
and no recovery action mutates a terminal operation journal.

## Cost and usage treatment

- before provider action is possible, usage is `not_applicable` and cost is
  `not_incurred`;
- after provider action may have started, missing usage is `unknown`, never zero;
- a recognized terminal event without usage is `not_reported`;
- after-spawn operations retain a conservative reservation until measured usage
  or provider reconciliation is available;
- duplicate operation lookup returns the original state and cannot create a
  second provider process.

## Integrity

On startup the broker validates:

- database integrity and foreign keys;
- monotonically increasing transition sequences and timestamps;
- legal transition graph;
- operation current state equals the last transition;
- request/idempotency uniqueness;
- required evidence hashes and failure reason codes;
- prepared receipt hash and file identity;
- no terminal state has outgoing transitions.

Any violation disables spawning and enters operator recovery mode.

## Fault-injection matrix

Required kill points include:

```text
after reservation
before/after request binding
immediately before/after spawn
before process identity commit
after first JSONL byte
after terminal event
before/after final output capture
before/after schema validation
before/after workspace snapshot
before/after mutation validation
before/after prepared receipt fsync
before/after campaign acknowledgement
```

Each point must recover to exactly one documented disposition.
