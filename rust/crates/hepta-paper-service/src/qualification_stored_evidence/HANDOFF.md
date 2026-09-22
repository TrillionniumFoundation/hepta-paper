# Original stored qualification evidence: native read-only readers

## Implemented APIs and scope

`read_full_research_qualification_receipt_pointer_v1(runtime_root,
repository_root, environment, now_millis)` reads the actual original publication
authority row and derived JSON mirror. It returns `Result<Option<Value>>` with the
original seven-field pointer projection. `read_autonomous_external_qualification_state_v1(runtime_root,
paper_id)` reads one actual `paper:<paper_id>` state row and returns the original
state value. Missing databases and missing singleton/scope rows return `None`.
Present but invalid evidence returns a stable error code. No repository writer,
provisioner, lease, repair, publisher, signing operation, provider or subprocess
is invoked by either native reader.

These are completed local data observations, **not signed/current qualification
or permission to perform an external action**. The original pointer reader does
not validate receipt version, kind, status, externalActionPerformed, signature or
current lifetime. Its publication writer checks a time window, but that writer is
not part of this port. The state reader checks the recorded inspection's shape
and identity bindings; it does not prove that the recorded inspection occurred.
The resident prerequisite evaluator must independently enforce full receipt
semantics, signature, signer role/time, current code/runtime and state bindings.

The original source contracts are:

- `paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs`,
  `read()` and its fixed path builder;
- `paper-adapters/automation/full-research-qualification-receipt-pointer-repository-support.mjs`,
  `receiptHashValid`, `validatedAuthority`, `safeFile`, `safeReadMirror`;
- `paper-adapters/automation/autonomous-research-qualification-state-repository.mjs`,
  `parsePersistedState`, `readState`, and the create:false path;
- `paper-domain/automation/autonomous-external-qualification-state-contract.mjs`,
  V4 state validation, V4/V5-shaped recovery and stored-evidence bindings.

## Actual pointer input chain

The fixed mirror is
`autonomous-research/qualification/qualification-receipt.json`; the authority
database is the same path with `.publication.sqlite` appended. The reader queries
only singleton 1 in the actual `full_research_qualification_pointer_authority`
table. Receipt JSON must have the real production own-hash and actual plugin
scope; raw text digest, receipt/runtime hashes, issued/expiry strings, state hash,
state generation, publisher identity/lease generation and publication generation
must agree with the row. `updated_at` is not a freshness gate. No lease or repair
is attempted. An absent authority row returns None even when a separately
observed mirror is missing or invalid, preserving original precedence.

Plugin scope is produced internally through
`runtime_image_reproducibility::resolve_runtime_image_plugin_authority_v1`, which
compiles and verifies the real builtin or configured signed public bundle. The
builtin path also calls `verify_runtime_image_builtin_plugin_source_binding_v1`
against actual repository sources. No scope hash, profile list, ready flag or
trust object supplied in a receipt is accepted as the expected context.
`now_millis` is used only for this plugin context; it is **not** a new receipt
freshness check. Native resolution happens per call. Original Node holds its
startup plugin authority in a module singleton; callers must treat these as
completed observations and must not describe the original module as hot-reloaded.

The receipt's required-profile array, definition-manifest **Object.keys order**,
active production profile array and plugin hashes are checked against that real
scope. This matters independently of the sorted production record hash: changing
only manifest insertion order can leave the hash unchanged but make the original
reader reject. `json.rs` retains ordered JSON through `parse_ordered`, removes
only the own-hash field and uses `parse_and_hash_production_record_v1`. Additional
receipt fields remain part of the hash. Mirror and row comparison also uses
Node-compatible JSON.stringify order plus a separate raw-byte digest; whitespace
changes in the mirror are not silently normalized into equality.

## Per-paper state semantics

The fixed database is
`autonomous-research/qualification/external-qualification-state.sqlite`.
Repository paper IDs retain the original 160-character ASCII grammar without
slash or @. The domain's campaign/paper ID grammar is separately wider. There is
no fallback to a legacy per-paper JSON file.

`state.rs` verifies the exact ten-key version-4 state, exact recovery keyset chosen
by presence of `maximumTotalCostUsd`, production own-hash, numeric safe integer
counters up to 1,000,000, epoch/attempt bounds, finite V5 cost limits, terminal
failure data, and canonical ordered 2000–2100 recovery times. Verified states
require matching stored FullResearchQualificationInspection fields and receipt
expiry shape; other statuses require null receipt and inspection. Actual row
generation, hash and expected paper ID are then checked against the validated
state. This order preserves state-content failures before fence failures.

The original `nextAttemptAt` diagnostic quirk is deliberately retained: null and
invalid nonnull values both parse as no next time during validation. The actual
stored field is returned unchanged and participates in the original hash. A
successful read is not evidence that such a value is a usable scheduling time.
No retry is scheduled, no budget is expanded and no state is rewritten.

