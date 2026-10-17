# Pristine runtime database observation

## Source and delivery boundary

This native library implements the local database observation and ten-database digest from `paper-adapters/automation/autonomous-research-pristine-runtime-state.mjs`. It reads actual SQLite tables, migration rows, administrative receipt JSON, machine-intake genesis evidence, and online metadata. It computes the policy, per-table, per-database, and combined runtime hashes using the qualified production record-hash and collation implementation. It does not return precomputed inspection snapshots or invoke Node in production.

This is a dependency of pristine schema rebind execution, not the completed migration command. It does not implement the separate pristine-runtime composition's root-owned authority database inspection, writer-quiescence evidence, actual schema-transition lease/lock ownership, journal normalization, durable per-instance installation publication, authority restart, or final runtime activation. No result creates an activated coordinator, mutation permit, recoverability epoch, or production qualification.

## Native API and evidence ownership

`inspect_pristine_database_state_v1(&mut Connection, PristineDatabaseOptionsV1)` starts one real deferred read transaction, observes every required table, and rolls back that read transaction on success. Errors drop and roll back only the transaction it created. A caller's existing transaction is rejected before any work, and its changes remain intact.

`PristineDatabaseInspectionV1` has private fields and a read-only `value()` method. It has no caller-claim constructor or deserializer. It represents the database read snapshot that was observed, not a future file-identity or freshness lease. The caller supplies database identity, schema contract/hash, manifest hash and phase. These are checked against persisted online metadata where the original checks them; this function does not independently qualify the caller's path, derive a closed deployment inventory, or replace the actual schema-fingerprint/required-object checks at the migration boundary. Production composition must obtain its connection through the appropriate private snapshot or exclusive migration-lock path.

`pristine_runtime_state_hash_v1(&[PristineDatabaseInspectionV1])` requires ten actual observations, one phase, and distinct roles. It checks the common online scope, writer manifest and global head; native/handoff cutover identity; and machine/topic configuration/profile binding before producing the runtime digest. This historical digest is not evidence that the ten databases were locked simultaneously.

`pristine_runtime_state_policy_hash_v1` computes the original policy digest, including phase-specific handoff migration counts and the zero-business-row default.

## Actual database checks

The native store validates all 25 checked-in migration names, versions, and SHA-256 values. Migration SQL bytes are included from the actual source migration files and hashed in Rust; they are not frozen successful-result fixtures. It checks the full expected store-metadata map, initial resource limits/peaks, and the inactive native handoff cutover.

Handoff observation checks the actual v1 or v2 migration rows for the selected phase, UUID instance nonce, active cutover and timestamps. Topic production, refresh state and qualification lease must retain their original empty/initial semantics. Machine-intake observation requires generation one, no rotation journal, matching producer/configuration hashes, and the complete persisted genesis chain.

Every database requires empty mutation markers/finalizations and exact persisted role, instance, schema and zero-sequence genesis metadata. The resident database also requires the actual authority-journal schema contract hash. Unlisted tables must have zero rows. A separate exact-prefix surface check rejects ordinary user tables such as `sqliteXbusiness` which the original `LIKE 'sqlite_%'` wildcard silently omits. The historical hash projection remains unchanged for valid inputs; hidden non-internal tables cannot obtain native pristine evidence even when Node accepts them. The observation hashes actual `quote(column)` SQL values in source column order, with the original qualified `localeCompare` row order, including text escaping and Unicode.

Limits are enforced during reading: at most 256 tables, 10,000 rows per baseline query/table, 2,048 columns and 4 MiB of cumulative text per query; the exact canonical per-table JSON also has the original 4 MiB limit. Invalid UTF-8 and unexpected semantic-query BLOBs fail explicitly. Missing SQL fields are distinguished from SQL NULL, so missing numeric/nullable baseline columns cannot masquerade as zero/null.

## Administrative receipt ledger

Actual rows must use the registered store-administrator policy and its computed issuer-policy hash, exact ledger identity/hash, allowed stream/kind, administrative evidence class and trusted writer fields. Accepted backup receipts have the exact source shape, absolute native-store/backup paths, positive safe byte count and valid recorded timestamp. These path checks describe the recorded receipt; they do not inspect a backup file or replace a verified restore-source proof.

