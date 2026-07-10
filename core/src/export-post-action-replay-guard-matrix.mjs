#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildPostActionReplayGuardMatrixReport } from './post-action-replay-guard-matrix.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Post-action Replay Guard Matrix',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.postActionReplayGuardMatrixHash}`,
    `Generated: ${report.generatedAt}`,
    `Runtime dry-run harness hash: ${report.runtimeDryRunHarnessHash}`,
    `Post-action evidence matrix hash: ${report.postActionEvidenceMatrixHash}`,
    `Post-action audit archive matrix hash: ${report.postActionAuditArchiveMatrixHash}`,
    `Aggregate archive hash: ${report.aggregateArchiveHash}`,
    '',
    '## Summary',
    '',
    `- Routes: ${report.summary.routeCount}`,
    `- Action classes: ${report.summary.actionClassCount}`,
    `- Aggregate archive entries: ${report.summary.aggregateArchiveEntries}`,
    `- New candidates clear: ${report.summary.newCandidateClearCount}`,
    `- Archived task/action blocked: ${report.summary.archivedTaskActionBlockedCount}`,
    `- Repeat missing approval blocked: ${report.summary.repeatMissingApprovalBlockedCount}`,
    `- Repeat approved clear: ${report.summary.repeatApprovedClearCount}`,
    `- Exact replay blocked: ${report.summary.exactReplayBlockedCount}`,
    `- Blocked archive decisions blocked: ${report.summary.blockedArchiveDecisionBlockedCount}`,
    `- Task/action replay blocker count: ${report.summary.taskActionReplayBlockedCount}`,
    `- Repeat approval required blocker count: ${report.summary.repeatApprovalRequiredBlockedCount}`,
    `- Repeat approved warning count: ${report.summary.repeatApprovedWarningCount}`,
    `- Exact bundle/ledger replay blocked: ${report.summary.exactBundleReplayBlockedCount}/${report.summary.exactLedgerReplayBlockedCount}`,
    `- Blocked archive not-ready blocker count: ${report.summary.blockedArchiveNotReadyBlockedCount}`,
    `- Blockers: ${report.blockers.length}`,
    '',
    '## Matrix',
    '',
    '| Scenario | Action | Role | New | Archived task/action | Repeat missing approval | Repeat approved | Exact replay | Blocked archive |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map((row) => [
      `| ${row.scenarioId}`,
      row.action,
      row.packageRole || 'n/a',
      row.newCandidateStatus,
      row.archivedTaskActionStatus,
      row.repeatMissingApprovalStatus,
      row.repeatApprovedStatus,
      row.exactReplayStatus,
      `${row.blockedArchiveStatus} |`,
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
    '- Replay guard decisions are checks only.',
    '- No runner process is spawned.',
    '- No browser/API session, upload, submit, IM/customer message, acceptance, payment, deployment, provider/model call, channel-state fetch, local lifecycle mutation, replay-state mutation, or archive-store mutation is performed.',
    '- This proves post-action replay guard closure only; it does not grant execution permission.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'post-action-replay-guard-matrix-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPostActionReplayGuardMatrixReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    postActionReplayGuardMatrixHash: report.postActionReplayGuardMatrixHash,
    runtimeDryRunHarnessHash: report.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: report.postActionEvidenceMatrixHash,
    postActionAuditArchiveMatrixHash: report.postActionAuditArchiveMatrixHash,
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
