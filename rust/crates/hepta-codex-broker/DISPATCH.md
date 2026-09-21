# Qualified Codex dispatch

`run_reserved_codex_operation` is the executable broker boundary. It takes an
operation ID already reserved by authenticated Unix admission. It reloads and
hash-checks the immutable canonical request from the broker journal. The network
request does not supply arbitrary executable, argument, environment, or shell
surfaces.

The caller supplies an exact inspected runtime, role, prepared workspace and
control files, restricted environments, limits, gate policy, containment policy,
clock, cancellation flag, and a `CodexDispatchAuthorityV1` implementation. That
implementation must validate the deployment's independently accepted external
qualification, current attempt/lease, immutable input/workspace and mutation
bindings, distinct role principal/home, and budget. It runs before spawn, before
release, and before output acceptance. There is no default permissive authority.
The public entry also rejects fixture schema authority, fixture gate authority,
process-group-only containment, and fixture cgroups, regardless of callback result.

A broker process executes under its configured role UID; this API does not change
UID or share an author credential home with a reviewer. Production executable
ownership must differ from the execution principal. The runtime's executable,
config, home and credential metadata are inspected before and after execution.
The official noninteractive Codex argv and prompt are constructed by
`build_codex_invocation`; its prompt hash must equal the signed request hash.

## Lifecycle and failures

1. Validate request/runtime/role/prompt, preflight schema, deadline and authority.
2. Commit `RequestBound`, create a bounded operation cgroup, and fsync its recovery
   record in the private gate state directory.
3. Spawn the stopped pre-exec gate (armed with parent-death SIGKILL and an exact
   parent-PID check), attach its PID to the cgroup, durably link the
   exact process identity, recheck bindings and authority, and commit release
   authorization before continuing the gate.
4. Supervise actual target execution with bounded input/output, an execution
   timeout tightened against the remaining absolute deadline, and cooperative
   cancellation. Terminate descendants and prove group and cgroup cleanup.
5. Reinspect runtime/schema/output control identities. Read exact output file
   descriptors, hash the actual bytes, and fsync immutable stdout/output evidence
   before advancing deterministic result processing.
6. Decode complete JSONL, require a successful terminal turn, parse the actual
   final JSON, and validate its bound schema. Success ends at `SchemaValidated`.

A cancelled or ambiguous released execution is never automatically replayed.
A repeated operation ID is refused by dispatch and remains queryable in the
journal. The API deliberately does not assert `WorkspaceSnapshotted`,
`MutationValidated`, `ResultPrepared`, `Acknowledged`, campaign-write or submission
authority: those require independent workspace/mutation and commit attestations.

`codex-result-<operation>.json` is a bounded durable evidence artifact containing
request/runtime/argv identities and actual captured stream/output bytes (hex).
Consumers must compare its request and evidence hashes with the journal. The
artifact is created exclusively and never overwritten. It is evidence for local
recovery; it is not a signed prepared-result receipt.

## Restart containment

`recover_codex_dispatch_containment` must run before generic process
reconciliation and listener readiness. It validates the private record's exact
journal request binding and the cgroup root/operation device and inode plus the
operation directory change timestamp. It kills
and removes only the bound cgroup; a replaced directory blocks recovery instead
of adopting untrusted PIDs. Cleanup is idempotent when the bound directory is
already absent. The process journal then applies its existing conservative
release/ambiguity recovery rules.

`create_quiesced_codex_dispatch_backup` obtains an exclusive lock against all
qualified dispatches, refuses active journaled processes, unreconciled containment
records and launch envelopes, copies the SQLite journal and all durable result
sidecars, and verifies the source journal and sidecar identities did not change.
A completed Codex operation with missing result evidence cannot be backed up.
The final `manifest.json` pins every copied file's bytes/hash and the logical
journal fingerprint. An interrupted directory without that manifest is incomplete.

`restore_quiesced_codex_dispatch_backup` requires the independently retained
manifest hash and a fresh destination. It checks database and sidecar hashes,
request bindings, the restored journal fingerprint and absence of active process
state. The output contains `journal.sqlite` and `state/`. It does not restore or
adopt cgroups, process IDs, provider credentials, runtime authority or listener
readiness. Every receipt states `requiresRequalification: true`; source target
bindings and ambiguous operations remain subject to the normal external checks.

