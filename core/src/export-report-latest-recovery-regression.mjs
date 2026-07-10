#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import {
  buildReportLatestRecoveryRegressionReport,
} from './report-latest-recovery-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

function markdownFor(report) {
  const lines = [
    '# Report Latest Recovery Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.latestRecoveryRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual recovery ok: ${report.summary.actualOk}`,
    `- Contaminated files: ${report.summary.contaminatedFileCount}`,
    `- Schema expected reports: ${report.summary.schemaExpectedReportCount}`,
    `- Contaminated schema blocked: ${report.summary.contaminatedSchemaBlocked}`,
    `- Contaminated freshness blocked: ${report.summary.contaminatedFreshnessBlocked}`,
    `- Contaminated tooling blocked: ${report.summary.contaminatedToolingBlocked}`,
    `- Bootstrap schema ok: ${report.summary.bootstrapSchemaOk}`,
    `- Bootstrap freshness ok: ${report.summary.bootstrapFreshnessOk}`,
    `- Bootstrap tooling ok: ${report.summary.bootstrapToolingOk}`,
    `- Final freshness ok: ${report.summary.finalFreshnessOk}`,
    `- Final gate hash mismatches: ${report.summary.finalGateHashMismatchCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contaminated Files',
    '',
    ...report.fixture.contaminatedFileIds.map((fileId) => `- ${fileId}`),
    '',
    '## Phases',
    '',
    '| Phase | Check | Status | Blockers |',
    '| --- | --- | --- | --- |',
    ...Object.entries(report.actual.phases).flatMap(([phaseId, phase]) => Object.entries(phase)
      .filter(([, item]) => item && typeof item === 'object' && 'status' in item)
      .map(([checkId, item]) => `| ${phaseId} | ${checkId} | ${item.status} | ${(item.blockerCodes || []).join('<br>') || 'none'} |`)),
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
    '- Uses synthetic report fixtures only.',
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
    fileId: 'report-latest-recovery-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportLatestRecoveryRegressionLatest({ generatedAt = new Date().toISOString() } = {}) {
  return buildReportLatestRecoveryRegressionReport({ generatedAt });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportLatestRecoveryRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    latestRecoveryRegressionHash: report.latestRecoveryRegressionHash,
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
