#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CONTRACT_SUMMARY_KEY_REGRESSION_REPORT_FILE_ID,
  buildReportContractSummaryKeyRegressionReport,
} from './report-contract-summary-key-regression.mjs';
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
    '# Report Contract Summary Key Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractSummaryKeyRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual coverage ok: ${report.summary.actualOk}`,
    `- Contracts covered: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Scenario contracts: ${report.summary.scenarioContractCount}`,
    `- Gate hash keys: ${report.summary.gateHashKeyCount}/${report.summary.contractCount}`,
    `- Gate ok keys: ${report.summary.gateOkKeyCount}/${report.summary.contractCount}`,
    `- Checkpoint hash keys: ${report.summary.checkpointHashKeyCount}/${report.summary.contractCount}`,
    `- Checkpoint scenario keys: ${report.summary.checkpointScenarioKeyCount}/${report.summary.scenarioContractCount}`,
    `- Checkpoint passed-scenario keys: ${report.summary.checkpointPassedScenarioKeyCount}/${report.summary.scenarioContractCount}`,
    `- Checkpoint blocker keys: ${report.summary.checkpointBlockerKeyCount}/${report.summary.scenarioContractCount}`,
    `- Audit objects: ${report.summary.auditObjectKeyCount}/${report.summary.contractCount}`,
    `- Audit hash fields: ${report.summary.auditHashFieldCount}/${report.summary.contractCount}`,
    `- Selftest hash keys: ${report.summary.selftestHashKeyCount}/${report.summary.contractCount}`,
    `- Selftest scenario keys: ${report.summary.selftestScenarioKeyCount}/${report.summary.scenarioContractCount}`,
    `- Selftest lane hash keys: ${report.summary.selftestLaneHashKeyCount}/${report.summary.contractCount}`,
    `- Selftest lane scenario keys: ${report.summary.selftestLaneScenarioKeyCount}/${report.summary.scenarioContractCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Status | Hash key | Ok key | Scenario key |',
    '| --- | --- | --- | --- | --- |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.hashKey} | ${contract.okKey} | ${contract.scenarioKey || 'n/a'} |`),
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
    fileId: 'report-contract-summary-key-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractSummaryKeyRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildReportContractSummaryKeyRegressionReport({
    gateSourceText: readSource('src/integration-dependency-gate.mjs'),
    checkpointSourceText: readSource('src/export-architecture-checkpoint.mjs'),
    auditSourceText: readSource('src/integration-dependency-audit.mjs'),
    selftestSourceText: readSource('src/selftest.mjs'),
    selftestLanesSourceText: readSource('src/selftest-lanes.mjs'),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractSummaryKeyRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractSummaryKeyRegressionHash: report.contractSummaryKeyRegressionHash,
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
