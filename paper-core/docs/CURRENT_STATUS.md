# hepta-paper current status

This is the normative status for the `v0.20.3` architecture release. Older remediation,
phase and retirement documents are historical records and do not override it.

## Architecture

- `paper-domain` owns contracts and workflow vocabulary.
- `paper-application` owns execution context, workflow orchestration, use cases
  and reports.
- `paper-ports` owns infrastructure boundaries.
- `paper-adapters` owns persistence, providers, automation executors and other
  infrastructure implementations.
- `workflow-kernel` owns domain-neutral transition, hashing and runtime
  utilities.
- `paper-core` owns CLI composition, verification entrypoints and compatibility
  re-exports. Adapter and application production modules may not import it.

The preferred command surface is `npm run hepta-paper -- <operator|verify|retirement> <command>`.
The older npm scripts remain compatibility aliases for automation and historical receipts.

Contract implementations live only in `paper-domain/contracts`. The former
`paper-core/src/contracts` files are one-line compatibility re-exports.
Historical legacy-cleanup code lives only in the read-only
`migration/retirement` namespace; it is not a production batch mode.

## Trust and evidence

Trusted ledger writers are minted by the private issuer-policy registry. A
caller cannot become trusted by supplying a boolean or its own kind/stream
allowlist. Original receipt rows are append-only; corrections use replacement
receipts and qualification/supersession records.
Only the composition broker may import the mint function; architecture tests
enforce that boundary. Formal and experiment evidence is promotion-eligible
only when its execution, artifact and reproducibility receipts resolve through
the trusted effective-ledger projection; unsafe or incomplete execution stays
blocked.
Runtime hygiene is idempotent for already-qualified receipts, and store status
reports raw historical classifications separately from unresolved current
classification debt.

- Local-admin-delegated owner acceptance: 249/249 across 19 families.
- Independent external-owner acceptance: 0/249.
- Production-source-bound conformance replay: 14/14 after a release-bound
  replay is run.
- Independent production operational proof: 0/14 until distinct external
  owner and observer signatures are ingested.

Local conformance is intentionally not labeled production operational history.

## Legacy retirement

`/data/home-data/paper_factory` has been physically removed. The permanent
recovery/audit set is `/data/home-data/hepta-paper-legacy-reference`, including
the immutable source snapshot
`retirement-source-snapshot-2026-07-13`. Regeneration commands cannot overwrite
the frozen salvage manifest, and the old online legacy-cleanup/archive write
entrypoints are retired.

## Runtime

The native store is `runtime/hepta-paper.sqlite` at schema 19. Receipt rows and
qualification rows are protected by update/delete-deny triggers. Startup
reconciliation is explicit, idempotent and transactional. Workspace retention
requires registered lineage, a hash-bound snapshot and a successful restore
verification before deletion.

The default ledger read path is the fail-closed `effective_receipt_ledger`
projection. Qualified invalid/tombstoned receipts are never returned as usable;
raw receipt access is explicitly audit-only.

The 2026-07-13 reconciliation requeued 12 expired nodes, removed 4 expired
resource leases and 8 expired waiters. Workspace backfill registered 11
workspaces, restore-verified 7 snapshots, protected 4 incomplete workspaces and
released about 1.64 GB through the receipt-backed retention path.
The schema-19 liveness reconciliation additionally paused 6 no-progress
campaigns without starting workers or discarding their 61 queued nodes.

## Verification surface

Use these commands for current status and release verification:

```bash
npm test
npm run paper:architecture-selftest
npm run coverage:architecture
npm run coverage:critical-modules
npm run coverage:repository
npm run coverage:system
npm run migration:retirement-status
npm run owner:status
npm run operational:status
npm run automation:status
npm run store:logical-integrity
```

The critical-module coverage gate reports and enforces line/function coverage
for each contracts, issuer/ledger, recovery and executor-boundary module rather
than relying only on a repository-wide aggregate.
