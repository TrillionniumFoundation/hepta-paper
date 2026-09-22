# Runtime image reproducibility operator handoff

Status: Rust source candidate with locally exercised Node parity and a complete
native `status`, `request`, `verify`, and offline `publish` chain. Test authorities
and synthetic OCI proofs demonstrate algorithm and storage behavior. They do not
establish production image reproducibility or production verifier qualification.
Native externally fenced publication and signed mirror recovery are exercised
below the runtime activation boundary. The online CLI/composition remains
unavailable until the complete verified activation chain can grant its capability.

## Source and interfaces

The binary is `hepta-runtime-image-reproducibility`. The public library module is
`rust/crates/hepta-paper-service/src/runtime_image_reproducibility.rs`.

| Source under that module | Responsibility |
| --- | --- |
| `workflow.rs` | Live configuration, registry, source inputs, provenance, four-operation composition and reports |
| `contract.rs` | Exact request/receipt/response contracts, OCI proof policy, active plugin scope and actual Ed25519 verification |
| `plugin.rs`, `plugin-inputs.v1.json` | Raw evaluator/profile compiler, canonical registry/ABI/package hashes, builtin and external signed startup authority |
| `context.rs` | Canonical Docker context, frontend/base pins, declared input completeness, release/source identity |
| `process.rs`, `process/identity.rs`, `process/executable.rs` | Bounded configuration, executable/interpreter/environment/credential identity, descriptor-pinned concurrent verifier processes |
| `publication.rs` | SQLite authority, monotonic publication, durable derived mirror, read-only revalidation and recovery |
| `online_publication.rs` | Actual shared coordinator transactions, signed finalization checks and authorized derived-mirror recovery; requires an activation capability with no current constructor |
| `support.rs` | Closed duplicate-rejecting JSON, descriptor-relative reads, hashing and canonical instants |

The composition API is `runtime_image_reproducibility_report_v2(options)`. Its
closed input accepts action, repositoryRoot, runtimeRoot, configPath, receiptPath,
environment, now and nonce. Explicit time and nonce support deterministic
embedding; the binary supplies the real clock and fresh OS randomness.
Low-level typed APIs separately expose request/receipt construction, receipt and
response verification, plugin authority resolution, current release binding,
context inspection, process configuration and invocation, and publication.
`ReceiptVerificationContext` is an embedding boundary: its source, configuration
and plugin inputs must come from current verified local authority. The native
composition constructs those inputs itself.

The CLI preserves `--action`, `--config`, `--receipt`, `--runtime-root`, `--root`,
and `--help`, accepting both separated and equals value forms. Default action is
status. Duplicate/unknown flags, unexpected positional tokens and missing values
fail. Reports go to stdout; successful ready/request operations exit 0, blocked
reports exit 2, and input or operational errors exit 1. Configuration/receipt
paths and the configuration identity pin have the original
`HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_*` fallbacks. Runtime root also recognizes
`HEPTA_PAPER_RUNTIME_ROOT`. Help explicitly identifies offline publication.

## Current authority and input binding

The native plugin resolver recompiles raw descriptors and raw profiles; no
precomputed scope/package hash grants authority. It recreates evaluator, profile,
registry, ABI and package hashes, then verifies the repository's real builtin
Ed25519 signature. Builtin composition additionally compares the three source
files recorded with the raw inputs against current repository bytes. External
bundle/trust-store configuration requires both absolute paths, an exact rebuilt
package, matching signed authority fields, actual Ed25519 signatures, active keys
with the empirical plugin role, canonical current validity and a bounded signing
window. Optional key validity and revocation fields are enforced. Active runtime
profiles are recomputed from the trusted package: pythonGpu is always required;
python and r are included according to active production plugin languages. The
builtin registry requires all three. A valid separately signed subset is tested.

Docker contexts bind actual current bytes, modes, declared definition manifests,
pinned frontend/base images, canonical USTAR policy, fixed source epoch and OCI
exporter policy. Extra/unmapped context files and forbidden links fail closed.
Python/GPU shared inputs must match. R source completeness is obtained from the
existing source-CAS verifier and cannot be substituted with a claimed boolean.
The release binding reuses native operational provenance, including Git dirty
source bytes and the sealed closure verifier. This embedding ignores the Node
image composition's release-commit environment override; current provenance is
the authority. The parity oracle uses the same explicit override-disabled mode.

