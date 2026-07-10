#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CLOSEOUT_DRIFT_CLASSIFICATION_REGRESSION_REPORT_FILE_ID,
  buildReportCloseoutDriftClassificationRegressionReport,
} from './report-closeout-drift-classification-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function docsText() {
  return [
    'README.md',
    'reports/README.md',
    'docs/integration-dependency-gate.md',
    'docs/report-final-settlement-regression.md',
    'docs/report-post-final-drift-regression.md',
  ].map((filePath) => readIfExists(path.join(packageRoot, filePath))).join('\n');
}

function markdownFor(report) {
  const lines = [
    '# Report Closeout Drift Classification Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.closeoutDriftClassificationRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual policy ok: ${report.summary.actualOk}`,
    `- Commands classified: ${report.summary.commandCount}`,
    `- Clean closeout commands: ${report.summary.cleanCloseoutCommandCount}`,
    `- Blocked gate-bound writers: ${report.summary.blockedGateBoundWriterCount}`,
    `- Documented blocked writers: ${report.summary.documentedBlockedWriterCount}`,
    `- Recovery-required blocked writers: ${report.summary.recoveryRequiredBlockedWriterCount}`,
    `- Allowed read-only probes: ${report.summary.allowedReadOnlyProbeCount}`,
    `- Allowed non-gate-bound writers: ${report.summary.allowedNonGateBoundWriterCount}`,
    `- Clean seed writes allowed: ${report.summary.cleanSeedWritesAllowed}`,
    `- Required scripts: ${report.summary.presentPackageScriptCount}/${report.summary.packageScriptCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Command Classes',
    '',
    '| Command | Class | Script | Latest report | Gate hash key | Allowed after final closeout | Recovery required |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.fixture.commandClassifications.map((command) => [
      command.commandId,
      command.classification,
      command.scriptId || 'none',
      command.fileId || 'none',
      command.gateSummaryHashKey || 'none',
      String(command.allowedAfterFinalCloseout),
      String(command.recoveryRequiredAfterDrift),
    ].join(' | ')).map((row) => `| ${row} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.scenarioId || item.commandId || item.stepId || item.scriptId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Uses synthetic command-class fixtures and local source/docs inspection only.',
    '- Does not run classified commands.',
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
    fileId: 'report-closeout-drift-classification-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportCloseoutDriftClassificationRegressionLatest({ generatedAt = new Date().toISOString() } = {}) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return buildReportCloseoutDriftClassificationRegressionReport({
    gateSourceText: fs.readFileSync(path.join(packageRoot, 'src', 'integration-dependency-gate.mjs'), 'utf8'),
    packageScripts: packageJson.scripts || {},
    docsText: docsText(),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportCloseoutDriftClassificationRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    closeoutDriftClassificationRegressionHash: report.closeoutDriftClassificationRegressionHash,
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
