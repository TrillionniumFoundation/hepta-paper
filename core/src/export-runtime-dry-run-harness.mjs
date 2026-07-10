#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildRuntimeDryRunHarnessReport } from './runtime-dry-run-harness.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Runtime Dry-run Harness',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.runtimeDryRunHarnessHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Ready handoffs: ${report.summary.readyScenarioCount}`,
    `- Blocked handoffs: ${report.summary.blockedScenarioCount}`,
    `- Ready SDK contracts: ${report.summary.readyForExternalImplementationCount}`,
    `- Ready handoffs missing action evidence contract: ${report.summary.readyScenarioMissingActionEvidenceContractCount}`,
    `- Blockers: ${report.blockers.length}`,
    '',
    '## Scenarios',
    '',
    '| Scenario | Status | External runner | SDK | Expected blockers observed |',
    '| --- | --- | --- | --- | --- |',
    ...report.scenarios.map((scenario) => [
      `| ${scenario.scenarioId}`,
      scenario.status,
      scenario.readyForExternalRunner ? 'ready' : 'blocked',
      scenario.readyForExternalImplementation ? 'ready' : 'blocked',
      scenario.observedExpectedBlockers ? 'yes' : 'no',
      '|',
    ].join(' | ')),
    '',
    '## Ready Handoff',
    '',
    ...report.scenarios
      .filter((scenario) => scenario.readyForExternalRunner)
      .flatMap((scenario) => [
        `- Scenario: ${scenario.scenarioId}`,
        `- Channel/action: ${scenario.handoff.channelId} / ${scenario.handoff.actionId}`,
        `- Package role: ${scenario.handoff.packageRole || 'n/a'}`,
        `- Task: ${scenario.handoff.taskKey}`,
        `- Runner: ${scenario.handoff.runnerId} at ${scenario.handoff.runnerLocation}`,
        `- Receipt fields: ${scenario.handoff.sdkActionEvidenceContract?.receiptResultFields?.join(', ') || 'none'}`,
        `- State proof fields: ${scenario.handoff.sdkActionEvidenceContract?.stateProofFields?.join(', ') || 'none'}`,
        `- SDK phases: ${scenario.handoff.sdkPhaseOrder.join(' -> ')}`,
        `- Manifest hash: ${scenario.hashes.manifestHash}`,
        `- Readiness hash: ${scenario.hashes.readinessReportHash}`,
        `- SDK hash: ${scenario.hashes.sdkHash}`,
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
    '- A ready external-runner handoff is not execution permission; the external runner must recheck approval, evidence, replay guard, and current channel state.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'runtime-dry-run-harness-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildRuntimeDryRunHarnessReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
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