Verifier configuration identity includes the command bytes, selected interpreter,
argument resources, restricted child environment, credentials, public keys,
backend identity, signer identities and cost/time bounds. The pin is the semantic
configuration identity hash, not a raw configuration file hash. Distinct subjects,
organizations, public keys, backends and credential trees establish the required
two-party independence. Private signing material is rejected from controller
configuration. Before invocation, every identity is recomputed. Configured
commands run directly, concurrently, with bounded JSON stdin/stdout/stderr,
timeouts and process-group termination; the controller does not forward its work
to the legacy application. Configured external verifiers remain an explicit
process capability and are not a general operating-system sandbox.
All three pipes use nonblocking bounded I/O and shared cancellation; total output
is bounded to 32 MiB. A detached descendant that retains a pipe cannot hold the
caller indefinitely. Process-group termination is not a promise to stop escaped
execution. The verified executable inode is held open and executed through its
descriptor, with full pre/post metadata checks. Those observations do not prevent
an owner-privileged process from modifying bytes after the final check.

Receipts require both real signatures over the request-bound response signing
hash, exact OCI equality, required-profile coverage, deterministic exporter proof,
current source completeness, matching scope/configuration/trust/release identity,
valid signer and receipt times, and the registered image digests. Verify/publish
reload current source, plugin and configuration after the two verifier processes
finish; drift blocks acceptance. Status redoes validation against current state.

## Filesystem and storage semantics

Strict JSON rejects duplicate keys and bounds recursion/collection size. Files
are opened component-by-component without following symbolic links; evidence and
configuration also reject group/world writable files. Single hard links, stable
metadata, read bounds and exact lengths are required. Source files may have
ordinary checkout permissions but retain the same link/identity checks. Limits
include 4 MiB external plugin bundles, 1 MiB trust stores, 32 MiB subprocess output
and receipts, 64 MiB individual context files, 256 MiB total context and command
resources, 100,000 context entries and depth 64. These limits can reject larger
legacy-accepted assets and must be evaluated before migration.

Offline publication validates the full receipt before creating output state.
Output paths must be absolute and canonical; parent creation traverses held
directory descriptors and rejects links. Final parent directories are private
and owner-controlled. SQLite uses the original strict singleton authority table,
DELETE journaling, FULL synchronization, and an immediate transaction. A successor
must have strictly later issue and expiry instants; retry of the identical receipt
is permitted. Generation uses checked arithmetic. Existing authority bytes and
hashes are validated before replacement.

The JSON mirror is derived from the committed SQLite row. It is written through
an exclusive private temporary file relative to a held directory descriptor,
fsynced, published with Linux no-replace/exchange rename and followed by directory
sync. An exchanged destination must be the captured prior inode; detected foreign
substitution is restored while the destination remains this invocation's new
inode. Failure cleanup only removes this invocation's file. SQLite opens deny
symbolic links and recheck the held file and parent identities before schema
work, before commit and after inspection/publication. No final pathname-based
permission change can target a substituted database. A separate immediate
transaction serializes mirror reconciliation with
other publishers. A failure after authority commit returns
`runtime_reproducibility_receipt_committed_mirror_pending`; read-only status
reports mirror drift without repairing it. Retrying a still-valid receipt repeats
all checks and restores the mirror. A crash can leave a complete authoritative
row and a missing/old mirror; tests exercise this recovery state. The API does not
claim cross-resource atomic publication and never fabricates a fenced write or
mirror permit. An owner-privileged process that bypasses this publication protocol
can still change filesystem objects; observed drift is rejected.

