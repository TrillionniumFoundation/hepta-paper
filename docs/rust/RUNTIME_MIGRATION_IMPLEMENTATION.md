# Executable Rust migration: implementation and acceptance boundaries

This document describes the current source on
`codex/full-rust-replacement-progress-20260916`, whose integration baseline is
`9570cec7bba9211099b24cb185abad907a591e0f`. Earlier planning-provider replay work
used `6e56a3508e871018e1b4e0c5a573b50818032e38`; that historical digest does not
identify this candidate. This is a technical implementation record, not a
qualification receipt, deployment authorization, or declaration that Node is retired.

## Implementation map

| Layer | Concrete implementation | Technical development contract |
|---|---|---|
| Production hash compatibility | Actual Node source oracle; native JavaScript number/property and pinned locale collation semantics | [Legacy compatibility](../../rust/crates/hepta-legacy-compatibility/README.md) |
| Production SQLite read compatibility | Actual Node migration ledger versions 1–25; replayed SQL schema; production logical-report parity | [Read-only store](../../rust/crates/hepta-readonly-store/README.md) |
| Durable campaign authority | Writer lease, atomic state/accounting/event and full result/receipt log, crash recovery | [Campaign writer](../../rust/crates/hepta-campaign-writer/README.md) |
| Durable control execution | Persistent sequencer, replay validation and independent artifact-byte verifier | [Control plane](../../rust/crates/hepta-control-plane/README.md) |
| Runnable service | CLI/stdin composition, CAS, dispatch intent, native jobs and pinned process workers | [Service](../../rust/crates/hepta-paper-service/README.md) |
| Real broker dispatch | Authenticated request plus an authority-owned product operation descriptor, role invocation, pre-exec gate, cgroup containment, output/schema and workspace-mutation validation, durable recovery | [Broker dispatch](../../rust/crates/hepta-codex-broker/DISPATCH.md) |
| Cooperative single writer | Durable journal, Node adapter fencing, backup/restore and same-database handoff/rollback | [Cutover](../../rust/crates/hepta-cutover/README.md) |
| Native authority inspection | Operational and owner evidence, nested-runtime qualification, journal discovery and signed target registries | [Authority inspection](../modules/NATIVE_AUTHORITY_INSPECTION_HANDOFF.md) |
| Local integrity-key lifecycle | Read-only status/loading and create-once Ed25519 provisioning, locking and crash-safe no-clobber publication | [Integrity keys](../modules/RELEASE_INTEGRITY_KEY_HANDOFF.md) |
| Portal registry import | Status, preflight, import-plan and local atomic import-execute, with real signed evidence verification | [Portal qualification](../modules/PORTAL_TARGET_QUALIFICATION_HANDOFF.md) |
| Image reproducibility | Signed active plugin resolution, input closure, two pinned verifier processes, OCI attestations and offline SQLite publication | [Image reproducibility](../modules/RUNTIME_IMAGE_REPRODUCIBILITY_HANDOFF.md) |
| Online SQLite mutation protocol | Fixed SQL ownership, actual Session changesets, signed head/reserve/finalize/abort/resolution and persisted recovery | [SQLite coordination](../modules/SQLITE_MUTATION_COORDINATOR_HANDOFF.md) |

The module registry, manifests and module specifications link these roots.
Documentation coverage and source implementation remain separate from capability
equivalence and effective qualification.

## Database and hash compatibility

Node production leaves `PRAGMA user_version` at zero and records migrations in
`schema_migrations`. Recognition validates the complete contiguous migration
history, production SQL digests, exact replayed tables/indexes/triggers/views and
metadata. Merely changing a version header cannot make an unrelated schema valid.
The Rust campaign-writer schema is explicitly a different format.

The fixture generator calls the actual production `createDefaultPaperStore` for
each of 25 versions. The Rust reader compares schema hash, logical database hash,
row counts and every table's canonical row hash with Node's real integrity report.
It covers SQLite NULL/INTEGER/REAL/TEXT/BLOB and rejects unsupported unsafe Number
integers, changed files and active SQLite sidecars. Inspection requires a closed,
consistent copy; it does not checkpoint or migrate a live input database.

