# Fixed native online mutation composition

## Source registry

`BuiltinOnlineMutationPlansV1::load` loads the fixed native source registry corresponding to `paper-composition/bootstrap/autonomous-research-online-mutation-operation-plans.mjs`. It includes all 134 original operation plans and 486 statement definitions from the sixteen original plan modules. SQL text, statement IDs, modes and operation membership are retained exactly. The writer manifest is the same compiled source document already consumed by the native backup CLI.

Loading runs the native complete writer-manifest validator and restricted-statement plan validator. It recomputes every writer implementation hash from its operation plans and retains a private `ValidatedPlanRegistryV1`. The complete native plan projection and original Node registry are compared for every operation. This is executable statement-plan source, not a generated claim that the 134 business handlers or all their command callers have been ported.

## Actual configured stage

`compose_configured_online_mutation_coordinator_v1` accepts an opaque actual database inventory, a pinned authority client, and the clock owned by the configured coordinator. It validates the closed ten-role inventory against the fixed production writer manifest, checks pinned writer/scope identity, builds the original sorted database-instance projection, and constructs the actual existing coordinator with the original default lease and 1000 ms commit safety margin. The caller cannot supply an alternative SQL plan set through this entrypoint.

Actual inventory and pinned configuration/public-key snapshots are rechecked before returning. Crate-private currentness methods expose no new external mutation API and perform no authority transport. A configuration changed after initial loading is rejected even when its JSON meaning remains the same.

The return value is a private-field `ConfiguredOnlineMutationCompositionV1` wrapper with only public read-only `inspect_status`. It has no write method, inner accessor, extraction or dereference path. A compile-fail contract checks that mutation cannot be invoked on this configured high-level value. The existing low-level coordinator remains a separate API. The wrapper retains the `autonomous_research_online_mutation_runtime_activation_required` blocker. This factory does not call authority transport, repair pending writes, inspect schema-transition completion, obtain active authority evidence, construct a backup controller, or create an activation or recoverability epoch. The complete activation composition must independently own the concrete recoverability fence and all its current proof dependencies. A prior inventory observation does not freeze future database state. The crate-private currentness check validates public authority configuration and key bytes only; arbitrary transport state is not part of that claim. A composition consuming a process transport must independently retain and recheck its process configuration and executable pins before use. No activation extraction path exists in this slice.

## Fixed-predicate validation cost

The shared native statement-plan validator caches at most 16 compiled, source-owned literal regular expressions. SQL remains input to those rules and cannot create cache keys. Matching releases the cache mutex first. Dynamic trigger identifier patterns retain the existing uncached compilation path. Hashes, SQL validation rules, case folding and whitespace conversion are unchanged.

An isolated cold-process complete 134-operation/486-statement Node/Rust comparison took 10.54 seconds before and 1.70 seconds after this change on the same host. These are local observations, not a portable performance guarantee. All six existing statement-plan parity and SQLite restriction groups pass with the cache.

## Differential evidence

The isolated tests export the original full registry under pinned Node 22.23.1 and compare all definitions, normalized native plan projections and manifest hash. A separate case provisions ten real SQLite databases using the original signed schema fixture, loads actual pinned public trust files, and checks the configured status. Wrong writer hash, wrong database scope, modified trust bytes, and changed inventory are rejected. An explicit rejecting transport with a call counter verifies zero authority calls. The tests do not obtain production credentials or activation permission.

Results are recorded against the final integrated commit and its logs. This source slice remains separate from business-operation parity, complete live activation and independent command acceptance.

## Initial owning evidence preparation

The crate-private `prepare_initial_online_mutation_composition_v1` is a second,
sealed stage. It owns a real system clock, actual process transports and their
pinned configuration/key/executable inputs. Callers supply canonical source,
runtime and backup roots, an existing resident lease identity and an optional
explicit original schema checkpoint root; they cannot
inject a clock, alternative SQL registry, generic fence or ready JSON.

