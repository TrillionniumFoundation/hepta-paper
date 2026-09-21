# Native automation reconciliation

The native service implements the incumbent offline schema-25 business transaction
from `paper-adapters/automation/automation-runtime-reconciler.mjs`. It is reachable
through a guarded local execution command. Both registered online business
callbacks now use the real signed reserve/apply/finalize coordinator privately.
Their concrete runtime activation, production admission and independent route
acceptance remain open.

## Source and entrypoints

Sources are `rust/crates/hepta-paper-service/src/automation_runtime_reconciliation.rs`,
its `offline_execution.rs` and `scoped_execution.rs` children, and the private
`node_package_deletion_writer.rs` guard. The existing read-only command remains:

```sh
hepta-automation-reconcile --database /absolute/runtime/hepta-paper.sqlite \
  --at 2026-07-13T08:00:00.000Z --no-progress-seconds 1800
hepta-automation-reconcile --execute-local /absolute/local-request.json
```

For passive inspection, both `--database` and `--at` are optional. An omitted
database uses nonempty `HEPTA_PAPER_RUNTIME_ROOT`, resolved lexically from the
working directory, then `hepta-paper.sqlite`. Without that variable it uses the
installed workspace sibling `hepta-paper-runtime/native-runtime`; native deployment
relocation is selected by `HEPTA_PAPER_WORKSPACE_ROOT`, with the compiled source
workspace as its default. An explicit database wins over both defaults. Existing
canonical-path/single-link/read-only checks remain mandatory; a missing database
is never created. Without `--at`, standard planning samples ISO and cutoff time
separately from SystemTime; legacy planning samples once after ID syntax validation.
An explicit time keeps deterministic inspection. The legacy mode ignores the
standard no-progress threshold. The original Node CLI and native CLI are compared
using the actual original entrypoint with replayed observed clock samples.

`--execute-local` is a native extension; it is not an alias for unrestricted Node
`--execute`. Its closed `LocalOfflineReconciliationRequestV1` document contains
`version: 1`, `workspaceRoot`, `assetRoot`, `runtimeRoot`, `legacyRoot`,
`writerFence: { writerId, generation, token }`, `noProgressSeconds`, and
optional `now`/`campaignId`/`releaseCommit` and `operation` (default `standard`). Omit `now` to use the real system clock;
supply it only for an explicit fixed-clock execution. The four roots must already exist, be
canonical, owned directories without group/other write permission, and be
pairwise disjoint. The database is always `runtimeRoot/hepta-paper.sqlite` and
must be an owned, private, single-link regular file. Unknown fields are rejected.
The request file is bounded to 1 MiB and opened without following a final symlink.

The writer ID is fixed to `automation-runtime-reconciler-rust`; the operation
scope is `store:automation-reconcile-entrypoint`. A caller must first complete
an explicit local cutover drill with backup/restore and measured shadow comparison
using `DurableCutoverCoordinatorV1`. Execution consumes its existing Canary or
Active epoch. A JSON fence alone grants no authority. The command never creates
enrollment, changes writer ownership, enrolls a production database or activates
production. Planned, rolled-back, stale, wrong-scope and Production epochs fail.

## Admission, ownership and concurrency

The scope checks the embedded Node migration names and SHA-256 values for versions
21–25. Any schema object whose name or owning table begins with
`autonomous_research_online_mutation_` or `autonomous_research_online_authority_`
blocks offline execution, including empty, incomplete and differently cased
objects. Schema and online-object checks run again inside `BEGIN IMMEDIATE`.
Existing online stores require their signed reserve/apply/finalize protocol;
their metadata is never removed or treated as an optional optimization.

Lock order is the Node foundation order: package-deletion repository flock,
durable cutover journal, then application transaction. The Rust guard holds the
same `.hepta-package-deletion-fences/.repository.lock` inode as Node's `flock`.
It validates all fence records and their canonical hashes, rejects every
prepared/deleting fence and a matching deleted operation, and retains directory
descriptors. Symlink, hardlink, mode, content and path replacement checks are
repeated before application, before commit and after the callback.

No raw writable connection or caller-controlled receipt issuer escapes the scope.
The private issuer has only the incumbent `automation-reconciler` policy and
`AutomationRuntimeReconciliationReceipt`/`automation-reconciliation` privileges.
Its 17-column ledger record is administrative `runtime_reconciliation` evidence.
It does not issue scientific, release, provider or production qualification.

## Business transaction and exact outputs

The transaction recovers expired running/leased nodes, pauses no-progress campaigns,
settles terminal queued and active siblings, deletes expired resource leases and
waiters, appends campaign events, and strictly inserts one reconciliation receipt.
Integrating/integrated siblings become `external_outcome_uncertain`; their outcome
is never silently reported as ordinary cancellation. Legacy terminal rows without
the supported settlement policy remain preserved.

