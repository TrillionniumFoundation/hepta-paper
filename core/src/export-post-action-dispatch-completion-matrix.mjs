#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { EXTERNAL_ACTIONS, canonicalExternalAction } from './contracts.mjs';
import { buildPostActionDispatchCompletionMatrixReport } from './post-action-dispatch-completion-matrix.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Post-Action Dispatch Completion Matrix',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.postActionDispatchCompletionMatrixHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Routes: ${report.summary.routeCount}`,
    `- Action classes: ${report.summary.actionClassCount}`,
    `- Dispatch envelope matrix hash: ${report.postActionDispatchEnvelopeMatrixHash}`,
    `- Accepted dispatch receipts: ${report.summary.acceptedReceiptCount}`,
    `- Dispatch receipt inboxes received: ${report.summary.dispatchReceiptInboxReceivedCount}`,
    `- Verified dispatch proofs: ${report.summary.verifiedProofCount}`,
    `- Dispatch proof inboxes received: ${report.summary.dispatchProofInboxReceivedCount}`,
    `- Ready dispatch transitions: ${report.summary.readyTransitionCount}`,
    `- Dispatch transition inboxes received: ${report.summary.dispatchTransitionInboxReceivedCount}`,
    `- Verified dispatch ledgers: ${report.summary.verifiedLedgerCount}`,
    `- Verified dispatch audit bundles: ${report.summary.verifiedAuditBundleCount}`,
    `- Aggregate archive entries: ${report.summary.aggregateArchiveEntries}`,
    `- Aggregate dispatch-chain entries: ${report.summary.aggregateDispatchInboxChainEntries}`,
    `- Dispatch chain hash bindings: ${report.summary.dispatchChainHashBindingCount}`,
    `- Tampered receipt / missing proof / missing transition blocked: ${report.summary.tamperedReceiptInboxBlockedCount}/${report.summary.missingProofInboxBlockedCount}/${report.summary.missingTransitionInboxBlockedCount}`,
    `- Raw / missing-transition bundles blocked: ${report.summary.rawBundleBlockedCount}/${report.summary.missingTransitionBundleBlockedCount}`,
    `- Archived dispatch replay blocked: ${report.summary.archivedDispatchReplayBlockedCount}`,
    `- Stripped bundle alias candidate null: ${report.summary.strippedBundleAliasCandidateNullCount}`,
    `- Customer-message / human-feedback message routes: ${report.summary.customerMessageRouteCount}/${report.summary.humanFeedbackCustomerMessageRouteCount}`,
    `- Customer-message preview-hash-bound routes: ${report.summary.customerMessageHashBoundRouteCount}`,
    `- Human-feedback contract-bound routes: ${report.summary.humanFeedbackContractBoundRouteCount}`,
    `- Prompt-generation spend/binding-bound/archive-bound routes: ${report.summary.promptGenerationSpendRouteCount}/${report.summary.promptGenerationBindingBoundRouteCount}/${report.summary.aggregatePromptGenerationBindingBoundEntries}`,
    `- Stripped prompt binding null/blocked probes: ${report.summary.strippedPayloadPromptBindingReplayCandidateNullCount}/${report.summary.strippedPayloadPromptBindingReplayBlockedCount}`,
    `- Blockers: ${report.blockers.length}`,
    '',
    '## Route Bindings',
    '',
    '| Scenario | Action | Workflow | Role | Message Preview Hash | Human Feedback Contract Hash | Prompt Binding |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows
      .filter((row) => canonicalExternalAction(row.action) === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE
        || row.humanFeedbackRevisionContractHash
        || row.promptGenerationBinding)
      .map((row) => [
        `| ${row.scenarioId}`,
        row.action,
        row.workflowId || 'n/a',
        row.packageRole || 'n/a',
        row.messagePreviewHash || 'n/a',
        row.humanFeedbackRevisionContractHash || 'n/a',
        `${row.promptGenerationBinding?.generationJobId || 'n/a'} |`,
      ].join(' | ')),
    '',
    '## Safety',
    '',
    '- Uses synthetic local fixtures only.',
    '- Verifies dispatch completion evidence only.',
    '- Does not run adapters, consume queues, acknowledge dispatch completion, fetch channel state, apply local state, upload, submit, send messages, pay, accept, deploy, call providers/models, or grant execution permission.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildPostActionDispatchCompletionMatrixReport();
  const reportFiles = writeLatestReportPair({
    report,
    fileId: 'post-action-dispatch-completion-matrix-latest.json',
    markdown: markdownFor(report),
  });

  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    postActionDispatchCompletionMatrixHash: report.postActionDispatchCompletionMatrixHash,
    runtimeDryRunHarnessHash: report.runtimeDryRunHarnessHash,
    postActionEvidenceMatrixHash: report.postActionEvidenceMatrixHash,
    postActionReplayGuardMatrixHash: report.postActionReplayGuardMatrixHash,
    postActionDispatchEnvelopeMatrixHash: report.postActionDispatchEnvelopeMatrixHash,
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
