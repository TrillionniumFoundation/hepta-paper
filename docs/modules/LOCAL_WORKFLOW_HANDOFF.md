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
configuration. Real callers read the current revision and use the live-clock owner within the
admitted local lease. An explicit timestamp is a deterministic local drill, not
a monotonic host clock or a trusted-time attestation. `advance` uses an ABSOLUTE target
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
advance is running. The ordinary lifecycle API does not promise immediate in-flight cancellation;
the autonomous CLI signal path below interrupts its currently supervised process group.
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
model-driven revision and repair rounds, qualification of scientific/runtime and
manuscript compilation adapters, full operator/maintenance mapping and accepted
capability replay. Remote
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

`hepta-local-workflow cancel-node STATE HASH STEP_ID REVISION [NOW]` is the
bounded compatibility path for the incumbent node-cancel command. The local
topology is strictly sequential: a committed step is already terminal and
replays as an unchanged no-op; an uncommitted step owns the complete remaining
suffix, so cancellation terminally fences the workflow. Unknown steps, stale
revisions and later execution fail closed. A pending/prepared attempt is
preserved for normal reconciliation rather than deleted or refunded. This is
not a claim of arbitrary DAG cancellation or production worker teardown.

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

## Exact scientific programs and named output bindings

The [scientific runtime handoff](SCIENTIFIC_RUNTIME_HANDOFF.md) adds actual trusted
local tool execution through the existing process-worker boundary. An optional
`artifactName` selects a named file from a closed, content-verified scientific
manifest; `artifactIndex` must then be zero. The resolver checks the entire named
output set against the prior committed result and actual CAS bytes. Missing or
changed bytes stop downstream dispatch, not the historical experiment's replay.
Omitting the optional field preserves serialization of existing definitions.

The source supports Python/R empirical and numerical programs, Lean compilation
and one-to-three-pass pdfLaTeX compilation; runtime support is not independent
scientific acceptance. Python and tool-equipped LaTeX scenarios are executed by
the new tests; R/Lean are not claimed as runtime-qualified. None of this supplies
live model author/reviewer integration, a hostile-code sandbox, a second writer,
production deployment or complete Node command parity.

## Scoped maintenance and recovery

See the [maintenance/recovery contract](../../rust/crates/hepta-paper-service/MAINTENANCE.md)
for immutable event/projection replay, exact original-path backup restoration and
native-only GC quarantine. Ordinary workflow `cancel` remains a between-step
lifecycle command; this source tree does not implement in-flight `cancel-node`.
Pending starts and unclassified attempt residue block semantic recovery and GC;
they cannot become completed work or permission for an automatic retry. Partial
local source mappings are not accepted full Node operator semantics.


## Autonomous research command composition

The existing `hepta-paper-rust autonomous-research` command now accepts an
explicit `--workflow-file ABSOLUTE_JSON_PATH` in `local-run` mode. The file is
a closed `LocalWorkflowV1`, not another plan, ledger or provider authorization.
`--campaign-id` must match its template; a supplied `--paper-id` must also match
`autonomous-research:<paper-id>`. Files are bounded to 16 MiB, private, current-UID,
single-link, canonical and stable across the read. Unknown typed fields fail.

`--action prepare` validates and hashes the definition without opening or
creating campaign state. `launch` initializes only an absent state root through
`initialize_local_workflow_v1`, then uses `operate_local_workflow_with_clock_and_cancellation_v1`; an existing
root must have the exact retained definition and valid owner history. Partial
initialization and ambiguous dispatch are preserved, never cleaned into success.
`launch` and `converge` accept `--through-steps N`, an absolute endpoint (default:
all steps), so response-loss retries cannot append extra steps or charges.
`status` reads through the same owner without a writer, including after expiry.

`pause`, `resume`, and `cancel` require `--expected-revision N` from the latest
owner status. Stale revisions and reopening a cancelled campaign fail. This is
between-step cancellation, not interruption of an already running provider.
Mutations sample actual system time at entry and through the same workflow and
service owner. `ControlPlaneV1::run_with_clock` repeats snapshot/lease admission
before every dependency wave and finalization, and passes the same live
admission callback to the executor before each individual request handoff within
a wave. The service retains its existing directory lock for the entire wave;
a refused later handoff preserves earlier prepared bytes and all reservations.
The time check alone is not atomic process-start authority or in-flight termination. The existing SQLite sequencer
passes the host clock into the result transaction: samples after `BEGIN IMMEDIATE`
and immediately before `COMMIT` reject expiry, backward time and clock failure.
Lifecycle writes apply the same transaction checks and capture their response
before commit, with no fallible post-commit reread. A failed final check rolls
back the whole result batch or lifecycle event; after dispatch the runtime retains
its inspection guard and charges. Already committed workflow steps and durable
prepared caches survive a later expiry; an expired restart cannot relaunch work.