Each mutation matches the complete incumbent old-row preconditions and must change
exactly one row: campaign revision/status/stop reason; node revision, attempt,
owner, generation, expiry and integration state; no-progress child counts; and
all selected resource fields. SQLite errors, stale rows, duplicate events or
receipts, and lost precommit admission roll back every earlier transition.
Rust process death before commit is recovered by SQLite without partial state.

Event, failure and receipt JSON retain incumbent field order and bytes, including
the production record hashes and fixed issuer policy hash. The result envelope
has kind `LocalOfflineAutomationRuntimeReconciliationExecution`, contains the
Node-compatible receipt under `reconciliation`, and reports
`productionActivation: false` and `nodeRetirementVerified: false`.

Ordered wire encoding is fallible. Encoding or numeric conversion failures
propagate as row errors through both offline and online callbacks before their
transaction can commit; no empty JSON field or panic substitutes for a failed
encoding. The existing field order, ECMAScript number spelling and digest input
bytes remain the compatibility contract.

Both planners reject SQLite INTEGER values outside JavaScript's exact range
(-9,007,199,254,740,991 through 9,007,199,254,740,991), matching the Node reader's
rejection before hashing. Otherwise distinct integer CAS values could alias to
the same binary64 plan/receipt hash. Active, queued and parent integer fields
are tested at and beyond both boundaries. SQLite INTEGER affinity does not
ensure integer storage: text generations/revisions are converted with the
incumbent scalar `Number(...)` rules, including ECMAScript whitespace, decimal and
radix grammar and binary64 rounding. Invalid numeric text cannot become a matching
text CAS parameter and authorize a write; actual Node/Rust rejection tests cover
both offline and online transactions.

Replay is not an upsert. Repeating an identical clean execution at the same fixed
clock collides with its strict receipt ID. Live execution preserves the six Node
observations in order: plan ISO time, plan cutoff time, reconciled time, ledger
creation time, then after-plan ISO and cutoff times after commit. Fixed-clock
requests retain their deterministic behavior. The clock is synchronous and does
not grant authority; this business clock adds no monotonicity policy that Node
does not enforce. A clock failure before commit leaves the transaction untouched;
a failure during the after-plan observations occurs after durable commit, so an
error alone never proves that replay is safe.

An error beginning `reconciliation_committed_scope_verification_failed` means the
business transaction committed before final path/scope validation failed. Inspect
the retained database and ledger before retrying. A post-commit diagnostic error
must not be interpreted as proof of rollback.

## Legacy terminal active residue mode

Use `--legacy-terminal-active-residue --campaign-id ID` with the read-only plan
command, or set request `operation: "legacy_terminal_active_residue"` for guarded
local execution. This selects the v0 planner before admission; the standard v1
campaign gate is not run against a legacy campaign. The implementation is
`automation_runtime_reconciliation/legacy_terminal_residue.rs`, with the same
private issuer, package fence, schema checks and durable epoch as standard mode.

A campaign ID is mandatory. Its parent must already be failed, cancelled, stopped
or completed, and its policy must be missing or exactly JSON integer zero.
String zero, real zero, null and booleans are rejected. Every remaining active
node must have an expired lease and must not be integrating/integrated. Any
resource lease/waiter tied to the campaign or one of its nodes blocks settlement,
even if expired or attached to another campaign ID. Parents, queued history and
unrelated campaigns are preserved; eligible active children become skipped.

The preserved queued-state digest streams 512-row keyset pages with Node's exact
domain prefix, UTF-8 byte-length framing and ordered JSON. It is an observation:
the incumbent transaction checks queued count, not equality of that digest. A
same-count queued update may remain visible while settlement commits; the native
code deliberately does not claim a stronger hash fence. Exact node/parent fields,
active/queued counts, policy and coordination absence are checked transactionally.
Event and 17-column receipt insertion remain strict and atomic. The receipt uses
version 3 with evidence class `legacy_terminal_active_residue_settlement`.

Legacy time sampling follows its own three observations: plan time (also settlement
time), ledger creation, then after-plan time. Re-executing after the active residue
is gone rejects `nothing_to_settle` without appending a receipt. Tests cover real
Node plans, full table and persisted JSON equality, 0/512/2,538 queued rows,
policy/lease/resource rejection, stale rows, collisions, crash rollback, separate
clocks, read-only CLI and typed execution selection.

