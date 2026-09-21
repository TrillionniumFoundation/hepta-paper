# Runnable Rust campaign service

This crate composes the real registry, policy, planner, resource allocator,
executor, content verifier and SQLite commit sequencer. It executes real bytes
and survives process restart. Its executable currently accepts **local/shadow
work only**. It cannot enable production with a boolean or issue its own host,
provider, scientific, external-effect or writer-cutover authorization.

## Build and first run

Use the repository-pinned Rust toolchain. Production compatibility checks also
require Node 22.23.1 with its pinned ICU/CLDR profile.

The SQLite Session extension is built from the locked bundled SQLite source.
Its binding generator needs a C compiler and a discoverable `libclang` shared
library at build time (local validation uses Clang 18). These tools are build
dependencies; native service execution does not invoke Node or Clang.

```sh
cargo build --manifest-path rust/Cargo.toml --locked -p hepta-paper-service
cargo run --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --example local_service_drill -- /absolute/new/disposable-state
cargo run --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --bin hepta-paper-rust -- run /absolute/new/disposable-state/run.json
```

The drill writes an actual manuscript object, schedules a native inventory job,
verifies its output bytes, commits through SQLite, closes and reopens the service,
and proves that exact replay returns the original commit without another debit.
The directory must be absent; the example cannot overwrite an existing campaign.
Its generated `run.json` is a complete runnable example, with a synthetic drill
clock and local writer token. It is not a deployment configuration.

## Command and configuration contracts

`hepta-automation-reconcile` provides read-only reconciliation plans with runtime
environment defaults and a live clock (or explicit `--database`/`--at`), and
`--execute-local REQUEST_JSON` for the complete incumbent offline schema-25
transaction under an already established local cutover epoch. The
[execution handoff](../../../docs/modules/AUTOMATION_RECONCILIATION_EXECUTION_HANDOFF.md)
documents the exact request, shared Node locks, receipt and rollback semantics,
tests, the private signed online callbacks and precommit scope hook, and remaining
production/online activation and admission gaps.

`hepta-paper-rust` implements:

