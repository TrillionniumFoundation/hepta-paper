# Offline authority journal CLI

`hepta-paper-state-authority-journal` exposes `inspect`, `export-native-image`
and `export-legacy-archive` through `run_authority_journal_cli_v1`. All require an
explicit daemon configuration path and SHA-256 pin plus an independently pinned
online configuration. The source database path comes only from that daemon
configuration. The configured private-key path is protected as a name but is
never opened. The online configuration pins the actual Ed25519 public-key file.

```text
hepta-paper-state-authority-journal inspect \
  --daemon-configuration /absolute/daemon.json \
  --daemon-configuration-sha256 sha256:<reviewed-daemon-file-digest> \
  --online-configuration /absolute/online.json \
  --online-configuration-sha256 sha256:<reviewed-online-file-digest>

hepta-paper-state-authority-journal export-native-image \
  --daemon-configuration /absolute/daemon.json \
  --daemon-configuration-sha256 sha256:<reviewed-daemon-file-digest> \
  --online-configuration /absolute/online.json \
  --online-configuration-sha256 sha256:<reviewed-online-file-digest> \
  --output-directory /separate-private-parent/fresh-bundle

hepta-paper-state-authority-journal export-legacy-archive \
  --daemon-configuration /absolute/daemon.json \
  --daemon-configuration-sha256 sha256:<reviewed-daemon-file-digest> \
  --online-configuration /absolute/online.json \
  --online-configuration-sha256 sha256:<reviewed-online-file-digest> \
  --output-directory /separate-private-parent/fresh-original-archive
```

The examples contain digest placeholders, not usable pins. Digests must contain
exactly 64 lowercase hexadecimal digits after `sha256:`. All paths must be
absolute canonical names. Inline `--key=value` is supported. Duplicate, unknown,
empty, non-UTF-8, extra positional and `--` separator arguments fail. All supplied
arguments are validated before `--help` can return without source I/O. An output
directory is required for export and refused for inspection.

## Owning source observation

The source adapter loads and retains all regular-file configuration/public-key
pins before SQLite opens. It captures the complete source ancestor identities
and uses only namespace metadata to observe the main file and any existing
WAL/SHM/rollback-journal names. Observed files must be regular, single-link and
not symlinks. No raw source-family file descriptor is opened for hashing or
cloned while SQLite owns its locks.

SQLite opens read-only with `NOFOLLOW`, enables `query_only`, uses a five-second
busy timeout and begins a deferred transaction. A main-schema query establishes
the actual main snapshot before the signed-history verifier runs. Inspection
uses the complete bounded history verifier. A closed internal mode selects
either the detached native image or the original-format SQLite backup archive
from the same authenticated snapshot. The latter calls
`build_offline_legacy_archive`, copies every source page using SQLite's backup
API into memory and re-verifies the copied history before serialization. It
does not copy just the main source file or patch journal-mode header bytes.
All success and error paths roll
back any active read transaction and explicitly close SQLite before retained
input pins are dropped or the filesystem publisher can run. A failed explicit
close drops its returned connection before reporting failure. Retained pins,
ancestors and the main name are checked again after successful close.

The inspection JSON has kind
`HeptaLocalStateAuthorityNamedJournalObservationV1`, scope
`named_source_snapshot_no_maintenance_authority`, the configured `sourcePath`,
`sourceConnectionClosed: true`, `sourceLogicalDataWritten: false`, the observed
device/inode/uid/gid/mode, and the complete `history` report. This is a before/after
observation of the named namespace, not proof of the exact descriptor opened by
SQLite or an atomic binding between that descriptor and a pathname. It does not
prove that a writer stopped or bind a production source incarnation. Read-only
logical data does not mean SQLite cannot manage shared-memory read marks or
sidecar lifecycle. Sidecars are checked before close because normal SQLite
close can remove its own sidecars.

## Export and errors

