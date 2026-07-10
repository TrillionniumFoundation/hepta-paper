#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIntegrationGateSequenceRegressionReport } from './integration-gate-sequence-regression.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function markdownFor(report) {
  const lines = [
    '# Integration Gate Sequence Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.sequenceRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual sequence ok: ${report.summary.actualOk}`,
    `- Lifecycle ok: ${report.summary.lifecycleOk}`,
    `- Lock release before stdout: ${report.summary.lifecycleReleaseBeforeStdout}`,
    `- Busy lock writes reports: ${report.summary.lifecycleWritesReportWhileBusy}`,
    `- Finally release fallback: ${report.summary.lifecycleFinallyReleaseFallback}`,
    `- Actual steps: ${report.summary.actualStepCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Regression blockers: ${report.summary.blockerCount}`,
    '',
    '## Expected Order',
    '',
    ...report.fixture.expectedOrder.map((stepId, index) => `${index + 1}. ${stepId}`),
    '',
    '## Actual Sequence',
    '',
    `- Status: ${report.actual.status}`,
    `- Steps extracted: ${report.actual.stepCount}`,
    `- Required steps: ${report.actual.requiredStepCount}`,
    `- Blockers: ${report.actual.blockers.length}`,
    '',
    '## Lifecycle',
    '',
    `- Status: ${report.lifecycle.status}`,
    `- Release before stdout: ${report.lifecycle.releaseBeforeStdout}`,
    `- Busy lock writes reports: ${report.lifecycle.writesReportWhileBusy}`,
    `- Finally release fallback: ${report.lifecycle.finallyReleaseFallback}`,
    `- Blockers: ${report.lifecycle.blockers.length}`,
    '',
    '## Scenarios',
    '',
    '| Scenario | Status | Expected blocker | Observed blockers | Analysis blockers |',
    '| --- | --- | --- | --- | ---: |',
    ...report.scenarios.map((scenario) => `| ${scenario.scenarioId} | ${scenario.status} | ${scenario.expectedBlockerCode} | ${scenario.observedBlockerCodes.join('<br>') || 'none'} | ${scenario.analysis.blockers.length} |`),
    '',
    '## Regression Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code} ${item.scenarioId || item.stepId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Source inspection and synthetic fixtures only.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'integration-gate-sequence-regression-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const sourceText = fs.readFileSync(path.join(packageRoot, 'src', 'integration-dependency-gate.mjs'), 'utf8');
  const report = buildIntegrationGateSequenceRegressionReport({ sourceText });
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    sequenceRegressionHash: report.sequenceRegressionHash,
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