The status-only `read_runtime_image_reproducibility_publication_v2` now reads
an effective private SQLite/WAL snapshot, as specified in the
[publication read contract](../../rust/crates/hepta-paper-service/src/runtime_image_reproducibility/PUBLICATION_READ_HANDOFF.md).
It captures the bounded mirror and closes its regular descriptor before private
SQLite opens. O_PATH source/sidecar pins preserve the existing effective-UID,
mode, inode and metadata policy through the read. SQLite only sees owned copies;
a missing source SHM is not created. Ordinary schema, row/cell and VM bounds are
checked before the existing authority parser and signature/context verification.
Missing authority still precedes deferred mirror errors. A completed observation
is neither an atomic multi-file snapshot nor retained authorization. Call this
reader before any caller-owned business SQLite connection or regular database
handle exists. This status change does not alter offline/online mutation or
online reconciliation ownership and does not grant their activation authority.

The online adapter uses the shared native coordinator's actual SQLite Session
changeset, reservation, fenced commit and signed finalization. Its fixed writer
statements and computed writer-plan hash match the original adapter. It never
creates a missing database or schema and does not fall back to offline writes.
Database role, instance, schema contract, writer, operation, receipt bytes and
mirror path bind the operation and side-effect hash. Before a mirror write, an
immediate transaction rechecks the current authoritative row and latest journal
marker, validates actual reservation/finalization signatures, and binds the
publication generation to the signed Session changeset. A newer pending marker
cannot borrow an older finalized permit. Read-only status repeats those checks
without repairing state. Recovery finalizes pending commits and retries the
derived mirror without repeating the publication mutation.

`ActivatedRuntimeImagePublicationV1` has private fields, no constructor and no
deserialization. The tests exercise its private lower-level implementation using
ephemeral signed authority receipts, not a forged activation object. The latest
finalization verifier proves local historical signatures; it does not substitute
for a fresh external global head, startup reconciliation, restore qualification
or complete runtime activation. Consequently this adapter is not yet selected by
the production CLI/composition.

## Validation and remaining boundaries

`rust/oracle/runtime-image-reproducibility-v2.mjs` calls the actual Node contracts,
source and configuration adapters with the pinned Node 22.23.1 runtime.
`runtime-image-isolated-verifier-v1.mjs` is a test-only verifier using ephemeral
keys and synthetic OCI proofs. It never performs a real image rebuild. The
Rust integration suite is `tests/runtime_image_reproducibility_parity.rs` in the
service crate, exercised with Rust 1.98.0.

The 15 initial groups passed, including exact scope/request/configuration/context
and receipt parity; signed proof/signature mutations; expiry/revocation/current
source drift; actual isolated process invocation; timeout, nonzero exit, duplicate
JSON and oversized output; command/credential/context drift and link refusal;
read-only SQLite status, monotonic CAS and mirror recovery; Git dirty provenance;
PATH-selected interpreter identity; builtin raw compilation and signature;
external package/signature/role/lifetime failures; complete native CLI
request→verify→publish→status; and strict error/blocked CLI exits. A sixteenth group
covers rejection before path creation and generation exhaustion. File snapshots
check that request, verify, status and failed prepublication validation do not
write controlled fixture state.

Four additional publication unit tests cover actual replacement, occupied staging
names, a raced-in foreign destination, parent replacement, database substitution
and parent-permission changes. These checks bind observed file identities; they
do not prevent a privileged process from changing files after the final check.

Five online adapter groups exercise real native coordinator reservation,
commit/finalization signatures and read-only status; deferred/invalid finalization
and recovery without repeated DML; failed mirror recovery and generation tamper;
invalid stored signatures and duplicate stored JSON; and rejection of an older
permit when the latest publication remains pending. The separate
`runtime-image-online-publication-v1.mjs` oracle checks the original plan and
side-effect/publication hashes. The seventeenth integration group and process unit
tests also cover detached descendant pipes and descriptor-pinned invocation.

Remaining work is explicit: construct the online capability only through the
complete verified runtime activation and then connect that chain to the CLI;
obtain the actual R
source-CAS closure; configure and qualify two real independent rebuild services;
and collect real image attestations for the active production plugin scope.
Absence of those assets cannot be closed by synthetic test output or by dropping
R from the builtin scope. This source candidate is not a claim of completed
production acceptance or total Node replacement.