The stage retains the actual source manifest file, initial and post-startup
inventory objects, signed initial schema readiness or the actual checkpoint and
verified historical replay, all ten startup confirmations,
complete source coverage, three active authority receipts, ten finalized-chain
proofs, authority inspection and verified cache write. It constructs the concrete
backup/recovery controller and attaches a clone of that same shared controller
to the actual fixed-plan coordinator. The recovery binding checks identical
inventory, manifest, authority configuration and process invocation contract,
backup-to-online trust, restore source and global head. Controller origin and
generation prevent a same-head renewal from reviving an old binding.

Recovery reconciliation runs before the active chain because it can change the
observed head. The active head must equal the retained recovery head. Startup
recovery is the existing signed finalization primitive, not business DML. This
initial mode requires unchanged full inventory after startup. An explicit
checkpoint selects the historical path before any startup RPC; missing or
invalid checkpoint evidence fails without falling back. The cache is a passive report,
and cannot recreate this owning object.

Retained checks revalidate all actual files and signatures, then take one final
system-clock sample after the last I/O. Memory-only checks cover schema,
startup, active, finalized, inspection and cache receipt windows, plus the
originating recovery binding's resident/head expiry and restore-source age.
Clock rollback is rejected. The original Node package-deletion flock remains
held for the lifetime of the object and is released on failure or drop.

The actual coordinator's status remains configured. The returned object has no
public API, business mutation method, inner coordinator accessor, deserializer
or activation extraction path. `runtimeReady`, `productionActivation` and
`nodeRetirementVerified` remain false. Source coverage still attests the Node
writer tree; native executable admission and a retained transaction scope are
separate requirements. Whole-runtime currentness checks cannot be reused after
DML by simply ignoring changed database bytes.

## Cutover inventory integration

The existing durable cutover protocol stores
`hepta-paper.sqlite.rust-cutover.sqlite` beside the business database. The
incumbent closed inventory correctly treats it as unregistered. Initial evidence
preparation therefore neither creates nor treats that journal as an accepted
business database. Enrolled runtimes remain blocked by the original inventory
rules. The new fresh v2 external coordinator-storage contract preserves the adjacent
JSON enrollment sentinel and moves only the coordinator journal outside the
business runtime. It is independently verified by Node and Rust. The future
writable composition must explicitly bind this selected storage and enrollment;
a filename exclusion would not establish that binding. Existing adjacent v1
SQLite journals are not automatically migrated or accepted.

## Initial composition validation

`online_mutation_composition/activation/tests.rs` uses
`rust/oracle/online-initial-composition-v1.mjs`. The fixture copies the complete
original source scan/import surfaces, creates ten real SQLite files and a real
resident lease before migration, and runs the original schema executor with
actual Ed25519 signatures. Actual subprocess brokers bind schema, startup,
active/finalized and backup observations to the same signed genesis. Test keys
and generous bounded test observation windows confer no production permission.
The composition test checks retained no-RPC reuse, final expiry refusal,
byte-identical process-file replacement, correct protocol instance projection,
held package exclusion and release. Root validation refuses aliases and overlap
before runtime writes. Both new composition groups pass; the real process
composition case completed in 324.20 seconds on this host. The two existing
configured-stage groups also pass, including all 134 operations and 486 statements.
This remains local prerequisite coverage, not acceptance
of writable online reconciliation or a production deployment.


## Owning historical restart evidence

The constructor now selects and retains the historical branch when
`schema_checkpoint_root` is supplied. It authenticates the original full
checkpoint against the actual pre-startup inventory before requesting recovery.
Startup may append only genuine recovered finalization rows. The original
inventory object remains owned for the startup proof's immutable input binding;
it is not reinterpreted as a current byte snapshot after those authorized writes.
Every subsequent controller/source/active/finalized/history/inspection/cache
consumer receives the startup producer's actual retained post-write inventory.

The retained schema enum owns either original initial readiness, or both the
original checkpoint and its verified current history. The historical branch
merges retained signed finalized records and performs actual private replay to
every current table, then obtains a new schema observation bound to the original
FINAL hash and the current terminal head. The final common temporal check covers
both modes. Retained verification rechecks checkpoint files and current inventory
and performs no broker calls. No ordinary DML is added by evidence preparation.

