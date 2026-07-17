# Operations

Use `npm run hepta-paper -- <operator|verify|retirement> <command>` as the
supported operator surface. `npm run scripts:surface` prints the complete
operator, verification, maintenance, retirement, compatibility, experimental
and internal classification. Maintenance commands rewrite accepted repository
evidence; compatibility and experimental scripts are not production operator
entrypoints.

## Before running campaigns

```bash
npm run store:migrate
npm run store:status
npm run automation:status
npm run safety:all
```

The current schema is 23. Migrations 021–023 provide job lease generations,
campaign attempt/generation/revision fencing with recoverable prepared results,
and restore-qualified workspace retention plus atomic workflow projections.

These migrations require an offline worker cutover. Do not run a rolling
old/new-worker deployment across schema versions 20 and 23:

1. Stop every job, campaign, automation, and submission worker using the DB.
2. Let outstanding leases expire or clear them through the supported recovery
   command, checkpoint and close the old store, then verify there are no job,
   campaign, delivery-outbox, or response-consumption lease markers left.
3. Run `npm run store:migrate` while workers remain stopped. Its first pass is
   read-only: an outstanding lease or active WAL sidecar rejects the cutover
   before the database schema or bytes are changed.
4. Run `npm run store:status` and verify `schema_migrations` contains the
   hash-matched versions 21, 22, and 23 (current schema 23).
5. Restart only workers built from the new release.

Migration 023 intentionally does not invent ledger evidence for pre-existing
`workflow_states` rows. Those legacy rows have no `ledger_receipt_id` and fail
closed after upgrade. If an operator still needs the non-authoritative legacy
projection, rebuild it explicitly after the cutover with
`npm run compat:legacy-workflow-projection -- --mode <MODE> --paper <SLUG> --execute`;
do not backfill receipt ids or hashes with SQL. A rebuilt projection is usable
only when its canonical receipt and the registered `workflow-state-projector`
ledger row commit together.

Scoped automation, batch, and submission roots fail startup when any of
migrations 021–023 is absent or has a mismatched history hash. The explicit
legacy compatibility root remains available for offline compatibility work;
it is not a production worker escape hatch. Writable roots, including the
legacy facade, never run migrations implicitly: initialize or upgrade with
`npm run store:migrate` first.

Start or inspect automation with `paper:campaign`. The campaign SQLite DAG is
the sole execution authority. `final-compile` is followed by a formal `package`
node; successful automation produces an immutable `CampaignReleaseBundle` for
separate submission verification. The bundle is only prepared while its node
is running. The same fenced SQLite transaction that completes the integrated
package attempt writes its hash-bound current-release authority; submission
consumes that typed authority lookup, never a loose bundle. It never grants
live-submission authority.

After a campaign completes, verify the handoff from an independent submission
root with an explicit campaign identity:

```bash
npm run paper:submission-handoff -- \
  --campaign-id <completed-campaign-id> \
  --root <submission-root> \
  --runtime-root <shared-runtime-root>
```

This command is always read-only and emits `CampaignReleaseSubmissionInput`.
It re-reads the immutable release bundle and package artifacts after authority
validation, does not consult the campaign attempt workspace, and performs no
provider dispatch or other external action.

## Safety behavior

- Planning and dry-run commands do not create a database or run migrations.
  They write no report unless the caller explicitly selects `--write-report`.
- `--write-report` writes only the scoped `reports`, `report-artifact-cas`, and
  `report-receipts` trees. Report receipts use descriptor-fenced immutable CAS
  materialization and are local provenance, not trusted business-ledger rows.
  The default immutable preview rejects an active SQLite WAL/SHM; checkpoint
  and close writable workers before running it.
- Cancellation propagates to the child process group. Fenced integration
  rejects late results after cancellation or lease loss.
- A snapshot remains protected until restore verification is persisted and
  retention qualification commits.
- Backup GC requires trusted backup and restore-drill ledger evidence, keeps at
  least two generations, and uses durable intent → delete → tombstone recovery.
- Scoped file materialization requires descriptor-relative filesystem access
  through Linux `/proc/self/fd` or an equivalent `/dev/fd`. Stale-lock recovery
  binds the PID to its process start time (from `/proc/<pid>/stat`) so PID reuse
  cannot inherit a lease. Platforms without an equivalent descriptor path, or
  without enough identity evidence to prove a stale owner, fail closed before
  source integration or lock reclamation.

## Verification

```bash
npm run reference:integrity
npm run reference:selftest
npm run reference:runtime-dry-run
npm run safety:p0
npm run safety:p1
npm run safety:p2
npm run safety:all
npm test
npm run release:verify
```

`reference:baseline:accept` rewrites the accepted vendored-reference baseline
and is never a routine verification command. Use it only for an explicitly
reviewed reference-package update.

## Recovery and retention

```bash
npm run automation:reconcile
npm run automation:workspace-backfill
npm run store:backup
npm run store:restore-drill
npm run store:logical-integrity
```

Audit the existing runtime tree before or after a deployment with:

```bash
npm run runtime:permissions
```

This is read-only by default. It reports every planned owner-only permission
change, already-compliant entry, blocker, an inventory hash, and a hash-bound
receipt on stdout. Review that output before applying the same policy with:

```bash
npm run runtime:permissions -- --execute
```

The execute path sets directories to `0700`, ordinary files to `0600`, and
files that already required execution to `0700`. It uses descriptor-relative
`fchmod`, refuses symbolic links, special files, multiply linked files and path
escapes, and applies nothing when the initial audit has a blocker. The command
never follows a link or writes a receipt into the tree it is auditing. Retain
the stdout receipt in the operator's normal protected evidence sink. Do not
substitute `runtime:hygiene`: that separate command classifies legacy database
evidence and is not a permission repair command.

Run the `:execute` automation variants only after reviewing their dry-run
output. Historical retirement modules are not operational entrypoints; their
supported checks are `migration:salvage-selftest` and
`migration:retirement-status`. The non-authoritative legacy workflow projection
is isolated behind `npm run compat:legacy-workflow-projection`; it is never
loaded by `paper-production-core` or the supported operator graph.
