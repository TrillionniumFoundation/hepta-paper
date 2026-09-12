# Local workflow execution and recovery

This is the current engineering handoff for `hepta-paper-service::workflow` and
`hepta-local-workflow`. It implements sequential/topologically ordered local and
shadow orchestration, not complete Node campaign parity or a production daemon.
No module, work item, qualification or activation is promoted by this document.

## Entry points and actual call chain

`initialize_local_workflow_v1` validates a closed `LocalWorkflowV1`, creates a NEW
private directory and the existing local-only campaign SQLite database, binds its
control stream, and fsyncs the immutable definition. It returns a definition digest.
`operate_local_workflow_v1` revalidates that externally retained digest, takes a
nonblocking cooperative lock, reads a consistent campaign snapshot, replays the
control log, verifies every saved step plan and actual CAS byte, and only then
admits a command. State and budget come from SQLite, not a workflow cursor file.

For a new step the call chain is:

```text
prior committed result -> hash-verified CAS bytes -> explicit JSON-pointer binding
-> NativeJobV1 decode and capability validation -> current snapshot and candidate
-> fsynced immutable step configuration -> run_service_v1
-> registry / policy / planner / allocator / ServiceExecutorV1
-> native kernel OR exact executable/code-bound local process
-> prepared results -> independent content verifier -> SQLite commit sequencer
-> read-only chain recomputation -> optional exact-subject routing gate
```

This is actual output chaining. A field from a preceding result is never replaced
by a pre-authored pretend result. The bundled example runs empirical aggregation,
propositional checking and linear solving; embeds their actual bytes in a
manuscript; reviews those exact manuscript bytes; builds a bundle containing the
actual outputs; and prepares a local submission record. The example does not run
models, discover science, execute general experiments or submit externally.

## Closed wire contracts

`LocalWorkflowV1` contains `version:1`, `template:ServiceRunV1` and `steps` (1–128).
The template has an empty frontier, revision one, the initial state hash, exact
canonical registry JSON, policies, capacity, budget and a local writer lease.
All authority booleans remain false. Each `WorkflowStepV1` carries an ID, module,
capability, complete resource vector, cost, job template, 0–32 bindings and an
optional gate. Rust derives reject unknown fields on every typed boundary.
The complete definition, record and input are at most 16 MiB. Individual inputs
also remain subject to the smaller native/process worker limits.

Each binding specifies `fromStep`, canonical-artifact `artifactIndex`,
`targetPointer`, and `encoding` (`utf8`, `json`, `digest`). Only prior steps may be
referenced; duplicate/overlapping targets, invalid JSON-pointer escapes, absent
locations and modification of the native job discriminator are rejected. Targets
are under `/job/`, `/input/`, or `/artifacts/`. All substituted input is decoded
again as `NativeJobV1`; the admitted native capability must match the typed job.

A gate requires one JSON artifact, an `acceptedPointer` boolean, and a
`subjectHashPointer` equal to the selected prior artifact. False blocks every
later step, including packaging. Missing fields, wrong types or another subject
are integrity errors. A true routing boolean is not authenticated scientific
review, independent principal evidence, release permission or submission consent.

Resources are conservatively summed across the entire immutable definition;
checked arithmetic and the initial capacity/budget bound prevent composition of
individually valid steps into an over-budget workflow. Memory sums are deliberately
conservative, not measured peaks. Worker accounting remains the existing admitted
upper-bound accounting, not OS resource metering. Provider calls, external actions
and central-writer requests in step vectors must be zero in this local surface.

## Command examples

The step definitions consumed by the Rust tests are in
[`examples/local-workflow-steps.v1.json`](examples/local-workflow-steps.v1.json).
The template must bind the actual local native implementation digest or an exact
trusted-process executable/configuration; the test builder demonstrates both.