| Command | Contract |
|---|---|
| `native-identity` | Print the linked native-worker source identity. |
| `put STATE FILE` | Insert up to 16 MiB of actual bytes and return their SHA-256. |
| `run CONFIG` | Decode one closed `ServiceRunV1` JSON document and emit its run receipt. |
| `serve` | Read one bounded JSON configuration per stdin line; emit one receipt per completed request. EOF shuts down. An invalid request exits nonzero. |
| `inspect-db IMMUTABLE_DB` | Validate a real Node migration database and print the production-compatible logical report. |
| `store-integrity [IMMUTABLE_DB]` | Emit the complete read-only Node logical-integrity report, including byte pre/post hashes, SQLite checks, receipt-ledger validation and fail-closed status. When omitted, the database resolves from `HEPTA_PAPER_RUNTIME_ROOT/hepta-paper.sqlite` with the installed sibling-runtime fallback used by the Node command. |
| `store-status IMMUTABLE_DB [RUNTIME_ROOT]` | Emit the read-only `HeptaNativeStoreStatus` projection for an explicitly supplied canonical store, including metadata, table counts, evidence/job classifications, contamination and submission-handoff gates. It does not discover, migrate, repair or authorize a production store. |
| `automation-status --help [--json]` | Emit the exact deterministic Node `AutomationStatusUsage` metadata. This is a bounded help-only route; readiness observers, handoff composition, deployment-environment loading, live provider/formal/release probes and authority actions remain unimplemented. |
| `local-golden-dataset-provision --action plan|execute [options]` | Inspect a bounded, source-bound local golden-dataset plan for the checked-in `ml_algorithm_benchmark` profile. The plan validates private roots, immutable dataset/split/harness/semantics/trust inputs and hashes without writing. `execute` validates the plan ID then fails closed before reading a private key or publishing an envelope, trust store, mount or receipt; all-family contract normalization, signing, mount authorization and no-clobber publication remain open. |
| `store-migrate NODE_DB [TARGET_VERSION]` | Apply the embedded Node schema migrations to a private local database, validating historical migration hashes and rejecting live leases/SQLite sidecars. Optional target is 1–25; this does not authorize a production write or retire Node. |
| `verify-legacy-freeze IMMUTABLE_DB REPOSITORY COMMIT TREE` | Read and validate an already drained immutable Node database against the exact source subject; print the freeze receipt. It does not drain the live database, activate a Rust writer, authorize rollback or retire Node. |
| `repository-assets [ROOT MANIFEST] [--handoff] [--require-externalized]` | Verify repository asset identities, pinned external references, restore-drill receipts and gitlink bindings; omitted roots resolve the current deployment root when its canonical manifest is present, then the compiled source root. `--handoff` emits a non-authorizing migration handoff. Invalid boundaries exit 1; `--require-externalized` also exits 1 for sound boundaries still awaiting externalization. |
| `command-surface ROOT [--write-package\|--check-package\|--npm-aliases\|--help-artifact\|--ci-matrix]` | Inspect or synchronize the local `package.json` command-script registry without invoking Node; write/check preserve Node's insertion order and JavaScript truthiness, including Object.keys/Object.entries coercion for malformed array/string `scripts` values, UTF-16 code-unit key ordering, and surrogate-safe JSON rewriting. Classify, help, aliases, and CI matrix are deterministic read-only projections backed by checked-in command-registry artifacts. |
| `research-capability-matrix --request ABSOLUTE_JSON_PATH [--require-production-ready]` | Project an already-observed descriptive readiness document through the ten-capability matrix; the optional gate is fail-closed and never grants authority or activation. |
| `research-readiness --workspace-root ABSOLUTE_PATH --runtime-root ABSOLUTE_PATH [--working-directory ABSOLUTE_PATH] [--now UNIX_MILLIS] [--require-ready]` | Project the actual passive Rust state-safety inspection and compare it with the Node diagnostic contract; `--require-ready` fails closed and the command performs no authority RPC or runtime write. Full automation-status observers and live activation remain outside this bounded route. |
| `generic-domain-capability-evidence --action status\|converge --runtime-root ABSOLUTE_PATH` | Inspect only the explicit private `generic-domain-capability-evidence.json` file under the supplied runtime root, matching Node shape/hash/path checks. `status` is read-only; `converge` is a fail-closed diagnostic that never publishes, invokes external replay/authority, or changes service state. |
| `personal-self-hosted-readiness [--root PATH] [--runtime-root PATH] [--cpu-receipt PATH] [--gpu-enabled --gpu-receipt PATH] [--require-ready] [--now ISO\|UNIX_MILLIS]` | Compose the read-only personal local observer: exact provenance, formal zero-skip evidence, tracked-source/runtime boundary, SQLite schema/lease and consistent-snapshot checks, anti-rollback ledger, backup/restore-drill receipts and CPU/optional GPU scientific receipts. Missing evidence stays blocked; the route never invokes external actors or grants authority. Hardware qualification, external authority, deployment and Node retirement remain open. |
| `personal-gpu-operational-gate --check [--root PATH] [--runtime-root PATH] [--receipt PATH]` | Read and verify the existing personal GPU operational receipt with the Node-compatible shape, blocker normalization and production hash. Missing, malformed and blocked receipts fail closed; the route never runs `nvidia-smi`, Docker, PDE/DL workers, CPU or holdout oracles, and never writes a receipt. The execute gate, second hardware, external authority, production activation and Node retirement remain open. |
| `retirement-reference ROOT` | Verify retirement snapshot receipts and archive hashes without consulting or mutating a live legacy runtime. |
| `release-trust-gate REQUEST` | Evaluate the pure release trust-layer count gate from JSON input, including the covered JavaScript `String(value || '')` release-commit and bounded `Number(...)` count coercions (`0b`/`0o` forms); broader arbitrary JavaScript number behavior remains outside this bounded profile. It never creates external signatures or activates production. |
| `release-state REQUEST` | Evaluate the pure package/document/tag release-state contract from JSON input, including omitted tag snapshots and deduplicated duplicate/newer-tag diagnostics; composite release verification remains separate. |
| `retirement-status REQUEST` | Inspect the read-only legacy archive retirement status for explicit roots and version; destructive identity-bound execution remains disabled. |
| `runtime-r-source-cas REPOSITORY_ROOT [--action status\|acquire] [--seed DIRECTORY]` | Verify the R lock closure, source-CAS manifest, indexes and archive hashes. `--action acquire --seed DIRECTORY` performs bounded offline acquisition (256 MiB per archive) with the host `tar` DESCRIPTION identity check, exact hashes, private staging and no-replace publication; network/CRAN acquisition remains unavailable. |

Separate native binaries inspect operational proof, owner acceptance, nested
runtime qualification and journal connector coverage. Their inputs, signature
validation, failure behavior and parity boundaries are documented in the
[authority inspection handoff](../../../docs/modules/NATIVE_AUTHORITY_INSPECTION_HANDOFF.md).

