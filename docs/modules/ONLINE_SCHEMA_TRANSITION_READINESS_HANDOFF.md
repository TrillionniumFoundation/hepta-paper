# Native schema-transition readiness

The native library verifies stored schema-transition completion and obtains a
fresh signed readiness observation against a real database inventory. This
slice does not execute migration or provide a complete operator command, and it
does not construct an active runtime capability.

## Source and native entrypoints

The source chain is `autonomous-research-online-schema-transition-contract.mjs`,
`autonomous-research-online-schema-transition-authority.mjs`, the audit validator
in `autonomous-research-online-schema-transition-completion.mjs`, the request
builder in `autonomous-research-online-schema-transition-state.mjs`, and the
readiness adapter at the end of `autonomous-research-online-schema-transition.mjs`.

Native contracts are in
`sqlite_mutation_coordinator/contracts/schema_transition.rs`. They implement the
version 1 quiesced migration and version 2 pristine writer-manifest rebind rules:
closed ten-role instances, exact request/receipt keys, identity and inventory
hashes, prior heads and derived rebind genesis, installation hashes, mirrored
subjects, lease windows, completion windows, and observation freshness.

`sqlite_mutation_coordinator/authority/schema_transition.rs` adds real pinned
reserve/finalize/observe and historical verification methods to
`PinnedMutationAuthorityV1`. Each call verifies actual Ed25519 signatures and
rechecks configuration/key snapshots. Finalization requires an opaque reservation
from that same verifier. Raw transports supply bytes/JSON, not verified authority.
The existing constrained process transport is reusable. Its 64 MiB transport
limit differs from the source schema client's 16 MiB limit; the audit itself is
limited to 16 MiB. No deployment-level linearizability claim follows from using
the local transport.

`online_schema_transition::inspect_online_schema_transition_readiness_v1`
consumes `ObservedStateDatabaseInventoryV1` from an actual database inventory
scan, a writer manifest, pinned authority and clock. It reads the actual
`autonomous-research/online-schema-transition/FINAL.json`, validates three
historical signatures, generates a fresh random observation nonce, obtains a
live signed observation, then rechecks actual inventory and audit identity.
`VerifiedSchemaTransitionReadinessV1` has private fields and no Deserialize or
claim constructor; `.assert_current` rechecks subject, files, trust and expiry
using a clock read after the full inventory/file verification. A final memory-only
check follows the pinned authority-file rechecks and signature verification; it
enforces inclusive maximum observation age, exclusive expiry, and clock monotonicity.
The retained proof also rejects clocks earlier than its successful construction. Current readiness
requires pinned trust for the target writer manifest, while historical rebind
contracts continue to accept source or target trust.
It cannot construct an active runtime capability.

## Files, ordering and deliberate restrictions

The audit is read with bounded nonblocking/no-follow reads, then loaded through
held-directory traversal and a byte pin. Duplicate JSON keys, aliases, hardlinks,
nonregular files, unsafe owners/modes and observed replacement are rejected.
The byte pin comes from the initial untrusted snapshot: the signatures and
cross-record links, not that self-observed pin, establish authenticity. Checks
are snapshots, not a promise that files cannot change in the future.

Actual audit bytes retain object-member order for the source's JSON.stringify
comparisons between reservation/request instances and finalization/request
installations. Version 2 genesis uses the source's exact canonical member order.
Numeric Values are normalized through the production JavaScript Number encoder
without coercing strings or booleans: raw `1.0`/`2.0` and integral sequence
spellings keep their original Node meaning and valid signatures. The standalone
Value contract APIs compare typed arrays structurally because
serde_json Values do not retain original object order; the file-backed readiness
boundary adds the raw-byte checks. Timestamps use the existing native canonical
UTC-millisecond profile; alternative Date.parse encodings are refused.

The native audit validator also binds the top-level projection and entire
reserve/finalize/observe chain. A live experiment against the original Node
adapter confirmed that it accepts an independently valid signed observation whose
`finalizationReceiptHash` points to an unrelated finalization when the outer
audit hash is recomputed. The native implementation refuses this splice. It also
uses a new clock reading after the RPC, all potentially expensive inventory and
audit checks, and output hashing. An observation that expires during those
operations cannot be returned as ready. Revalidation likewise accepts a clock,
not an earlier timestamp.

## Verification

The oracle `rust/oracle/online-schema-transition-v1.mjs` runs original
Node 22.23.1 code and generates private keys only in memory. Its version 1/2
fixtures have 83 live-generated signed contract cases and six actual process
modes. Its runtime fixture
creates ten temporary real SQLite databases, executes the original source
migration with genuinely signed receipts, and holds a signing authority in its
process memory for fresh challenge responses. No production key or database is
read, modified or printed.

