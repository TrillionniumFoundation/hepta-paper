# Paper Production Risk Register And Next Plan

Generated after Phase 10-13 overlay hardening.

## Current Batch State

- Total non-quarantined inventory rows: 23
- Active submission candidates: 19
- Local dry-run ready: 19
- Dry-run receipts and venue state proofs: 19
- Generic local blockers: 0
- Manual venue decisions: 2
- Manual source adaptation: 1
- Non-submission archive rows: 1
- Reviewed-submit live external actions: 0

## Remaining Decisions

| family | count | papers | next action |
| --- | ---: | --- | --- |
| venue decision | 2 | `credit_card`, `token_flow` | choose venue or mark non-submission |
| source adaptation | 1 | `Autoencoder-Asset-Pricing-Models-main` | identify true main tex or archive/non-submit |
| non-submission archive | 1 | `dropbox_archive` | keep out of active production batch |
| referee revision | 16 issues / 4 papers | `DQL_Exploration_Convergence`, `NeurIPS_2026_ai_dual_contract_work`, `NeurIPS_2026_dynamic_contracting_ai_work`, `Optimal_Depth_NeurIPS_work` | run only after rollback ledger execution mode exists |
| live submission | 19 candidates | active submission candidates | requires explicit operator approval and separate live executor |

## Closed Risks

- `artifact_package_not_submit_ready` is no longer a generic local blocker for
  the NeurIPS package rows because the package adapter reads SQLite
  `submissions` / `artifacts` records.
- Missing venue rows no longer poison production readiness; they are classified
  as manual venue decisions.
- Archive rows no longer enter active submission lifecycle.
- Referee revision no longer stops at a flat patch plan; it now has execution
  preflight and rollback ledger draft records.
- Research verification is no longer only filename scanning; typed contracts are
  bound to local worker bridge receipts by worker path/hash.
- Reviewed-submit has operator-facing preflight summary and remains blocked by
  approval/live-executor boundaries.
- Venue decisions now have `VenueResolutionPacket` records: `credit_card`
  needs manual venue selection, while `token_flow` must first become
  submit-ready packaged.
- `credit_card` now has a `VenueRegistryAddPlan` template for operator-supplied
  venue metadata; the overlay does not write registry entries automatically.
- `token_flow` now has a runtime compiled PDF, source zip, package record, and
  checksum; venue resolution now waits only on an operator venue target.
- Venue resolution now emits `VenueResolutionOperatorPacket` records so manual
  venue/archive decisions have required inputs, accepted outcomes, and
  no-external-action guardrails.
- Source adaptation now has a `SourceAdaptationPacket`: `Autoencoder-Asset-Pricing-Models-main`
  is a PDF/code project with no tex manuscript source found.
- Source adaptation now emits `SourceAdaptationOperatorPacket` records so main
  tex selection, missing source intake, or archive decisions are hash-bound and
  cannot silently synthesize source.
- Referee revision now has preimage snapshot ledgers and plan-only execute
  plans for all 4 papers with open referee issues.
- Referee revision now has `RefereeRevisionApplyModeContract` records for all 4
  papers, each controlled by agent-owned apply approval.
- Referee revision now emits `RefereeRevisionExecuteDesignPacket` records that
  bind issue queue, patch plan, preimage ledger, execute plan, apply contract,
  and dry-run receipt before any apply mode is allowed.
- Referee revision now emits `RefereeApplyApprovalPacket` records that bind the
  execute design packet to agent approval inputs for hashes, target paths,
  preimage hashes, worktree scope, and rollback restore confirmation.
- Referee revision now emits `RefereePatchApplyExecution` boundary records that
  consume the approval packet and list planned patch inputs, preimage checks,
  execution order, and post-apply actions blocked until a real applied-patch
  receipt exists.
- Referee revision now emits `RefereePatchApplyInvocation` records. Without
  `--execute`, they block on explicit invocation. With `--execute`, the agent
  validates patch hashes, target scope, target preimages, and clean
  `git apply --check` before any source write.
- Referee revision now emits `RefereeAppliedPatchReceipt` gate records that
  require executor id, applied patch hashes, accepted preimages, postimages,
  source diff hash, build/package/research rechecks, and rollback
  reconciliation before any post-repair state can advance.
- Referee revision now emits `PostRepairBuildPackage` gate records that keep
  repaired package creation blocked until the applied-patch receipt and
  build/package/research/rollback rechecks are present.
- Referee revision now emits `RefereeIssueResolutionProof` gate records that
  block issue closure until a post-repair package, applied-patch receipt,
  issue-to-artifact evidence, recheck receipts, and agent/reviewer acceptance
  exist.
- Referee revision now emits `RepairReconciliation` gate records that keep the
  repair loop blocked until issue-resolution proof, repaired package,
  applied-patch receipt, rollback reconciliation, queue update receipts, and
  submission-readiness reentry evidence exist.

## Next Plan

1. Venue resolution packet:
   - operator fills/selects venue for `credit_card` using the registry-add plan,
     or marks it non-submission
   - operator fills/selects venue for `token_flow`, or marks it non-submission
   - keep all outcomes as packet/receipt updates, not silent SQLite edits

2. Source adaptation packet:
   - decide whether `Autoencoder-Asset-Pricing-Models-main` has missing tex
     source outside the current workspace
   - otherwise move it to non-submission archive
   - do not synthesize a main tex

3. Referee execute design:
   - preimage snapshot ledger and execute plan now exist
   - apply-mode contract now exists and is completed by agent-owned approval
     when the hash/preimage chain is ready
   - apply approval packet now exists and is agent-approved for the 4 open
     referee papers
   - patch-apply execution boundary now becomes ready after agent approval
   - patch-apply invocation now exists; without `--execute` it remains blocked
     on explicit invocation, and with `--execute` the current stale patch queue
     is blocked by clean-apply validation before source mutation
   - applied-patch receipt gate now exists and remains blocked until the patch
     apply invocation is actually applied
   - post-repair package gate now exists and remains blocked until an applied
     patch receipt is recorded and post-repair checks are available
   - issue-resolution proof gate now exists and remains blocked until the
     post-repair package is ready
   - repair reconciliation gate now exists and remains blocked until the
     issue-resolution proof is ready
   - execute-design packet now binds the full pre-apply chain
   - next step is to generate or select current clean substantive repair patch
     inputs; the existing queued status/request patches do not apply cleanly
   - execute one paper at a time only after invocation validation passes
   - re-enter build/package/research gates after patch application

4. Research worker execution bridge:
   - pick a small allowlist of pure local workers from the bridge receipts
   - run in dry-run or report-only mode first
   - require output receipt hash before it can affect readiness

5. Live submit executor design:
   - keep outside `paper-core/`
   - require approval packet, fresh venue evidence, replay guard, and receipt
     inbox
   - start with sandbox/mock executor before any portal/email/upload action

## Guardrails

- `core/` remains a frozen hepta snapshot.
- `paper-core/` owns contracts, state, reports, receipts, and CLI.
- `paper-adapters/` owns paper-domain plugins.
- Old `paper_factory` remains data/domain capability pool, not primary workflow.
- No live upload, email, portal open, provider/model call, or external submit is
  allowed inside the overlay.
