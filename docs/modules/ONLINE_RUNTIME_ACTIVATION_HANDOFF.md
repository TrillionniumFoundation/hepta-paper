# Native online runtime activation — implementation handoff

Status: **partial, not production activation**. The native implementation does
not yet expose an active coordinator constructor. A serialized receipt or a
caller-provided `ready` / `externalAuthorityVerified` field never upgrades a
configured coordinator.

## Source and ownership

The source contracts are
`paper-domain/automation/autonomous-research-online-runtime-activation-contract.mjs`
and `paper-adapters/automation/autonomous-research-online-runtime-activation.mjs`.
Native implementation: `rust/crates/hepta-paper-service/src/online_runtime_activation.rs`
and its `contracts`, `inventory`, `database`, and `ordered_json` children.

The active authority additions are
`sqlite_mutation_coordinator/contracts/activation.rs` and
`sqlite_mutation_coordinator/authority/activation.rs`. They extend the existing
pinned Ed25519 verifier, rather than accepting an application-provided signature
boolean. See `SQLITE_MUTATION_COORDINATOR_HANDOFF.md` for the original verifier's
file/process pins and operational limits.

## Implemented activation foundations

- `runtime_activation_receipt_hash_v1` and
  `assert_runtime_activation_receipt_v1` implement exact receipt/database entry
  keys, ten distinct required roles, unique UTF-16-sorted instance identifiers,
  safe sequence bounds, required hashes, timestamp profile, and recomputed
  activation receipt hash. This is structural validation only.
- `state_database_scope_hash_v1` and `state_database_inventory_hash_v1` compute
  original domain hashes using the existing production Node-compatible record
  encoder. Scope sorting uses the pinned production collation profile.
- `assert_closed_activation_inventory_v1` validates the writer manifest first,
  requires complete coverage, and enforces the closed ten-role inventory,
  current scope/hash, clean checks, schema identity and empty blockers.
  This checks an inventory claim, not actual inventory discovery.
- `stable_activation_inventory_scope_json_v1` accepts **raw JSON bytes**, preserving
  nested object member order for the source `JSON.stringify` comparison. The
  parser implements duplicate-member last-value/first-position behavior,
  numeric-property enumeration order and Node scalar normalization. A
  `serde_json::Value` is deliberately insufficient for this API.
- `assert_schema_transition_readiness_claim_v1` validates the source adapter's
  schema transition claim bindings, receipt hash and expiry. It returns no
  verified capability; signed transition audit and live observation validation
  are separate required work.
- `open_runtime_activation_database_v1` opens an existing SQLite database against
  its full inventory file identity. `ActivationDatabaseV1::inspect` performs
  fixed SQLite quick-check, foreign-key check, schema hash, user-version and
  application-id observations. Its connection is private and no public callback
  accepts `&mut Connection`, preventing owned-connection replacement/extraction.
  The opening hook API is only a deterministic race observation seam.

## Filesystem and compatibility boundaries

The database opener never creates a database or schema. It holds parent and file
handles, rejects symlink components, checks the named and held device/inode and
full snapshot around opening, and repeats checks before/after observations.
Group-write is allowed for `submission-handoff` only; world-write is rejected.

These checks detect observed replacement, mode changes and parent rebinding.
They are not an immutable future lease or a custom SQLite VFS that binds every
SQLite access to an already-open file descriptor. An adversary able to perform
undetected ABA swaps between checks remains outside this snapshot guarantee.

Native paths deliberately reject dot traversal and symlink components, including
cases the original opener would normalize. File identity enters this typed API
as a parsed object; it compares all canonical fields and values, not the original
JSON member order. The Node opening oracle restores the inventory builder's
canonical field order before calling the original opener. Raw inventory
stability tests independently retain and compare member order.

Native time validation currently supports canonical UTC millisecond timestamps;
it does not claim all permissive ECMAScript `Date.parse` inputs. Hash parity is
measured for the production-supported JSON profile, with original legacy
collation qualification in the authority oracle.

## Actual authority interfaces

`PinnedMutationAuthorityV1` adds:

- `challenge_active_authority(request, expected_instances, now)`;
- `observe_scope(request, now)`;
- `list_unresolved_mutations(request, now)`;
- read-only revalidation through `verify_current_head_receipt`,
  `verify_active_challenge_receipt`, `verify_scope_receipt`, and
  `verify_unresolved_list_receipt`.

All return the existing opaque `VerifiedMutationReceiptV1`, which has no public
constructor or deserializer. Transport bytes remain untrusted. Requests are
validated before a transport call; configuration/public-key snapshots are checked
before and after, and real Ed25519 validation binds the response to the exact
request, trust, scope, time window and expected database instances.

Challenge verification checks the challenge nonce, all database heads, schema
bindings and freshness. Scope verification checks the static inspection hash,
code provenance hash, complete required-role list, sorted operation list/count,
and covered-role list. A signed partial scope is a valid observation, **not**
full writer qualification or permission to activate.

The unresolved response is bounded to zero or one reservation, binds its set
hash and count, and authenticates both the outer list and the nested stored
reservation. Historical reservations are verified at their signed issue time;
this permits recovery after their lease expires, without granting a new commit
lease. The outer list must still be fresh. Nested malformed/invalid signatures
are rejected; no default grants acceptance.

## Verification evidence