## Descriptor, SQLite and namespace lifecycle

Every reader must be called **before any caller-owned business SQLite connection
or regular database descriptor exists**. Closing an additional regular descriptor
that aliases a business database can release process-scoped POSIX locks. This is
a caller-lifecycle requirement, not just a promise that the reader does not write.

The pointer first captures the bounded mirror through actual no-follow file and
ancestor directory descriptors. It records current real UID, mode, inode/device,
size, link count, mtime/ctime and raw bytes; it rechecks the held objects and
namespace and explicitly drops every descriptor before starting the private
SQLite callback. Only bytes/metadata cross that boundary. A deferred mirror error
is surfaced only after a present authority row has been validated.

Both readers use the existing descriptor-pinned **effective WAL snapshot** API,
not the main-only helper. Source main/WAL and observed sidecars are retained and
checked; SQLite queries only owned private copies and owns a private SHM file.
Active rollback journals are refused. Callback statements and connection close
before snapshot/source owners close. The pointer uses the current-real-UID
variant, matching the original `process.getuid()` file contract; the state reader
does not invent that UID condition. After all SQLite/snapshot resources close,
the pointer rechecks original mirror namespace/metadata before returning.

The observation is bracketed and sequential. It is not an atomic cross-file or
concurrent SQLite snapshot, does not prevent arbitrary writers, and does not keep
evidence current after return. UID, namespace, content or sidecar drift can turn a
read into refusal. Neither native reader repairs the source or mutates a mirror.

## Explicit bounded native input profile

The native source snapshot policy requires canonical no-symlink ancestry, regular
files, nlink 1 and safe modes; each database/sidecar is bounded to 256 MiB and the
snapshot aggregate to 1 GiB. This is intentionally narrower than the original
state repository's leaf-only checks. The mirror is bounded to 16 MiB, current
real UID and no group/world write bits; its ancestor depth is bounded to 128
components. A FIFO is opened nonblocking and rejected as nonregular. Filesystem
paths must be valid UTF-8.

Private SQLite opens readonly, enables query_only, disables trusted_schema, and
uses finite busy wait, schema and VM limits. At most 128 sqlite_schema entries,
64 columns per target table, 64 KiB DDL per schema object and 128-byte column names
are accepted. Target views, virtual tables and generated/hidden columns are
refused before the business SELECT. The canonical required columns must exist;
this is not full DDL/provenance verification. Duplicate target rows are refused.
The VM progress budget is approximately ten million steps across one callback;
it is not a hard operating-system wall-clock guarantee.

State JSON is 2 bytes through 2 MiB. Pointer row JSON and mirror bytes are at most
16 MiB. Guarded SELECT expressions check text byte length before returning a cell,
and SQLite's length limit bounds even intermediate cells/rows to payload maximum
plus 64 KiB. Canonical SQL integer/text storage classes are required for selected
row metadata; unlike the original Number(row.generation) convenience coercion,
text/real metadata in a noncanonical replacement schema is not accepted. Hash/ID
metadata is bounded to 256 bytes; stored issued/expiry text is bounded to 128
bytes. These are native resource/type restrictions, not full acceptance parity
for arbitrary replacement schemas.

External plugin bundle/trust paths must be absolute because this API intentionally
has no caller-supplied working-directory argument. The current native resolver's
other public bundle bounds still apply. JSON unpaired UTF-16 keys or values and
overflowing number literals are explicitly refused before serde Value projection;
otherwise Infinity could become null and pass a state check that original
JavaScript rejects. Supported ordinary values, property ordering and numbers use
the existing production JSON/hash implementation. No hash or ready flag is
invented when a profile cannot be represented faithfully.

## Verification evidence and remaining work

Private `tests.rs` covers real mirror bounds/mode/FIFO/symlinks, completed
observation parent/leaf/in-place drift, target view refusal before a business
query, schema-count/generated-column bounds, ordered object distinctions and
lossy scalar refusal. These tests use only owned filesystem or SQLite fixtures.

The root-owned Node oracle/integration target uses the actual original state
builder, offline CAS repository, publication lease/publisher and original readers
on owned nonsecret fixtures. No qualifier, signer or provider executes. A prior
bounded prototype proved the original low-level reader accepts an explicitly
constructed unsigned nonqualification-kind receipt; that is data-contract
evidence, not signed acceptance. Exact Node/native success/error comparisons,
committed WAL visibility and source-preservation results belong to the root's
executed test report after this module freezes. Unexecuted tests are not results.

Actual resident composition now adds its original narrow active-signature/time/code/state/configuration/cost checks and full health consumes that composition. The broader independent qualification envelope, separate recovery trust and production acceptance remain unfinished; these stored readers alone establish none of them.
