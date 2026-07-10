#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildPostActionDispatchEnvelopeMatrixReport } from './post-action-dispatch-envelope-matrix.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Post-action Dispatch Envelope Matrix',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.postActionDispatchEnvelopeMatrixHash}`,
    `Generated: ${report.generatedAt}`,
    `Runtime dry-run harness hash: ${report.runtimeDryRunHarnessHash}`,
    `Post-action evidence matrix hash: ${report.postActionEvidenceMatrixHash}`,
    `Post-action audit archive matrix hash: ${report.postActionAuditArchiveMatrixHash}`,
    `Post-action replay guard matrix hash: ${report.postActionReplayGuardMatrixHash}`,
    `Archive hash: ${report.archiveHash}`,
    '',
    '## Summary',
    '',
    `- Routes: ${report.summary.routeCount}`,
    `- Action classes: ${report.summary.actionClassCount}`,
    `- Archive entries: ${report.summary.archiveEntries}`,
    `- Ready envelopes: ${report.summary.readyEnvelopeCount}`,
    `- Blocked replay envelopes: ${report.summary.blockedReplayEnvelopeCount}`,
    `- Mismatch envelopes blocked: ${report.summary.mismatchEnvelopeBlockedCount}`,
    `- Tampered outbox envelopes blocked: ${report.summary.tamperedOutboxEnvelopeBlockedCount}`,
    `- Stripped outbox alias candidate null: ${report.summary.strippedOutboxAliasCandidateNullCount}`,
    `- Stripped outbox alias envelopes blocked: ${report.summary.strippedOutboxAliasEnvelopeBlockedCount}`,
    `- Stripped outbox alias blocker count: ${report.summary.strippedOutboxAliasBlockedCount}`,
    `- Missing replay guard envelopes blocked: ${report.summary.missingReplayGuardEnvelopeBlockedCount}`,
    `- Replay-not-clear blocker count: ${report.summary.replayGuardNotClearBlockedCount}`,
    `- Candidate mismatch blocker count: ${report.summary.mismatchCandidateBlockedCount}`,
    `- Tampered outbox hash blocker count: ${report.summary.tamperedOutboxHashBlockedCount}`,
    `- Missing replay guard blocker count: ${report.summary.missingReplayGuardBlockedCount}`,
    `- Ready envelope hash bindings: ${report.summary.readyEnvelopeHashBindings}`,
    `- Blockers: ${report.blockers.length}`,
    '',
    '## Matrix',
    '',
    '| Scenario | Action | Role | Ready | Replay blocked | Mismatch | Tampered outbox | Missing replay guard |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map((row) => [
      `| ${row.scenarioId}`,
      row.action,
      row.packageRole || 'n/a',
      row.readyEnvelopeStatus,
      row.blockedReplayEnvelopeStatus,
      row.mismatchEnvelopeStatus,
      row.tamperedOutboxEnvelopeStatus,
      `${row.missingReplayGuardEnvelopeStatus} |`,
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
    '- Dispatch envelopes are handoff records only.',
    '- No runner process is spawned or dispatched.',
    '- No browser/API session, upload, submit, IM/customer message, acceptance, payment, deployment, provider/model call, channel-state fetch, local lifecycle mutation, or execution permission is performed or granted.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'post-action-dispatch-envelope-matrix-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPostActionDispatchEnvelopeMatrixReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    postActionDispatchEnvelopeMatrixHash: report.postActionDispatchEnvelopeMatrixHash,
    runtimeDryRunHarnessHash: report.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: report.postActionEvidenceMatrixHash,
    postActionAuditArchiveMatrixHash: report.postActionAuditArchiveMatrixHash,
    postActionReplayGuardMatrixHash: report.postActionReplayGuardMatrixHash,
    archiveHash: report.archiveHash,
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
