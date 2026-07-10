#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildPostActionReconciliationMatrixReport } from './post-action-reconciliation-matrix.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Post-Action Reconciliation Matrix',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.postActionReconciliationMatrixHash}`,
    `Generated: ${report.generatedAt}`,
    `Post-action dispatch completion matrix hash: ${report.postActionDispatchCompletionMatrixHash}`,
    `Aggregate archive hash: ${report.aggregateArchiveHash}`,
    '',
    '## Summary',
    '',
    `- Routes: ${report.summary.routeCount}`,
    `- Action classes: ${report.summary.actionClassCount}`,
    `- Dispatch completion matrix ok: ${report.summary.postActionDispatchCompletionMatrixOk}`,
    `- Aggregate archive entries: ${report.summary.aggregateArchiveEntries}`,
    `- Aggregate dispatch-chain entries: ${report.summary.aggregateDispatchInboxChainEntries}`,
    `- Reconciled routes: ${report.summary.reconciledRouteCount}`,
    `- Aggregate / per-route archive matches: ${report.summary.aggregateEntryMatchCount}/${report.summary.perRouteArchiveMatchCount}`,
    `- Bundle-ledger matches: ${report.summary.bundleLedgerMatchCount}`,
    `- Aggregate / per-route dispatch-chain matches: ${report.summary.aggregateDispatchChainMatchCount}/${report.summary.perRouteDispatchChainMatchCount}`,
    `- Dispatch-chain matches: ${report.summary.dispatchChainMatchCount}`,
    `- Stripped bundle alias probes blocked: ${report.summary.strippedBundleAliasBlockedCount}`,
    `- Missing aggregate / tampered bundle / missing dispatch chain / per-route drift blocked: ${report.summary.missingAggregateEntryBlockedCount}/${report.summary.tamperedBundleBlockedCount}/${report.summary.missingDispatchChainBlockedCount}/${report.summary.perRouteArchiveDriftBlockedCount}`,
    `- Missing bundle / ledger dispatch source probes blocked: ${report.summary.missingBundleDispatchSourceBlockedCount}/${report.summary.missingLedgerDispatchSourceBlockedCount}`,
    `- Customer-message hash routes / drift probes blocked: ${report.summary.customerMessageHashRouteCount}/${report.summary.customerMessageHashDriftBlockedCount}`,
    `- Human-feedback contract routes / drift probes blocked: ${report.summary.humanFeedbackContractRouteCount}/${report.summary.humanFeedbackContractDriftBlockedCount}`,
    `- Prompt-generation binding routes / drift probes blocked: ${report.summary.promptGenerationBindingRouteCount}/${report.summary.promptGenerationBindingDriftBlockedCount}`,
    `- Package-role routes / drift probes blocked: ${report.summary.packageRoleRouteCount}/${report.summary.packageRoleDriftBlockedCount}`,
    `- Blockers: ${report.blockers.length}`,
    '',
    '## Matrix',
    '',
    '| Scenario | Action | Workflow | Role | Message Hash | Feedback Contract | Prompt Binding | Reconciled | Aggregate | Per-route | Bundle | Dispatch chain |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map((row) => [
      `| ${row.scenarioId}`,
      row.action,
      row.workflowId || 'n/a',
      row.packageRole || 'n/a',
      row.messagePreviewHash || 'n/a',
      row.humanFeedbackRevisionContractHash || 'n/a',
      row.promptGenerationBinding?.generationJobId || 'n/a',
      row.ok,
      row.aggregateEntryMatched,
      row.perRouteEntryMatched,
      row.bundleLedgerMatched,
      `${row.dispatchChainMatched} |`,
    ].join(' | ')),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code}: ${item.notes || ''}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Uses synthetic local fixtures only.',
    '- Reconciles dispatch completion evidence only.',
    '- Does not run adapters, consume queues, acknowledge dispatch completion, fetch channel state, apply local state, upload, submit, send messages, pay, accept, deploy, call providers/models, or grant execution permission.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPostActionReconciliationMatrixReport();
  const reportFiles = writeLatestReportPair({
    report,
    fileId: 'post-action-reconciliation-matrix-latest.json',
    markdown: markdownFor(report),
  });

  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    postActionReconciliationMatrixHash: report.postActionReconciliationMatrixHash,
    postActionDispatchCompletionMatrixHash: report.postActionDispatchCompletionMatrixHash,
    aggregateArchiveHash: report.aggregateArchiveHash,
    summary: report.summary,
    blockers: report.blockers.map((blocker) => blocker.code),
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  }, null, 2)}\n`);
  if (strict && !report.ok) process.exit(1);
}

if (isCliEntrypoint(import.meta.url)) main();