The original draft lexical hash format remains versioned. Production compatibility
uses the actual `workflow-kernel/record-hash.mjs` functions as oracle. The contract
includes JavaScript integer-index property order, stable locale comparisons,
number formatting and raw JSON insertion order. ICU/CLDR and Node identities are
pinned because a library's default collation is insufficient evidence of parity.
The compatibility README specifies supported inputs and fail-closed cases.

## Control, execution and failure behavior

The local Rust service runs the real planner/admission/dispatch/verifier/SQLite
pipeline. It no longer relies on an in-memory sequencer for durable acceptance.
The independent verifier checks actual artifact/evidence bytes; a hash-shaped
string or a self-described successful worker response is insufficient.

Commit persists the prepared body, receipt, expected/new state, campaign revision,
resource/budget debit and event atomically. Replay reads the original durable
history. Old snapshots cannot execute new work, and writer generation conflicts
cannot acquire authority through an alternate service instance.

Dispatch persists intent before launching a worker. A restart after intent but
before a complete prepared record requires reconciliation. The process bridge
records its actual language and pinned executable/source configuration; it never
counts a Node worker as a native Rust rewrite. The local process runner supervises
trusted code but does not enforce a production security sandbox.

The real broker installs `ProductCodexDispatcherV1` rather than a universal
accept-all authority. A separate operation principal owns canonical descriptors,
prompt/input-manifest/schema bytes and exact campaign, role, lease, workspace,
mutation and budget bindings. The broker revalidates those inputs at preflight,
physical release and postflight; postflight permits only mutations subsequently
accepted by the durable workspace owner. Descriptor identity is retained in the
prepared receipt. The existing gate and cgroup containment remain mandatory.
Schema-validated provider output still does not automatically become an accepted
campaign result: scientific validation, prepared-result acknowledgement and
sequencer acceptance remain separate contracts. Installed daemon configuration,
real provider credentials and author/reviewer canaries remain deployment evidence.

Broker recovery includes a quiesced backup bundle containing the journal and
durable result sidecars. Restore verifies an independently retained manifest hash
and requires fresh destinations. Active gates/cgroups and concurrent dispatch
prevent backup; restored evidence does not restore provider or host authority.
The older journal-only API rejects actual Codex dispatch history that requires
the complete bundle.

## Shadow, canary and rollback

The cutover coordinator binds its journal and enrollment marker to the exact
database identity. Node's real SQLite store adapter wraps mutating operations in
the same coordinator lock and generation check used by Rust. An old Node process
cannot silently refresh its writer generation when the database changes owner.

Initial enrollment requires maintenance mode, stopped admission and drained old
writers. A newly installed fence cannot retroactively stop a write already in
progress in code that never participated in the fence. Once enrolled, writer
callbacks and handoff share SQLite locking; missing/replaced authority state
fails closed. Direct database writers outside these adapters are outside this
cooperative guarantee and must be removed from the deployment's writer set.

The Node adapter also prevents scoped transaction callbacks from escaping their
owner's transaction through `query`, `run` or `execute`. The SQL boundary scanner
recognizes quoted strings/identifiers, comments, multiple statements and complete
trigger bodies, then rejects top-level transaction-control statements before
execution. A rejected statement poisons the entire unit of work even if its
caller catches the error. Outer migration transactions remain supported.

The disposable drill performs actual Node/Rust query comparison, consistent
backup and restore verification, canary ownership, process reopen, promotion and
rollback. Rollback changes ownership/epoch and **preserves post-cutover writes**;
it never replaces the current database with a stale backup.

This proves same-database ownership mechanics. It does not establish that every
Node business table has been translated into the separate Rust campaign schema,
or that Node can read every new Rust business state after a production rollback.
Production actions require the signed authorization path and exact database
preimage; local-mode commands cannot substitute for those requirements.

## Reproducible acceptance

```sh
cargo test --manifest-path rust/Cargo.toml --locked \
  -p hepta-legacy-compatibility -p hepta-compatibility \
  -p hepta-readonly-control -p hepta-readonly-store
cargo test --manifest-path rust/Cargo.toml --locked \
  -p hepta-campaign-writer -p hepta-control-plane \
  -p hepta-paper-service -p hepta-cutover
node --test paper-core/tests/rust-cutover-fence.test.mjs \
  paper-core/tests/sqlite-transaction-control-boundary.test.mjs \
  paper-core/tests/sqlite-store-failure-contract.test.mjs \
  paper-core/tests/typed-persistence-ports.test.mjs
cargo run --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --example local_service_drill -- /absolute/new/service-drill
cargo run --manifest-path rust/Cargo.toml --locked -p hepta-cutover \
  --example local_cutover_drill -- /absolute/new/cutover-drill
```

