#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CONTRACT_REQUIRED_COVERAGE_REGRESSION_REPORT_FILE_ID,
  buildReportContractRequiredCoverageRegressionReport,
} from './report-contract-required-coverage-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8');
}

function markdownFor(report) {
  const lines = [
    '# Report Contract Required Coverage Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractRequiredCoverageRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual coverage ok: ${report.summary.actualOk}`,
    `- Manifest contracts: ${report.summary.manifestContractCount}`,
    `- Required contracts: ${report.summary.requiredContractCount}`,
    `- Optional contracts: ${report.summary.optionalContractCount}`,
    `- Classified contracts: ${report.summary.classifiedContractCount}`,
    `- Unclassified contracts: ${report.summary.unclassifiedContractCount}`,
    `- Missing required contracts: ${report.summary.missingRequiredContractCount}`,
    `- Optional reason missing contracts: ${report.summary.optionalReasonMissingContractCount}`,
    `- Optional missing manifest contracts: ${report.summary.optionalMissingManifestContractCount}`,
    `- Optional/required overlaps: ${report.summary.optionalRequiredOverlapContractCount}`,
    `- Required list exported: ${report.summary.requiredExportPresent}`,
    `- Optional reason map exported: ${report.summary.optionalExportPresent}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Required Contract Ids',
    '',
    ...report.actual.requiredContractIds.map((contractId) => `- ${contractId}`),
    '',
    '## Optional Contract Ids',
    '',
    ...(report.actual.optionalContractIds.length
      ? report.actual.optionalContractIds.map((contractId) => `- ${contractId}`)
      : ['- none']),
    '',
    '## Unclassified Contract Ids',
    '',
    ...(report.actual.unclassifiedContractIds.length
      ? report.actual.unclassifiedContractIds.map((contractId) => `- ${contractId}`)
      : ['- none']),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.contractId || item.scenarioId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads only local report contract manifest source and synthetic mutations.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-contract-required-coverage-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractRequiredCoverageRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildReportContractRequiredCoverageRegressionReport({
    manifestSourceText: readText('src/report-contract-manifest.mjs'),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractRequiredCoverageRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractRequiredCoverageRegressionHash: report.contractRequiredCoverageRegressionHash,
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
