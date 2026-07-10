#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import { buildReportRetentionRegressionReport } from './report-retention-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Report Retention Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.retentionRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Archive candidates observed: ${report.summary.archiveCandidateCount}`,
    `- Protected keeps expected: ${report.summary.protectedKeepCount}`,
    `- Regression blockers: ${report.summary.blockerCount}`,
    '',
    '## Scenarios',
    '',
    '| Scenario | Status | Expected archive | Observed archive | Blockers |',
    '| --- | --- | ---: | ---: | ---: |',
    ...report.scenarios.map((scenario) => `| ${scenario.scenarioId} | ${scenario.status} | ${scenario.expected.archive?.length || scenario.expected.archivedCount || 0} | ${scenario.observed.archive?.length || scenario.observed.archivedCount || 0} | ${scenario.blockers.length} |`),
    '',
    '## Regression Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code} ${item.scenarioId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Synthetic fixture only.',
    '- Does not move, delete, or rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-retention-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportRetentionRegressionReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    retentionRegressionHash: report.retentionRegressionHash,
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
