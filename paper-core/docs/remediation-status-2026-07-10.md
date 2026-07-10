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
  migration matrix has 0 verified entries and 263 missing P0/P1 entries (2 P0,
  261 P1), so paper_factory retirement is blocked.
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
- Added deterministic vendored-core selftest distinct from the cross-repository
  workspace integration test.
- Added failure-closed migration and referee-authority tests, SQLite rollback
  and concurrent-writer tests, foreign-key checks, and legacy-store immutability
  checks.

The original contracts, batch-summary, journal registry, empirical runner, and
referee-repair files remain larger than the desired module budget. Further
mechanical extraction is engineering debt, not a reason to relax the safety
gates above.

## Verification

```bash
npm run store:status
npm run core:integrity
npm run audit:local-accepts
npm test
```

The external submission executor must remain absent until the 263 migration
matrix rows, attested research evidence, independent referee route, and module
debt gates are all closed and reviewed.
