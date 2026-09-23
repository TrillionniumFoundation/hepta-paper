# Detached native authority image

`LegacyAuthorityJournalVerifierV1::build_offline_native_image(&Connection)`
builds a standalone native SQLite artifact entirely in memory. Its only public
entry point is the existing owner loaded with the pinned daemon configuration
and independently pinned online configuration/public-key document. It first
performs the same complete source-schema and signed-history verification as
`inspect`, retaining the exact six-table SQL snapshot used by that observation.
No private key is loaded, no receipt is signed and no transport is invoked.

The source connection must already hold a real main READ or WRITE transaction.
The operation neither starts nor ends that transaction, changes its PRAGMAs,
writes source rows nor opens/clones/closes a source file descriptor. The owner
must still be loaded before opening the source connection and retained until
that connection closes. At completion it rechecks retained configuration/key
inputs, source transaction state and source `total_changes`.

The returned `OfflineNativeAuthorityImageV1` has private fields and only
`bytes()` and `report()` accessors. It has no deserializer, public constructor,
writable database handle, destination-path argument or publisher. Its report
has kind `HeptaLocalStateAuthorityOfflineNativeImageV1` and evidence scope
`offline_native_image_no_publication_authority`. Returning bytes does not
authorize replacing a live journal, stopping Node, taking maintenance control
or starting a native service. Existing signed configuration paths are preserved
as data; none is opened as an output.

The private builder creates a fresh `:memory:` connection, sets only that
connection's page size to 4,096 bytes, temp store to memory and maximum page
count to 49,152. The maximum complete artifact is 192 MiB. This is an output and
SQLite page-allocation bound, not an exact bound on total process memory: the
verified source rows, SQLite structures and serialized byte copies coexist.
Oversized inputs or images fail; historical rows are never dropped or truncated.

Within its own memory-only transaction the builder executes the embedded native
`schema.sql`, then inserts every original value through bound SQL parameters,
including all original rowids and unmodified JSON TEXT. Metadata, all ten
database heads and retained schema, rebind and mutation evidence remain intact.
As required by the first history contract, backup history is refused before
conversion. The native mutation table replaces the original unconditional
global-sequence uniqueness with the native partial live-sequence index; an
aborted tail remains present and no longer permanently consumes the next live
sequence. The new identity row contains the hash of the actual independently
pinned Ed25519 public key, and `user_version` is exactly 1.

Before committing the private memory transaction, the builder validates the
exact native schema, one correctly bound identity row, version and `quick_check`.
It reads all six preserved tables again with the same typed logical-hash
profile and requires an identical hash and row counts. It repeats native
validation after the memory commit, checks actual page size/count against the
byte limit, and uses rusqlite 0.40.2's safe `serialize(MAIN_DB)` API. The repository
enables that existing dependency's `serialize` feature; there is no new FFI or
unsafe allocation code. The serialized byte length must equal the complete
page count, and the SQLite header must advertise ordinary rollback-format
read/write versions rather than a missing WAL.

The report contains `sourceLogicalHash`, `nativeLogicalHash`, `publicKeySha256`,
`userVersion`, `imageSha256`, `imageByteLength`, `rowCounts` and the original
`sourceHistory` observation. Both logical hashes use
`HeptaLocalStateAuthorityLegacySqlRowsV1`: they cover exactly the preserved six
tables, rowids, SQL scalar types and raw TEXT. They intentionally exclude the
new schema and native identity row. `nativeLogicalHashScope` makes this explicit;
the hash of the complete serialized image covers those additions and the
SQLite format bytes. Physical page layout is an artifact property and is not
claimed to reproduce the source file bytes.

Tests use the actual Node runtime to create isolated signed initial/rebind and
multi-database mutation histories, including an aborted tail. They can write a
returned image back to that disposable fixture's original configured path only
after all original source handles are closed. A real native runtime can then
open the native-format fixture and continue reserving/finalizing while retaining
the original signed history. Such a test validates artifact usability and the
uniqueness repair; it does not establish production process isolation, a genuine
maintenance barrier or permission to publish a converted live journal.

A separate real WAL case keeps an old reader snapshot open while another
SQLite connection commits equivalent whitespace around a genuinely signed
request's original JSON. A passive checkpoint confirms committed frames remain
uncheckpointed. The old reader retains the old raw TEXT/hash, while a new source
reader and its converted image contain the new exact TEXT/hash. No raw main or
WAL file is opened during either snapshot. DELETE and existing WAL tests also
use a separate process to verify that conversion success and refusal preserve
the caller's actual SQLite writer lock.

The live migration requirements in `../../JOURNAL_MIGRATION_DESIGN.md` remain
open: actual old-service retirement and restart exclusion, source namespace and
installed-identity ownership, durable archive/publication, uncertain-commit
recovery, and independently qualified native service handoff. This API provides
none of those capabilities.