Additional native operator commands are documented in the
[release-integrity key handoff](../../../docs/modules/RELEASE_INTEGRITY_KEY_HANDOFF.md),
[portal qualification handoff](../../../docs/modules/PORTAL_TARGET_QUALIFICATION_HANDOFF.md)
and [runtime image handoff](../../../docs/modules/RUNTIME_IMAGE_REPRODUCIBILITY_HANDOFF.md).
Each describes its complete argument interface, actual Node differential tests,
write ownership, crash behavior and remaining acceptance boundaries.

`ServiceRunV1` uses camelCase, rejects unknown fields, and binds a version, state
directory, `registryJson`, hard policy, planner policy, frozen snapshot, frontier,
verifier hash, initial state hash, writer lease, explicit clock and worker table.
`registryJson` is a string containing the registry's **exact canonical JSON**;
decoding into a generic object and reordering fields would violate that protocol.
Snapshot, policy, manifest and frontier hashes are independently checked by the
existing control-plane contracts. The worker must match the registry execution
kind and identity; a missing worker never falls back to Node or a fixture.

The clock is explicit to support reproducible drills. It is not a live clock:
this executable must not be used as a production lease/timer supervisor. The
initial campaign snapshot uses revision one; later plans bind the recovered
state and the next revision. Exact historical replay remains a distinct case.

## Filesystem and SQLite state

The canonical absolute state directory and its `objects` and `attempts` children
are private mode 0700. Objects and records are mode 0600, created exclusively and
fsynced; parent directories are fsynced before the operation returns. Object
filenames are raw SHA-256 hex, but readers recompute the hash from actual bytes.
Symlinks, unsafe file modes, hard links and changed object identities fail closed.
Torn or corrupt objects are retained for investigation, never silently repaired.

`campaign.sqlite` uses the writer's explicit `local_only` identity marker. A local
service cannot open an unmarked production writer database or an existing Node
native store as though it were this format. The sequencer persists the full
prepared body, receipt, campaign revision, accounting and event in one transaction.
See [the writer contract](../hepta-campaign-writer/README.md) and
[the control-plane contract](../hepta-control-plane/README.md).

The executor fsyncs a dispatch intent before work and persists the complete
prepared result after writing artifacts. A committed or prepared exact attempt
can replay. A started attempt with no complete prepared record is ambiguous and
requires reconciliation; restart does not automatically run it again. Errors
return bounded categories without echoing worker stdout, prompts or credentials.

## Native work and gradual process migration

`NativeJobV1` supports artifact inventory, immutable Node-database inspection and
`Business` jobs. The latter dispatch seven Rust kernels: manuscript structuring,
structural review, propositional proof checking, descriptive aggregation, dense
linear solving, deterministic packaging and prepared submission. Each typed job
has exactly one capability ID, checked both in-process and at the native process
entry point. A mismatched job is rejected before a durable dispatch intent.
These bounded kernels are not a claim of complete legacy business equivalence,
model-generated research, general theorem proving or live external submission.
Database inspection remains read-only and does not itself translate all Node
business tables into the new campaign schema.

For a process worker, the registry binds executable bytes, fixed argument vector,
working directory, declared implementation language, timeout, network declaration
and source-file hash closure. Interpreted workers require explicit code files;
hashing only the Node/Python executable would leave script contents unbound.
The executable and declared code files are checked before and after execution.
The runner never parses shell commands or inherits ambient credential variables.

The worker receives one JSON stdin envelope containing `version`, `execution`
and `input`. It returns closed camelCase `WorkerResponseV1` JSON with version one,
1–256 base64 artifacts, evidence, and `externalActionMayHaveStarted: false`.
Output, stderr, stdin, deadlines and cleanup are bounded; truncated, malformed,
failed or ambiguous results cannot commit. All output bytes are independently
verified. Accounting conservatively charges the admitted resource/cost upper
bound; it does not pretend to provide operating-system resource metering.

This process path is for **trusted local workers**. It shares the invoking user's
filesystem and privileges. Network declarations and worker evidence are not
sandbox enforcement or proof that no external action occurred. Node bridges must
remain explicitly labelled `node_bridge`. Real provider dispatch uses the
[broker authority/gate/cgroup contract](../hepta-codex-broker/DISPATCH.md), which
requires independently verified deployment authority and has no permissive
production callback supplied by this executable.

## Verification and remaining production work

