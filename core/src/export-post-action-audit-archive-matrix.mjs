#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildPostActionAuditArchiveMatrixReport } from './post-action-audit-archive-matrix.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Post-action Audit Archive Matrix',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.postActionAuditArchiveMatrixHash}`,
    `Generated: ${report.generatedAt}`,
    `Runtime dry-run harness hash: ${report.runtimeDryRunHarnessHash}`,
    `Post-action evidence matrix hash: ${report.postActionEvidenceMatrixHash}`,
    `Post-action audit bundle matrix hash: ${report.postActionAuditBundleMatrixHash}`,
    `Aggregate archive hash: ${report.aggregateArchiveHash}`,
    '',
    '## Summary',
    '',
    `- Routes: ${report.summary.routeCount}`,
    `- Action classes: ${report.summary.actionClassCount}`,
    `- Aggregate archive: ${report.summary.aggregateArchiveStatus}`,
    `- Aggregate entries: ${report.summary.aggregateArchiveEntries}`,
    `- Aggregate verified entries: ${report.summary.aggregateVerifiedEntries}`,
    `- Aggregate customer-message preview-hash-bound entries: ${report.summary.aggregateCustomerMessagePreviewHashBoundEntries}`,
    `- Aggregate human-feedback contract-bound entries: ${report.summary.aggregateHumanFeedbackContractBoundEntries}`,
    `- Aggregate bundle/ledger hashes: ${report.summary.aggregateBundleHashes}/${report.summary.aggregateLedgerHashes}`,
    `- Archived action IDs: ${report.summary.archivedActionIds}`,
    `- Archived channels: ${report.summary.archivedChannels}`,
    `- Per-route archives ready: ${report.summary.perRouteArchiveReadyCount}`,
    `- Raw bundle archives blocked: ${report.summary.rawBundleArchiveBlockedCount}`,
    `- Missing transition archives blocked: ${report.summary.missingTransitionArchiveBlockedCount}`,
    `- Stripped message hash archives blocked (payload/binding): ${report.summary.strippedPayloadMessageHashArchiveBlockedCount}/${report.summary.strippedBindingMessageHashArchiveBlockedCount}`,
    `- Stripped feedback contract archives blocked (payload/binding): ${report.summary.strippedPayloadContractHashArchiveBlockedCount}/${report.summary.strippedBindingContractHashArchiveBlockedCount}`,
    `- Stripped prompt binding archives blocked (payload/binding): ${report.summary.strippedPayloadPromptBindingArchiveBlockedCount}/${report.summary.strippedBindingPromptBindingArchiveBlockedCount}`,
    `- Duplicate archive blocked: ${report.summary.duplicateArchiveBlocked}`,
    `- Tampered archive blocked: ${report.summary.tamperedArchiveBlocked}`,
    `- Empty archive blocked: ${report.summary.emptyArchiveBlocked}`,
    `- Blockers: ${report.blockers.length}`,
    '',
    '## Matrix',
    '',
    '| Scenario | Action | Workflow | Role | Message Hash | Feedback Contract | Archive | Raw archive | Missing transition | Stripped message | Stripped contract | Stripped prompt binding |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map((row) => [
      `| ${row.scenarioId}`,
      row.action,
      row.workflowId || 'n/a',
      row.packageRole || 'n/a',
      row.messagePreviewHash || 'n/a',
      row.humanFeedbackRevisionContractHash || 'n/a',
      row.archiveStatus,
      row.rawBundleArchiveStatus,
      row.missingTransitionArchiveStatus,
      `${row.strippedPayloadMessageHashArchiveStatus || 'n/a'}/${row.strippedBindingMessageHashArchiveStatus || 'n/a'}`,
      `${row.strippedPayloadContractHashArchiveStatus || 'n/a'}/${row.strippedBindingContractHashArchiveStatus || 'n/a'}`,
      `${row.strippedPayloadPromptBindingArchiveStatus || 'n/a'}/${row.strippedBindingPromptBindingArchiveStatus || 'n/a'} |`,
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
    '- Synthetic fixture records only.',
    '- Archive outputs are redacted indexes only.',
    '- No runner process is spawned.',
    '- No browser/API session, upload, submit, IM/customer message, acceptance, payment, deployment, provider/model call, channel-state fetch, local lifecycle mutation, or archive-store mutation is performed.',
    '- This proves post-action audit archive closure only; it does not grant execution permission.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'post-action-audit-archive-matrix-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPostActionAuditArchiveMatrixReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    postActionAuditArchiveMatrixHash: report.postActionAuditArchiveMatrixHash,
    runtimeDryRunHarnessHash: report.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: report.postActionEvidenceMatrixHash,
    postActionAuditBundleMatrixHash: report.postActionAuditBundleMatrixHash,
    aggregateArchiveHash: report.aggregateArchiveHash,
    summary: report.summary,
    blockers: report.blockers.map((item) => item.code),
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  }, null, 2)}\n`);
  if (strict && !report.ok) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) main();