The [private bundle publisher](publication/HANDOFF.md) runs only after the source
connection closes. The final directory must be fresh under an existing private
`0700` parent. It must be separate from every protected input namespace,
including the entire source parent; export into that parent is refused. The
native bundle contains `authority.sqlite` and `report.json`, both `0600`; this
existing command's report and stdout contracts are unchanged. The legacy
archive bundle contains `legacy-authority.sqlite` and `report.json`, also
`0600`. It preserves the original Node schema and `user_version=0`, every SQL
value/rowid/raw TEXT, and the complete copied page allocation. Its own
source-configuration paths remain unchanged as signed data. Neither export
rewrites a source journal or prepares a relocated daemon configuration.

The legacy bundle report has kind
`HeptaLocalStateAuthorityOfflineLegacyArchiveBundleV1`, scope
`offline_original_format_archive_no_migration_or_restore_authority`, an
`archive` equal to the verified archive's full report, and
`sourceNamespaceObservation` equal to the actual closed source observation.
The archive report includes the actual source/archive logical hashes, source
schema hash, original-format byte hash/length, complete signed history, page
size/count and journal header mode. Success stdout has kind
`HeptaLocalStateAuthorityOfflineLegacyArchivePublicationV1`, scope
`offline_original_format_archive_no_live_migration_authority`, and
`publicationCommitted`, `outputPath`, `archivePath`, `reportPath`,
`archiveSha256`, `reportSha256`, `archiveByteLength`, `reportByteLength`.

A WAL-format archive is a complete backup image containing the selected
snapshot, including committed pages that existed only in the source WAL.
Its `[2,2]` journal header remains unchanged. Reopen it as an ordinary SQLite
file; do not feed that form directly to SQLite's memory-deserialize API. SQLite
may manage sidecars for the new archive file. It is not an archive of the
original physical WAL/SHM family, source inode or filesystem metadata, and its
content hash is not claimed to equal the source main-file hash. The archive's
192 MiB page-image bound includes freelist allocation and is not a process-RSS
limit. See the [archive contract](../archive/HANDOFF.md).

Ordinary success is one JSON object on stdout. Failures exit 1 with one JSON
object on stderr preserving `code`, `details`, `retryable`,
`stateRecoverabilityFatal` and `stateRecoverabilityDeferred`. Publication errors
retain `details.publicationCommitted`: false before a known uncommitted failure,
true after a successful rename, and null when rename outcome is uncertain.
The latter two require inspection of the retained final/staging namespace;
they never trigger deletion of a final artifact or automatic retry. Losing
stdout or terminating the process can also lose the result after publication;
an absent result alone is not proof that export did not occur.

## Verification and remaining scope

Actual Node fixtures exercise uninitialized state, two activated rebinds,
multidatabase mutations and an aborted tail. Integration tests run the actual
binary, remove the unused fixture private key, compare every preserved SQL
value/rowid and the native schema/identity, verify bundle hashes, and test pins,
pending/backup refusal, path aliases, argument rejection and output collisions.
Archive tests additionally compare original schema/all six tables, open the
new file with the actual qualified Node SQLite implementation, and exercise a
genuinely uncheckpointed committed WAL change behind an older reader. The new
snapshot is exported while that older reader still sees the old raw TEXT;
no raw source main/WAL file is opened or hashed during those SQLite lifetimes.
Owning-source tests inspect `/proc/self/fd` without opening source descriptors
and confirm no source-family handle remains after either export or refusal. Publisher
tests exercise actual no-replace conflicts and post-rename failure retention.
These are source tests, not target-filesystem crash durability qualification.

The 2026-09-21 extension passed the combined owning-source/publication library
suite (11 tests, 1.51 s), the real journal CLI integration target (11 tests,
4.82 s: six existing tests and five archive tests), and strict Clippy for the
library plus that integration target (15.16 s). Fixtures used the qualified
Node 22.23.1 profile; the new Node archive reader also passed its syntax check.

Source-history limits and refusal policy remain those in the
[history contract](../history/HANDOFF.md). An exported native image is an offline
artifact. The original-format export also remains an offline artifact, even
after its fresh bundle is published. A live logical CAS, real service-stop
and persistent restart barrier, installed principal/key qualification,
uncertain-migration recovery and native service handoff remain separate work.
None of these commands grants migration/restore permission, production activation or Node
retirement.