The original supplied-time APIs remain deterministic compatibility/library
entrypoints. They are not live-clock substitutes for the CLI. The clock-only compatibility path does
not renew leases, kill in-flight workers, provide a continuously running timer,
prove an independent trusted wall clock, or authorize production. Expiry after
the final precommit sample or ambiguity in the COMMIT I/O itself is not made
impossible by a timestamp check.
Inspection entrypoints cannot mutate even when called directly with forged
options. Production, golden-bootstrap and full-readiness requests fail before
state creation. Omitting `--workflow-file` preserves the previous diagnostic.

The report's `ready` means only that this bounded local operation succeeded;
`readinessScope=local_workflow_operation_only` and `fullResearchReady=false`.
Scientific acceptance, production activation and Node retirement remain false.
Process workers are trusted local programs, not a physical sandbox. Their
provider/external/network outcomes are null (unobserved), never replaced with
an asserted false based on worker JSON or a network declaration. An execution
error reports reconciliation required and retains the original recovery inputs.
No private request content or raw worker diagnostics is printed by this wrapper.

Run from the repository root:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test local_workflow
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test autonomous_research_route --test durable_service
```

`tests/local_workflow/autonomous_entrypoint.rs` invokes the actual command and
reuses the existing workflow fixtures. It checks seven-step durable progress,
absolute-endpoint retries, shared status with `hepta-local-workflow`, budget
conservation, stale-revision rejection, pause/resume/terminal cancel, request
substitution, private/oversize/symlink refusal, actual pinned Rust workers and a
crashing child that is not relaunched by repeated fresh CLI processes. These
are local composition tests, not live author/reviewer scientific evaluation,
independent command acceptance, installed host qualification or Node cutover.

### Exact-source execution evidence

The existing `production-composition-source` bundle in
`docs/system/evidence/rust-functional-source-closure-v1.json` now binds the
autonomous CLI adapter, its local entry, the existing workflow owner and all six
`autonomous_entrypoint::` regression selectors. The existing exact-head and
prospective-merge jobs execute those tests, including the real Rust child worker
and crash/no-relaunch case. A zero exit code, discovery-only run, ignored test or
zero matching tests is not accepted as executed evidence. The verifier requires
the exact successful libtest selector and nonempty successful test totals; Node
owner tests likewise require nonempty TAP execution without skips or todos.
These transcript checks complement exact source/discovery binding; they are not
independent producer authentication or scientific acceptance. No new workflow,
scheduler, state owner, migration inventory or production authority is created.

### Live-clock regression execution

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-control-plane --lib tests::runtime_clock::
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test local_workflow clock::
```

Controlled clocks exercise actual SQLite/CAS/owner paths without sleeps: expiry
or rollback between dependency waves; expiry after final preparation; a failing
precommit clock after both result rows were staged; lifecycle rollback; a
clock-free status read; preservation of a prior workflow commit and prepared
bytes after the next step expires. The existing autonomous-entrypoint tests run
the CLI with its real system clock and real Rust children. These are source
regressions, not full research-role parity or target-host acceptance.


