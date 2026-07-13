import path from 'node:path';
import { ensureDir } from '../../paper-core/src/runtime/file-utils.mjs';
import { nowIso } from '../../paper-core/src/runtime/time-utils.mjs';
import { writeJsonFile, writeTextFile } from '../../paper-adapters/artifacts/write-artifact.mjs';
import { blockerFamilySummary, makeBlockerFamilyMarkdown, makeMarkdownTable, summarizeResults, summarizeRows } from '../../paper-core/src/batch-summary.mjs';
import { currentCodeProvenance } from '../../paper-core/src/code-provenance.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function markdown(report, includeSummaryHeading = false) {
  return [
    `# Paper Batch ${report.mode}`, '', ...(includeSummaryHeading ? ['## Summary', ''] : []), '```json',
    JSON.stringify(report.summary, null, 2), '```', '', '## Blocker Families', '', report.blockerFamilyTable,
    '', '## Batch Table', '', report.markdownTable,
  ].join('\n');
}

export function buildBatchReport({ root, runtimeRoot, mode, execute, targetOverride, datasetRoot, benchmarkId, applyManuscript, scan, results, legacyCleanupAudit, coreIntegrity, targetScopeReceipt } = {}) {
  const rows = results.map((item) => item.workflowRow);
  const blockerFamilies = blockerFamilySummary(results);
  const report = {
    version: 1, kind: 'PaperBatchRunReport', generatedAt: nowIso(), root, runtimeRoot, mode, execute: Boolean(execute),
    codeProvenance: currentCodeProvenance(),
    requestedTargetOverride: String(targetOverride || '').trim() || null,
    requestedDatasetRoot: String(datasetRoot || '').trim() || null,
    requestedBenchmarkId: String(benchmarkId || '').trim() || null,
    requestedApplyManuscript: Boolean(applyManuscript),
    registryRefs: scan.registryRefs,
    targetScopeReceipt,
    inventory: { source: scan.inventorySource, fallback: scan.inventoryFallback, quarantinedCount: scan.quarantined?.length || 0, quarantined: scan.quarantined || [] },
    summary: { ...summarizeRows(rows, mode), ...summarizeResults(results, legacyCleanupAudit), blockerFamilies },
    rows, results, legacyCleanupAudit, coreIntegrity,
    markdownTable: makeMarkdownTable(rows), blockerFamilyTable: makeBlockerFamilyMarkdown(blockerFamilies),
    safety: { coreSnapshotModified: coreIntegrity.coreSnapshotModified, coreIntegrityStatus: coreIntegrity.status, upstreamCoreSnapshotExactMatch: coreIntegrity.upstream.exactMatch, importsOldPaperFactoryControlPlane: false, externalActionPerformed: false, reviewedSubmitBlockedByDefault: true },
  };
  return { ...report, reportHash: hashRecord('PaperBatchRunReport', report) };
}

export async function persistBatchReport(report) {
  const reportRoot = path.join(report.runtimeRoot, 'reports');
  await ensureDir(reportRoot);
  const stamp = report.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const base = path.join(reportRoot, `paper-batch-${report.mode}-${stamp}`);
  await writeJsonFile(`${base}.json`, report, { scopeRoot: reportRoot, role: 'paper_batch_report' });
  await writeTextFile(`${base}.md`, markdown(report), { scopeRoot: reportRoot, role: 'paper_batch_report_markdown' });
  const pointer = {
    version: 1,
    kind: 'CurrentReportPointer',
    status: 'current_report_pointer',
    mode: report.mode,
    reportPath: path.basename(`${base}.json`),
    reportHash: report.reportHash,
    generatedAt: report.generatedAt,
    validUntil: new Date(Date.parse(report.generatedAt) + 24 * 60 * 60 * 1000).toISOString(),
    codeProvenance: report.codeProvenance,
  };
  await writeJsonFile(path.join(reportRoot, `paper-batch-${report.mode}-latest.json`), pointer, { scopeRoot: reportRoot, role: 'paper_batch_current_report_pointer' });
  await writeTextFile(path.join(reportRoot, `paper-batch-${report.mode}-latest.md`), ['# Current report pointer', '', '```json', JSON.stringify(pointer, null, 2), '```', ''].join('\n'), { scopeRoot: reportRoot, role: 'paper_batch_current_report_pointer_markdown' });
}

export function renderBatchConsole(report) {
  return [`paper-production-core ${report.mode}`, JSON.stringify(report.summary), '', report.markdownTable].join('\n');
}
