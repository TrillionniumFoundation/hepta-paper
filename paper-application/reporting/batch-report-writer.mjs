import path from 'node:path';
import { ensureDir } from '../../paper-core/src/runtime/file-utils.mjs';
import { nowIso } from '../../paper-core/src/runtime/time-utils.mjs';
import { writeJsonFile, writeTextFile } from '../../paper-adapters/artifacts/write-artifact.mjs';
import { blockerFamilySummary, makeBlockerFamilyMarkdown, makeMarkdownTable, summarizeResults, summarizeRows } from '../../paper-core/src/batch-summary.mjs';

function markdown(report, includeSummaryHeading = false) {
  return [
    `# Paper Batch ${report.mode}`, '', ...(includeSummaryHeading ? ['## Summary', ''] : []), '```json',
    JSON.stringify(report.summary, null, 2), '```', '', '## Blocker Families', '', report.blockerFamilyTable,
    '', '## Batch Table', '', report.markdownTable,
  ].join('\n');
}

export function buildBatchReport({ root, runtimeRoot, mode, execute, targetOverride, datasetRoot, benchmarkId, applyManuscript, scan, results, legacyCleanupAudit, coreIntegrity } = {}) {
  const rows = results.map((item) => item.workflowRow);
  const blockerFamilies = blockerFamilySummary(results);
  return {
    version: 1, kind: 'PaperBatchRunReport', generatedAt: nowIso(), root, runtimeRoot, mode, execute: Boolean(execute),
    requestedTargetOverride: String(targetOverride || '').trim() || null,
    requestedDatasetRoot: String(datasetRoot || '').trim() || null,
    requestedBenchmarkId: String(benchmarkId || '').trim() || null,
    requestedApplyManuscript: Boolean(applyManuscript),
    registryRefs: scan.registryRefs,
    inventory: { source: scan.inventorySource, fallback: scan.inventoryFallback, quarantinedCount: scan.quarantined?.length || 0, quarantined: scan.quarantined || [] },
    summary: { ...summarizeRows(rows, mode), ...summarizeResults(results, legacyCleanupAudit), blockerFamilies },
    rows, results, legacyCleanupAudit, coreIntegrity,
    markdownTable: makeMarkdownTable(rows), blockerFamilyTable: makeBlockerFamilyMarkdown(blockerFamilies),
    safety: { coreSnapshotModified: coreIntegrity.coreSnapshotModified, coreIntegrityStatus: coreIntegrity.status, upstreamCoreSnapshotExactMatch: coreIntegrity.upstream.exactMatch, importsOldPaperFactoryControlPlane: false, externalActionPerformed: false, reviewedSubmitBlockedByDefault: true },
  };
}

export async function persistBatchReport(report) {
  const reportRoot = path.join(report.runtimeRoot, 'reports');
  await ensureDir(reportRoot);
  const stamp = report.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const base = path.join(reportRoot, `paper-batch-${report.mode}-${stamp}`);
  await writeJsonFile(`${base}.json`, report, { scopeRoot: reportRoot, role: 'paper_batch_report' });
  await writeTextFile(`${base}.md`, markdown(report), { scopeRoot: reportRoot, role: 'paper_batch_report_markdown' });
  await writeJsonFile(path.join(reportRoot, `paper-batch-${report.mode}-latest.json`), report, { scopeRoot: reportRoot, role: 'paper_batch_latest_report' });
  await writeTextFile(path.join(reportRoot, `paper-batch-${report.mode}-latest.md`), markdown(report, true), { scopeRoot: reportRoot, role: 'paper_batch_latest_markdown' });
}

export function renderBatchConsole(report) {
  return [`paper-production-core ${report.mode}`, JSON.stringify(report.summary), '', report.markdownTable].join('\n');
}
