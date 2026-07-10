# Paper Overlay Phase 1-7

This overlay keeps `core/` as the unmodified hepta design-production-core
snapshot. Paper production lives in `paper-core/` and `paper-adapters/`.

## Implemented Spine

1. Paper overlay skeleton: paper channel/profile/action contract in
   `paper-core/src/paper-contracts.mjs`.
2. Canonical paper state: `PaperTask`, `PaperArtifactPackage`, and
   `PaperWorkflowState`.
3. Inventory adapter: read-only scan from SQLite by default, with YAML fallback
   and controlled scans of `registry/`, `drafts/`, `submission/`,
   `workspaces/`, and `logs/paperctl/`.
4. Build/package adapter: LaTeX command planning and optional local runtime
   output under `hepta-paper-workspace/runtime/`, including package records and
   checksums.
5. Research verify adapter: read-only claim/evidence/proof/referee evidence
   scan, typed contracts, and worker bridge receipts.
6. Runner handoff: paper action manifest, handoff envelope, and dry-run
   receipt.
7. Submission lifecycle: venue plan, dry-run venue proof, audit archive, and
   reviewed-submit blocking.
8. Local readiness closure: submission intent classification and SQLite-backed
   package artifact binding.
9. Referee revision preflight: dry-run patch execution preflight and rollback
   ledger draft.
10. Reviewed-submit preflight: approval/evidence/outbox summary with live
    executor blocked by default.
11. Manual decision packets: venue resolution and source adaptation reports.
12. Referee execute plan: preimage snapshot ledger and plan-only execution
    sequence.

## Commands

```bash
npm run paper:selftest
node paper-core/bin/paper-production-core.mjs batch-run --mode inventory
node paper-core/bin/paper-production-core.mjs batch-run --mode venue-resolve
node paper-core/bin/paper-production-core.mjs batch-run --mode source-adapt
node paper-core/bin/paper-production-core.mjs batch-run --mode referee-revise
node paper-core/bin/paper-production-core.mjs batch-run --mode local-dry-run --write-report
node paper-core/bin/paper-production-core.mjs batch-run --mode reviewed-submit
node paper-core/bin/paper-production-core.mjs batch-run --mode legacy-cleanup --write-report
```

Useful flags:

```bash
node paper-core/bin/paper-production-core.mjs batch-run --mode inventory --inventory-source sqlite
node paper-core/bin/paper-production-core.mjs batch-run --mode inventory --inventory-source yaml
node paper-core/bin/paper-production-core.mjs batch-run --mode inventory --include-quarantined
```

`reviewed-submit` intentionally remains blocked until a later explicit live
executor is designed and authorized. The overlay performs no upload, email,
portal open, or external submission.

## Next Cut Implemented

- Batch reports include a blocker-family table and JSON summary.
- Rust-shadow and test fixture inventory rows are quarantined by default.
- SQLite is the default inventory source when `paper_factory.sqlite` is
  readable; YAML remains the fallback/export path.
- `local-package` writes `PACKAGE_RECORD.json` and `SHA256SUMS.txt` to
  `runtime/packages/<paper_id>/`.
- `research-verify` now emits typed claim scope, proof obligation, evidence
  matrix, reproducibility, worker bridge, and verify receipt contracts.
- `referee-revise` emits a dry-run issue queue, patch plan, execution
  preflight, rollback ledger draft, preimage snapshot ledger, and execute plan
  plus apply-mode contract without mutating source.
- `venue-resolve` emits manual venue decision packets for papers without venue
  targets, including submit-ready package plans and registry-add plans.
- `source-adapt` emits source adaptation packets for papers with source/main tex
  ambiguity.
- `submission` now includes approval packet, fresh venue evidence, replay guard,
  external executor outbox, receipt inbox, venue proof, archive, and
  reconciliation.
- `legacy-cleanup` audits old `paper_factory` code for adapter candidates and
  quarantined control-plane modules.

## Latest Full-Batch Shape

`local-dry-run` currently separates production state into:

- 19 active submission candidates with dry-run receipts and venue state proofs.
- 2 papers needing a manual venue decision.
- 1 paper needing source adaptation.
- 1 non-submission archive row kept out of active production.

`venue-resolve` currently separates the two venue cases:

- `credit_card`: manual venue decision required; no registry candidate can be
  selected automatically. It has a registry-add plan template.
- `token_flow`: manual venue decision required; no registry candidate can be
  selected automatically. Its runtime compiled PDF, source zip, package record,
  and checksums are present.

`source-adapt` currently identifies `Autoencoder-Asset-Pricing-Models-main` as
having PDF/code assets but no tex manuscript source.

`reviewed-submit` currently produces approval packets, fresh venue evidence, and
external executor outbox records for the 19 active candidates, but all remain
blocked by explicit approval and live-executor boundaries. External actions stay
at zero.