The supplemental `rust-migration-acceptance` workflow records exact source and
runtime identities and retains logs/drill receipts. Existing foundation, supply
chain, architecture, documentation and qualification policies continue to apply.
Changes to a workflow update its declared producer file hashes; they do not
manufacture a successful run, external acceptance or `source_qualified` status.

Historical container socket and PID-namespace restrictions do not describe every
current validation host. Record the actual test outcomes and runtime identity for
each candidate, including any explicit host-dependent tests. Passing local or
hosted Linux tests still does not qualify the production cgroup configuration,
credential custody or workload; those require the actual target host.

## Capability migration and completion criteria

| Scope | Current source result | Remaining acceptance |
|---|---|---|
| Native database reading and hash generation | Concrete native implementation and actual Node differential tests | Full historical/private corpus and deployed-runtime acceptance |
| Control and durable commit | Executable local/shadow composition with actual bytes and SQLite | Qualified production composition, live clock and host identity |
| Native artifact inventory and DB inspection | Small native workers in the service | Business capability-specific inputs, receipts and parity |
| Author/reviewer, empirical, formal/numerical, build/package, submission | Native business kernels, function-level Node oracles and scientific process orchestration exist; their supported input domains are documented | Complete Node business call chains, historical/capability replay, scientific evidence and external-effect authority |
| Evidence/operator commands | Native status and bounded mutation paths listed above have complete source chains for their documented modes | Deliberate compatibility restrictions, production composition and independent command/mode acceptance |
| External SQLite coordinator | Authenticated protocol client, exclusive callback connection ownership and durable local commit/recovery are implemented | Activated runtime/epoch composition, every required writer, real linearizable authority and target-host qualification |
| Local state authority daemon/client | Native EOF Unix transport, supplied-key signed 15-kind protocol, native journal, backup/mutation exclusion and actual target-config pristine rebind are implemented; see [the implementation contract](../modules/LOCAL_STATE_AUTHORITY_HANDOFF.md) | Explicit Node authority-journal migration, installed principal/key custody and pinned process/topology binding; independent production and full command acceptance |
| Broker provider execution | Concrete supervised dispatch API with mandatory authority callback | Real credential custody, deployment adapter, workspace/result integration and provider canaries |
| Single-writer control and recovery | Durable same-database local exercise and Node adapter fencing | Node-to-Rust data translation, reverse compatibility, host workloads and signed cutover |
| Node retirement | Not declared | Full capability equivalence, accepted shadow/canary, recovery/rollback and removal of every Node writer/entrypoint |

No percentage based on crate count, documentation count or passing fixture count
can establish full replacement. `CTL-001` and production activation remain open
until the complete production service and its independent evidence are accepted.

## Native provisioning plan identity

`hepta-paper-rust autonomous-state-provision --action plan` remains a read-only
source preflight. Its exact command flags are owned by the existing command map,
not a second registry. Runtime-root spelling is normalized before hashing. The
returned `provisioningPlanId` is the actual production `hashRecord` of
`AutonomousResearchStateBusinessSchemaProvisioningPlan` and the returned object
with that one field removed. Machine/topic semantic values and byte observations
come from the same retained reads, revalidated before return.

Old plans that incorporated an earlier hidden `provisioningPlanId` are not an
accepted alternative encoding: regenerate them from the current inputs. A source
byte change changes the plan; an existing runtime is never adopted. The real Node
hash oracle, equivalent target spellings, changed source and non-overwrite cases
run in `autonomous_state_provision_route`.

The original no-genesis-input profile remains diagnostic and its execute path
remains blocked. The explicit `pinned-external-genesis-v1` profile below instead
validates actual inputs and creates the ten business databases. Neither profile
activates an online writer, qualifies a host or authorizes Node retirement.

### Native ten-database execution

Use the existing `autonomous-state-provision` command with these additional
Rust-profile flags: `--genesis-inputs ABSOLUTE_JSON` and
`--genesis-inputs-sha256 SHA256`. Both are mandatory for native execution. The
second value must be the independently selected raw-file digest, not a trust
statement inferred from a file supplied by an untrusted caller.

