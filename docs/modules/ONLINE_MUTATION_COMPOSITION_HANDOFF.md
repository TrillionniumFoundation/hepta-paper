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


The native-process targeted suite passed 5/5 in 118.04 seconds, including four
actual re-executed process modes. Strict service Clippy lib/tests checks pass.
Opaque cutover authorization now also exposes read-only currentness and initial
lease-hash accessors; consumers must still compute the native epoch's separate
hash domain and compare it with the signed value under the actual cutover lock.


## Complete deployment inputs retained for a native-store transaction

`RetainedNativeControlProcessV1::retain_for_native_store_transaction_v1` now
produces the private `RetainedNativeControlInputsV1`. Its constructor requires
the genuine original native-process observation and a real database inventory,
reruns full deployment/process and inventory checks, and opens every needed
file before the owning SQLite connection exists. A failed pathname can already
alias SQLite, so constructing this scope after opening even an idle WAL
connection is forbidden by the owning integration contract.

The scope retains every unique service ELF, every declared writable root and
its ancestor directory identities, and the actual `/proc/self/cmdline` file.
Shared broker paths require identical hash/owner/group/mode declarations;
separate roles, principals and argv remain part of the complete original
manifest. The original deployment identity uses the same pure canonical hash
helper as the unchanged full verifier. That helper alone cannot verify files
or produce deployment evidence.

Transaction checks require the exact original native-process object and the
guard bound to the same actual preconnection inventory. They rehash retained
ELF descriptors, check named and held inode/owner/mode identities, and read the
retained kernel argument file using bounded positional reads. Procfs reports
zero cmdline length; the check reads actual bytes through EOF within the
existing argument limit. Kernel executable identity and real/effective/saved
UID/GID checks remain live. All service executable ancestry receives the same
safe-ancestry checks as the existing control executable. Writable roots keep
exact namespace/owner/group/permissions while allowing ordinary child creation
and its directory timestamp/link-count changes.

No transaction check opens, clones or closes a regular-file descriptor, calls
the full deployment verifier, or replaces the original opaque subject with a
JSON report. These scopes and their borrowed original process/inventory must
outlive SQLite connection close on every result and unwind path. The original
full currentness method retains its existing behavior for use before connection
creation. The source-owned reconciliation implementation digest now includes
this new retention module.

The new targeted suite passes 7/7 in 30.36 seconds, including two subprocess
helpers actually invoked by the parent cases. It covers all service files,
conflicting shared ELF declarations, missing/modified/replaced/symlinked or
hardlinked non-control executables, writable-root and ancestor changes, equal
inventory reports with distinct origins, and actual kernel argv/executable
checks. Real ten-database inventories and separate processes prove that DELETE
and WAL writers remain locked after a service executable is replaced with a
hardlink to the live database, including rejection paths. The original native-process 5/5 and deployment
4/4 regressions also pass; strict service Clippy lib/tests succeeds.

These positive file/process fixtures use genuine native ELF files owned by the
test principal solely through the private lower observation primitives. They do
not construct `VerifiedProductionDeploymentV1` or a qualified upper scope. A
complete production positive still requires an actually installed root-owned
eight-role deployment and the declared current control principal/argv; the
existing test verifies that user-owned installation cannot mint that proof.
Other declared service files are not observations of those services' running
processes. Independent host qualification, admitted operation ownership, signed
native writer/epoch/scope, and complete CLI activation remain open.


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


## Retained evidence while SQLite is open

The private `activation::transaction` check now composes retained startup,
schema (initial or checkpoint/history/replay), finalized inventory, active
inspection, complete source, cache and recoverability evidence. It takes actual
opaque scopes made before opening the target connection, uses the original
startup input only as the immutable subject, and binds the guard to the startup
producer's actual post-recovery inventory by pointer identity. An independently
observed equal inventory cannot substitute for that origin. Cache scope also
binds the exact original verified-cache producer. No scoped check opens,
clones or closes a regular-file descriptor, creates a private SQLite snapshot,
renews evidence or invokes an authority transport. Held authority signatures and
all original hashes, manifests, heads and final time windows remain checked.

