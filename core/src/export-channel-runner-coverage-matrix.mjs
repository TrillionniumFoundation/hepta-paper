#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildChannelRunnerCoverageMatrixReport } from './channel-runner-coverage-matrix.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const routeRows = (report.rows || [])
    .slice()
    .sort((left, right) => `${left.channelId}:${left.actionId}`.localeCompare(`${right.channelId}:${right.actionId}`))
    .map((row) => [
      row.channelId,
      row.actionId,
      row.action,
      row.packageRole || 'n/a',
      row.implementationClass,
      row.messagePreviewHash || 'n/a',
      row.humanFeedbackRevisionContractHash || 'n/a',
      row.liveEntrypointMatched ? 'yes' : 'no',
      row.liveEntrypointMatched ? (row.liveEntrypointOk === true ? 'yes' : 'no') : 'n/a',
      row.lifecycleValidationStatus || 'n/a',
      row.blockers.length ? row.blockers.map((blocker) => blocker.code).join(', ') : 'none',
    ]);
  const lines = [
    '# Channel Runner Coverage Matrix',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.channelRunnerCoverageMatrixHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Runtime ready routes: ${report.summary.runtimeReadyRouteCount}`,
    `- Matrix routes: ${report.summary.routeCount}`,
    `- Classified routes: ${report.summary.classifiedRouteCount}`,
    `- Unclassified routes: ${report.summary.unclassifiedRouteCount}`,
    `- Implemented live entrypoint routes: ${report.summary.implementedLiveEntrypointRouteCount}`,
    `- Guarded provider/model spend routes: ${report.summary.guardedProviderSpendRouteCount}/${report.summary.guardedModelSpendRouteCount}`,
    `- Prepare-only routes: ${report.summary.prepareOnlyRouteCount}`,
    `- Preview-only customer-message routes: ${report.summary.previewOnlyCustomerMessageRouteCount}`,
    `- Customer-message hash-bound routes: ${report.summary.customerMessageHashBoundRouteCount}`,
    `- Human-feedback message hash-bound routes: ${report.summary.humanFeedbackMessageHashBoundRouteCount}`,
    `- Human-feedback contract-bound routes: ${report.summary.humanFeedbackContractBoundRouteCount}`,
    `- Audit-only live entrypoints: ${report.summary.auditOnlyLiveEntrypointCount}`,
    `- Blockers: ${report.blockers.length}`,
    '',
    '## Route Classes',
    '',
    ...Object.entries(report.summary.byImplementationClass || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => `- ${key}: ${count}`),
    '',
    '## Route Matrix',
    '',
    '| Channel | Action ID | Action | Role | Class | Message Hash | Feedback Contract | Live Entry | Live OK | Lifecycle | Blockers |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...routeRows.map((row) => `| ${row.join(' | ')} |`),
    '',
    '## Audit-Only Live Entrypoints',
    '',
    ...((report.auditOnlyLiveEntrypoints || []).length
      ? report.auditOnlyLiveEntrypoints.map((row) => `- ${row.actionId}: ${row.status}`)
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Uses local code/package-script inspection and synthetic runtime handoff reports only.',
    '- Does not run adapters, dispatch runners, consume queues, fetch channel state, upload, submit, send messages, pay, accept, deploy, call providers/models, or grant execution permission.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildChannelRunnerCoverageMatrixReport();
  const reportFiles = writeLatestReportPair({
    fileId: 'channel-runner-coverage-matrix-latest.json',
    report,
    markdown: markdownFor(report),
  });

  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    channelRunnerCoverageMatrixHash: report.channelRunnerCoverageMatrixHash,
    runtimeDryRunHarnessHash: report.runtimeDryRunHarnessHash,
    summary: report.summary,
    blockers: report.blockers.map((blocker) => blocker.code),
    warnings: report.warnings.map((warning) => warning.code),
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  }, null, 2)}\n`);
  if (strict && !report.ok) process.exit(1);
}

if (isCliEntrypoint(import.meta.url)) main();