Node's broad V8 `Date.parse` compatibility is not fully ported. Canonical UTC,
ISO date-only and explicit ISO offsets/fractions are supported; timezone-less
and unsupported legacy/RFC spellings fail closed. Hour 24 accepts only an entirely
zero raw fraction; nonzero digits beyond millisecond precision must be rejected
before truncation, matching V8. A real Node test with
`TZ=Asia/Shanghai` proves that the native gate never silently interprets a local
time as UTC. This input compatibility gap remains open and blocks claiming
complete parity for the legacy mode.

## Private signed online business path

`online_execution.rs` fixes the writer ID to
`writer:native-store:automation-runtime-reconciler:v1` and the two registered
standard/legacy operation IDs. Child `offline_execution/online.rs` and
`legacy_terminal_residue/online.rs` prepare source-owned events and 17-column
receipts, then use only `RestrictedMutationTransactionV1` statement IDs. The
callbacks never execute raw SQL or accept caller-owned receipt authorization.
The real coordinator verifies metadata, plan/writer hashes, signed current head,
reservation and finalization, and captures the actual business/ledger changeset.

The online registered predicates intentionally differ from the offline SQL:
standard pause is running-only, some row guards are narrower, resource deletion
uses the exact resulting counts, and legacy queued state remains count-fenced.
Competing-write fixtures compare these actual Node predicates rather than
silently strengthening them or reusing offline SQL. Both paths preserve the
source-owned receipt issuer and exact persisted event/receipt JSON.

Three source-private checks are distinct: before application, after application,
and the genuine precommit check after signed reservation and local marker insertion.
`execute_mutation_with_precommit_guard_v1` runs the final guard before the final
lease-time observation and COMMIT. A rejected guard rolls back all business and
marker rows and attempts a signed abort. An unwind rolls back locally; it does
not prove the remote reservation was aborted. Existing public coordinator calls
retain their original clock sequence through a no-op guard.

Coordinator fatal/deferred/retryable errors are preserved. If the business
clock/after-plan fails after successful finalization, the returned error carries
`committed: true`, reservation ID, reservation receipt hash and finalization
receipt hash. Such an error must not be retried as though no transaction occurred.

This core is private and deliberately has no constructor accepting a writable
connection or readiness JSON as production authority. It is not an online CLI
activation. The missing owning composition must retain concrete process authority
transports, resident lease, source/static/schema/startup/finalized inventory/cache
proofs, package/database identity and the same concrete shared recoverability
fence used for feedback. Feedback alone never proves the epoch is current. A
transaction-aware final guard must distinguish expected target writes from
unrelated scope replacement; comparing an old database byte hash after valid DML
would incorrectly reject every mutation. Restart after prior writes also needs
the signed historical schema-audit-to-current-finalized-history bridge. Successful
writes or pending finalization invalidate frozen proofs until refreshed. Existing
Node static-callsite coverage does not establish native callback coverage.

## Verification and remaining integration

Tests invoke the actual pinned Node v22.23.1 implementation and issuer broker on
schema-25 copies. They compare complete table snapshots and exact persisted JSON,
exercise late event/receipt collisions and stale row fields, kill a child process
after all DML before commit, and verify Node/Rust flock exclusion in both
directions. Admission tests cover the successful writer, stale/rolled-back epochs,
wrong Canary scope, tampered history, online metadata, root aliases, hardlinks,
FIFOs and Production rejection. Advancing, backward and negative-epoch clock
fixtures compare actual Node observations, hashes, receipt/event text and all
rows, including each of the six clock failure positions. The CLI test compares the complete receipt and
proves a later rollback invalidates the serialized request.

From `rust/` with the actual pinned Node executable on `PATH`:

```sh
cargo test --locked -p hepta-paper-service --lib automation_runtime_reconciliation
cargo test --locked -p hepta-paper-service --lib node_package_deletion_writer
cargo test --locked -p hepta-paper-service --test automation_runtime_reconciliation_parity
cargo test --locked -p hepta-paper-service --test automation_reconciliation_default_cli
cargo test --locked -p hepta-paper-service --lib precommit_tests
cargo test --locked -p hepta-paper-service --test sqlite_mutation_coordinator_parity
```

Remaining source work includes the native production signed subject's binding to
this exact writer/epoch/operation scope, complete writable CLI/activation composition,
full legacy Date.parse compatibility, and the retained online admission/lifecycle path. The
existing cutover preimage hash can recognize Node SQLite bytes; schema format is
not the reason production is disabled here. Production must not be enabled merely
by observing a past coordinator `production_activation` flag. Target-host execution,
independent acceptance, full branch convergence and Node retirement evidence also
remain required. No program-truth acceptance or external principal is changed by
this implementation; exact source changes invalidate prior qualification bindings.