`tests/online_schema_transition_parity.rs` contains six integration groups. The
latest actual-workspace run passed all six (199.26 seconds, zero failures). The
additional real-signature regression first failed against the earlier source:
that source accepted an observation whose 1000 ms age limit was crossed only
after the final pinned-file verification. The corrected implementation accepts
exactly 1000 ms, rejects 1001 ms before a still-future receipt expiry, and rejects
clock rollback during construction or retained-proof reuse. Retained checks
perform no authority transport call. These tests use actual ten-database inventory
and the original isolated signing process. The oracle also passes ESLint.

- `schema_transition_v1_and_pristine_rebind_v2_contracts_match_real_node_signatures`
  compares all 83 independently generated signed cases, including exact request
  error codes, lease/order/genesis/subject/signature failures and both versions.
- `schema_transition_process_modes_match_node_and_require_verified_same_authority_reservation`
  compares full objects for six real process modes and rejects a reservation
  from a different pinned verifier before invoking the second transport.
- `schema_transition_invalid_request_makes_no_rpc_and_transport_cannot_change_pinned_trust`
  proves invalid requests cause zero RPCs and mid-RPC trust-file replacement fails.
- `actual_ten_database_signed_schema_readiness_matches_node_and_retains_current_evidence`
  compares complete readiness objects after source execution over ten real
  temporary databases, repeats the comparison after raw integer-to-decimal JSON
  spelling changes without resigning, and rejects expired or changed evidence.
- `actual_schema_readiness_rejects_spliced_signatures_raw_member_drift_filesystem_and_late_rpc`
  verifies 13 refusal paths with exact failure stages: signature, signed splice,
  member order, symlink, FIFO, hardlink, writable control directory/audit file,
  duplicate keys, changed database, expired or forged live response, and audit
  changes during RPC. Original Node accepts the independently signed splice;
  native rejects it before making a fresh authority call.

Version 2 has contract and process coverage; the complete ten-database source
execution/readiness fixture is version 1. A complete version 2 migration and
service restart integration is not claimed by these tests.

## Historical checkpoint

`online_schema_transition::history::checkpoint::load_schema_transition_checkpoint_v1`
loads retained historical evidence into the opaque
`VerifiedSchemaTransitionCheckpointV1`. It accepts a checkpoint directory, an
actual `ObservedStateDatabaseInventoryV1`, a writer manifest and pinned authority.
There is no JSON proof constructor, Deserialize implementation, capture writer,
authority RPC, SQLite open, or live database write in this API.

The directory must contain exactly `POST_INVENTORY.json` and `databases/`.
The latter holds `000.sqlite` through `009.sqlite` in the original inventory's
instance order, together with exactly the corresponding `.sqlite-wal` files
recorded by that inventory. The full original inventory is retained, including
original main/WAL file identities and hashes. Retained copies have their own held
file identities; their metadata is never presented as original source metadata.
The loader recomputes the complete inventory hash, then passes that historical
inventory to the unchanged strict audit verifier. All three real historical
signatures must bind `FINAL.postInventoryHash` to that exact hash. Main/WAL copy
lengths and bytes must match the signed inventory's `sourceSha256`/`walSha256`.
Missing historical bytes, a later backup, or a caller's ready flag cannot fill
this gap.

The proof retains no-follow file/directory handles, exact file metadata, original
audit bytes and the authority configuration binding. It rejects extra files,
aliases, hardlinks, nonregular files, duplicate JSON keys, unsafe permissions or
owners, replacement and content drift. Bounds are 16 MiB for the inventory,
256 MiB per copied file and 1 GiB total database/WAL bytes. Revalidation checks
the retained evidence, real current ten-database membership, manifests, paths,
schema/contracts and stable source device/inode/mode/link identities, including
their binding to the signed schema reserve request.

This proves an authenticated historical starting point only. Current in-place
business changes and newly created current WAL files do not invalidate that
historical fact, and are not authenticated by it. The original readiness API
still rejects a current inventory different from `FINAL.postInventoryHash`.
Current business parity requires a separate contiguous signed history verifier,
isolated changeset replay and complete effective-state comparison. The checkpoint
does not grant runtime readiness, a current-head lease, native provenance, or
mutation authority; it is not consumed as an activation shortcut.

The new `rust/oracle/schema-checkpoint-v1.mjs` uses the existing real ten-database
schema fixture/executor and genuine test-only Ed25519 verification. The pinned
Node 22.23.1 run passed both native test groups: two main/WAL-current evolution
cases (43.84 seconds) and fifteen historical evidence rejection cases
(200.69 seconds), seventeen cases total. Rejections cover missing report/main
copy, later substituted bytes, extra database/WAL, symlink/hardlink/FIFO, writable
copy, duplicate or forged inventory JSON, ready-only claims, bad signature,
source inode substitution and checkpoint directory substitution. The original
schema executor forbids WAL/SHM at finalization; the successful source fixture
therefore captures DELETE-mode originals and introduces real current WAL writes
only afterward. Successful original-WAL schema execution is not claimed.
`cargo clippy -p hepta-paper-service --lib -- -D warnings` also passed.

## Remaining scope

