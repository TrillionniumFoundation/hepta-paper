#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_POST_FINAL_DRIFT_REGRESSION_REPORT_FILE_ID,
  buildReportPostFinalDriftRegressionReport,
} from './report-post-final-drift-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function markdownFor(report) {
  const lines = [
    '# Report Post-Final Drift Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.postFinalDriftRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual policy ok: ${report.summary.actualOk}`,
    `- Drift events: ${report.summary.driftEventCount}`,
    `- Drifted files: ${report.summary.driftedFileCount}`,
    `- Post-drift freshness blocked: ${report.summary.postDriftFreshnessBlocked}`,
    `- Post-drift freshness mismatches: ${report.summary.postDriftFreshnessGateHashMismatchCount}`,
    `- Post-drift checkpoint blocked: ${report.summary.postDriftCheckpointBlocked}`,
    `- Recovery clean gate ok: ${report.summary.recoveryCleanGateOk}`,
    `- Recovery freshness gate hash matches: ${report.summary.recoveryFreshnessGateHashMatches}`,
    `- Recovery checkpoint freshness matches: ${report.summary.recoveryCheckpointFreshnessMatches}`,
    `- Recovery seed writes: ${report.summary.recoverySeedWriteCount}`,
    `- Recovery seed skips: ${report.summary.recoverySeedSkipCount}`,
    `- Required scripts: ${report.summary.presentPackageScriptCount}/${report.summary.packageScriptCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Drift Writers',
    '',
    '| Drift | Command | Latest report | Gate hash key |',
    '| --- | --- | --- | --- |',
    ...report.fixture.driftWriters.map((writer) => `| ${writer.driftId} | ${writer.command} | ${writer.fileId} | ${writer.gateSummaryHashKey} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.scenarioId || item.fileId || item.stepId || item.scriptId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Uses synthetic post-final drift fixtures and integration gate source inspection only.',
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
    fileId: 'report-post-final-drift-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportPostFinalDriftRegressionLatest({ generatedAt = new Date().toISOString() } = {}) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return buildReportPostFinalDriftRegressionReport({
    gateSourceText: fs.readFileSync(path.join(packageRoot, 'src', 'integration-dependency-gate.mjs'), 'utf8'),
    packageScripts: packageJson.scripts || {},
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportPostFinalDriftRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    postFinalDriftRegressionHash: report.postFinalDriftRegressionHash,
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