`hepta-paper-rust external-authority-intake` is the bounded passive intake
surface for the first external production dependency. Its `--help` payload,
missing-input report, inspection hash and `--require-ready` exit status match
the Node composition; supplied paths are pinned regular files (canonical,
single-link, non-writable, owner-checked) and symlinks fail closed. The current
Rust route deliberately reports `rust_external_authority_intake_adapter_not_ported`
for configured material. It does not parse or trust author envelopes, release
attestor v3/KMS hardware bundles, invoke signer processes, read private keys,
or claim production readiness. Those independently reviewed authority adapters
remain an open migration row in the command-gap ledger.

`hepta-paper-rust generic-domain-capability-evidence` deliberately covers a
narrower local boundary than the incumbent generic-domain command. It accepts
only an explicit absolute, canonical, private runtime root and reads its
canonical `generic-domain-capability-evidence.json` with a no-follow file
descriptor, stable identity/size/mtime checks, the 16 MiB bound, exact fourteen
field shape and the production Node record hash. `status` reports that local
inspection and never returns an authority decision. `converge` always exits
with the fail-closed blocked result: persisted authority lineage, formal-domain
replay, independent review, target-host qualification and the atomic
publication writer are not represented by this adapter. No environment path,
external authority, signer, replay, private key or runtime mutation is used.
The [generic-domain evidence handoff](../../../docs/modules/GENERIC_DOMAIN_CAPABILITY_EVIDENCE_HANDOFF.md)
defines the local `ready` field, exact input shape, exits, and remaining strong
status/convergence call chain.

`hepta-paper-rust personal-self-hosted-readiness` composes the seven local
controls from the incumbent personal profile and matches the pinned Node report
for missing evidence, GPU opt-in blocking and a safe schema-25 database with a
valid anti-rollback ledger, backup and restore drill. The [personal readiness
handoff](../../../docs/modules/PERSONAL_SELF_HOSTED_READINESS_HANDOFF.md)
defines the private-file, SQLite snapshot, scientific-receipt and
`--require-ready` boundaries. The route remains a source-level local observer;
it never performs provider, network, signer, deployment or publication work.

`hepta-paper-rust personal-gpu-operational-gate --check` is the bounded
read-only counterpart for the incumbent private GPU gate. It accepts the same
valid ready and blocked receipt wire format, verifies all nested GPU/PDE/deep
learning/IR fields and the `personalGpuOperationalReceiptHash`, and emits the
same exit class as Node (zero only for a valid personal-ready receipt; two for
missing, malformed or blocked evidence). Receipt reads use a regular-file,
single-link, no-follow descriptor, stable identity and 64 MiB bound. The Rust
route does not claim to execute or authorize the real GPU gate: that still
requires the pinned NVIDIA/Docker/PDE/DL/CPU-oracle/holdout chain and remains a
separate migration and host-qualification gap.

`cargo test -p hepta-paper-service` covers executable configuration, actual CAS
bytes, durable commit/replay, unsafe content rejection and authority refusal.
Run the local service and cutover drills independently: one proves campaign
orchestration; the other proves cooperative single-writer handoff. Their success
does not establish a complete Node-to-Rust data migration.

Production composition still needs a live clock and qualified runtime identity,
real immutable deployment/source closure, validated provider authority, actual
business workers and their capability replay corpora, Node schema translation
and reverse compatibility, and retained target-host shadow/canary evidence.
These conditions are tracked in the
[migration implementation report](../../../docs/rust/RUNTIME_MIGRATION_IMPLEMENTATION.md).

## Native bundle verification

`native_business::verify_native_build_bundle_v1(bytes, expected_sha256)` provides
Rust-native verification and decoding of `HEPTA-NATIVE-BUNDLE-V1`. The caller must
obtain the expected digest from an independently selected manifest or CAS record.
The decoder checks lengths before allocation, bounded entry counts, UTF-8, exact
end-of-input, canonical ordering, duplicate paths, unsafe path components and
file/directory prefix collisions. It returns in-memory `BuildEntryV1` values and
does not extract files, authorize publication or run embedded content. The encoder
uses the same path and collision rules.

The native numerical worker rejects non-finite products, partial sums and residuals
before reducing the infinity norm. A NaN cannot be hidden by `f64::max` and emitted
as a successful finite residual. Numerical V1's tolerance retains its existing
pivot semantics; this check does not certify a forward-error bound.

```sh
cargo test --locked -p hepta-paper-service --test native_bundle_and_binding
cargo test --locked -p hepta-paper-service --test native_business_service
```

