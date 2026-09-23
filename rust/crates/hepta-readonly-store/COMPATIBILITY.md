# Earlier logical-store diagnostic hashes

`logical_store_compat_v1` retains the pure row/table/store wire from
`codex/rust-all-gap-closure-v2-20260830`, source blob
`c9b9d7686a4c3ca46011ebd785690f4233ca04ac`. It accepts a current
`LogicalDatabaseSnapshotV1` and a caller-claimed database byte hash. It never
opens SQLite, reads/re-hashes source files, or changes an existing owner.

The earlier domains are `HeptaLogicalStoreRowV1`, `HeptaLogicalStoreTableV1`, and
`HeptaLogicalStoreSnapshotV1`. Integers become decimal strings, finite real
numbers become their 16-digit IEEE-754 bit strings, and blobs use lowercase hex.
Rows sort by their encoded bytes, retaining duplicate rows. Table names sort by
UTF-8 bytes. The original `NOT LIKE 'sqlite_%'` filter is reproduced, including
its case-insensitive ASCII comparison and wildcard underscore. The logical hash
excludes the copied database byte-hash claim and the current snapshot/schema
hashes. All legacy hashes are rebuilt from typed fields.

Only version-one observations with `user_version = 25` are accepted. A Node
migration-ledger database whose actual header is zero is not silently relabeled
as this historical schema-25 draft. Current canonical finite float strings and
lowercase even-length blob hex are required. The existing reader already rejects
non-UTF-8 SQLite text and non-finite real values; this projection does not widen
that profile. It cannot verify that the caller's values or claimed byte hash came
from a real database. Obtain observations with the current owner and its existing
source-preservation discipline, then project the data. This output is neither a
production Node logical hash nor an integrity/authority attestation.

`tests/logical_store_compat.rs` compares complete output to the original blob's
projection over an owned in-memory SQLite fixture, with duplicate rows, signed
64-bit boundaries, finite real bits, Unicode text, blobs, NULL, an empty table and
the original table-name filter. Additional checks bind actual row changes and
make claimed-byte-hash independence and unsupported profiles explicit. The frozen
vector is `tests/fixtures/logical-store-compat-v1.json`.
