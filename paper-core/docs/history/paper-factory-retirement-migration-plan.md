# Paper Factory Retirement Migration Plan

This document preserves the retirement plan and its historical execution
record. Current migration status is determined by the immutable legacy
reference verification and the behavior-bound semantic migration matrix, not
by a retired production mode.

The supported, repeatable status check is:

```bash
npm run migration:retirement-status
```

The former `legacy-cleanup` batch mode and its reports below are historical
artifacts; they are not part of the current command surface or an operational
source of truth.

> Correction (2026-07-10): earlier versions of this document treated adapter
> directory presence as semantic migration evidence and therefore reported 263
> claims complete. That inference was invalid. Only the hash- and behavior-test
> bound matrix under `migration/` may now create a verified claim.

> Architecture v3 status: the matrix now records 14 behavioral replacements
> and 249 explicit retirements. The 249 are further classified as 88 permanent
> retirements, 40 native-coverage obligations, and 121 capability concepts to
> reimplement. Owner acceptance remains pending for all 249 decisions. The
> numeric snapshot below is retained as historical planning context and is not
> the current release status.

## Executed retirement status

The non-destructive control-plane retirement run has completed:

- all 7 retirement-wave execution receipts are recorded;
- `LegacyEntrypointFreezeReceipt` is recorded and both `bin/paperctl` and
  `paperctl_modules/paper_production_core.py` are non-executable;
- `PaperFactoryQuarantineIsolationReceipt` is recorded;
- `OldPaperFactoryControlPlaneRemovalReceipt` is recorded for removal of the
  active execution route;
- the hepta repository, paper assets and native runtime/store are physically
  outside the frozen legacy root;
- destructive legacy source deletion was not performed;
- the resulting state is `paper_factory_control_plane_archive_ready`, not
  functional parity or owner-approved physical deletion.

All 249 business dispositions still require owner acceptance. A real
worker→evidence→independent-referee→dual-authorization pilot and any separately
implemented provider executor remain outside this retirement receipt.

Latest audit report:

- `runtime/reports/paper-batch-legacy-cleanup-latest.json`
- `runtime/reports/paper-batch-legacy-cleanup-latest.md`

## Historical pre-remediation audit snapshot

Latest scan:

- scanned files: 526
- hepta adapters detected: 12
- adapter candidates: 261
- retire-not-migrate files: 162
- quarantine/report/matrix/capstone files: 43
- blocked primary entrypoints: 1
- P0 items: 2
- P1 migration candidates: 261
- P2 triage/domain assets: 58
- P3 retire/quarantine items: 205
- retirement wave packets: 7
- wave packets ready: 5
- wave packets blocked: 2
- wave execution receipts recorded: 0
- wave execution receipts blocked: at least 1
- full P0/P1 migration backlog: 263
- verified semantic migration claims: 0
- migration-matrix entries missing: 263
- active P0 migration blockers: 2
- active P1 migration blockers: 261
- live external executor policy: `live_external_executor_policy_recorded`
- final retirement readiness: `paper_factory_retirement_blocked`
- final retirement blockers: P0/P1 semantic migration parity remains open

Disposition counts:

- `adapter_candidate_research_compute`: 155
- `adapter_candidate_source_package`: 36
- `adapter_candidate_referee_revision`: 25
- `adapter_candidate_submission_lifecycle`: 30
- `adapter_candidate_plugin_wrapper`: 9
- `adapter_candidate_venue_source_decision`: 6
- `domain_asset_or_documentation`: 58
- `retire_llm_or_manual_control_plane`: 153
- `retire_legacy_orchestration_control_plane`: 9
- `quarantine_control_plane_report`: 43
- `blocked_primary_entrypoint`: 1
- `retire_legacy_production_core`: 1

Runtime wave-family counts:

- `wave_0_freeze_legacy_entrypoints`: 1
- `wave_1_promote_registry_schema_templates_docs`: 58
- `wave_2_migrate_research_source_package_semantics`: 191
- `wave_3_migrate_referee_review_repair_semantics`: 34
- `wave_4_migrate_submission_venue_source_decision_semantics`: 36
- `wave_5_quarantine_reports_matrices_capstones_llm_manual_chains`: 205
- `wave_6_remove_old_control_plane`: 1

