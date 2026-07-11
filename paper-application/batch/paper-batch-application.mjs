import path from 'node:path';
import {
  paperWorkflowRow,
} from '../../paper-core/src/paper-contracts.mjs';
import { buildCoreIntegrityReport } from '../../paper-core/src/core-integrity.mjs';
import { PAPER_BATCH_MODES, assertPaperMode } from '../../paper-core/src/mode-registry.mjs';
import { runWorkflowStages } from '../../paper-core/src/workflow-engine.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../../paper-core/src/workspace-layout.mjs';
import { enterArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { bootstrapPaperExecutionContext } from '../bootstrap/service-bootstrap.mjs';
import { createPaperStageHandlers } from '../use-cases/paper-stage-handlers.mjs';
import { discoverInventory } from '../../paper-adapters/inventory/index.mjs';
import { runLegacyCleanupAdapter } from '../../paper-adapters/legacy-cleanup/index.mjs';
import { runLocalDiagnosticReviewLoop } from '../use-cases/local-diagnostic-review-loop.mjs';
import { projectWorkflowState } from '../projections/workflow-state-projector.mjs';
import { buildBatchReport, persistBatchReport, renderBatchConsole } from '../reporting/batch-report-writer.mjs';

export { PAPER_BATCH_MODES } from '../../paper-core/src/mode-registry.mjs';

function defaultRoot() {
  return defaultPaperAssetRoot();
}

function defaultRuntimeRoot() {
  return defaultPaperRuntimeRoot();
}

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
  const executionContext = bootstrapPaperExecutionContext({
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
  });
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
    const state = projectWorkflowState(row, {
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
    const workflowStateProjection = execute
      ? executionContext.services.workflowStateStore.put({
        paperId: row.task.paperId,
        mode,
        state,
        workflowReceiptHash: workflowExecution.workflowReceipt.workflowReceiptHash,
      })
      : null;
    results.push({
      paperId: row.task.paperId,
      task: row.task,
      state,
      workflowStateProjection,
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
  const report = buildBatchReport({ root: resolvedRoot, runtimeRoot: resolvedRuntimeRoot, mode, execute, targetOverride, datasetRoot, benchmarkId, applyManuscript, scan, results, legacyCleanupAudit, coreIntegrity });
  if (writeReport) await persistBatchReport(report);
  return report;
}

export { renderBatchConsole };