The schema path retains the original signed FINAL post-inventory hash and the
actual previously completed replay. It does not replay staged target changes or
claim they are authorized. Passive cache-based inspection is not accepted by
this active-only transaction helper; the owning composition separately retains
its actual verified active cache. A final real clock sample follows all I/O and
checks every earlier receipt plus the concrete recovery token's origin,
generation, evidence identity, head and resident/source deadlines.

Recovery now retains the same `Rc<Evidence>` allocation through failures and
coordinator feedback. A weak scope marker prevents full observations through any
clone of that concrete fence while a transaction token exists. This is not a
process-global protection against arbitrary other database opens. All original
inventories and retained source/cache/recovery scopes must survive until the
owning SQLite connection closes, including after rollback and on unwind; an idle
WAL connection still holds locks. The upper sealed writer must enforce this
lifetime and prohibit unrelated full observation during the connection lifetime.

The actual signed owning tests cover initial FINAL and genuine pending
finalization recovery followed by historical replay, staged native-store DML,
wrong equal-report guard origin, incorrect pre/post startup binding, byte-identical
schema/checkpoint replacement, no new RPC, and independent-process SQLite locks.
These checks leave all activation/retirement flags false. The internal owning
source path described below now combines these prerequisites. Its `InstalledV2`
profile additionally retains the verified nine-role deployment, actual state-
authority socket peer/pidfd and systemd manager observation, and maps both online
and backup authority RPCs through that one installed Rust daemon. The complete
writable CLI and full genuine target-host production-installation acceptance
remain open.

The retained owning suite passes 3/3 in 454.12 seconds (two complete signed
composition scenarios and their actually invoked subprocess probe). Source/cache
retention passes 8/8; inventory guard passes 16/16; recovery retention passes all
8 cases plus the original 5 activation-binding regressions. These are targeted
results, not a claim that the old full-service 714-test baseline ran again.


## Sealed native reconciliation owner and exact signed subject

The crate-private [owning execution](../../rust/crates/hepta-paper-service/src/online_mutation_composition/activation/execution.rs)
consumes the prepared composition and genuine native-process, qualification and
cutover producers. It opens only the fixed observed native-store database and
runs either of the two fixed reconciliation operations through the real process
coordinator. The narrow business bridge accepts no caller SQL, plan registry,
authority transport or clock. No writable CLI is exposed by this source path.

Full evidence checks, all raw-file retention and actual sidecar-free database
preimage inspection finish before the owner opens its external cutover journal
connection. This includes the journal's idle WAL lifetime, not only its locked
callback. Under the same journal transaction the owner checks the original
held target bytes again, verifies the genuine qualification/deployment/cutover
subject and fixes Production + Canary, the exact writer, one scope, generation,
token, revision, enrollment hash and authorization receipt. LocalDrill, Planned,
Active, RolledBack, extra scopes and copied readiness flags cannot grant this
entrypoint. Existing generic cutover APIs keep their original compatibility.

The [native epoch encoding](../../rust/crates/hepta-paper-service/src/online_mutation_composition/activation/admission_hashes.rs)
is a pure typed projection shared by signer preview and actual locked state. Its
5 passing tests include a real independently signed fixture canary transition.
It excludes authorization/configuration/activation-receipt hashes and expiry to
avoid circular signatures. The [subject binder](../../rust/crates/hepta-paper-service/src/online_mutation_composition/activation/admission.rs)
separately compares the actual authorization receipt and initial writer lease
hash. Its configuration binds canonical roots, all ten observed instance/schema
identities, the fixed two plans and writer IDs, original state/writer manifest
hashes, actual source AST/provenance hashes, native implementation/ELF/full
deployment/control-unit identities, actual online process and backup authority
configuration hashes, and the external enrollment plus epoch. Transient active
receipt nonces, times, cache bytes and content inventory hashes are excluded.
The independently signed database preimage is still compared to real original
bytes under the cutover lock; a changed database needs fresh authorization.