## Retirement Waves

### Wave 0: Freeze Legacy Entrypoints

Target:

- `bin/paperctl`
- `paperctl_modules/paper_production_core.py`

Replacement:

- `paper-core/bin/paper-production-core.mjs`
- `paper-core/src/paper-batch-runner.mjs`

Status:

- `LegacyEntrypointDeprecationPacket` ready
- `PaperFactoryRetirementWavePacket` ready
- `LegacyEntrypointFreezeReceipt` recorded by `--execute`
- destructive removal is still blocked until data/export parity is accepted

### Wave 1: Promote Data Assets

Target:

- `registry/`
- `schema/`
- `templates/`
- durable docs that describe domain state rather than old control flow

Replacement:

- `paper-adapters/inventory`
- `paper-adapters/proposal`
- `paper-adapters/source-adapt`
- `paper-core/docs`

Status:

- `HeptaDataAssetExportPlan` ready
- `HeptaDataAssetExportReceipt` recorded by `--execute`
- `PaperFactoryRetirementWaveExecutionReceipt` recorded
- SQLite/YAML registry is still the active data source

### Wave 2: Research And Source Package Semantics

Target:

- `paperctl_modules/research_compute_*`
- paper production source/package/archive helpers

Replacement:

- `paper-adapters/research-verify`
- `paper-adapters/build-package`

Migration rule:

- extract useful domain semantics only
- do not import old workers as workflow control plane
- represent old worker behavior as typed contracts, worker receipts, package
  records, recheck reports, or adapter-local deterministic logic

Status:

- `PaperFactoryRetirementWavePacket` ready
- `PaperFactoryMigrationCoverageReceipt` recorded by `--execute`
- remaining backlog is mostly research-compute semantics

### Wave 3: Referee Review And Repair Semantics

Target:

- referee plugins
- referee repair modules
- old patch planning and repair queue logic

Replacement:

- `paper-adapters/referee-review`
- `paper-adapters/referee-revise`

Status:

- `PaperFactoryRetirementWavePacket` ready
- `PaperFactoryMigrationCoverageReceipt` recorded by `--execute`
- covered for the current loop
- hepta-paper can now generate review issues from `main.tex`, materialize them
  into `referee_revision_requests`, revise source, recheck, resolve issues, and
  reenter reviewed-submit readiness

### Wave 4: Submission And Decision Semantics

Target:

- external lifecycle helpers
- submission/portal/executor readiness helpers
- venue/source decision helpers

Replacement:

- `paper-adapters/submission`
- `paper-adapters/venue-resolve`
- `paper-adapters/source-adapt`

Status:

- `PaperFactoryRetirementWavePacket` ready
- `PaperFactoryMigrationCoverageReceipt` recorded by `--execute`
- `PaperFactoryLiveExternalExecutorPolicyReceipt` recorded
- `PaperFactoryRetirementWaveExecutionReceipt` recorded
- control boundary covered
- live external venue submission remains a separate future executor and is not
  delegated to legacy `paper_factory`

### Wave 5: Quarantine Reports, Matrices, Capstones

Target:

- report-only modules
- matrix-only modules
- stale latest-report readers
- capstone-only gates
- old LLM/manual authorization chains

Replacement:

- no direct migration

Status:

- `PaperFactoryQuarantineManifest` ready
- `PaperFactoryRetirementWavePacket` ready
- `PaperFactoryQuarantineIsolationReceipt` recorded by `--execute`
- retain only archive references for audit

### Wave 6: Remove Old Control Plane

Target:

- legacy executable workflow ownership

Status:

- `PaperFactoryRetirementReadinessGate` blocked
- `OldPaperFactoryControlPlaneRemovalReceipt` blocked
- raw P0/P1 backlog is not drained; all 263 items require verified matrix rows
- destructive file removal has not been performed; old files remain retained as
  archive-readable evidence

Exit criteria:

