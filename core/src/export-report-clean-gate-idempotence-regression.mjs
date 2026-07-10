#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CLEAN_GATE_IDEMPOTENCE_REGRESSION_REPORT_FILE_ID,
  buildReportCleanGateIdempotenceRegressionReport,
} from './report-clean-gate-idempotence-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function markdownFor(report) {
  const lines = [
    '# Report Clean Gate Idempotence Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.cleanGateIdempotenceRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual policy ok: ${report.summary.actualOk}`,
    `- Tracked reports: ${report.summary.trackedReportCount}`,
    `- Allowed seed files: ${report.summary.allowedSeedFileCount}`,
    `- Run A stable hashes: ${report.summary.runAMatchingHashCount}/${report.summary.runAComparableHashCount}`,
    `- Run B stable hashes: ${report.summary.runBMatchingHashCount}/${report.summary.runBComparableHashCount}`,
    `- Clean seed writes: ${report.summary.seedWriteCount}`,
    `- Clean seed skips: ${report.summary.seedSkipCount}`,
    `- Gate summary hashes: ${report.summary.gateSummaryHashCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Tracked Reports',
    '',
    '| File | Requirement |',
    '| --- | --- |',
    ...report.fixture.trackedFileIds.map((fileId) => `| ${fileId} | same stable semantic hash across run A and run B |`),
    '',
    '## Clean Bootstrap Decisions',
    '',
    '| File | Expected decision |',
    '| --- | --- |',
    ...report.fixture.allowedSeedFileIds.map((fileId) => `| ${fileId} | write=false / ${report.fixture.cleanSkipReason} |`),
    '',
    '## Scenarios',
    '',
    '| Scenario | Status | Expected blocker | Observed blockers |',
    '| --- | --- | --- | --- |',
    ...report.scenarios.map((scenario) => `| ${scenario.scenarioId} | ${scenario.status} | ${scenario.expectedBlockerCode} | ${scenario.observedBlockerCodes.join('<br>') || 'none'} |`),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code} ${item.scenarioId || item.fileId || item.stepId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Uses synthetic clean gate rerun fixtures and integration gate source inspection only.',
    '- Does not run the integration gate recursively.',
    '- Does not read or mutate real latest reports.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-clean-gate-idempotence-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportCleanGateIdempotenceRegressionLatest({ generatedAt = new Date().toISOString() } = {}) {
  return buildReportCleanGateIdempotenceRegressionReport({
    gateSourceText: fs.readFileSync(path.join(packageRoot, 'src', 'integration-dependency-gate.mjs'), 'utf8'),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportCleanGateIdempotenceRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    cleanGateIdempotenceRegressionHash: report.cleanGateIdempotenceRegressionHash,
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