Tests exercise a genuine original registered heartbeat and a genuine committed
heartbeat whose original coordinator deliberately receives a finalization
failure. The latter begins with one local marker and no local finalization; the
Rust startup producer obtains the signed finalization and appends it, then the
owning composition proves current state from the original checkpoint. The test
requires different pre/post inventory hashes and exact recovered reservation ID.
An explicitly missing checkpoint is refused before startup RPC. These are local
source tests; runtimeReady, productionActivation and nodeRetirementVerified
remain false. Native signed admission and the complete retained transaction
scope remain required before exposing writable reconciliation.

The latest full initial regression passed in 297.64 seconds. The owning
historical heartbeat case passed in 420.29 seconds; genuine pending-finalization
recovery, missing-checkpoint refusal and retained post-inventory verification
passed in 404.69 seconds under the pinned Node 22.23.1 oracle profile.


## Retained actual native process prerequisite

The crate-private `activation::native_process::RetainedNativeControlProcessV1`
accepts the genuine opaque verified production deployment and its complete typed
manifest. It reruns the original deployment verifier, requires the identical
verified result, and selects the sole ControlPlane unit. It never accepts a JSON
report or caller-provided current-process facts as verification.

The observer retains the named executable and every canonical directory's
identity, owner and permissions. Production ancestry must be root owned and not
group/other writable; the executable remains the declared single-link native
ELF with exact content hash, mode and ownership. The kernel `/proc/self/exe`
descriptor and current executable path must identify that same inode. Real,
effective and saved UID/GID must equal the unit's nonroot principal, and the
kernel argument vector must exactly equal the canonical executable path plus
the declared arguments. Errors identify the failed contract without including
argument values. A PID change, byte-identical file/directory replacement,
permission change or content change invalidates the retained observation.

Currentness rechecks the actual process, re-verifies the complete deployment,
then checks the retained process again. The separate source-owned reconciliation
implementation digest covers the explicitly embedded reconciliation kernels and
fixed statement registry; it is distinct from the older native worker digest.
The independently signed ELF and exact tree must still bind the complete build;
this source digest does not prove reproducible compilation.

Local tests exercise a real re-executed native test binary and its real kernel
identity, wrong principal/arguments, changed executable/directory, unsafe
permissions, symlink/hardlink and content replacement. Temporary test ownership
is used only by the private low-level observation primitive. A user-owned test
binary is rejected by the genuine full deployment verifier. No root-owned
production installation or full successful deployment admission is fabricated.
Environment, cgroup, loaded-library and realtime host attestation are outside
this observer; actual independent host/service qualification remains required.
The observer itself grants no writer, cutover, transaction or retirement authority.


The native-process targeted suite passed 5/5 in 109.78 seconds, including four
actual re-executed process modes. Strict service Clippy lib/tests checks pass.
Opaque cutover authorization now also exposes read-only currentness and initial
lease-hash accessors; consumers must still compute the native epoch's separate
hash domain and compare it with the signed value under the actual cutover lock.


## Transaction observation and locked state prerequisites

A fixed-native-store inventory guard now preserves all non-target byte and
sidecar checks while permitting target SQLite content changes inside its safe
namespace. It must be minted before opening the owning SQLite connection and
retained through connection close. Its checks do not reopen target files or
release SQLite POSIX locks. See the
[inventory handoff](STATE_DATABASE_INVENTORY_HANDOFF.md) for the exact scope and
15 passing tests. This primitive does not yet own a restricted business action,
its original head/generation or its post-transaction invalidation.

`DurableCutoverCoordinatorV1::with_writer_state_v1` supplies the actual durable
state loaded under the same IMMEDIATE journal transaction held across its
callback. The original `with_writer` delegates with unchanged checks/semantics.
A future native admission callback must require the exact Production/Canary
state, fixed writer/scope and signed authorization, rather than trusting a prior
`inspect` report or accepting the incumbent Planned/RolledBack modes. Five new
callback tests and the original 10 durable plus 6 external-storage cases pass,
including real interprocess exclusion and same-process observer open/drop.
The new callback API grants no independent qualification or native admission.
