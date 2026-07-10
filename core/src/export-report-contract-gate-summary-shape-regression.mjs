#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CONTRACT_GATE_SUMMARY_SHAPE_REGRESSION_REPORT_FILE_ID,
  buildReportContractGateSummaryShapeRegressionReport,
} from './report-contract-gate-summary-shape-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8');
}

function markdownFor(report) {
  const lines = [
    '# Report Contract Gate Summary Shape Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractGateSummaryShapeRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual gate summary shape ok: ${report.summary.actualOk}`,
    `- Contracts covered: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Gate ok shapes: ${report.summary.okShapeCount}/${report.summary.contractCount}`,
    `- Gate hash shapes: ${report.summary.hashShapeCount}/${report.summary.contractCount}`,
    `- Markdown ok lines: ${report.summary.markdownOkCount}/${report.summary.contractCount}`,
    `- Markdown hash lines: ${report.summary.markdownHashCount}/${report.summary.contractCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Status | Step | Ok key | Hash key |',
    '| --- | --- | --- | --- | --- |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.stepId} | ${contract.okKey} | ${contract.hashKey} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.contractId || item.scenarioId || ''} ${item.key || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads only local source files and synthetic mutations.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-contract-gate-summary-shape-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractGateSummaryShapeRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildReportContractGateSummaryShapeRegressionReport({
    gateSourceText: readSource('src/integration-dependency-gate.mjs'),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractGateSummaryShapeRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractGateSummaryShapeRegressionHash: report.contractGateSummaryShapeRegressionHash,
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