- all active papers are reachable through hepta inventory
- normal production uses only `paper-production-core`
- venue/source decision semantics have hepta coverage and claim receipts
- `runtime/hepta-paper.sqlite` is the default store and has a recorded legacy
  import receipt; legacy `paper_factory.sqlite` is import-only
- live external executor policy is explicit

## P0/P1 Backlog Shape

Runtime `PaperFactoryMigrationBacklogPacket`:

- full P0/P1 backlog: 263
- P0: 2
- P1: 261
- `PaperFactoryP0P1BacklogDrainReceipt`: blocked
- verified semantic migration claims: 0
- active P0/P1 blockers: 263

Former automatically inferred claim families (backlog classification only, not
verified migration):

- `research_verify_worker_receipt`: 155
- `build_package_contract`: 36
- `submission_lifecycle_contract`: 30
- `referee_revise_repair_contract`: 19
- `native_paper_adapter_replacement`: 9
- `referee_review_heuristic_contract`: 6
- `venue_source_decision_contract`: 6
- `legacy_entrypoint_replacement`: 1
- `legacy_batch_runner_retirement`: 1

P0:

- replace `bin/paperctl` as the primary entrypoint
- retire `paperctl_modules/paper_production_core.py` after adapter coverage and
  data/export parity are accepted

P1:

- extract remaining research-compute semantics into `research-verify`
- extract source/package/archive rules into `build-package`
- extract submission lifecycle semantics into `submission`
- extract residual referee review/repair semantics into `referee-review` and
  `referee-revise`
- replace old plugin wrappers with native paper adapters

## Non-Migration Policy

Do not port these into hepta-paper as executable code:

- LLM recorder chains
- manual authorization chains
- stale latest-report readers
- capstone-only modules
- matrix-only modules
- report-only modules
- old `paperctl` command orchestration

They can remain as archived evidence until removal is safe, but they must not
be imported by paper adapters.

## Runtime Retirement Packets

The `legacy-cleanup` report now emits hash-bound packets for the whole
retirement plan:

- `LegacyEntrypointDeprecationPacket`
- `HeptaDataAssetExportPlan`
- `PaperFactoryMigrationBacklogPacket`
- `PaperFactoryQuarantineManifest`
- seven `PaperFactoryRetirementWavePacket` records
- seven `PaperFactoryRetirementWaveExecutionReceipt` records when
  `--execute` is used
- `LegacyEntrypointFreezeReceipt`
- `HeptaDataAssetExportReceipt`
- `PaperFactoryP0P1BacklogDrainReceipt`
- `PaperFactoryMigrationCoverageReceipt`
- `PaperFactoryLiveExternalExecutorPolicyReceipt`
- `PaperFactoryQuarantineIsolationReceipt`
- `OldPaperFactoryControlPlaneRemovalReceipt`
- `PaperFactoryRetirementReadinessGate`

These packets do not delete legacy source, rewrite entrypoint bytes, write
legacy SQLite, or perform external actions. Execute mode persists hepta runtime
receipts and may remove executable permission bits from the two declared
legacy entrypoints. That permission change is recorded with pre/post hashes and
does not change file content.

## Current Retention Constraints And Blockers

- `paper_factory.sqlite` remains retained as immutable import/audit evidence;
  it is no longer the default or an active runtime registry/state source.
- Live external venue submission is explicitly outside old `paper_factory`
  retirement. Hepta may record local `ControlledExternalExecutorReceipt`
  boundaries, but live venue submission requires a separate future hepta adapter,
  dedicated receipt, and reconciliation.
- Raw P0/P1 migration backlog is preserved for audit. Verified dispositions
  are 14 behavioral replacements and 249 explicit retirements; only the 14
  replacements are semantic migration claims.
- There are no active control-plane archive blockers. Physical deletion and
  functional-parity claims remain disallowed.

## Next Implementation Steps

1. Keep old `paper_factory` executable paths archive-readable but outside the
   normal production route.
2. Add a destructive-removal executor only if a separate removal policy is
   accepted; current receipts intentionally do not delete files.
3. Keep `paper_factory.sqlite` retained as immutable data evidence while the
   schema-v2 hepta-native store remains the sole production default.
