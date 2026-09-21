# Legacy authority journal history observation

`migration::LegacyAuthorityJournalVerifierV1` implements read-only verification
of a bounded, settled original Node authority journal. It authenticates an
observed history against independently pinned configuration and a real Ed25519
public key. It does not migrate a journal, grant writes, sign receipts, establish
file provenance, stop a service, or establish production acceptance.

## Inputs, custody and lifetime

Call `load(daemon_configuration_path, expected_daemon_file_hash,
online_configuration_path, expected_online_file_hash)` before opening the source
SQLite connection. Both paths and hashes are explicit. Retain the verifier until
after that connection closes. Loading uses the existing no-follow, single-link,
owner/mode/size and byte-hash `Snapshot` loader. The independently pinned online
configuration selects a separately byte-pinned public-key document with exact
authority/key IDs and the real Ed25519 SPKI key. Its complete trust fields must
equal the daemon configuration with its three private installation paths removed.

The daemon configuration is at most 1 MiB and uses the same strict structural
validator as native runtime startup. Validation of `privateKeyPath` is textual;
the inspector never opens that key or any configured daemon database/socket.
Its transport implementation always errors and is never invoked. Input identity
is checked before and after observation using retained file metadata and named
namespace observations, without opening or cloning another source descriptor.
The supplied file hashes pin bytes; their presence does not establish deployment
approval or that a caller's chosen files belong to the live authority.

`inspect(&Connection)` requires a real held READ or WRITE transaction on `main`.
It first performs the exact original [schema inspection](../source_profile/HANDOFF.md),
including current SQLite-setting checks and `quick_check`, then reads all six
tables from that same snapshot. No statement changes PRAGMAs or rows; statement
`readonly()` is checked before stepping. The method never begins, commits or
rolls back the transaction. Transaction state and `total_changes` must remain
unchanged. The caller still owns source connection/path provenance, schema-cache
history, extensions and authorizer policy; this borrowed-connection API does not
independently authenticate those facts or a running service's current state.

## Bounded exact SQL snapshot

`source_rows.rs` uses source-owned table/column names with explicit `main` and
`ORDER BY rowid`. Every row contains the signed-table's original SQL values and
rowid; JSON TEXT remains byte-for-byte intact before parsing. Only NULL, INTEGER
and valid UTF-8 TEXT are admitted. Individual TEXT cells are at most 1 MiB,
aggregate raw cell payload at most 64 MiB, and row limits are 1 metadata, 10 heads,
1 initial transition, 64 rebinds, 10,000 mutations and 1 backup. Exceeding a limit
refuses the entire observation; it never yields a truncated successful history.
Every backup row is refused, so collecting one suffices to detect its presence.

These are first-version compatibility bounds. In particular the mutation wire
contract allows changesets larger than this inspector's 1 MiB persisted-cell
limit. Such valid larger journals require a future streaming implementation or
explicitly revised resource profile and are not reported as verified here.
Limits bound copied raw payload; SQLite scans, parsed JSON and signature/hash
work have additional time/memory costs and no wall-clock deadline in this API.

`sourceLogicalHash` uses SHA-256 over this exact framing, not normalized JSON or
SQLite main-file bytes: ASCII `HeptaLocalStateAuthorityLegacySqlRowsV1` followed
by NUL; table count as little-endian u64; each table's name and comma-separated
column list, each framed by byte length as little-endian u64; for each row a
byte `1`, then each cell as tag `0` for NULL, tag `1` plus little-endian i64 for
INTEGER, or tag `2` plus length-framed original UTF-8 for TEXT; finally byte `0`
and little-endian u64 row count for that table. Table order and column lists are
the source-owned `TABLES` constant. Raw whitespace, rowid, SQL values or receipts
changing therefore changes this digest even if signed JSON meaning is identical.
The separate source schema hash binds the exact admitted structural profile.
No digest in this report is a WAL/archive file hash or a migration permit.

## Authenticated replay

The pure [schema history verifier](../schema_history/HANDOFF.md) checks complete
request/receipt pairs, SQL identities, historical signatures and deterministic
initial genesis, then one unique content-linked activated pristine-rebind chain.
Only writer-manifest transitions supported by the incumbent rebind producer are
reconstructed. Its final epoch must reproduce the current complete configuration.
Pending schema reservations and finalized-but-unactivated rebinds are refused.

The pure [mutation history verifier](../mutation_history/HANDOFF.md) starts from
that authenticated epoch, verifies every original request and receipt, recomputes
Node global/database/state/marker/permit hashes, and replays every finalized
mutation. An authentic abort is permitted only at the next-sequence tail, where
the original unconditional UNIQUE index prevented subsequent progress. Reserved
mutations are refused even when expired. A valid late authority finalization is
accepted when its actual local commit satisfies the original lease contract;
the implementation does not invent cross-row clock monotonicity.

The final global head and all ten database heads, including untouched roles,
must equal actual SQL metadata/heads. Current metadata must also match the full
daemon configuration hash and authority/key/scope/writer identities. Original
JSON is strictly parsed: duplicate fields and unsupported/ambiguous encodings
fail; individual signed contracts reject extra fields and unsupported values.
No handler is used as a validator and no historical receipt is re-signed.

An uninitialized journal is admitted only with its deterministic initial global
hash, no heads and no schema/rebind/mutation/backup history. Its report explicitly
says `uninitialized_no_signed_history`; the public-key pin supplies the selected
verification identity but cannot create a historical signature that never existed.

All backup rows remain unsupported because the incumbent could genuinely sign
a false uninterrupted-fencing claim. Valid signatures alone cannot repair that
history. The first-version refusal does not discard, relabel or rewrite it.

## Report and errors

The report kind is `HeptaLocalStateAuthorityLegacyHistoryInspectionV1` with
`evidenceScope=signed_history_observation_no_migration_authority`. It includes
schema/logical hashes, configuration hashes, public-key hash, per-table counts,
schema/rebind receipt hashes, mutation counts and reconstructed terminal heads.
It contains no key bytes, mutable SQL connection, verifier token or production
activation flag. Ordinary errors retain the existing non-retryable coordinator
error shape; failure does not authorize corrective writes or cleanup.

## Tests and remaining execution boundary

Actual Node 22.23.1 fixtures generate initial/rebound journals and signed
multirole mutation chains, including late finalization and an aborted tail.
Whole-owner tests remove the fixture private key before loading the verifier,
then authenticate with separately pinned public inputs. They cover pending
operations, wrong/changed pins and trust, terminal tampering, backup refusal,
unchanged source bytes and real DELETE/WAL cross-process writer exclusion after
both success and refusal. Submodule tests include genuinely signed but
non-incumbent hash derivations, broken chains, SQL-key transplantation, malformed
JSON, equivalent numeric encodings and resource-limit rejection.

Run from `rust` with the qualified Node on PATH:

```text
cargo test -p hepta-paper-service --lib local_state_authority::migration
```

This closes a read-only history-validation prerequisite, within the explicit
admission limits above. A durable archive, format conversion/publication,
uncertain-commit recovery, actual old-process stop/restart exclusion and native
installed-service handoff remain absent. See
[`JOURNAL_MIGRATION_DESIGN.md`](../../JOURNAL_MIGRATION_DESIGN.md). The normal native
runtime continues refusing populated Node version-0 journals.
