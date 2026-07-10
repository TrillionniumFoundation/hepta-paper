#!/usr/bin/env node

import process from 'node:process';
import {
  buildHumanFeedbackIdentityNormalizationMatrix,
  summarizeHumanFeedbackIdentityNormalizationMatrix,
} from './human-feedback-identity-normalization-matrix.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');

function markdownFor(report) {
  const summary = report.summary || {};
  const failedRows = (report.rows || []).filter((row) => row.ok !== true);
  const profileLines = (report.profiles || []).map((profile) => (
    `- ${profile.id}: ${profile.failedRowCount}/${profile.rowCount} failed, action=${profile.expectedAction}, contract=${profile.contractHash}`
  ));
  const failedLines = failedRows.slice(0, 50).map((row) => (
    `- ${row.profileId}/${row.variant}/${row.surface}: ${(row.failures || []).join(', ') || 'failed'}`
  ));
  return [
    '# Human Feedback Identity Normalization Matrix',
    '',
    `Status: ${report.status}`,
    `Report hash: ${report.reportHash}`,
    '',
    '## Summary',
    '',
    `- Profiles: ${summary.profileCount}`,
    `- Surfaces: ${summary.surfaceCount}`,
    `- Rows: ${summary.passedRowCount}/${summary.rowCount} passed`,
    `- Contract-bound rows: ${summary.humanFeedbackContractBoundRows}`,
    `- Message-preview-bound rows: ${summary.messagePreviewBoundRows}`,
    `- Non-message rows without messagePreviewHash: ${summary.nonMessageRowsWithoutMessagePreviewHash}`,
    `- Unsafe rows: ${summary.unsafeRowCount}`,
    '',
    '## Profiles',
    '',
    ...(profileLines.length ? profileLines : ['- none']),
    '',
    '## Failed Rows',
    '',
    ...(failedLines.length ? failedLines : ['- none']),
    '',
    '## Safety',
    '',
    '- Report only: true',
    '- Executes external action: false',
    '- Sends messages/uploads/accepts/pays/deploys: false',
  ].join('\n');
}

const report = buildHumanFeedbackIdentityNormalizationMatrix();
const written = writeLatestReportPair({
  report,
  fileId: 'human-feedback-identity-normalization-matrix-latest.json',
  markdownFileId: 'human-feedback-identity-normalization-matrix-latest.md',
  markdown: markdownFor(report),
});
const summary = {
  ...summarizeHumanFeedbackIdentityNormalizationMatrix(report),
  latestJson: relativeToWorkspace(written.latestJson),
  latestMd: relativeToWorkspace(written.latestMd),
};

console.log(JSON.stringify(summary, null, 2));

if (strict && report.ok !== true) {
  process.exitCode = 1;
}
