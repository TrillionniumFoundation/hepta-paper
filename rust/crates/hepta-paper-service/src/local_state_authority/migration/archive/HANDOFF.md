# Verified original-format authority archive

`LegacyAuthorityJournalVerifierV1::build_offline_legacy_archive(&Connection)`
produces an `OfflineLegacyAuthorityArchiveV1` with read-only `bytes()` and
`report()` accessors. It has no public constructor, destination-path argument,
deserializer, filesystem publisher or maintenance capability. Unlike the native
image builder, this operation retains the original Node schema and version 0.
The [offline CLI](../cli/HANDOFF.md) separately exposes `export-legacy-archive`:
it closes source SQLite before publishing the opaque archive in a fresh private
bundle as `legacy-authority.sqlite` plus `report.json`. This method itself still
does not publish files or grant restore/migration permission.

The existing pinned owner must be loaded before source SQLite opens and retained
until source SQLite closes. This method requires an already established main
READ transaction. Autocommit, bare deferred transactions and main WRITE
transactions fail. SQLite backup cannot copy from its own active writer, so
archive construction must precede the eventual live migration write transaction.
The method does not change source settings, start/end its transaction, load a
private key, open source-family descriptors, sign receipts or invoke transport.

The owner first performs complete source-schema, configuration/public-key and
signed-history verification. All original admission limits apply, including
refusal of pending operations, every backup row and unsupported histories. It
then copies the same held snapshot using rusqlite's safe `Backup` API into a
fresh, private memory database. Destination page size matches the actual source
page size, from 512 through 65,536 bytes. The full physical page allocation,
including freelist pages, must fit 192 MiB before copying begins; the destination
maximum page count is set accordingly. This is an image bound, not a total RSS
bound: verified rows, SQLite caches, serialization and returned bytes coexist.

Each backup step copies at most 128 pages. Its reported total must equal the
held source page count, remaining pages must strictly decrease, and only
`Done` with zero remaining pages finishes successfully. Busy, locked, unknown
states, inconsistent progress and any SQLite error refuse the archive without
retry. No destination API is called until the backup owner drops. rusqlite
0.40.2 calls `sqlite3_backup_finish` exactly once in that owner's destructor;
every accepted operation has already reached `SQLITE_DONE` with no step error.
The [SQLite backup contract](https://sqlite.org/c3ref/backup_finish.html)
defines destination completion and finish behavior.

After backup completion the same pinned verifier establishes a real read
transaction on the copied database and fully replays its history. Its entire
history report must equal the source report, including exact logical digest,
schema digest, row counts and every reconstructed head. The memory read
transaction then closes. Safe SQLite serialization must have the complete
page-count byte length and valid SQLite header. Original read/write format
bytes are preserved: either `[1,1]` or `[2,2]`, reported respectively as
`journalHeaderMode: rollback` or `wal`. No source or output bytes are patched.

The WAL form is a complete SQLite backup image containing the copied snapshot's
committed pages; it is not a copy of the original main file without its WAL.
It reopens as an ordinary SQLite file without the original source sidecars.
SQLite can manage sidecars for that new file. SQLite's in-memory deserialize
API cannot directly consume WAL header mode unchanged; consumers must not
mistake this artifact for a rollback-format memory image. See the
[SQLite deserialize limitation](https://sqlite.org/c3ref/deserialize.html).
Physical file identity, original WAL bytes, original filesystem metadata and
historical file layout are not claimed to be preserved by a backup image.

The report has kind `HeptaLocalStateAuthorityOfflineLegacyArchiveV1`, scope
`offline_original_format_archive_no_publication_authority`, format
`sqlite_backup_image`, source/archive logical hashes, source schema hash,
row counts, complete source history, page size/count, journal header mode,
archive hash/byte length, version 0 and `backupComplete: true`. These facts are
observations of the copied snapshot, not signed permission to publish or restore
it. Source transaction state, total changes and retained pins are rechecked
before returning.

Four actual Node fixture tests cover complete original-format reopening by
SQLite and the original Node authority for uninitialized, genesis, activated
rebind, multirole and aborted-tail histories; concurrent old/new snapshots with
genuinely uncheckpointed committed WAL content; pending/wrong-key/write-state
refusal and retained writer exclusion; and 512/16,384-byte page sizes plus an
oversized freelist in an otherwise valid original journal. Tests reuse the
existing offline-image fixture helpers in `../offline_image/tests/legacy_archive.rs`.

The offline publisher does not establish live source provenance. A maintenance-bound
archive/source expected-hash comparison,
real retained service stop/restart barrier, source installation/key provenance,
uncertain-commit recovery and native service handoff remain unimplemented.
An offline archive or a successful original Node reopen is not permission to
restart Node after live migration. The
[maintenance-owner design](../MAINTENANCE_OWNER_DESIGN.md) records that separate
boundary and the observed installed service's requirements.