Legacy v2 and administrative v3 restore subjects are checked against the original allowed shape and result rules. Version 3 additionally preserves the original builder's JSON member-order requirement using the order-preserving parser. Integral JSON spellings such as `3.0` retain JavaScript Number semantics. Every restore subject must match an actual backup ledger receipt, its hash/path/content digest and causal timestamp.

Duplicate JSON members are rejected by the native bounded parser, even where Node JSON.parse would accept the last value. The differential test records this explicit security tightening. Accepted exact receipt shapes exclude every explicit receipt-hash override field, so their original selector necessarily uses the computed kind/payload fallback.

## Machine genesis trust

Root-owned-configuration genesis is checked by reconstructing the exact original envelope, empty trust store, payload and signers, and comparing all persisted hashes and subjects. The self-consistent historical row is not elevated into independently proven root ownership or live deployment authority.

The external path requires `PinnedMachineGenesisDocumentsV1::load`, with separate byte pins for owner trust, genesis envelope, rotation trust and bootstrap documents. All four are actually read through the existing bounded, no-follow, identity-rechecked file reader; pins are rechecked during observation and before returning. Only the public owner trust and genesis envelope are interpreted for the genesis operation, matching the original dependency chain.

External genesis checks exact structure, historical time windows, active Ed25519 public keys, required capability-owner/operational-observer roles, two distinct key IDs and subjects, genuine signatures, and all persisted envelope/trust/signers/payload/hash bindings. Private signing material exists only in the test oracle's memory and is never persisted or printed.

This configurable independently pinned input path is not a port of the original hard-coded `/etc/hepta-paper/authority-rotation` deployment policy, which additionally requires root ownership throughout the ancestor chain. That fixed production-path composition remains to be integrated and qualified. The native external verifier accepts standard public Ed25519 SPKI PEM and canonical Base64 signatures; wider Node/OpenSSL container or permissive Base64 encodings are not asserted equivalent.

## Supported timestamp profile

Cryptographic genesis and restore-subject timestamps retain canonical UTC millisecond validation. Non-cryptographic store baseline timestamps also support the actual SQLite UTC datetime format and explicit-offset ISO/RFC3339 forms. The implementation treats timezone-free SQLite store timestamps as UTC. It does not emulate locale-dependent or unusual JavaScript Date.parse spellings; qualification outside this supported timestamp profile remains open.

## Differential validation

The test oracle runs the actual original business-schema provisioning service against temporary roots, then installs actual original marker/journal schema and metadata. No production directory, key or database is accessed. Node 22.23.1 and its pinned ICU/CLDR profile are checked in the test output.

The native test symbols are:

- `actual_ten_database_pristine_observation_and_cross_bindings_match_node`: all ten actual databases in pre-rebind, post-rebind and adoption phases; complete inspection objects, policy hash and runtime hash; source database bytes unchanged.
- `pristine_observer_rejects_real_corruption_and_business_rows_at_matching_node_stage`: migration, metadata, resources, handoff, topic, missing-column, refresh, lease, business-row and online-journal/head corruption, with exact original failure stages.
- `real_native_receipt_ledger_causality_hashes_and_raw_member_order_match_node`: real v2/v3 ledger writes, Unicode/path quoting, safe numeric spellings, missing causal backup, member-order rejection and explicit duplicate-member tightening.
- `actual_external_genesis_requires_pinned_documents_two_signatures_and_persisted_binding`: actual two-key signed genesis, bad signature, shared subject, unauthorized role, expiry, persisted-envelope splice, payload-hash drift extra-key rejection, and JavaScript numeric-subject coercion. Only the original document loader is replaced at the project's established test-double seam; the original cryptographic/state validator runs unchanged.
- `ordinary_tables_hidden_by_legacy_like_wildcard_never_yield_pristine_evidence`: actual populated ASCII, case-varied and Unicode user-table names which Node omits but native rejects.
- `actual_snapshot_scope_table_limits_and_caller_transaction_are_enforced`: actual divergent global head, excessive table count and preservation of an existing caller transaction.

The module is integrated as `pristine_runtime_state`. All six differential test groups passed in the actual workspace (70.29 seconds), including the three hidden-user-table rejection cases. Strict production Clippy passed against the integrated module; test Clippy and both oracle ESLint checks also passed during the isolated validation. These local checks do not close the overall Node-retirement gate.
