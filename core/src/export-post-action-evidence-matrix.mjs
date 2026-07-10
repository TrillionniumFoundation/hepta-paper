#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildPostActionEvidenceMatrixReport } from './post-action-evidence-matrix.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Post-action Evidence Matrix',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.postActionEvidenceMatrixHash}`,
    `Generated: ${report.generatedAt}`,
    `Runtime dry-run harness hash: ${report.runtimeDryRunHarnessHash}`,
    '',
    '## Summary',
    '',
    `- Routes: ${report.summary.routeCount}`,
    `- Action classes: ${report.summary.actionClassCount}`,
    `- Accepted receipts: ${report.summary.acceptedReceiptCount}`,
    `- Verified state proofs: ${report.summary.verifiedStateProofCount}`,
    `- Missing receipt fields blocked: ${report.summary.blockedMissingReceiptFieldCount}`,
    `- Missing state proof fields blocked: ${report.summary.blockedMissingStateProofFieldCount}`,
    `- Tampered state proof fields blocked: ${report.summary.blockedTamperedStateProofFieldCount}`,
    `- Blockers: ${report.blockers.length}`,
    '',
    '## Matrix',
    '',
    '| Scenario | Action | Role | Receipt | Proof | Missing receipt | Missing proof | Tampered proof |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map((row) => [
      `| ${row.scenarioId}`,
      row.action,
      row.packageRole || 'n/a',
      row.receiptStatus,
      row.proofStatus,
      row.missingReceiptStatus,
      row.missingProofStatus,
      row.tamperedProofStatus,
      '|',
    ].join(' | ')),
    '',
    '## Contract Fields',
    '',
    ...report.rows.flatMap((row) => [
      `- ${row.scenarioId}`,
      `- Receipt fields: ${row.receiptResultFields.join(', ')}`,
      `- State proof fields: ${row.stateProofFields.join(', ')}`,
      '',
    ]),
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code}: ${item.notes || ''}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Synthetic fixture records only.',
    '- No runner process is spawned.',
    '- No browser/API session, upload, submit, IM, acceptance, payment, deployment, provider/model call, channel-state fetch, or local lifecycle mutation is performed.',
    '- This proves post-action receipt/proof contract shape only; it does not grant execution permission.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'post-action-evidence-matrix-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPostActionEvidenceMatrixReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    postActionEvidenceMatrixHash: report.postActionEvidenceMatrixHash,
    runtimeDryRunHarnessHash: report.runtimeDryRunHarnessHash,
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
