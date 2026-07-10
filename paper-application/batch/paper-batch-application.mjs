import path from 'node:path';
import { ensureDir } from '../../paper-core/src/runtime/file-utils.mjs';
import { normalizeText } from '../../paper-core/src/runtime/text-utils.mjs';
import { nowIso } from '../../paper-core/src/runtime/time-utils.mjs';
import { writeJsonFile, writeTextFile } from '../../paper-adapters/artifacts/write-artifact.mjs';
import {
  PAPER_ACTIONS,
  createPaperWorkflowState,
  autoLevelForState,
  inferPaperStage,
  nextActionForState,
  paperWorkflowRow,
  hashPaperRecord,
} from '../../paper-core/src/paper-contracts.mjs';
import { buildCoreIntegrityReport } from '../../paper-core/src/core-integrity.mjs';
import { createExecutionContext, assertExecutionServices } from '../../paper-core/src/execution-context.mjs';
import { PAPER_BATCH_MODES, assertPaperMode } from '../../paper-core/src/mode-registry.mjs';
import { runWorkflowStages } from '../../paper-core/src/workflow-engine.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../../paper-core/src/workspace-layout.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { createSha256Hasher } from '../../paper-adapters/runtime/sha256-hasher.mjs';
import { createAuthorityVerifier } from '../../paper-adapters/authority/authority-verifier.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createSqliteJobReceiptStore } from '../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import { enterArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { createPaperStageHandlers } from '../use-cases/paper-stage-handlers.mjs';
import { discoverInventory } from '../../paper-adapters/inventory/index.mjs';
import { runLegacyCleanupAdapter } from '../../paper-adapters/legacy-cleanup/index.mjs';
import { runLocalDiagnosticReviewLoop } from '../use-cases/local-diagnostic-review-loop.mjs';

export { PAPER_BATCH_MODES } from '../../paper-core/src/mode-registry.mjs';

function defaultRoot() {
  return defaultPaperAssetRoot();
}

function defaultRuntimeRoot() {
  return defaultPaperRuntimeRoot();
}

function stateWithAdapterResults(row, { buildResult, packageResult, researchReport, refereeRevision, lifecycle } = {}) {
  const artifactPackage = packageResult?.artifactPackage || null;
  const hasCompiledPdf = (artifactPackage?.artifacts || []).some((artifact) => artifact.role === 'compiled_pdf');
  const submissionIntent = row.submissionIntent || row.task.registry?.submissionIntent || {
    status: 'submission_candidate',
    disposition: 'active_submission',
    reason: 'default_submission_candidate',
  };
  const compileStatus = buildResult?.status === 'build_passed'
    ? 'build_passed'
    : hasCompiledPdf
      ? 'compiled_pdf_present'
    : row.state.compileStatus;
  const researchVerifyStatus = ['evidence_present', 'proposal_seed_present'].includes(researchReport?.status)
    ? researchReport.status
    : row.state.researchVerifyStatus;
  const packageStatus = artifactPackage?.packageStatus || row.state.packageStatus;
  const runnerStatus = lifecycle?.receipt?.status === 'dry_run_recorded'
    ? 'dry_run_receipt_recorded'
    : row.state.runnerStatus;
  const submissionStatus = lifecycle?.venueStateProof?.status === 'dry_run_state_proof'
    ? 'venue_state_proof_recorded'
    : row.state.submissionStatus;
  const rawBlockers = [
    ...(row.state.blockers || []),
    ...(buildResult?.blockers || []),
    ...(packageResult?.blockers || []),
    ...(researchReport?.blockers || []),
    ...(refereeRevision?.blockers || []),
    ...(lifecycle?.venuePlan?.blockers || []),
    ...(lifecycle?.reviewedSubmit ? (lifecycle?.approvalPacket?.blockers || []) : []),
    ...(lifecycle?.manifest?.blockers || []),
  ];
  let blockers = rawBlockers;
  let forcedNextAction = null;
  let forcedAutoLevel = null;
  let forcedReadinessStatus = null;
  if (submissionIntent.status === 'needs_venue_decision') {
    blockers = rawBlockers.filter((blocker) => !['venue_target_missing', 'venue_submission_plan_not_ready'].includes(blocker));
    const packageNotSubmitReady = artifactPackage && !artifactPackage.submitReady;
    forcedReadinessStatus = blockers.length || packageNotSubmitReady
      ? 'needs_local_package_before_venue_decision'
      : 'needs_venue_decision';
    forcedNextAction = 'paper.venue.resolve';
    forcedAutoLevel = 'manual_venue_decision';
  } else if (submissionIntent.status === 'source_adapt_required') {
    blockers = [];
    forcedReadinessStatus = 'source_adapt_required';
    forcedNextAction = 'paper.source.adapt';
    forcedAutoLevel = 'manual_source_adapt';
  } else if (submissionIntent.status === 'non_submission_archive') {
    blockers = [];
    forcedReadinessStatus = 'non_submission_archive';
    forcedNextAction = 'paper.archive.non_submission';
    forcedAutoLevel = 'non_submission_archive';
  }
  const warnings = [
    ...(row.state.warnings || []),
    ...(buildResult?.warnings || []),
    ...(packageResult?.warnings || []),
    ...(researchReport?.warnings || []),
    ...(refereeRevision?.warnings || []),
    ...(lifecycle?.venuePlan?.warnings || []),
    ...(lifecycle?.manifest?.warnings || []),
  ];
  const readinessStatus = forcedReadinessStatus || (blockers.length
    ? 'blocked'
    : ['package_present', 'package_ready'].includes(packageStatus)
      ? 'ready_for_local_dry_run'
      : row.state.readinessStatus);
  let state = createPaperWorkflowState({
    paperTask: row.task,
    draftStatus: row.state.draftStatus,
    compileStatus,
    researchVerifyStatus,
    packageStatus,
    readinessStatus,
    runnerStatus,
    submissionStatus,
    blockers,
    warnings,
    submissionIntent,
    evidenceRefs: [
      ...(row.state.evidenceRefs || []),
      ...(artifactPackage?.evidenceRefs || []),
    ],
  });
  state = {
    ...state,
    nextAction: forcedNextAction || nextActionForState(state),
    autoLevel: forcedAutoLevel || autoLevelForState(state),
  };
  return {
    ...state,
    stage: inferPaperStage(state),
  };
}

import {
  blockerFamilySummary,
  makeBlockerFamilyMarkdown,
  makeMarkdownTable,
  summarizeResults,
  summarizeRows,
} from '../../paper-core/src/batch-summary.mjs';

export async function runPaperBatch({
  root = defaultRoot(),
  runtimeRoot = null,
  mode = PAPER_BATCH_MODES.INVENTORY,
  limit = null,
  paperIds = [],
  includeRetired = false,
  includeQuarantined = false,
  inventorySource = 'auto',
  execute = false,
  writeReport = false,
  maxRounds = 6,
  targetOverride = null,
  datasetRoot = null,
  benchmarkId = null,
  applyManuscript = false,
} = {}) {
  const workflowDefinition = assertPaperMode(mode);
  const resolvedRoot = path.resolve(root);
  const resolvedRuntimeRoot = runtimeRoot ? path.resolve(runtimeRoot) : defaultRuntimeRoot();
  const store = createDefaultPaperStore({ root: resolvedRoot, runtimeRoot: resolvedRuntimeRoot });
  const clock = createSystemClock();
  const receiptLedger = createSqliteReceiptLedger({ store, clock });
  const jobReceiptStore = createSqliteJobReceiptStore({ store, receiptLedger, clock });
  const submissionDeliveryStore = createSqliteSubmissionDeliveryStore({ store, receiptLedger, clock });
  const executionContext = createExecutionContext({
    root: resolvedRoot,
    runtimeRoot: resolvedRuntimeRoot,
    mode,
    execute,
    writeReport,
    options: {
      maxRounds,
      targetOverride,
      datasetRoot,
      benchmarkId,
      applyManuscript,
    },
    services: {
      store,
      artifactRepositoryFactory: (scopeRoot) => createFilesystemArtifactRepository({ scopeRoot, receiptLedger, clock }),
      clock,
      hasher: createSha256Hasher(),
      authorityVerifier: createAuthorityVerifier(),
      receiptLedger,
      jobReceiptStore,
      submissionDeliveryStore,
    },
  });
  assertExecutionServices(executionContext);
  enterArtifactWriteContext(executionContext.services);
  const coreIntegrity = buildCoreIntegrityReport({
    workspaceRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
  });
  if (execute && !coreIntegrity.ok) {
    throw new Error(`Core integrity gate blocked execution: ${coreIntegrity.status}`);
  }
  const scan = await discoverInventory({
    root: resolvedRoot,
    store: executionContext.services.store,
    limit,
    paperIds,
    includeRetired,
    includeQuarantined,
    inventorySource,
    proposalStagingRoot: path.join(resolvedRuntimeRoot, 'proposal-staging'),
  });
  const legacyCleanupAudit = mode === PAPER_BATCH_MODES.LEGACY_CLEANUP
    ? await runLegacyCleanupAdapter({
      root: resolvedRoot,
      runtimeRoot: resolvedRuntimeRoot,
      execute,
      store: executionContext.services.store,
    })
    : null;
  const results = [];
  for (const row of scan.rows) {
    const initialStageState = {
      buildResult: null,
      packageResult: null,
      researchReport: null,
      refereeReview: null,
      refereeRevision: null,
      localDiagnosticReviewLoop: null,
      journalManagement: null,
      empiricalAnalysis: null,
      venueResolution: null,
      sourceAdaptation: null,
      lifecycle: null,
    };
    const handlers = createPaperStageHandlers({
      context: executionContext,
      row,
      venues: scan.venues,
      runLocalDiagnosticReviewLoop,
    });
    const workflowExecution = await runWorkflowStages({
      definition: workflowDefinition,
      context: executionContext,
      initialState: initialStageState,
      handlers,
    });
    const {
      buildResult,
      packageResult,
      researchReport,
      refereeReview,
      refereeRevision,
      localDiagnosticReviewLoop,
      journalManagement,
      empiricalAnalysis,
      venueResolution,
      sourceAdaptation,
      lifecycle,
    } = workflowExecution.state;
    const state = stateWithAdapterResults(row, {
      buildResult,
      packageResult,
      researchReport,
      refereeRevision,
      refereeReview,
      venueResolution,
      sourceAdaptation,
      lifecycle,
      workflowReceipt: workflowExecution.workflowReceipt,
    });
    results.push({
      paperId: row.task.paperId,
      task: row.task,
      state,
      workflowRow: paperWorkflowRow(state),
      buildResult,
      packageResult,
      researchReport,
      refereeReview,
      refereeRevision,
      localDiagnosticReviewLoop,
      journalManagement,
      empiricalAnalysis,
      venueResolution,
      sourceAdaptation,
      lifecycle,
    });
  }
  const rows = results.map((item) => item.workflowRow);
  const blockerFamilies = blockerFamilySummary(results);
  const report = {
    version: 1,
    kind: 'PaperBatchRunReport',
    generatedAt: nowIso(),
    root: resolvedRoot,
    runtimeRoot: resolvedRuntimeRoot,
    mode,
    execute: Boolean(execute),
    requestedTargetOverride: normalizeText(targetOverride || '') || null,
    requestedDatasetRoot: normalizeText(datasetRoot || '') || null,
    requestedBenchmarkId: normalizeText(benchmarkId || '') || null,
    requestedApplyManuscript: Boolean(applyManuscript),
    registryRefs: scan.registryRefs,
    inventory: {
      source: scan.inventorySource,
      fallback: scan.inventoryFallback,
      quarantinedCount: scan.quarantined?.length || 0,
      quarantined: scan.quarantined || [],
    },
    summary: {
      ...summarizeRows(rows, mode),
      ...summarizeResults(results, legacyCleanupAudit),
      blockerFamilies,
    },
    rows,
    results,
    legacyCleanupAudit,
    coreIntegrity,
    markdownTable: makeMarkdownTable(rows),
    blockerFamilyTable: makeBlockerFamilyMarkdown(blockerFamilies),
    safety: {
      coreSnapshotModified: coreIntegrity.coreSnapshotModified,
      coreIntegrityStatus: coreIntegrity.status,
      upstreamCoreSnapshotExactMatch: coreIntegrity.upstream.exactMatch,
      importsOldPaperFactoryControlPlane: false,
      externalActionPerformed: false,
      reviewedSubmitBlockedByDefault: true,
    },
  };
  if (writeReport) {
    await ensureDir(path.join(resolvedRuntimeRoot, 'reports'));
    const stamp = report.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const base = path.join(resolvedRuntimeRoot, 'reports', `paper-batch-${mode}-${stamp}`);
    await writeJsonFile(base + '.json', report);
    await writeTextFile(base + '.md', [
      `# Paper Batch ${mode}`,
      '',
      '```json',
      JSON.stringify(report.summary, null, 2),
      '```',
      '',
      '## Blocker Families',
      '',
      report.blockerFamilyTable,
      '',
      '## Batch Table',
      '',
      report.markdownTable,
    ].join('\n'));
    await writeJsonFile(path.join(resolvedRuntimeRoot, 'reports', `paper-batch-${mode}-latest.json`), report);
    await writeTextFile(path.join(resolvedRuntimeRoot, 'reports', `paper-batch-${mode}-latest.md`), [
      `# Paper Batch ${mode}`,
      '',
      '## Summary',
      '',
      '```json',
      JSON.stringify(report.summary, null, 2),
      '```',
      '',
      '## Blocker Families',
      '',
      report.blockerFamilyTable,
      '',
      '## Batch Table',
      '',
      report.markdownTable,
    ].join('\n'));
  }
  return report;
}

export function renderBatchConsole(report) {
  return [
    `paper-production-core ${report.mode}`,
    JSON.stringify(report.summary),
    '',
    report.markdownTable,
  ].join('\n');
}