`tests/online_runtime_activation_parity.rs`: six passing test functions, using
Node 22.23.1 as an executing oracle:

1. `activation_receipt_hash_and_rejections_match_node_without_minting_authority`
2. `closed_inventory_hash_scope_collation_and_preflight_match_node`
3. `schema_transition_readiness_claim_hash_expiry_and_binding_match_node`
4. `actual_database_opening_role_permissions_and_changed_identity_match_node`
5. `database_descriptor_guards_reject_rebinding_and_expose_fixed_observations_only`
6. `stable_inventory_preserves_nested_member_order_and_detects_physical_drift`

The receipt cases cover required fields, extra fields, duplicate/missing roles,
instance order, malformed hashes/sequences and claimed ready/blocker changes.
Inventory tests recompute hashes after attacks and exercise Unicode collation,
traversal, schema/foreign-key/quick-check failures and raw nested member order.
Database tests use only disposable `/tmp/hepta-native-activation-*` databases.

`tests/online_mutation_activation_authority_parity.rs`: three passing tests:

1. `active_challenge_scope_and_unresolved_lists_match_node_real_signatures`
   compares 57 genuinely signed accepted/rejected cases, including expired
   historical nested reservations, replay, wrong authority/scope, stale/expired
   receipts, request shape, multiple unresolved entries and nested tampering.
2. `active_authority_process_modes_match_node_and_preserve_opaque_verification`
   compares all four observation modes through real fixed synthetic processes.
3. `activation_authority_rejects_invalid_requests_before_transport_and_rechecks_pins`
   proves malformed requests make zero external calls and mid-call key-file
   mutation cannot mint a verified result.

The authority oracle generates Ed25519 private keys only in process memory.
Temporary files contain public trust documents, signed receipts and fixed-response
synthetic brokers, never private key material. These fixtures do not certify a
real authority's linearizability, deployment or production qualification.

## Required closure before exposing active runtime capability

1. Actual signed schema-transition audit completion plus fresh live observation.
2. Native inventory discovery and stable before/after state inspection.
3. Actual startup unresolved reconciliation across all ten databases, including
   proven remote-only abort and committed-marker recovery.
4. Real writer source AST/scope discovery, import/callback boundary checks and
   provenance; a caller-provided static inspection cannot substitute for it.
5. Fresh current-head, scope and challenge receipts agreeing on a linearized
   global head, followed by full local finalized-chain inspection for every DB.
6. Reverification of active evidence, actual verified stored restore-source
   evidence, state-safety predicates and recoverability/epoch boundaries.
7. Safe derived-evidence cache persistence, then actual inventory reinspection
   proving the cache did not mutate registered state.
8. A single private capability constructor consuming the verified chain and
   binding coordinator trust, manifest/scope, runtime identity, all instance/schema
   identities, activation receipt and evidence lifetime. The image publication
   adapter must consume this capability, never a JSON receipt.

The module has no production CLI or online composition yet. Route/command-map
integration must remain partial until the above call chain and qualified external
service are present. Native production code does not invoke Node; Node is used
only in parity tests.

## Implemented active refresh and source proof extension

`online_runtime_activation/active_refresh.rs` now implements
`refresh_online_authority_evidence_v1`. Its static input is an actual
`VerifiedWriterStaticCoverageV1` from the native Oxc AST/scope source scanner,
not a JSON declaration. See `ONLINE_WRITER_STATIC_HANDOFF.md` for that scanner.

The refresh creates unpredictable current-head/challenge/scope nonces, performs
real pinned authority observations in source order (head, scope, challenge),
checks that their signed global heads agree and that head/challenge database
heads match, and retries inconsistent observations up to the explicit bounded
1–5-attempt limit. It computes the original full active-refresh receipt and
receipt hashes and records no authority journal or registered state mutation.

`VerifiedActiveAuthorityEvidenceV1` has no public constructor/deserializer. It
binds the authority configuration hash, inventory hash/expected database
instances, static inspection hash, full requests and verified responses.
`assert_current` rechecks the authority pins, source evidence and all three
signatures/time windows. The evidence remains **an authority observation**, not
an `ActiveCoordinator` or proof of live inventory discovery. Typed heads compare
canonical field values; raw object member-order identity is only promised by the
separate raw JSON inventory-stability API.

Native tightening: all three receipts are reverified at a new clock observation
after the final external call, and source evidence is rechecked after the call
chain. A response that expired while IPC was running cannot become evidence.

`tests/online_runtime_active_refresh_parity.rs`: two passing tests:

- `real_static_scan_and_signed_active_refresh_match_node_success_retry_and_instability`
  executes real source inspection and real Ed25519 responses, then replays the
  exact generated nonces/receipts through the original Node refresh and its actual
  pinned authority process client. Complete success, retry and exhausted-retry
  results match; the broker is a disposable fixed-response test process.
- `active_evidence_rejects_post_rpc_expiry_modified_source_and_wrong_subject`
  rejects post-RPC expiry, a different inventory hash, expired stored active
  evidence and newly added unregistered writer source. Invalid source evidence
  prevents further authority calls.

Synthetic private keys in this test exist only in Rust test memory. Public trust
files and signed replies are stored under disposable
`/tmp/hepta-native-active-refresh-*` trees. The oracle
`rust/oracle/online-runtime-active-refresh-v1.mjs` runs original Node code and
never supplies a production qualification.