The closed input document has `version: 1`,
`kind: NativeStateProvisioningGenesisInputsV1`, and exactly four named objects:
`ownerTrustStore`, `genesisEnvelope`, `rotationTrustStore`, `bootstrapReceipt`.
Each object has only `path` (absolute) and `sha256` (lowercase `sha256:` plus 64
hex digits). Existing pinned-genesis verification reads those public documents;
no private key is loaded. Genesis needs the existing capability-owner and
operational-observer Ed25519 signatures, distinct subjects, exact configuration
and producer binding, and a currently valid interval. The native profile refuses
`root-owned-configuration` rather than treating a flag as unsigned authority.
Rotation/bootstrap documents are retained for the existing evidence contract;
this operation creates generation one and does not perform a rotation.

Machine configuration V2 reuses the existing V1 structural, static-intake and
budget validator plus the genuine V2 hash/producer binding. The actual registered
topic observer reads dataset bytes and the original implementation identity.
This does not activate V2 health or execute that JavaScript implementation.

```bash
hepta-paper-rust autonomous-state-provision --action plan \
  --root "$SOURCE_ROOT" --runtime-root "$NEW_RUNTIME_ROOT" \
  --machine-intake-config "$MACHINE_CONFIG" --topic-producer-profile "$TOPIC_PROFILE" \
  --dataset-root "$DATASET_ROOT" --genesis-inputs "$GENESIS_INPUTS" \
  --genesis-inputs-sha256 "$APPROVED_GENESIS_INPUTS_SHA256"
# Repeat those identical inputs with --action execute --execute --plan-id "$PLAN_ID".
```

The target must be absent, beneath a non-shared parent owned by the executing
UID. All ancestor names are checked against retained directory descriptors.
The plan binds the normalized target, parent device/inode/owner/mode, actual
retained source observations, signed input pins, schema bundle and original
seven-field provisioning identity. Its hash excludes only its own identifier.
The execution profile currently uses the original refresh-policy defaults plus
explicit maximum-attempt and maximum-cost fields. Other incumbent policy and
provider CLI options remain unmapped rather than silently ignored.

The constructor uses the original 25 migration files for `native-store`, the
existing handoff migration data, and compiled business schema templates for the
other eight roles. Templates are checked against actual Node constructors by
`autonomous_state_provision_execution`; they contain no fixture genesis rows or
ready flags. Actual metadata, genuine external genesis, and one fresh random
handoff nonce and matching cross-database cutover identity are inserted. All ten
connections are in-memory and explicitly closed before filesystem publication.
Every database must pass SQLite quick-check and foreign-key checks. Per-image
bytes are bounded at 32 MiB and the complete image set at 128 MiB.

One private same-parent staging directory receives the ten 0600 files, closed
namespace and byte verification, a prepared manifest and directory/file fsync.
The parent directory is synced immediately after creating the recovery name. Linux
`RENAME_NOREPLACE` installs the whole tree. Final source/currentness and output
checks cannot turn an already-published result into a no-effect claim. The
retained prepared receipt lists the actual path, schema and byte digest of every image
and keeps `freshRuntimeInstalled=false`, `ready=false`, `publicationState=prepared`.
Only after observing rename, directory sync and byte verification does this owner
persist `native-provisioning-publication.json` with `publicationState=published`
and return that exact terminal receipt. It binds the prepared receipt hash;
`ready` means business-schema initialization only. Online schema transition,
installed service activation, complete writable-owner admission and external
qualification remain separate.

### Provisioning failure and recovery runbook

| Failure | Result and operator action | Required invariant |
|---|---|---|
| Missing pin, invalid signature/profile/dataset, changed plan | No staging or runtime is created; repair the input through its real owner and obtain a new plan. | A claimed hash or ready flag cannot substitute for authority or bytes. |
| Construction or pre-publication failure | Runtime stays absent. A created `.NAME.provisioning-*` stage is retained, and later runs reject it for inspection. | No automatic reuse, deletion, hidden retry or overwrite. |
| Target appears before rename | The existing target is untouched; retain staging and resolve the conflicting owner. | `RENAME_NOREPLACE`, never check-then-overwrite. |
| Rename succeeds, later sync/verification fails | Error explicitly says `publicationState=published`; preserve the runtime and prepared/terminal receipts. Verify all ten hashes before the next lifecycle action. | Never restore an older backup or delete the installed tree. |
| Rename outcome uncertain | Error says `publicationState=indeterminate`; preserve both possible names and resolve identities under exclusive maintenance. | Do not infer non-execution or automatically retry. |