The tool-equipped migration lane also exercises the actual autonomous CLI with
an R scientific program through the existing `hepta-scientific-worker`, durable
workflow and SQLite/CAS owners. `scientific_workflow` runs with `--include-ignored`:
separate CLI processes prepare, partially launch, inspect, converge and replay
without a second scientific execution or budget debit. The named real R result
feeds the existing manuscript and bundle kernels. See the
[installed scientific-tool lane](SCIENTIFIC_RUNTIME_HANDOFF.md#mandatory-installed-tool-migration-lane)
for exact source/tool observations and retained raw outputs. This local program
case does not implement model-driven research or grant production authority.

## Autonomous CLI process interruption

`hepta-paper-rust autonomous-research` installs SIGINT/SIGTERM handlers only in
its command process before opening a mutating workflow. The handlers set one
sticky atomic flag; library calls never install signal handlers or alter signal
masks. `execute_autonomous_research_with_cancellation_v1` carries that flag
through the current workflow, service, executor and Codex-runtime process owner.
The existing fixed-time and live-clock APIs remain compatibility wrappers around
that same implementation. No second writer, scheduler, result journal or daemon
is introduced.

A flag observed before dispatch prevents a new start. A running process is
interrupted through `run_bounded_process_with_cancellation`: the existing
bounded TERM/KILL escalation, child reaping and process-group cleanup still apply.
The same token is checked before and after time observations at admission and
SQLite precommit boundaries. A token is not an atomic check-and-COMMIT protocol:
a signal racing a completed commit does not erase committed data, and a result
already durably committed remains discoverable from normal status/replay.

The report adds `interruptionRequested` and sets `cancellationScope` to
`signal_process_group_and_commit_boundaries`. An interrupted execution returns
a bounded non-success report and retains the original pending plan, dispatch
intent and prepared bytes. Complete prepared results can be integrated by a
subsequent explicit invocation without repeating execution or budget debit.
Started work without complete prepared output stays ambiguous and cannot be
restarted automatically. The signal itself does not write a Cancelled lifecycle.
A later explicit revision-bound `cancel` can close future admission but must
retain `pendingStep=true` and cannot settle or refund uncertain effects.

This is supervision of declared trusted-local processes, not a hostile-code
sandbox or proof that a descendant which escaped the group has terminated.
Native in-process kernels are bounded but not preempted mid-calculation. Worker
network/provider effects remain unobserved; a dead process is not a remote
terminal receipt. Automatic renewal, remote cancellation and production authority
are not supplied.

Executable coverage in `tests/local_workflow/interruption.rs` uses the actual
Rust autonomous CLI and a small explicitly declared Python worker with its real
child process. It tests SIGINT and SIGTERM, both process deaths, no second step,
retained pending execution and no relaunch after CLI restart, revision-bound
cancellation without clearing residue, pre-dispatch refusal and prepared-result
replay preserving earlier committed steps. This is not a live model fixture.

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test local_workflow
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-codex-runtime --lib
```

## Broker-prepared result consumption

The existing service and local workflow now accept `WorkerBindingV1::BrokerPrepared`
(`kind: broker_prepared`, `source: BrokerPreparedSourceV1`) with a matching
`NativeJobV1::BrokerPrepared` (`kind: broker_prepared`, `input: BrokerPreparedInputV1`).
The implementation is `rust/crates/hepta-paper-service/src/broker_prepared.rs`.
Its registry execution is `InProcess`, with the hash returned by
`broker_prepared_implementation_hash_v1(&source)`, not the native-kernel hash.
There is no subprocess or provider dispatch in this backend.

The source closes the absolute broker socket, its expected UID/GID, canonical
request directory and its owner UID/GID, role, runtime identity and 1–30000 ms
query deadline. The input closes version 1, task kind, prompt-envelope hash,
workspace and mutation-policy hashes, output-schema hash and the desired input
manifest. That manifest is bounded to 1 MiB of Serde JSON; its SHA-256 must match
the original broker request. Previous workflow artifacts can enter it through
ordinary `/input/inputManifest/...` bindings. Roles are Author/Repairer for
CAP-AUTHOR, Reviewer for CAP-REVIEW and FormalReviewer for CAP-FORMAL.

The selected request owner publishes the original canonical signed request as
`hex(SHA256(local_attempt_id_utf8)).json` in the configured request directory.
`broker_prepared_request_filename_v1` supplies the exact filename. The operation
ID and attempt ID must both equal the actual selected local attempt; campaign,
step, planning revision and writer generation must match the existing service.
Request files must be single-link regular files, mode 0400 or 0440. Original
file descriptors and directory identity are retained through the query.
Publishing a request after plan selection avoids putting an attempt-dependent
signature into the very payload from which that attempt is derived.

The client checks the socket object and kernel peer before sending the existing
read-only result-query frame. Connection backlog pressure fails immediately;
subsequent I/O uses the broker client's cumulative timeout. The broker retains
signature/currentness checks and never turns this query into a reservation or
execution. Request, directory and socket identities are checked again after the
reply. Cancellation before or after the bounded query refuses local acceptance;
it does not send a remote cancellation or undo an upstream provider action.

Returned output is verified by the existing broker decoder, stored as one CAS
artifact, independently read by the service verifier, then committed by the
existing SQLite sequencer. The original broker receipt and token observation
remain in private CAS evidence. The service charges the admitted candidate cost
upper bound once; this is not a measured provider invoice. Request cost and token
hints may not exceed admission, and reported input/output tokens are checked.
Reopening a committed result neither queries again nor charges again.

Only an exact incoming broker-query identity may revisit its own unresolved
`.started` record. Other unresolved native/process attempts still fence admission.
A missing, expired or unprepared result never causes automatic model execution.
Partial local record/CAS writes still follow the existing inspection-required
rules; this addition does not claim arbitrary torn-write repair.

This is a local result consumer, not a model planner, operation/request signer,
provider launcher, scientific acceptance, production writer or commit-bound ACK
sender. The production API continues to refuse this backend. Real role-principal
and deployment qualification, request issuance and author/reviewer canaries are
still separate work. The consumer tests use a labelled local protocol peer plus
real Unix sockets, CAS, SQLite and the ordinary CLI; the existing broker delivery
tests separately cover the actual signed journal and live query-admission path.

Run `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service
--test broker_prepared_consumer` for this consumer regression target.

The [checked-in input example](examples/broker-prepared-input.v1.json) is consumed
by the executable consumer tests. Its digest strings bind named local fixture
inputs, not real credentials or accepted scientific evidence. It is only the
job's `input` body, not a complete service configuration or signed request.


## Explicit signed broker execution and recovery

`WorkerBindingV1::BrokerExecute` and `NativeJobV1::BrokerExecute` use wire kind
`broker_execute`. They reuse the source/input types and exact signed-request
ownership rules above, but the registry must bind
`broker_execution_implementation_hash_v1`, never the prepared-only hash. A step
reserves exactly one `provider_calls` unit; the local workflow still forbids
external actions and central-writer turns. Native and prepared-only backends
retain their zero-provider-call contract. The real broker, not the service JSON,
verifies the independently supplied signature, current capability and qualified
product operation before a provider can start.

On a fresh attempt, the service captures and validates the signed request,
connects the selected endpoint and authenticates its kernel peer before writing
any dispatch intent. A missing, malformed or mismatched request, missing/stale
socket or denied peer leaves no `.started` record and may be retried with the
same immutable operation. Only after these local checks does it fsync the
existing `.started` record, revalidate the held request and cancellation, and
send one execution frame. No error after intent persistence deletes that record
or authorizes a second execution. `dispatch_signed_operation` requires the
expected kernel peer and exact operation/request response binding. Reservation,
running or rejected state is not a prepared result. On a prepared response it
opens another connection, requests the bytes using the original read-only query,
and verifies the same prepared receipt before the existing CAS/verifier/SQLite
path can accept it. Request-file and socket identities stay pinned; elapsed
request capture, execution response and result query share a 1–30000 ms budget.
The normal `run` and stdin `serve` entrypoints choose the live host clock for this
backend, reusing post-lock, per-dispatch and commit checks. Serialized old time
cannot make an expired writer lease current.

Any restart or error after `.started` exists selects query-only recovery. It
never resends the execution frame, even when a request was not delivered or an
initial busy reply arrived. Missing/unprepared results remain unresolved until
an explicit owning reconciliation; no guessed failure releases the identity.
Other unresolved native/process/broker attempts still fence new admission. The
backend identity participates in the existing attempt hash, so changing a worker
kind cannot convert an ambiguous effect into a fresh query or another execution.
A completed local commit replays without IPC or another debit.

Cancellation denies local acceptance around the bounded exchange; this is not a
remote cancellation protocol and cannot recall an already released provider
operation. The observed provider usage is retained; accounting still charges the
admitted upper bound, not a measured provider invoice. No request/operation
signing owner, dynamic author/reviewer request producer, scientific quality
acceptance, commit-bound ACK or installed production acceptance is synthesized.
Both broker backends remain refused by the existing full production-writer API.

The `broker_prepared_consumer` target exercises both ordinary CLI/workflow
backends, first execution, query-only recovery after lost response, malformed
response identity, reservation-only refusal, stale CLI clock and unrelated
ambiguity. Its protocol peer is explicitly a fixture. The broker's
`service_lifecycle` target separately exercises the new typed client against the
actual signed admission, SQLite journal, supervised fixture process and restart.
These are source tests, not a live model canary.
