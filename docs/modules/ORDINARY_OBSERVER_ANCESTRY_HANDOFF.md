# Ordinary observer selected-ancestry continuity

## Scope and defect

The ordinary SQLite read-only observer previously retained `FullIdentity` for
every ancestor, including `/tmp` and `/`. Creating or removing an unrelated
sibling changed directory timestamps, size or link count and rejected an
unchanged selected database. A test-only fixture lifecycle mutex and isolated,
serial test runs did not establish normal parallel behavior.

The regression opens a real SQLite database at an owned temporary path, creates
an unrelated directory beside its database parent, proves the ancestor metadata
changed, and verifies the retained actual observer. This is not a mock of the
guard or an immutable-mode substitute.

## Security boundary

The immediate database parent still uses full held/named metadata, including
mtime/ctime and link count. Coordination preparation still permits only the exact
NoReplace WAL/SHM leaf delta. Main/WAL/journal identity, bytes and hashes, sidecar
presence, requested canonical target, read transaction, query-only mode, read
budgets, cancellation and absolute deadline are unchanged.

Higher ancestors keep device/inode, type/mode and owner/group checks. Descriptor
`fstatfs` admits selective-event comparison only on local tmpfs, ext-family, XFS
and Btrfs. Network, FUSE, overlay and unknown filesystem ancestors retain the
original full metadata guard; an installed watch alone does not establish coverage
of remote or lower-layer changes. A retained,
nonblocking close-on-exec inotify observer watches each held ancestor descriptor
through `/proc/self/fd`, selecting only the next path component. Self events,
selected-child changes, watch removal, unmount, overflow or unknown watches are
fail-closed. A rejected witness stays rejected even after its event queue drains.
Unrelated child events alone are allowed; timestamps and link counts are no
longer being treated as selected-object content identity.

The witness is installed and verified before held database/sidecar capture and
SQLite open, then checked before and after directory metadata checks and again
after file hashing. It does not claim SQLite opens the retained descriptor.
Event processing checks cancellation/deadline and is bounded to 4096 events and
64 reads per checkpoint. Event floods or unavailable watches refuse rather than
silently dropping continuity requirements. Resources close with the read handle.
Cancellation during event draining can discard the rest of an already-consumed
kernel batch, so that witness remains invalid even if cancellation is cleared;
the caller must reopen. Cancellation detected before draining does not discard
events. Other Unix targets keep the old full-ancestor metadata policy instead of
claiming selected-event continuity without a supported kernel witness.

## Verification and qualification

Regression owners cover real unrelated sibling creation/removal/rename, multiple
concurrent readers and sibling lifecycles, selected ancestor rename/restore,
replacement and symlinks, changed and restored permissions, unchanged strict
immediate-parent behavior, real main-file mutation and new WAL refusal, watch
loss and event-flood refusal. Existing actual Node differential, live WAL,
WAL-commit invalidation, cancellation, SQL interruption and deadline tests remain
required. The obsolete global fixture lifecycle mutex is removed rather than
used to hide ancestor interference.

This change makes no claim of full-workspace, hosted, target-host or production
qualification. Exact-head broader gates remain independently required.

## Change-accounting no-delta record

- Static status, backlog, parity state and dependencies: no promotion or closure
  of broader routes; this is a scoped observer correctness/usability repair.
- TCB/principal matrix: no new principal or authority. Existing Linux filesystem
  observation gains inotify watches on already held ancestors; installation or
  observation failure refuses the operation.
- Risk/operator impact: unrelated ancestor activity is accepted; selected path
  changes and incomplete observation still require reopening a fresh reader.
  Extremely busy ancestors can hit a bounded observation refusal.
- Crash/recovery: no journal, mutation, recovery or coordination-cleanup change.
- External package contracts: no public API/wire-format, package, lockfile or
  production Node change. Existing `DatabaseChanged` and native budget refusals
  remain infrastructure refusals rather than semantic reports.
- Required check contexts and qualification invalidation: unchanged. Scoped
  tests are evidence for this source revision, never a hosted qualification.

## Recorded local verification

On the reviewed integration base `4c50f37e63a7d16796a6b36dd75a91f66c1d816b`,
the new default-`/tmp` regression failed the unchanged guard with
`DatabaseChanged` after only unrelated sibling creation. The fixed source passed
48 scoped Rust tests (42 unit and six integration, zero ignored) using the normal
parallel harness and `TMPDIR=/tmp`. No private temporary-root override or global
fixture serialization was used. The suite includes the existing actual Node
v22.23.1 differential and live-WAL/currentness checks.

Strict crate-scoped all-target/all-feature Clippy, whole-workspace formatting,
static program-truth validation and 31 qualification-contract tests also passed.
An independent source review found no remaining blockers. Cross-platform native
builds and filesystem implementations beyond this Linux tmpfs fixture environment
were not executed; the fallback behavior is covered by policy/guard tests and
source review. The full workspace and exact-head hosted matrix were not run.

## Source identity and evidence binding

The native-business compiled implementation identity includes both the Linux
selected-name witness and the conservative non-Linux fallback source. The
production-composition source bundle pins both helpers and registers the exact
Linux witness and ordinary-reader ancestry regression owners. The merged
source needs fresh exact-head execution; the earlier scoped results above do
not qualify a later combined worker/observer source tree.
