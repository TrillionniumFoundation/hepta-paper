# Online finalized-head inspection handoff

Status: native source candidate. The complete single-database inspection executes
against actual SQLite state and an independently pinned authority. Synthetic test
keys exercise the signature and journal algorithms. This inspection deliberately
returns `runtimeReady: false`; it is evidence for subsequent runtime activation,
not an activation or write permit.

## Source and interfaces

`rust/crates/hepta-paper-service/src/online_finalized_head_inspection.rs` ports
`paper-adapters/automation/autonomous-research-online-finalized-head-inspection.mjs`
and its domain receipt contract. `online_finalized_head_inspection/storage.rs`
provides bounded, strict persisted JSON and SQLite observation helpers.

`inspect_online_finalized_database_head_v1` accepts an exclusively borrowed SQLite
connection, database instance, inventory, pinned mutation authority, writer
manifest and clock. It generates a fresh cryptographic nonce, invokes the real
pinned authority transport and verifies the response through the shared Ed25519
contract verifier. Production callers must use the process authority and an
observed inventory; the transport trait remains a deliberate embedding seam.

The returned `VerifiedFinalizedHeadInspectionV1` has private fields, no public
constructor and no deserialization. Read access exposes the derived receipt,
verified current-head receipt and the authority configuration hash for subsequent
binding. The separate receipt hash/assertion functions validate serialized claims
only and cannot construct this opaque evidence.

## Verification chain

All local observations use one read transaction. The inspector rejects existing
transactions, attached databases, temporary schema objects, failed integrity or
foreign-key checks, and a schema mismatch. It verifies metadata, inventory and
writer-manifest scope; genesis sequences must both be zero.

A fresh signed external head must contain exactly the expected inventory binding.
Every local marker must have a finalization. The inspector verifies each actual
reservation and finalization signature, their complete stored-column bindings,
writer implementation identity, operation integration, timestamps, local-marker
hash and reservation/request hashes. Database sequence, hash and state continuity
start at the provisioned genesis. Global sequences must advance and cannot exceed
the observed authority head. The final local schema, sequence, hash and state must
match that authority's database head. The final clock observation rejects evidence
that expired during transport or local inspection. Clock samples are monotonic across request, observation, local scan and completion. A final memory-only time check follows public-key/configuration pin rechecks and SQLite transaction rollback; expiry is exclusive and maximum observation age is inclusive. This prevents late verification I/O from returning stale evidence.

The derived marker-chain and inspection hashes match the original Node adapter.
No local business rows, journal records, schema or cache are written. The caller
owns file identity and permission checks when supplying the SQLite connection;
this module does not claim a file-descriptor-bound SQLite VFS.

## Supported boundaries

Inventory input is limited to 256 instances, a local history to 4,096 markers,
individual stored text to 32 MiB and aggregate materialized row text to 256 MiB.
Persisted JSON rejects duplicate members and non-object roots. Text must be valid
UTF-8. These native bounds can reject larger legacy-accepted inputs.

The original schema hash uses `NOT LIKE 'sqlite_%'`, whose underscore wildcard
also excludes some legal user-object names. The native inspection preserves the
protocol hash but separately rejects user objects hidden by that projection.
Canonical timestamps are required. A connection on which SQLite has instantiated
a temporary database must be reopened before inspection, matching the original
adapter's `database_list` gate and its fresh-connection activation composition.

## Tests and remaining integration

`tests/online_finalized_head_inspection_parity.rs` uses temporary databases and
actual ephemeral Ed25519 signing. `rust/oracle/online-finalized-head-inspection-v1.mjs`
reconstructs isolated in-memory SQLite fixtures and calls the original Node
adapter with real signature verification. The suite compares exact receipts for
genesis and one/two finalized commits, and rejects pending finalizations, damaged
metadata/markers, invalid finalization signatures, duplicate JSON, bad recorded
times, attached/temp/hidden schema, mismatched authority heads and evidence that
expires during the call. Database snapshots and change counters verify no local
mutation.

A regression advances time only after the previous final verification sample: the old implementation incorrectly returned evidence at age 1001 ms with a 1000 ms observation-age limit. The corrected path refuses age 1001 ms, exact expiry, final clock rollback and an intermediate clock rollback; it accepts the exact 1000 ms age boundary. These cases use real signed receipts and leave the SQLite transaction closed and database contents unchanged. The previous Node adapter lacks this final post-I/O clock sample; this is an explicit stricter native boundary.

The remaining runtime activation chain must combine this evidence for every
registered database with startup reconciliation, fresh active challenge and broker
scope, actual writer static coverage, schema-transition evidence, validated restore
evidence and the authority-evidence cache. All observations must bind the same
inventory, manifest, trust and global head. A self-hashed inspection receipt or a
configured coordinator must never substitute for those observed dependencies.