Automatic adoption/cleanup of abandoned stages is not implemented. A retained
stage is not a production runtime or a command-acceptance receipt. The failure
reports keep the original result and both names so an owner can determine which
side of publication survived; no production database or live service is touched
by the repository test harness.

```bash
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --test autonomous_state_provision_execution --test autonomous_state_provision_route
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --lib autonomous_state_provision
```

Differential tests require the pinned Node oracle runtime for fixture setup,
then remove Node and external tools from the actual Rust execution PATH. They
compare every business schema and initial row, separately verify the paired
handoff identity, and test rejection before writes. Publisher tests additionally
exercise real target races, retained stages, output corruption, post-rename
failure and SIGKILL on both sides of rename. They do not qualify a production
installation or an external principal.

### Explicit unpublished-stage recovery

The existing provisioning command accepts a separate Rust-only profile:

```bash
hepta-paper-rust autonomous-state-provision --recover-staging "$RECOVERY_REQUEST"
```

Use the [executable request example](../modules/examples/provisioning-recovery-request.v1.json).
It is a closed `NativeStateProvisioningRecoveryRequestV1`: `version=1`, exact
`kind`, `action` (`inspect` or `quarantine`), absolute `runtimeRoot` and
`stagingRoot`, boolean `execute`, and optional/null `expectedPlanHash`.
Unknown/duplicate JSON fields, additional CLI arguments and requests above
64 KiB are refused. A staging name must be the exact same-parent
`.NAME.provisioning-` plus 32 lowercase hex digits for the selected runtime.
This profile does not load genesis, model credentials or database connections.

First use `action=inspect`, `execute=false`, `expectedPlanHash=null`. Inspection
creates no file and reports the actual retained-directory and file identities,
byte lengths and SHA-256 values in `plan.inventory`. The plan hash binds that
inventory, the normalized target, both original/quarantine names and the parent
identity. The only allowed action is non-destructive quarantine, not execution
or adoption of any staged content. For mutation, retain the selected
`plan.recoveryPlanHash`, use `action=quarantine`, `execute=true`, and supply that
value as `expectedPlanHash`. The owner re-reads and compares the entire inventory
under its exclusive nonblocking parent-directory lock before renaming.

Recovery and new publication share that advisory lock. This is a local
cooperating-owner contract, not exclusion of older binaries, hostile same-UID
processes or a qualified network filesystem. Stop such older/noncooperating
producers before recovery; this command is not a systemd stop or installed-host
qualification ceremony. The lock needs no persistent lock file and inspection
never constructs a runtime. Independent targets under one parent serialize.

The bounded inventory accepts only manifest-derived directories/database paths
and the prepared receipt. Partial or empty files are preserved as bytes, not
accepted as valid SQL. Files must be private 0600, single-link regular files;
directories private 0700 on the retained parent device. At most 64 total entries,
32 MiB per database, 1 MiB for the prepared receipt and 129 MiB aggregate file
bytes are read. Symlinks, special nodes, unknown names and a terminal publication
receipt cause refusal. An existing runtime causes refusal even if it appears
pristine: published roots and newer committed state are never touched.

Quarantine uses same-parent `RENAME_NOREPLACE` to
`.NAME.quarantined-provisioning-NONCE`, flushes the retained files/directories and
parent, and re-verifies the original descriptors at the new name. No bytes are
deleted or rewritten, no missing schema is invented, and the result keeps
`freshRuntimeInstalled=false`, `productionActivation=false`, `nodeRetirement=false`.
Preserve the request/plan and receipt outside the runtime. A new ordinary
provisioning plan can subsequently create a fresh root; the quarantined bytes
remain available for inspection and are not used as a rollback image.

| Observed failure/state | Operator action |
|---|---|
| `owner_busy` | Finish or stop the actual competing cooperating owner; no recovery mutation happened. |
| Missing/both names, unsafe namespace, existing runtime | Preserve all names and resolve ownership manually. Do not delete or force-adopt a directory. |
| `recovery_plan_mismatch` | Inspect the changed bytes/identity. Approval of the earlier snapshot does not approve the replacement. |
| `quarantineState=not_quarantined` | Original staging is retained; resolve the reported input/namespace/destination conflict. |
| `quarantineState=quarantined` after a late failure | Preserve quarantine. Reissue the identical selected request to verify bytes and finish directory durability. |
| `quarantineState=indeterminate` or process death | Inspect both names. Exactly one matching name plus the selected plan is required for explicit reconciliation; there is no automatic retry. |

