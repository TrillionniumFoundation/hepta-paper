#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_RUNNER_CONTRACTS,
  buildReportRunnerContractRegressionReport,
} from './report-runner-contract-regression.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8');
}

function readPackageScripts() {
  const packageJson = JSON.parse(readText('package.json'));
  return { ...(packageJson.scripts || {}) };
}

function readExporterSources() {
  return Object.fromEntries(REPORT_RUNNER_CONTRACTS.map((contract) => [
    contract.exporterPath,
    readText(contract.exporterPath),
  ]));
}

function markdownFor(report) {
  const lines = [
    '# Report Runner Contract Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.runnerContractRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual contracts ok: ${report.summary.actualOk}`,
    `- Contracts: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Package scripts strict: ${report.summary.strictPackageScriptCount}/${report.summary.packageScriptCount}`,
    `- Gate steps: ${report.summary.gateStepBindingCount}/${report.summary.expectedGateStepBindingCount}`,
    `- Parse JSON gate steps: ${report.summary.parseJsonGateStepCount}/${report.summary.expectedGateStepBindingCount}`,
    `- Gate args: ${report.summary.gateArgBindingCount}/${report.summary.requiredGateArgBindingCount}`,
    `- Gate hash keys: ${report.summary.presentGateSummaryHashKeyCount}/${report.summary.gateSummaryHashKeyCount}`,
    `- Freshness inventory entries: ${report.summary.freshnessInventoryCount}/${report.summary.contractCount}`,
    `- Stdout hash fields: ${report.summary.stdoutHashFieldCount}/${report.summary.contractCount}`,
    `- Stdout reportFiles pointers: ${report.summary.stdoutReportFilesCount}/${report.summary.contractCount}`,
    `- Latest writers: ${report.summary.latestWriteCount}/${report.summary.contractCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Status | Script | Steps | Hash field | Report |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.scriptId} | ${contract.stepIds.join('<br>')} | ${contract.stdoutHashField} | ${contract.fileId} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.contractId || item.scenarioId || item.scriptId || item.stepId || item.fileId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads local package scripts, integration gate source, freshness inventory, and exporter source files.',
    '- Uses source inspection and synthetic mutations only.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-runner-contract-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportRunnerContractRegressionLatest({ generatedAt = new Date().toISOString() } = {}) {
  return buildReportRunnerContractRegressionReport({
    gateSourceText: readText('src/integration-dependency-gate.mjs'),
    packageScripts: readPackageScripts(),
    exporterSources: readExporterSources(),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportRunnerContractRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    runnerContractRegressionHash: report.runnerContractRegressionHash,
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
