#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildPostActionAuditBundleMatrixReport } from './post-action-audit-bundle-matrix.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Post-action Audit Bundle Matrix',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.postActionAuditBundleMatrixHash}`,
    `Generated: ${report.generatedAt}`,
    `Runtime dry-run harness hash: ${report.runtimeDryRunHarnessHash}`,
    `Post-action evidence matrix hash: ${report.postActionEvidenceMatrixHash}`,
    '',
    '## Summary',
    '',
    `- Routes: ${report.summary.routeCount}`,
    `- Action classes: ${report.summary.actionClassCount}`,
    `- Receipt inbox received: ${report.summary.receiptInboxReceivedCount}`,
    `- Proof inbox received: ${report.summary.proofInboxReceivedCount}`,
    `- Transition inbox received: ${report.summary.transitionInboxReceivedCount}`,
    `- Verified ledgers: ${report.summary.verifiedLedgerCount}`,
    `- Verified audit bundles: ${report.summary.verifiedAuditBundleCount}`,
    `- Raw ledger bundles blocked: ${report.summary.rawLedgerBundleBlockedCount}`,
    `- Missing transition inbox bundles blocked: ${report.summary.missingTransitionInboxBundleBlockedCount}`,
    `- Inbox hash chains present: ${report.summary.inboxHashChainPresentCount}`,
    `- Customer-message preview-hash-bound routes: ${report.summary.customerMessageHashBoundRouteCount}`,
    `- Human-feedback contract-bound routes: ${report.summary.humanFeedbackContractBoundRouteCount}`,
    `- Stripped message hash bundles blocked (payload/chain): ${report.summary.strippedPayloadMessageHashBundleBlockedCount}/${report.summary.strippedChainMessageHashBundleBlockedCount}`,
    `- Stripped feedback contract bundles blocked (payload/chain): ${report.summary.strippedPayloadContractHashBundleBlockedCount}/${report.summary.strippedChainContractHashBundleBlockedCount}`,
    `- Stripped prompt binding bundles blocked (payload/chain): ${report.summary.strippedPayloadPromptBindingBundleBlockedCount}/${report.summary.strippedChainPromptBindingBundleBlockedCount}`,
    `- Blockers: ${report.blockers.length}`,
    '',
    '## Matrix',
    '',
    '| Scenario | Action | Workflow | Role | Message Hash | Feedback Contract | Receipt inbox | Proof inbox | Transition inbox | Ledger | Bundle | Raw bundle | Missing transition bundle | Message strip | Contract strip | Prompt strip |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map((row) => [
      `| ${row.scenarioId}`,
      row.action,
      row.workflowId || 'n/a',
      row.packageRole || 'n/a',
      row.messagePreviewHash || 'n/a',
      row.humanFeedbackRevisionContractHash || 'n/a',
      row.receiptInboxStatus,
      row.proofInboxStatus,
      row.transitionInboxStatus,
      row.ledgerStatus,
      row.auditBundleStatus,
      row.rawLedgerBundleStatus,
      row.missingTransitionInboxBundleStatus,
      `${row.strippedPayloadMessageHashBundleStatus || 'n/a'}/${row.strippedChainMessageHashBundleStatus || 'n/a'}`,
      `${row.strippedPayloadContractHashBundleStatus || 'n/a'}/${row.strippedChainContractHashBundleStatus || 'n/a'}`,
      `${row.strippedPayloadPromptBindingBundleStatus || 'n/a'}/${row.strippedChainPromptBindingBundleStatus || 'n/a'} |`,
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
    '- No runner process is spawned.',
    '- No browser/API session, upload, submit, IM/customer message, acceptance, payment, deployment, provider/model call, channel-state fetch, or local lifecycle mutation is performed.',
    '- This proves post-action audit bundle closure only; it does not grant execution permission.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'post-action-audit-bundle-matrix-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPostActionAuditBundleMatrixReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    postActionAuditBundleMatrixHash: report.postActionAuditBundleMatrixHash,
    runtimeDryRunHarnessHash: report.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: report.postActionEvidenceMatrixHash,
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
