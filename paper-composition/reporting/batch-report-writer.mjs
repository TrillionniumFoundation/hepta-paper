import path from 'node:path';
import { ensureDir } from '../../workflow-kernel/runtime/file-utils.mjs';
import { nowIso } from '../../workflow-kernel/runtime/time-utils.mjs';
import { writeJsonFile, writeTextFile } from '../../paper-adapters/artifacts/write-artifact.mjs';
import {
  blockerFamilySummary,
  makeBlockerFamilyMarkdown,
  makeMarkdownTable,
  summarizeCampaignResults,
  summarizeRows,
} from '../../paper-application/reporting/batch-summary.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function markdown(report, includeSummaryHeading = false) {
  return [
    `# Paper Batch ${report.mode}`, '', ...(includeSummaryHeading ? ['## Summary', ''] : []), '```json',
    JSON.stringify(report.summary, null, 2), '```', '', '## Campaign Queue', '', '```json',
    JSON.stringify({ status: report.status, executionStatus: report.executionStatus, campaigns: report.campaignSubmissions }, null, 2),
    '```', '', '## Blocker Families', '', report.blockerFamilyTable,
    '', '## Batch Table', '', report.markdownTable,
  ].join('\n');
}

function campaignSubmissionRow(item) {
  const queue = item.campaignQueue || {};
  return Object.freeze({
    paperId: item.paperId,
    status: queue.status || null,
    executionStatus: queue.executionStatus || 'not_applicable',
    workflowExecutionPerformed: queue.workflowExecutionPerformed === true,
    campaignId: queue.campaignId || null,
    campaignPlanHash: queue.campaignPlanHash || null,
    requestedMode: queue.requestedMode || null,
    effectiveMode: queue.effectiveMode || null,
    releaseHandoffRequired: queue.releaseHandoffRequired === true,
    externalSubmissionEnabled: queue.externalSubmissionEnabled === true,
    nodeCount: Number(queue.nodeCount || 0),
    nodeKinds: Object.freeze([...(queue.nodeKinds || [])]),
    idempotentReplay: Boolean(queue.idempotentReplay),
  });
}

export function buildBatchReport({ root, runtimeRoot, mode, execute, targetOverride, datasetRoot, benchmarkId, applyManuscript, scan, results, targetScopeReceipt } = {}) {
  const rows = results.map((item) => item.workflowRow);
  const blockerFamilies = blockerFamilySummary(results);
  const campaignSubmissions = Object.freeze(results.map(campaignSubmissionRow).filter((item) => item.campaignId));
  const nodeKinds = Object.freeze([...new Set(campaignSubmissions.flatMap((item) => item.nodeKinds))].sort());
  const reportStatus = execute
    ? 'paper_campaigns_queued_not_executed'
    : campaignSubmissions.length
      ? 'paper_campaigns_planned_not_queued'
      : mode === 'inventory'
        ? 'paper_batch_inventory_preview'
        : 'paper_campaign_plan_preview_unavailable';
  const resultSummary = summarizeCampaignResults(results);
  const campaignQueue = Object.freeze({
    ...resultSummary.campaignQueue,
    status: reportStatus,
    executionStatus: execute ? 'queued_not_executed' : 'not_executed',
    workflowExecutionPerformed: false,
    campaignIds: Object.freeze(campaignSubmissions.map((item) => item.campaignId)),
    campaignPlanHashes: Object.freeze(campaignSubmissions.map((item) => item.campaignPlanHash)),
    nodeKinds,
  });
  const summary = {
    ...summarizeRows(rows, mode),
    ...resultSummary,
    campaignQueue,
    blockerFamilies,
  };
  const report = {
    version: 2, kind: 'PaperBatchRunReport', status: reportStatus,
    executionStatus: execute ? 'queued_not_executed' : 'not_executed',
    workflowExecutionPerformed: false,
    generatedAt: nowIso(), root, runtimeRoot, mode, execute: Boolean(execute),
    codeProvenance: currentCodeProvenance(),
    requestedTargetOverride: String(targetOverride || '').trim() || null,
    requestedDatasetRoot: String(datasetRoot || '').trim() || null,
    requestedBenchmarkId: String(benchmarkId || '').trim() || null,
    requestedApplyManuscript: Boolean(applyManuscript),
    registryRefs: scan.registryRefs,
    targetScopeReceipt,
    inventory: { source: scan.inventorySource, fallback: scan.inventoryFallback, quarantinedCount: scan.quarantined?.length || 0, quarantined: scan.quarantined || [] },
    summary,
    campaignSubmissions,
    rows, results,
    markdownTable: makeMarkdownTable(rows), blockerFamilyTable: makeBlockerFamilyMarkdown(blockerFamilies),
    safety: {
      vendoredReferenceRuntimeScanPerformed: false,
      importsOldPaperFactoryControlPlane: false,
      externalActionPerformed: false,
      reviewedSubmitBlockedByDefault: true,
    },
  };
  return { ...report, reportHash: hashRecord('PaperBatchRunReport', report) };
}

