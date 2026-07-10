#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_GATE_CLEAN_RERUN_REGRESSION_REPORT_FILE_ID,
  buildReportGateCleanRerunRegressionReport,
} from './report-gate-clean-rerun-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function markdownFor(report) {
  const lines = [
    '# Report Gate Clean Rerun Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.gateCleanRerunRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual policy ok: ${report.summary.actualOk}`,
    `- Allowed seed files: ${report.summary.allowedSeedFileCount}`,
    `- Dirty seed writes: ${report.summary.dirtySeedWriteCount}`,
    `- Clean seed writes: ${report.summary.cleanSeedWriteCount}`,
    `- Clean seed skips: ${report.summary.cleanSeedSkipCount}`,
    `- Final reports: ${report.summary.finalReportCount}`,
    `- Seed hash reuses: ${report.summary.seedHashReuseCount}`,
    `- Gate seed hash leaks: ${report.summary.gateSummarySeedLeakCount}`,
    `- Final marker leaks: ${report.summary.finalBootstrapMarkerLeakCount}`,
    `- Source steps: ${report.summary.sourceStepCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Clean Decisions',
    '',
    '| File | Write | Reason | Hash |',
    '| --- | --- | --- | --- |',
    ...report.fixture.allowedSeedFileIds.map((fileId) => {
      const decision = report.actual.cleanSeedDecisions[fileId] || {};
      return `| ${fileId} | ${decision.write} | ${decision.reason || 'missing'} | ${decision.hash || 'null'} |`;
    }),
    '',
    '## Final Bindings',
    '',
    '| File | Final status | Gate key | Seed marker |',
    '| --- | --- | --- | --- |',
    ...report.fixture.allowedSeedFileIds.map((fileId) => {
      const final = report.actual.cleanFinalReports[fileId] || {};
      const gateHashKey = report.fixture.gateHashKeys[fileId] || 'null';
      return `| ${fileId} | ${final.status || 'missing'} | ${gateHashKey} | ${final.seedMarker} |`;
    }),
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
    '- Uses synthetic latest-report fixtures and integration gate source inspection only.',
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
    fileId: 'report-gate-clean-rerun-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportGateCleanRerunRegressionLatest({ generatedAt = new Date().toISOString() } = {}) {
  return buildReportGateCleanRerunRegressionReport({
    gateSourceText: fs.readFileSync(path.join(packageRoot, 'src', 'integration-dependency-gate.mjs'), 'utf8'),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportGateCleanRerunRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    gateCleanRerunRegressionHash: report.gateCleanRerunRegressionHash,
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
