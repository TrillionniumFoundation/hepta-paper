# Native runtime publication status reader

The public `read_runtime_image_reproducibility_publication_v2` remains a
read-only diagnostic consumer of an explicit `ReceiptVerificationContext`.
It now delegates to private `publication_read.rs`. Writer schema, authority,
offline publication and online mutation helpers in `publication.rs` are
unchanged. No caller report is promoted to verified installation or activation.

The new status path observes the real main file and effective committed WAL
using the existing `with_database_effective_snapshot_path_v1` owner. SQLite
opens only an owned private copy. Original source SHM is observed for identity
and bytes, while any SHM SQLite needs to initialize belongs to the private
snapshot. Nonzero rollback journal headers are refused instead of recovering
the source. A snapshot is a bracketed observation, not an atomic multi-file
snapshot; concurrent source changes can cause refusal.

## Ownership and SQLite ordering

1. Preserve the original missing-database return and `paths()` initial checks,
   including an existing unsafe mirror or sidecar before an authority lookup.
2. Retain the actual private source parent and O_PATH pins for main, WAL, SHM and
   rollback journal, including absence observations. Check the original
   **effective UID**, no group/other writes, nlink 1, regular-file type and
   256 MiB per-source bound. The parent retains its effective-UID/private-mode
   policy. Full file metadata includes device/inode, UID/GID, mode, links, size,
   mtime and ctime. Recheck held and named sources around the private callback
   and before return. O_PATH pins do not read file bytes or create the regular
   FD close hazard associated with process-scoped POSIX SQLite locks.
3. Read the real mirror by descriptor-relative no-follow/nonblocking open,
   bounded to 32 MiB plus one detecting byte; verify original metadata and
   namespace, then **close its regular FD before SQLite**. Only bytes and
   metadata remain. Capture errors are deferred until a validated authority
   row actually exists, preserving absent-authority/missing-mirror precedence.
4. The existing snapshot helper owns source regular descriptors, hashes/copies
   actual main/WAL, checks namespace/content before and after the callback, and
   owns temporary cleanup. It limits each file to 256 MiB and aggregate source
   files to 1 GiB. The generic helper is used deliberately: the alternative
   current-real-UID helper would incorrectly substitute getuid for the original
   runtime publication geteuid policy. The new O_PATH policy checks effective
   UID on actual main **and sidecars** before/after, including inside the
   callback before SQLite opens.
5. Open only the private SQLite path, validate/query the bounded ordinary table,
   and drop every statement/connection before callback return. The callback's
   explicit `drop(connection)` also covers successful/error authority parsing;
   Rust unwinding through earlier Result errors drops the connection first.
   Snapshot copies/source owners are closed/cleaned only after that return.
6. Compare exact mirror bytes and parsed value to the original authority,
   run the unchanged actual receipt signature/context verifier, then recheck
   mirror namespace metadata and source pins. Return the original receipt,
   inspection, receiptContentHash and publicationGeneration fields.

The caller must run this observer **before opening any caller-owned business
SQLite connection or database descriptor**. Source hashing/copying still owns
regular descriptors, so observing a source alias and later closing its FD could
release unrelated process-scoped POSIX locks if that precondition is ignored.
This function does not support nested observation during a caller transaction.
Neither metadata bracketing nor retained descriptors prevent noncooperating
same-UID changes, establish ongoing currentness, or provide an atomic snapshot.

## Status-only bounded SQLite profile

The private connection is readonly/query-only with trusted_schema disabled;
no repair, DDL, checkpoint, lease, mutation authority or source SQLite open is
performed. It permits at most 128 schema entries, 64 columns, 64 KiB per schema
SQL entry, bounded names and no generated/hidden target columns. The target
must be an ordinary CREATE TABLE, not a view or virtual table. Other schema
entries are bounded and not treated as independent authority. Required columns
must exist. An absent target retains the existing database-invalid error.

A fixed query checks at most two matching singleton rows; duplicate rows are
refused. Receipt text is bounded to 32 MiB, four metadata text fields to 4 KiB
each, and publication_generation must have the original SQLite integer type.
The original `authority` helper then performs the unchanged JSON parser,
receipt own-hash/content-hash, timestamp-field and generation checks. SQLite
row/cell length is limited to 32 MiB + 64 KiB, SQL text to 512 KiB, expression
depth to 100, attached databases/worker threads to zero. A progress handler
interrupts after approximately 10 million VM operations; busy timeout is one
second on the owned copy. These limits are a documented narrower profile for
nonstandard schemas/oversized unrelated metadata, not a claim to accept every
possible SQLite database previously readable by the unbounded path.

Original runtime errors from the authority/parser/verifier are preserved.
New status-only refusals include
`runtime_reproducibility_receipt_schema_unsupported` and
`runtime_reproducibility_receipt_rollback_journal_pending`. Source unsafe/limit
errors map to the original file-invalid code, and source/copy/namespace snapshot
failures map to the original database-changed code. Runtime errors raised inside
the callback retain their original code. Failed observations do not repair or
publish anything and do not imply an absent or uncommitted authority row.

## Verification and limits

Private tests in `publication_read_tests.rs` use owned ordinary files/databases
only: target-view/generated-column/duplicate-row refusal; actual schema count
and metadata-size limits; original main same-inode modification; actual sidecar
and parent replacement; effective-UID metadata on original O_PATH owners and
unsafe sidecar mode refusal; mirror FIFO/symlink/oversize and same-size drift.
They do not claim a production UID installation, snapshot atomicity, or any
independent verifier acceptance. They were added without executing Cargo in the
implementation agent; root coordinates test execution and records results.

Root's separate actual Node/publication fixture covers real synthetic Ed25519
receipt validation, committed WAL versus main-only state, missing source SHM,
source-byte preservation, missing-authority/mirror precedence and the full
public observer. Constructed signed evidence validates the reader/algorithm;
it is not evidence of a real runtime rebuild or independent production
qualification. This change does not alter status composition's code-environment
policy, repair the external-action recovery trust contract, or enable resident
fully-autonomous health.