The tests exercise all 49 job/capability combinations, parser truncations and
corruption, exact bundle round trips, both process and durable-service dispatch,
and rejection before dispatch-intent creation. Source tests grant no production
writer, provider, release or submission authority.

## Multi-step local workflow

`workflow` and the `hepta-local-workflow` executable add immutable output-bound
steps, SQLite-derived progress, absolute-target retries and between-step
pause/resume/cancel. See [the workflow engineering handoff](../../../docs/modules/LOCAL_WORKFLOW_HANDOFF.md).
This is local/shadow orchestration with real artifacts, not complete Node command
parity, live-model scientific acceptance or production activation.

## Actual scientific programs and manuscript compilation

`scientific_runtime` and `hepta-scientific-worker` add a first-party Rust adapter
for exact, operator-selected Python/R/Lean/pdfLaTeX programs. The existing service
owns reservation, durable dispatch/prepared replay and SQLite commit. Named
scientific output manifests support `ArtifactBindingV1.artifactName`, avoiding
reliance on CAS hash order when wiring an actual result into a later step.
See [the executable runtime handoff](../../../docs/modules/SCIENTIFIC_RUNTIME_HANDOFF.md)
for profiles, limits, error/recovery contracts, tests and the trusted-local ceiling.
External scientific tools remain external; this is not a Node bridge or full
business/runtime qualification. No production or retirement authority is added.


## Cooperative local byte backups

The [maintenance contract](MAINTENANCE.md) specifies shared service-state access,
exclusive maintenance sessions, bounded byte inventories, manifest-last backups
and independently digest-bound verification. `hepta-local-maintenance` exposes
`inspect`, `backup` and `verify` byte operations; recovery and quarantine commands
are specified separately below. No permanent GC-delete command is installed.
The seven lock tests and fifteen integration tests exercise actual files, SQLite
and the CLI. Byte identity never implies valid workflow recovery, fresh leases,
Node command parity, production qualification or Node retirement. Old binaries
and direct database writers must be drained before lock enrollment.

## Immutable local recovery and quarantine GC

The [maintenance contract](MAINTENANCE.md) now separates byte backups from immutable
semantic replay, absent original-path no-overwrite restoration and native-only
mark/quarantine GC. These paths reuse the existing service/writer and require
explicit quiescence, source identity and reconciliation. Quarantine does not purge
data or reclaim disk. Historical recovery reports do not qualify a runtime, renew
a lease or grant production/Node-retirement authority. Three former unmapped
maintenance modes now have partial local source mappings; `cancel-node` remains
unmapped. None is an accepted full Node parity decision.

## Native incumbent-function ports

`campaign_policy` and `campaign_slo` add a pure closed JSON command surface via
`hepta-campaign-policy`; no state writer, provider or Node process is invoked.
`NativeBusinessJobV1::EmpiricalInference` adds bounded paired-analysis statistics
under `CAP-EMPIRICAL` and the existing durable service pipeline. The seven original
jobs retain their meaning. See the [native parity handoff](../../../docs/modules/NATIVE_PARITY_HANDOFF.md)
for exact input domains, limits, Node source/profile oracles, errors, tests and
rollback exclusions. A dependency-set decision is not in-flight cancellation;
computed SLOs and p-values are not independently qualified observations.


Initial online composition now retains actual pinned process clients, the full
startup/finalized proof chain, a concrete shared recovery fence and a final common
expiry check. The evidence constructor is crate-private and grants no native activation;
a separate sealed consuming owner now runs the fixed signed reconciliation path. Historical schema checkpoint loading verifies original signed
inventory and exact copied bytes. A separate internal history bridge now proves actual registered replay
and all-table equivalence to the current signed finalized head. The owning
evidence constructor explicitly retains this historical branch and the actual
post-startup inventory, including recovered pending finalizations; signed native
admission and transaction ownership are checked by that separate consuming owner. See the repository's
[composition handoff](../../../docs/modules/ONLINE_MUTATION_COMPOSITION_HANDOFF.md)
and [schema readiness handoff](../../../docs/modules/ONLINE_SCHEMA_TRANSITION_READINESS_HANDOFF.md).


A private native-process observer now independently re-verifies the actual
production deployment and retains the current kernel executable, safe ancestry,
ELF hash, nonroot UID/GID and exact argv binding. Its separate source-owned
reconciliation digest is a prerequisite for signed native admission, not a
substitute for independent qualification or a writable transaction scope.
See the composition handoff for the actual-process tests and deployment limits.
A separate private transaction scope now retains all service ELF descriptors,
writable-root and ancestor identities, and the kernel argv file before SQLite
opens. Its checks bind the original native-process object and actual inventory,
use held hashes/metadata/positional reads, and preserve real DELETE/WAL locks
when executable paths are replaced by database hardlinks. The full deployment
verifier remains unchanged; production qualification still requires a genuine
root-owned installation and the declared current service principal.