The older journal-only `create_broker_backup` now rejects active process records,
`RequestBound` dispatches, and all provider-action history (including ambiguous
recovery), which must use the complete bundle path. Its checks run on both the source and the captured snapshot. Bundle
creation uses a private journal-copy path only while exclusive dispatch quiescence
and sidecar checks are held. Recovery takes the same exclusive lock, so it cannot
kill a concurrently executing operation.

`BrokerServerV1::with_dispatcher` installs a `BrokerOperationDispatcherV1` adapter.
Its `recover_before_ready` composes containment recovery; `dispatch` resolves local
bound inputs and calls the qualified API. Only fresh reservations are dispatched.
Without an adapter the server continues to provide admission/reservation only.

## Journal schema identity and bounded admission

`BrokerJournalStoreV1::open` checks the actual stored schema on its read-only
preflight connection before creating a writer connection or applying persistent
pragmas or querying caller-controlled metadata tables/views. Interrupted
initialization uses the same literal-prefix rule and refuses a foreign schema
without consuming the initialization marker. The closed object inventory and five STRICT tables are necessary but
insufficient: each table and trigger now also matches `type`, `name`, `tbl_name`
and the complete stored SQL definition produced by the compiled `SCHEMA_SQL` in
a fresh in-memory SQLite database. No source SQL is executed to construct that
reference. At most 20 rows are read, with 256-byte fields and a 64 KiB SQL limit
per definition. The literal reserved `sqlite_` prefix is excluded; a name such as
`sqliteXforeign` is an extra object and is refused.

This exact comparison preserves the SQLite normalization of the existing compiled
schema and rejects changed trigger bodies, CHECK constraints, foreign keys,
column definitions and differently formatted replacement definitions. It does
not silently migrate, repair, adopt, or restamp an existing database. The same
check runs through explicit integrity validation and the existing backup/restore
contract consumers. `BrokerJournalError::SchemaDefinitionMismatch` is a new
public error variant; downstream exhaustive matches must handle it. The error
contains no untrusted SQL or database content. Current schema and wire versions
are unchanged. A check is an observation at that boundary, not continuous
protection against a separately authorized writer changing the database later.

The socket admission reader uses one monotonic elapsed-time budget across the
complete frame header and body; successful partial reads do not reset it. The
actual server samples its clock and trust state after the complete frame is read
and uses that time for capability verification and reservation. Explicit-time
library APIs retain their caller-supplied-time contract. These checks do not yet
resample time after SQLite `BEGIN IMMEDIATE` waits; transaction-wait freshness is
an additional integration requirement. They grant no installed host, runtime,
provider, process identity or production activation authority.

Focused source regressions replace every one of the 14 actual append-only
triggers, weaken an actual table constraint, alter a trigger's target table,
exercise oversized definitions and reserved-prefix lookalikes, and reopen an
unchanged journal with real persisted history. The read-only refusal tests
compare the actual source bytes and require no new sidecars or initialization
marker. Real socket and signed-request tests cover the admission time boundary;
these local tests remain distinct from independent host/provider qualification.

## Output schema contract

The bounded local schema validator supports boolean schemas, object/array/string/
number/integer/null/boolean types (including type arrays), `properties`, `required`,
`additionalProperties`, `items`, `const`, `enum`, `allOf`, `anyOf`, `oneOf`, length/
item/property bounds, numeric bounds and `uniqueItems`. It accepts draft-07 and
2020-12 dialect labels for this shared subset. Unsupported keywords, references,
regexes and unknown dialects fail preflight. Nested schema and output evaluation
have fixed depth/work budgets; large mixed integer/fraction comparisons beyond
exact float range are rejected. No unsupported assertion is silently ignored.
Captured complete JSONL is capped by the configured tail capacity (at most the
runtime's 1 MiB hard bound); exceeding that limit fails the execution.

## Verification

Build the workspace `hepta-codex-preexec-gate` binary first. Unit tests execute a
credential-free deterministic local CLI through the same gate path, validate
actual output and durable journal transitions, reject fixture production/role/
prompt/schema drift, verify runtime-config drift becomes ambiguous, cancel an
already released process, and recover exact fixture cgroup identities. The
fixture execution entry and allowing authority exist only under unit-test control;
these tests do not constitute live-provider or production-host qualification.