Before apply, after apply and after reservation immediately before commit, the
owner rechecks retained native deployment, source/cache/schema/history/startup,
finalized/active/recoverability inputs and the callback-local external storage
observer. A final shared clock sample checks all original receipt deadlines and
independent qualification/cutover expiry. No boundary reopens a regular file.
The target connection is declared after all retained scopes and closed first;
the cutover connection then closes before any retained descriptors can drop.
This order also applies to early errors and panic unwinding. The composition is
consumed on every outcome and cannot reuse the old head/preimage for another
write. Coordinator feedback intentionally invalidates its previous recovery
proofs after a committed write.

The external storage observer checks before, within and after its callback with
retained pins and the original SQLite connection. Its writer/Shadow observer suite
passes 13 cases; the complete cutover crate passes 44 cases. A post-callback failure cannot undo a target commit:
the owner preserves the actual business result and returns committed=true, while
rich pending/fatal/retryable business errors retain their complete original
fields. Three targeted owner-result tests cover these reporting boundaries.

These source and lower-layer results are not full production acceptance. The
`InstalledV2` source now checks the declared state-authority unit against the
actual running socket peer and systemd manager state and retains that identity
through fence and transaction revalidation. Genuine target-host installation
qualification under the intended principals, all independently signed host/runtime
packages, the complete writable CLI and safe signed-transfer workflow, ongoing
admission beyond the first exact preimage, and existing v1 cutover migration
remain open.
No test constructor manufactures a genuine production deployment or marks
acceptedParity, productionActivation or nodeRetirement true.


## Signing diagnostic before native transfer

The private [signing preview](../../rust/crates/hepta-paper-service/src/online_mutation_composition/activation/signing_preview.rs)
borrows the actual already prepared composition, genuine current native process
and complete qualified subject. Earlier preparation may have performed startup
repair, backup observation and cache publication; this new diagnostic itself
performs retained read-only observation and opens no business SQLite connection.
All full captures and real preimage inspection precede opening the cutover journal.
The new external-v2 Shadow observer holds the actual journal lock, permits only
Production/ShadowVerified with no writer/scope/activation receipt, and returns
no connection, SQL callback or writer grant.

The preview derives the next checked generation/revision, fixed writer/scope
and token using the same runtime epoch hash and configuration body as admission.
Its output contains the exact reviewed subject, configuration body/hash, original
preimage hash, initial lease hash, expected revisions, qualification receipt and
observation time. All readiness/activation/retirement result flags remain false.
The authority supplies its own nonce, issue/expiry times and signature. The
local Shadow state does not prove that unregistered Node processes have stopped,
so the diagnostic never fabricates nodeWriterDisabled attestation.

The actual kernel argv, principal and ELF remain mandatory. A separate CLI
invocation with different argv cannot preview another declared production unit;
the diagnostic must run in the actual unit, with the same declared invocation
as the later operation. Two projection/refusal tests pass, and the real signed
canary test now calls the locked Shadow API and shared preview function, compares
the complete actual resulting state except its separately signed receipt, and
checks that the Shadow API rejects the activated Canary before its callback.

The existing generic `start_production_canary` still hashes a raw target preimage
inside its journal transaction. The separate owning external-v2 transfer now
captures and retains preimage before opening the journal, then verifies only
held bytes under lock. The native composition uses this owning route.


## Actual schema-25 business integration scope

The dedicated `native-fixture` oracle provisions the original Node schema-25
store and campaign rows before real schema transition/genesis signing, then
uses the same other nine state databases, resident lease, actual process
brokers and complete prepared proof chain. The lower composition tests run the
fixed standard/legacy business bridge with retained evidence at all three
transaction boundaries. They inspect the actual SQLite changeset, signed
reservation/finalization or abort, complete rollback table snapshot, marker and
receipt rows, and an independently observed terminal signed authority head.
Independent-process probes check that the target lock remains held. Success
invalidates the original recovery token through actual coordinator feedback;
rejection consumes the old scope too, including the removed DELETE journal.
These fixtures intentionally do not construct a production native deployment,
qualification closure or admitted runtime from test-only fields.
The final suite passes all four tests (three actual business scenarios and the
independently invoked lock-probe helper). After closing SQLite and releasing
the old scopes, the actual pinned process verifier confirms signed terminal
head sequence 1 for each committed operation and sequence 0 after abort, with
no unresolved reservation. The original three retained-composition tests also
pass after the shared evidence-view refactor. Strict service Clippy passes.