The private fixed-native-store transaction inventory guard checks all non-target
bytes and complete namespace membership without reopening target SQLite files.
It is minted before opening SQLite and retains inventory through connection
close. The durable cutover callback can now inspect actual state under its held
lock, using a borrowed external-v2 observer at each write boundary.


Private retained evidence checks now preserve original source/cache, startup,
schema/history/replay, active/finalized and recovery bindings while SQLite is
open. Constructors run before the owning connection; checks use held files and
metadata only. Recovery holds the same evidence allocation through invalidation,
so clearing controller evidence cannot close target descriptors prematurely.
The owning caller must close SQLite before releasing any scope or inventory.
Actual signed fixtures and separate-process lock checks cover these primitives;
they grant no production activation. The internal consuming reconciliation owner
now binds real qualification/deployment, actual signed preimage, closed native
epoch/configuration and locked Production/Canary state. It completes all raw-file
preflight before opening either SQLite connection, retains every scope until
both close, and preserves committed/pending failure details. The writable CLI,
full genuine production-installation acceptance and subsequent-write admission
still need completion; no activation or retirement flag has changed.


A private signing diagnostic now observes an actual external-v2 Production/Shadow
state under its retained journal lock and derives the same future native epoch
and closed configuration used at admission. It requires the genuine current
unit/principal/argv and complete qualification, outputs no authorization, and
keeps activation/retirement flags false. Its shared projection matches a real
signed fixture transition. The private owning signed-transfer entrypoint now
binds a freshly observed typed subject, uses the external-v2 full-Shadow CAS
and safe retained preimage transfer, then freshly admits the fixed business
operation from its actual returned Canary. Separate cutover/business outcomes
preserve committed or unknown status and cannot automatically retry. The
complete writable CLI remains separate work; the existing generic transfer's
raw preimage read is not used as a claimed safe native transfer.

The native authority command prerequisite verifies held executable path/hash,
ELF bytes, root-owned safe installation, and retained process/public-key pins
for both online and backup clients. It does not invoke an RPC or change generic
script support. An ELF can be Node itself: reviewed Rust adapter semantics and
child topology binding remain necessary before exposing the native writer.
See the [composition handoff](../../../docs/modules/ONLINE_MUTATION_COMPOSITION_HANDOFF.md).

Native `hepta-paper-state-authority-client` and
`hepta-paper-state-authority-daemon` now implement the Unix protocol and all 15
local authority request kinds, including genuine Ed25519 signing from an
operator-provided key, native SQLite persistence, mutation/backup fencing and
pristine schema rebind. The target-config restart atomically activates ten heads
and fences an already running old configuration. The dedicated daemon has its
own key-custody requirements; the library API does not prove OS separation from
writers. See the [local authority implementation contract](../../../docs/modules/LOCAL_STATE_AUTHORITY_HANDOFF.md)
for exact configuration, transaction, socket, compatibility and recovery rules.
Existing Node journals require explicit migration. Installed adapter/topology
qualification, complete native writer composition and retirement remain open.

Migration preparation now has a read-only original-journal schema inspector:
actual held main transaction, closed six-table/index profile, complete SQLite
metadata comparison and `quick_check`, with collection bounds and no source FD
reopening. The report is explicitly schema-only; it does not verify signed row
history, stop a service or permit journal rewriting. See the
[inspection contract](src/local_state_authority/migration/source_profile/HANDOFF.md).

A separate [signed-history inspector](src/local_state_authority/migration/history/HANDOFF.md)
now authenticates a bounded settled legacy journal with independently pinned public
inputs, reconstructs schema/rebind epochs and all mutation heads, and compares the
complete terminal SQL state. It does not read private keys, sign or rewrite data.
Pending/backup/oversized histories are refused; live migration and service handoff
remain unimplemented.

That pinned owner also exposes
[`build_offline_native_image`](src/local_state_authority/migration/offline_image/HANDOFF.md),
which returns a bounded standalone SQLite artifact built in new memory from the
same verified snapshot. All original rowids/receipt TEXT and heads are retained;
native format/key identity are added. There is no destination path or source
write, and the artifact does not provide durable publication or service cutover.