```sh
cargo build --manifest-path rust/Cargo.toml --locked -p hepta-paper-service
hepta-local-workflow init /absolute/definition.json
hepta-local-workflow status /absolute/new-state sha256:<returned-definition-digest>
hepta-local-workflow advance /absolute/new-state sha256:<digest> 3 1100
hepta-local-workflow pause /absolute/new-state sha256:<digest> 3 1200
hepta-local-workflow resume /absolute/new-state sha256:<digest> 4 1300
hepta-local-workflow advance /absolute/new-state sha256:<digest> 7 1400
```

The example clock and revision values are disposable test values, not production
configuration. Real callers read the current revision and provide an explicit
monotonic clock within the admitted local lease. `advance` uses an ABSOLUTE target
step count: retrying target 3 never means execute three additional steps. Pause,
resume and cancel bind the expected campaign revision; repeated identical state
transitions are idempotent only at the immediately resulting revision. Cancelled
and completed campaigns cannot reopen. Status works after lease expiry without
acquiring a writer; SQLite may coordinate existing WAL readers, so this is not an
immutable-file inspection guarantee. CLI errors never echo confidential input.

## Persistence, failures and reconciliation

`workflow.json` and `step-NNNN.json` are immutable recovery inputs, mode 0600 in a
canonical mode-0700 root. The root must be absent on initialization. Initialization
failure retains an orphan instead of adopting an existing database or deleting
unknown state. The lock is nonblocking and bound to a regular private inode.
This is cooperative same-principal integrity, NOT hostile same-UID isolation.

A step configuration is fsynced before the service's durable dispatch intent.
A crash before invocation may replay that same plan. A prepared result can resume
through the existing byte-verified cache. A committed result advances only through
the original SQLite log, without re-execution or a second debit. Started work with
no complete prepared result remains ambiguous and cannot automatically retry.
Saved plan mutation, CAS corruption, missing objects, unknown journal entries,
changed definition, stale revisions and clock rollback fail closed. Read-only
status never repairs missing artifacts. Cancel may stop later dispatch but does
not erase ambiguity or refund uncertain work.

Pause/cancel are BETWEEN-STEP operations: concurrent commands return busy while an
advance is running. This API does not promise immediate in-flight cancellation.
The core sequencer now rejects paused/cancelled/completed campaigns at begin_run,
before any new executor dispatch; late SQL rejection alone is insufficient.
A rejected review cannot be resumed into a passing review by toggling lifecycle.
Appending steps, adding a structural revision round, renewing an unexpired local
lease or increasing budget now requires the explicit, event-bound amendment API
in [WORKFLOW_AMENDMENT_HANDOFF.md](WORKFLOW_AMENDMENT_HANDOFF.md). Lifecycle toggles
alone never alter the definition or clear a rejection.

