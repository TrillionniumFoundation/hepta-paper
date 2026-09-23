import path from 'node:path';
import {
  EXPLICIT_LEGACY_WORKFLOW_PROJECTION_BOUNDARY,
  runPaperBatch,
} from '../batch/paper-batch-application.mjs';
import { bootstrapBatchContext } from '../bootstrap/capability-scoped-bootstrap.mjs';
import { bootstrapBatchInventoryContext } from '../bootstrap/batch-inventory-context-bootstrap.mjs';
import { persistLegacyWorkflowStateProjection } from './legacy-workflow-state-projection.mjs';
import { persistBatchReport } from '../reporting/batch-report-writer.mjs';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../../paper-adapters/runtime/workspace-layout.mjs';
import { summarizeResults } from '../../paper-application/reporting/batch-result-summary.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function rehashReport(report, changes = {}) {
  const { reportHash: _reportHash, ...payload } = { ...report, ...changes };
  return Object.freeze({ ...payload, reportHash: hashRecord('PaperBatchRunReport', payload) });
}

function attachCompatibilityStageSummary(report) {
  const { campaignQueue: _campaignQueue, ...compatibilityStageSummary } = summarizeResults(report.results);
  return rehashReport(report, {
    compatibilityProjection: Object.freeze({
      kind: 'LegacyWorkflowCompatibilityProjection',
      authoritative: false,
      stageMetricsComputed: true,
    }),
    compatibilityStageSummary: Object.freeze(compatibilityStageSummary),
  });
}

// Explicit compatibility entry point. The production batch module cannot
// import or construct workflow_states; only callers choosing this boundary can
// request the non-authoritative legacy projection.
export async function runLegacyWorkflowProjectionBatch(options = {}) {
  const root = path.resolve(options.root || defaultPaperAssetRoot());
  const runtimeRoot = path.resolve(options.runtimeRoot || defaultPaperRuntimeRoot());
  const writeReport = Boolean(options.writeReport);
  const baseReport = await runPaperBatch({
    ...options,
    root,
    runtimeRoot,
    writeReport: false,
    legacyWorkflowProjection: true,
    compatibilityBoundary: EXPLICIT_LEGACY_WORKFLOW_PROJECTION_BOUNDARY,
  });
  const report = attachCompatibilityStageSummary(baseReport);
  if (!options.execute) {
    if (!writeReport) return report;
    const previewContext = bootstrapBatchInventoryContext({
      root,
      runtimeRoot,
      mode: options.mode,
      execute: false,
      writeReport: true,
      readOnly: true,
      allowMissingReadOnlyStore: true,
      options: { legacyWorkflowProjection: true },
      serviceOverrides: options.serviceOverrides || {},
    });
    try {
      await withArtifactWriteContext(previewContext.services, () => persistBatchReport(report));
      return report;
    } finally {
      previewContext.services.persistenceSession.close?.();
    }
  }
  const context = bootstrapBatchContext({
    root,
    runtimeRoot,
    mode: options.mode,
    execute: true,
    writeReport,
    options: { legacyWorkflowProjection: true },
    serviceOverrides: options.serviceOverrides || {},
  });
  try {
    const results = report.results.map((result) => ({
      ...result,
      workflowStateProjection: persistLegacyWorkflowStateProjection({
        lineage: result.workflowAuthorityLineage,
        workflowStateStore: context.services.workflowStateStore,
        paperId: result.paperId,
        mode: options.mode,
        state: result.state,
        workflowReceiptHash: null,
      }),
    }));
    const projected = rehashReport(report, { results });
    if (writeReport) {
      await withArtifactWriteContext(context.services, () => persistBatchReport(projected));
    }
    return projected;
  } finally {
    context.services.persistenceSession.close?.();
  }
}