The generic online/backup process transports still accept pinned executable
scripts for compatibility and differential fixtures. Production-oriented
`InstalledV2` instead derives both transports from the same retained
`LocalStateAuthoritySocketTransportV1`, whose original peer pidfd/credentials,
public configuration and manager binding are rechecked across activation and the
native-store transaction. That source path removes the process/script transport
from the installed owner, but does not manufacture a real target-host deployment
or an independently qualified build. Compatibility process transports remain
available for their existing fixtures. Production acceptance and retirement
flags remain false.

## Owning signed transfer and subsequent business execution

The private [transfer owner](../../rust/crates/hepta-paper-service/src/online_mutation_composition/activation/transfer.rs)
consumes Prepared, the actual native process, complete external qualification,
genuinely verified cutover signature and one fixed reconciliation request. It
accepts no caller lease, root, state, SQL callback or diagnostic JSON as a grant.
Its three phases each close SQLite before releasing any retained raw-file scope:

1. The signing observer returns a private typed copy of actual Shadow state,
   external root/enrollment, prospective Canary, subject, preimage and epoch.
   All preview scopes and its journal are gone before transfer starts. The
   exact independently signed subject, cutover ID, preimage and initial epoch
   must match, and the existing proofs and signatures must still be current.
2. The [lower owning transfer](../../rust/crates/hepta-cutover/src/durable/external_transfer.rs)
   captures real preimage before opening its journal. It binds enrollment and
   exact full Shadow state, rechecks retained target bytes and storage under
   the actual transaction, samples its own terminal clock and appends the
   unchanged cutover wire format. A peer Shadow change rejects the CAS.
3. Only the returned actual Canary, equal to the expected full state plus the
   genuine authorization receipt, can supply the writer lease. The consuming
   execution entry reobserves all evidence and creates fresh scopes; preview
   tokens are not reused. It then repeats locked native admission before DML.

The cutover and business transactions are separate. Every lower error returns
an unresolved cutover outcome requiring inspection, does not run business SQL,
and cannot automatically retry. After confirmed cutover, all later errors say
cutoverCommitted=true and productionActivationPerformed=true, preserve original
business committed/unknown details and fatal/deferred flags, and retain the
complete original business error including its retry classification. The whole
workflow disables automatic retry. Successful output includes both actual
cutover state and actual business result; it does not attest Node retirement.

Seven new real lower tests cover genuine Ed25519 activation, unchanged Node/Rust
fencing, peer revision races, invalid storage/subject/preimage, existing sidecars,
DELETE/WAL lock retention, terminal expiry rollback and unwind. The cutover
crate passes 51 tests. Four preview/binding tests, five epoch tests (including
the real safe signed transfer), and three outcome tests pass; strict service
Clippy and independent lifecycle review pass. No full production-native fixture is fabricated: the `InstalledV2` authority
adapters and retained manager/socket topology now exist in source, while genuine
target-host qualification and the public writable CLI remain separate required
work.

## Installed V2 state-authority owner

The production-oriented [installation binder](../../rust/crates/hepta-paper-service/src/online_mutation_composition/activation/installation.rs) now consumes the closed `ProductionDeploymentManifestV2`, verifies and retains its static nine-role deployment, opens the declared native state-authority socket before any business SQLite connection, and binds the socket-origin pidfd/UID/GID to the actual systemd service observation. A replaced peer, manager identity, invocation, executable, cgroup, principal or any retained public deployment input invalidates the owner. Legacy Node runtime disposition must be `removed_from_production` before this path is constructed.

The adjacent [closed transport wrapper](../../rust/crates/hepta-paper-service/src/online_mutation_composition/activation/authority_transport.rs) gives the owning composition exactly two profiles: historical pinned process transports for compatibility, or the installed socket transport for both online mutation and backup authority. `InstalledV2` keeps the retained installation proof beside the coordinator and rechecks it before activation binding, inside recoverability/fence checks and at the native-store transaction boundary. It never converts a manager report or a deployment manifest into a write grant: the same external qualification and independently signed cutover subject remain mandatory.