## Verification and scope of evidence

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test local_workflow
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-control-plane -p hepta-campaign-writer
```

The workflow suite executes all seven exact document examples, native and actual
Rust subprocess chains, real SQLite/CAS recovery, process death after COMMIT,
non-reexecution of an ambiguous failed subprocess, pause/resume/cancel, absolute
retry, stale revision/clock/lease rejection, tampered saved plans, corrupt/missing
objects, incorrect review subjects, negative gates, CLI boundaries and lock/path
rejection. Public control-log replay returns ordinary historical receipts; it
never creates a production verified-result capability or writer grant.

## Node migration mapping and remaining work

The closest existing Node surface is `operator campaign`, but only local progress,
status, pause/resume/cancel semantics are source candidates here. The CLI syntax,
active schema, role evaluation, runtime scheduling and
external effects are not claimed equivalent. No per-command parity row is promoted.
The original 57 command routes and all argument-dependent modes remain the audit
inventory, not seven local-kernel jobs.

Next implementation work is actual authorized author/reviewer broker integration,
model-driven revision and repair rounds, experiment/runtime and manuscript compilation
adapters, full operator/maintenance mapping and accepted capability replay. Remote
credentials, target-host isolation, private historical corpus, storage soak,
release/submission receipts, production shadow/canary, writer transfer and Node
retirement remain independently controlled requirements.


## Explicit amendments and structural revision rounds

The current local extension/renewal/budget and structural repair APIs are specified
in [WORKFLOW_AMENDMENT_HANDOFF.md](WORKFLOW_AMENDMENT_HANDOFF.md). They retain the
original immutable definition and all committed results. They do not provide live
model author/reviewer integration, in-flight cancellation, production resource
metering or automatic business equivalence.


## Local operational read commands

These commands project the existing local-only database and verified CAS history;
they do not introduce another campaign registry, writer or log database:

```sh
hepta-local-workflow list LIST_REQUEST
hepta-local-workflow events STATE HASH EVENTS_REQUEST
hepta-local-workflow logs STATE HASH OFFSET LIMIT
hepta-local-workflow slo STATE HASH
```

`list_local_workflows_v1` accepts version 1 and 1–128 explicit `{stateDirectory,
definitionHash}` references. Roots must be distinct canonical private directories.
A missing, busy, aliased, corrupted or stale entry rejects the entire response.
Entries retain request order, omit host paths and writer tokens, and are separately
consistent; `atomicAcrossWorkflows=false`. There is no host-wide discovery.

`inspect_local_workflow_v1` verifies the original definition, amendments, saved
plans, receipts and actual CAS bytes under the existing cooperative workflow lock.
It does not acquire a writer lease. Inspection remains available after lease
expiry. It never recreates missing artifacts or performs lifecycle recovery.

| Command | Input | Output and boundary |
|---|---|---|
| `events` | Closed JSON `{action:"events", cursor:null, limit:2}`; limit 1–256. Supply the returned `nextCursor` for another page. | Hash-only SQLite event metadata. Cursor binds campaign, last delivered global sequence/hash and frozen snapshot sequence/hash. Events appended later stay outside that page series. Altered/deleted anchors or a corrupt chain fail closed. Filtering a campaign can leave global sequence gaps. Full-chain verification is capped at 100000 events, not a production retention strategy. |
| `logs` | Absolute zero-based committed-step offset 0–128 and limit 1–256. Offset beyond current committed history fails. | Actual result/committed-state/artifact hashes and charges; `nextOffset` is null at end. No raw worker stdout, prompts, manuscript text or Node log-filter equivalence. |
| `slo` | Exact active definition hash; no extra arguments. | Verified progress, spent/remaining budget, pending plan, structural gate and amendment counts. `productionSloQualified=false`: no invented uptime, latency percentile or production error-budget claim. |

The closed [inspection request schema](schemas/local-workflow-inspection-request-v1.schema.json),
[response schema](schemas/local-workflow-inspection-response-v1.schema.json),
[list request schema](schemas/local-workflow-list-request-v1.schema.json), and
[executable requests](examples/local-inspection-requests.v1.json) are part of this
version. JSON uses snake_case action/kind values and camelCase object fields.
Commands read at most 16 MiB of request bytes and reject unknown fields, links at
the request leaf, invalid limits and mismatched query kinds. Filesystem, busy,
definition and history errors use the existing redacted `WorkflowError` classes;
CLI rejection emits no partial JSON or user-supplied diagnostic text.

SQLite can coordinate existing WAL readers; read-only does not mean immutable
sidecar bytes. Same-UID arbitrary writers remain within the existing trusted
local boundary. These projections are not authenticated event provenance,
production monitoring or independently accepted Node parity.

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-campaign-writer local_event_
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test local_workflow
node --test paper-core/tests/module-work-state-projection.test.mjs
```

The workflow tests import the exact documented requests, execute real kernels
and SQLite operations, validate real responses against the committed schemas,
and invoke the actual CLI binary. Storage tests include cursor filtering,
corruption, sequence relabeling, marker denial and unsafe paths. No activation,
cutover, full parity or Node-retirement state is advanced by these tests.