export async function persistBatchReport(report) {
  const reportRoot = path.join(report.runtimeRoot, 'reports');
  await ensureDir(reportRoot);
  const stamp = report.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const base = path.join(reportRoot, `paper-batch-${report.mode}-${stamp}`);
  const detailPayload = { version: 2, kind: 'PaperBatchResultDetail', mode: report.mode, rows: report.rows, results: report.results };
  const detailHash = hashRecord('PaperBatchResultDetail', detailPayload);
  const detailPath = path.join(reportRoot, 'details', `${detailHash.replace(/^sha256:/, '')}.json`);
  const detailReceipt = await writeJsonFile(detailPath, detailPayload, { scopeRoot: reportRoot, role: 'paper_batch_result_detail' });
  const { results: _results, reportHash: _reportHash, ...bounded } = report;
  const persistedPayload = {
    ...bounded,
    version: 2,
    resultDetail: { path: path.relative(reportRoot, detailPath).replace(/\\/g, '/'), detailHash, contentHash: detailReceipt.hash, manifestHash: detailReceipt.manifestHash, writeReceiptHash: detailReceipt.writeReceiptHash, ledgerReceiptId: detailReceipt.ledgerReceiptId },
  };
  const persistedReport = { ...persistedPayload, reportHash: hashRecord('PaperBatchRunReport', persistedPayload) };
  await writeJsonFile(`${base}.json`, persistedReport, { scopeRoot: reportRoot, role: 'paper_batch_report' });
  await writeTextFile(`${base}.md`, markdown(persistedReport), { scopeRoot: reportRoot, role: 'paper_batch_report_markdown' });
  const pointer = {
    version: 1,
    kind: 'CurrentReportPointer',
    status: 'current_report_pointer',
    mode: report.mode,
    reportPath: path.basename(`${base}.json`),
    reportHash: persistedReport.reportHash,
    generatedAt: report.generatedAt,
    validUntil: new Date(Date.parse(report.generatedAt) + 24 * 60 * 60 * 1000).toISOString(),
    codeProvenance: report.codeProvenance,
  };
  await writeJsonFile(path.join(reportRoot, `paper-batch-${report.mode}-latest.json`), pointer, { scopeRoot: reportRoot, role: 'paper_batch_current_report_pointer' });
  await writeTextFile(path.join(reportRoot, `paper-batch-${report.mode}-latest.md`), ['# Current report pointer', '', '```json', JSON.stringify(pointer, null, 2), '```', ''].join('\n'), { scopeRoot: reportRoot, role: 'paper_batch_current_report_pointer_markdown' });
}

export function renderBatchConsole(report) {
  return [`paper-production-core ${report.mode}: ${report.status}`, JSON.stringify(report.summary), '', report.markdownTable].join('\n');
}