The separate [schema execution module](ONLINE_SCHEMA_EXECUTION_HANDOFF.md)
already implements normalization, installation, resume, finalization and
observation primitives. A complete operator workflow, final durable receipt
completion/recovery, schema CLI and runtime activation remain open integration
work. The historical checkpoint loader does not capture missing old snapshots.
The separate private history bridge below proves their signed replay to current
rows; the owning evidence constructor now explicitly selects and retains this
branch using startup recovery's actual post-write inventory.
Whole runtime activation must compose actual startup recovery,
finalized-head inspection, active writer coverage/head/challenge/scope evidence,
recoverability epochs/restore proofs, safe cache publication and final inventory
checks. External authority service qualification remains a deployment requirement.

The signed `targetAuthorityConfigurationHash` belongs to the separate
`HeptaLocalAutonomousResearchStateAuthorityConfiguration` hash domain. It is not
compared with the public verifier configuration hash. Actual service-side
configuration activation/restart remains part of the authority implementation
and deployment qualification; this slice verifies its signed observation.


## Checkpoint to current finalized state

The crate-private `history::current::verify_schema_transition_history_v1` now
consumes the actual historical checkpoint, current inventory, source inspection,
active evidence and all-ten finalized inspections. This does not construct a
currentness claim by replacing the old signed `postInventoryHash`.

Finalized inspections retain each already authenticated reserve request,
reservation, reconstructed finalize request and finalization. Their public
receipt and hash remain unchanged. An internal `VerifiedFinalizedMutationChainV1`
merges those records by global sequence, starts every database from the original
signed schema genesis, rejects omissions/duplicates/gaps/forks and checks the
terminal global and database heads against the actual signed current heads.
Empty history must retain the identical signed genesis and full database set.
The chain has no public or JSON constructor. Original backup range envelopes
remain unchanged; their verifier delegates only the shared signature/continuity
loop and retains the real signed range. No placeholder backup ID, snapshot hash
or empty backup range is invented for schema history.

Private replay materializes original authenticated main/WAL bytes in a fresh
0700 scratch directory. It validates schema, integrity, empty initial mutation
journals and exact actual metadata against signed genesis and FINAL. WAL bytes
are included in normal SQLite reads, never ignored via immutable mode. Nonempty
history requires the complete fixed original operation registry and allowed
changeset effects; empty history still binds that registry. The existing replay
engine applies each business changeset and journal record in a private
transaction. A complete effective-state digest then compares every current table,
including SQLite types, duplicate/NULL-primary-key rows, hidden rowid and
sqlite_sequence. Only the existing authenticated journal-JSON and local
recorded_at normalizations apply. Neither source database nor checkpoint files
are opened for writes.

After actual replay equality, the verifier requests a fresh schema observation
using the original FINAL's `postInventoryHash`. Its head must match the fresh
active/finalized chain terminal head. Retained checks revalidate all opaque
inputs, signatures and a final common temporal boundary. The private replay
proof binds the exact current inventory and cannot be reused after a business
file change. The report leaves runtimeReady, productionActivation and
nodeRetirementVerified false.

Full tests use the original schema executor, actual process signatures and a
real original registered resident heartbeat. They cover empty-history success,
retained no-RPC verification, hidden rowid mutation without a journal (refused
before requesting schema observation), and exact one-heartbeat replay across all
ten databases. Chain tests also cover exact two-heartbeat records, incomplete
membership, inspection reordering and genuinely signed current-genesis
substitution. JSON integral decimal spellings retain their original ECMAScript
Number meaning; strings/booleans are not coerced.

The bridge currently accepts the existing closed ten-instance profile and at
most 4096 finalized entries. The owning evidence constructor now selects and retains this history path after
startup recovery with its concrete recoverability controller. Native-writer
admission and a transaction-aware write scope remain separate requirements. A
checkpoint capture/publication operator and migration of existing runtimes that
lack original bytes are separate requirements; missing history still fails
closed. A complete v2 service restart acceptance is not claimed by these v1
fixtures.


## Retained transaction checks

Initial readiness, historical checkpoint, completed replay and current history
now have crate-private fixed-native-store variants. They share the original
subject, signature and retained-file verification with the complete public
checks. The actual inventory guard replaces only full live-byte observation;
it must be pointer-bound to the original preconnection opaque inventory. All
checkpoint copies/report, audit identities, manifest/scope, chain hash, original
FINAL hash and exact active/finalized heads remain bound. Replay is not repeated
against in-flight bytes. The schema observation is verified again with pinned
trust and exclusive expiry after all I/O. No SQLite snapshot or named regular
file is opened during these checks. Their caller must still validate the actual
restricted changeset and retain every descriptor owner until SQLite closes.

The owning regression uses actual initial readiness and actual history after
recovering a genuine committed-but-unfinalized Node heartbeat. Both preserve
separate-process write exclusion through checks and byte-identical report
replacement refusal. These observations grant no new writer or activation.