Targeted source verification runs 44 online-mutation-composition cases under the exact Node 22.23.1 differential oracle, including the actual installed-profile identity/manager binding tests, signed business commit/abort paths, retained SQLite locks and stale/replaced process rejection. Strict all-target Clippy also passes. These are source results. The next product gap is a named public caller that loads the real external qualification and cutover authorities and then consumes this installed owner; no diagnostic JSON or caller-selected readiness flag may substitute for those opaque verified values.

## Retained authority child-command prerequisite

Both pinned process clients expose a crate-private native-command assertion
against expected command path/hash. The shared [held command checker](../../rust/crates/hepta-paper-service/src/sqlite_mutation_coordinator/authority/process/native_command.rs)
uses the original Snapshot descriptor, hashes via positional reads, requires
ELF and root-owned 0555/0755 installation with safe ancestors, and rechecks
the actual process configuration and pinned public-key identities. It neither
opens/clones/closes a regular descriptor nor calls the child RPC. Generic
script-based transports remain compatible.

ELF is only a necessary condition: Node itself can be an ELF. These methods do
not establish Rust adapter semantics, map child commands into the eight-role
deployment, or mint native runtime admission. The expected identity must come
from a separately reviewed adapter/topology binding before production wiring.
Six targeted command tests pass, including actual installed ELF identity,
script rejection without RPC, stale configuration/key pins and independent
DELETE main/WAL SHM lock probes. The existing online all-actions process parity
and backup v1/v2 process parity tests each pass using the qualified Node oracle;
strict service Clippy also passes. The [source-adjacent contract](../../rust/crates/hepta-paper-service/src/sqlite_mutation_coordinator/authority/process/NATIVE_COMMAND_HANDOFF.md)
records the exact API and its limits.

## Native local authority service implementation

The [native authority implementation](LOCAL_STATE_AUTHORITY_HANDOFF.md) now has
two actual Rust binaries, the EOF-framed Unix client/server, all 15 authority
request kinds, the supplied-key signer and an exact native SQLite journal.
Mutation/backup exclusion, signed chain verification and atomic target-config
schema rebind are implemented; a stale source instance is fenced inside its
next transaction. These source components can replace the incumbent protocol
handlers after their distinct installation and migration requirements are met.

They do not by themselves bind the authority child to the qualified deployment,
prove old-Node-process shutdown, migrate an existing Node authority journal,
or establish independent principal/key custody. The private native composition
still needs that actual installed adapter/topology proof before exposing a
writable production CLI. No Boolean readiness or activation flag is promoted by
adding the daemon. The dedicated daemon's key-loading behavior is not a new
credential capability for the control-plane module.

The [native authority/business fixture](../../rust/crates/hepta-paper-service/src/online_mutation_composition/activation/tests/native_authority_business/HANDOFF.md)
now connects the actual Rust client/server and supplied-key journal to the
retained standard reconciliation path. Original Node code provisions the ten
databases and executes its real schema protocol; all authority responses come
from Rust. This exposed the Node schema contract's member-order-sensitive
receipt comparison, which is now addressed at the client/server wire boundary
without reordering the oracle request or changing a signed value. The fixture
checks actual business effects, signed heads, rollback/abort and writer locks.
It uses an explicitly test-only Cargo example adapter under a private temporary
socket; no installed adapter/topology proof or production activation capability
is manufactured by these tests. Build that helper before running the dedicated
tests, as documented in their handoff.

The [authority installation design](../../rust/crates/hepta-paper-service/src/online_mutation_composition/activation/AUTHORITY_INSTALLATION_DESIGN.md)
records the remaining pre-RPC binding: actual socket-origin continuity, a
versioned deployment subject including the independent daemon, and real manager
association. The existing eight-role V1 digest cannot silently acquire another
service. Actual cross-UID executable inspection on this host is denied; the
design does not substitute a basename or caller-supplied principal for qualified
installation evidence. It grants no production capability.
