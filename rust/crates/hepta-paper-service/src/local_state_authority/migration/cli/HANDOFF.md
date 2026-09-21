# Offline authority journal CLI

`hepta-paper-state-authority-journal` exposes `inspect` and
`export-native-image` through `run_authority_journal_cli_v1`. Both require an
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
uses the complete bounded history verifier; export builds the detached native
image from the same authenticated snapshot. All success and error paths roll
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
bundle contains `authority.sqlite` and `report.json`, both `0600`. Its own
source-configuration paths remain unchanged as signed data. Export does not
rewrite a source journal or prepare a relocated daemon configuration.

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
Owning-source tests inspect `/proc/self/fd` without opening source descriptors
and confirm no source-family handle remains after success or refusal. Publisher
tests exercise actual no-replace conflicts and post-rename failure retention.
These are source tests, not target-filesystem crash durability qualification.

Source-history limits and refusal policy remain those in the
[history contract](../history/HANDOFF.md). An exported native image is an offline
artifact. A durable original-source archive, live logical CAS, real service-stop
and persistent restart barrier, installed principal/key qualification,
uncertain-migration recovery and native service handoff remain separate work.
Neither command grants migration permission, production activation or Node
retirement.
