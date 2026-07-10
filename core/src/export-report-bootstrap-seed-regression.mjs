#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import {
  buildReportBootstrapSeedRegressionReport,
} from './report-bootstrap-seed-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Report Bootstrap Seed Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.bootstrapSeedRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual policy ok: ${report.summary.actualOk}`,
    `- Allowed seed files: ${report.summary.allowedSeedFileCount}`,
    `- Seed reports: ${report.summary.seedReportCount}`,
    `- Final reports: ${report.summary.finalReportCount}`,
    `- Final overwrites: ${report.summary.finalReportOverwriteCount}`,
    `- Gate summary bindings: ${report.summary.gateSummaryBindingCount}`,
    `- Gate seed hash leaks: ${report.summary.gateSummarySeedLeakCount}`,
    `- Final marker leaks: ${report.summary.finalBootstrapMarkerLeakCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Allowed Seeds',
    '',
    ...report.fixture.allowedSeedFileIds.map((fileId) => {
      const gateHashKey = report.fixture.gateHashKeys[fileId] || 'null';
      return `- ${fileId} -> ${gateHashKey}`;
    }),
    '',
    '## Actual Policy',
    '',
    '| File | Seed status | Final status | Gate key |',
    '| --- | --- | --- | --- |',
    ...report.fixture.allowedSeedFileIds.map((fileId) => {
      const seed = report.actual.seedReports[fileId] || {};
      const final = report.actual.finalReports[fileId] || {};
      const gateHashKey = report.fixture.gateHashKeys[fileId] || 'null';
      return `| ${fileId} | ${seed.status || 'missing'} | ${final.status || 'missing'} | ${gateHashKey} |`;
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
      ? report.blockers.map((item) => `- ${item.code} ${item.scenarioId || item.fileId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Uses synthetic bootstrap seed fixtures only.',
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
    fileId: 'report-bootstrap-seed-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportBootstrapSeedRegressionLatest({ generatedAt = new Date().toISOString() } = {}) {
  return buildReportBootstrapSeedRegressionReport({ generatedAt });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportBootstrapSeedRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    bootstrapSeedRegressionHash: report.bootstrapSeedRegressionHash,
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