With staging absent and the exact quarantine present, explicit execution of the
same selected plan returns the same deterministic receipt after full byte/identity
verification and directory sync. A copied or modified quarantine does not match.
Once a new runtime exists this recovery profile refuses even replay; normal
runtime lifecycle owners take over. No source-to-runtime adoption or repair of a
published root is implied.

The provisioning integration target imports the checked-in request example,
constructs genuine ten-database native images, models retained staging in its
private fixture, executes the actual recovery CLI without Node in PATH, compares
all ten byte hashes, repeats the receipt and creates a fresh runtime while
preserving quarantine. Unit tests independently use actual SIGKILL at
before-rename, after-rename and post-sync cuts. Those publisher/recovery byte
fixtures are not production database, storage-loss or external-principal proof.

### Reconcile a published root with no terminal receipt

Use the existing command, not the staging-quarantine profile:

```bash
hepta-paper-rust autonomous-state-provision --recover-publication "$RECOVERY_REQUEST"
```

The [executable request](../modules/examples/publication-recovery-request.v1.json)
is a closed `NativeStatePublicationRecoveryRequestV1`, version 1, containing
`action`, absolute `runtimeRoot`, `expectedPreparedReceiptHash`, boolean `execute`
and optional/null `expectedPlanHash`. Start with `action=inspect`, `execute=false`
and no plan hash. Select the prepared-record digest from your retained original
initialization evidence; a digest copied from untrusted bytes does not authenticate
that history. Inspection checks the exact prepared-record fields, false authority
flags, current compiled schema bundle/manifest and every one of the ten recorded
file hashes/lengths. It does not invoke SQLite, genesis, a provider or a signer.

Inspection reports `published_without_terminal` or `terminal_present`, plus
`plan.recoveryPlanHash`. To persist a missing terminal, use `action=finalize`,
`execute=true` and that exact plan hash. This is a current-object/CAS selection,
not a human-review ceremony. Parent, directory and database inode identities and
bytes must still match. The new native-only plan hashes canonical compact serde
JSON, including its kind, without its own hash field. It preserves full u64
inode/device values; it does not use the historical Node numeric hash domain.
The existing parent lock excludes cooperating publication
and staging-recovery owners. Quiesce older or noncooperating producers separately;
this local advisory lock is not installed-service isolation.

All existing bounds apply: private 0700 directories and 0600 single-link files,
same device, no symlinks/special nodes, at most 64 entries, 32 MiB per database,
1 MiB per receipt and 129 MiB aggregate. Only the original complete ten database
paths, prepared receipt and optional terminal receipt are admitted. New tables,
new committed rows, missing files, WAL sidecars, unregistered files, changed
inode identity or conflicting terminal content block recovery. Nothing is
restored over those bytes.

The owner syncs retained files/directories and the publication parent, derives
the exact terminal through the existing publisher, and exclusively creates
`native-provisioning-publication.json` only when absent. Existing matching
terminals are verified without rewriting their identity. JSON is checked for
duplicate keys before its original serde numeric representation is retained;
`1.0` is not silently rewritten as `1`. The integration test requires recovered
terminal bytes and its hash to equal the original publisher output.

After writing, the owner observes the completed namespace and compares it to the
original held database/root objects. Late failures retain `publicationState=published`
and `terminalWriteAttempted`; they never report no effect or invite automatic
retry. SIGKILL before writing, after writing/sync and after final verification is
covered by actual subprocess tests. Reissuing the same selected request verifies
matching state and returns the same receipt. A partial or conflicting terminal
is retained and refused, not overwritten; repair of such content is outside this
profile. Missing prepared history or a missing trusted digest similarly requires
explicit investigation rather than reconstructed authority.

This completes receipt reconciliation for unchanged fresh initialization, not
arbitrary published-root maintenance. Its terminal's `ready`/`freshRuntimeInstalled`
mean the selected historical business-schema initialization only. Production
activation, writer transfer, current external qualification and Node retirement
remain false. It never uses an old database image to replace newer work.
