# Hepta-paper remediation status — 2026-07-10

## Release decision

`No-Go` for real external submission. Local inventory, build/package smoke, and
dry-run orchestration remain available.

## P0 results

- Independent Git history exists; the import baseline is commit `a1df01c`.
- Accepted vendored-core tree:
  `sha256:f542d687fbe17c19cf6e62a431ccde5ae3abda8fbfae485c1e90d0a4719dc0d6`
  across 588 protected files, with zero accepted-baseline drift.
- Historical upstream comparison remains explicitly divergent: 478/840 files
  match and 362 differ. No report claims historical byte identity.
- The former automatic 263 semantic migration claims are withdrawn. The
  migration matrix now has an explicit row for all 263 P0/P1 source paths.
  Both P0 rows are complete and verified; 250 P1 rows remain partial, so
  paper_factory retirement is still blocked.
- The primary-entrypoint P0 row exhaustively binds all 760 legacy argparse
  commands to all 760 dispatch branches and gives each command a native,
  pending-P1, quarantine, data-export, or retirement disposition. The old
  entrypoint and pending-P1 routes are not allowed by the canonical hepta
  policy.
- The production-core P0 row uses an independent Python/JavaScript
  differential suite covering all 11 production states, all repair-frontier
  routes, stage ordering, summary counters, and artifact-label resolution.
- The hepta-native SQLite store is the default inventory/referee/package store.
  The migrated snapshot has 29 papers, 3 venues, 19 ledger rows, 1,128
  submissions, 3,601 artifacts, 779 non-orphan referee requests, and 710
  non-orphan patch rows; `quick_check` and `foreign_key_check` pass.
- Legacy `paper_factory.sqlite` is import-only. The remediation regression test
  verifies its hash does not change.
- Deterministic empirical output is `pipeline_smoke_only`, never academic
  evidence, and cannot mutate a manuscript.
- Academic evidence requires a hash-bound source-workspace
  `ACADEMIC_EVIDENCE_ATTESTATION.json`.
- Deterministic referee personas have no independent academic acceptance
  authority.
- Reassessment found 16 unique prior autopilot acceptance receipts; all 16 are
  invalidated as academic accepts. Valid academic accept count is 0.
- Across 20 active submission candidates, reviewed-submit preflight is now
  0 ready / 20 blocked; external actions performed remain 0.

## P1 engineering work landed

- Added explicit modules for core integrity, native store paths, migration
  matrix verification, academic evidence attestation, empirical evidence
  policy, review authority, and shared referee-store access.
- Split the five historical orchestration monoliths behind compatibility
  facades:
  - paper-contracts now delegates referee planning, referee application,
    repair closure, submission, and venue/source intake contracts to five
    domain modules plus shared hash/normalization primitives.
  - paper-batch-runner delegates report aggregation and blocker-family
    rendering to batch-summary.
  - journal profile/deadline data is isolated in journal-registry.
  - generated empirical experiment code is isolated in experiment-runner.
  - patch creation/validation/application is isolated in repair-executor.
- A 64 KiB production-module budget is now enforced by remediation selftest
  across all 39 MJS modules under paper-core and paper-adapters.
- Added deterministic vendored-core selftest distinct from the cross-repository
  workspace integration test.
- Added failure-closed migration and referee-authority tests, SQLite rollback
  and concurrent-writer tests, foreign-key checks, and legacy-store immutability
  checks.
- Added direct boundary checks for contract facade identity, batch-summary
  behavior, the 97-profile journal registry, network-free empirical code
  generation, and referee patch path containment.

The mechanical monolith split is complete under the current 64 KiB budget.
Further decomposition may improve maintainability, but is no longer an
unbounded-file blocker.

## Migration matrix progress after P1

- Matrix version 2 contains 263/263 explicit source rows. Every row binds the
  exact legacy hash, a top-level source-symbol inventory, an assigned native
  capability family, the exact target hash, and target symbols.
- Verified: 13 total = 2 P0 plus 11 plugin-descriptor replacements.
- Remaining: 250 P1 partial/invalid rows. They have structural mappings but
  intentionally lack a complete behavioral/retirement proof, so they continue
  to count as blockers.
- The 11 verified plugin descriptors cover compile, package, evidence, external
  boundary, report, venue, section-writer retirement, structural/substantive
  referee, revision planning, and patch-request routing. Model calls,
  independent acceptance authority, direct manuscript mutation, and external
  actions are explicitly not inherited from the legacy wrappers.
- Shared hash-bound behavior tests execute once per audit and are reused across
  rows, preventing a 263-row matrix from repeatedly running identical suites.
- Current blocker counts: P0 = 0, P1 = 250. Retirement and old-control-plane
  removal remain blocked.

## Verification

```bash
npm run store:status
npm run core:integrity
npm run audit:local-accepts
npm run migration:p0-selftest
npm run migration:p1-plugin-selftest
npm run migration:matrix-integrity
npm test
```

The external submission executor must remain absent until the remaining 250
P1 matrix rows, attested research evidence, and independent referee route are
all closed and reviewed.
