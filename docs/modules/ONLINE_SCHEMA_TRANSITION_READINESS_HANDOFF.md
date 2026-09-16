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

## Remaining scope

This slice does not execute schema migration, normalize/checkpoint journals,
install schema objects, resume a interrupted migration, or implement the schema
operator CLI. Those remain separate source chains. Whole runtime activation
still requires actual startup recovery, finalized-head inspection, active writer
coverage/head/challenge/scope evidence, recoverability epochs/restore proofs,
safe cache publication, and a final inventory equality check. External authority
service qualification remains a deployment requirement.

The signed `targetAuthorityConfigurationHash` belongs to the separate
`HeptaLocalAutonomousResearchStateAuthorityConfiguration` hash domain. It is not
compared with the public verifier configuration hash. Actual service-side
configuration activation/restart remains part of the authority implementation
and deployment qualification; this slice verifies its signed observation.
