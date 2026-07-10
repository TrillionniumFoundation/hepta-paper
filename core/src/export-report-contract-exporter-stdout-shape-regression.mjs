#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReportContractExporterStdoutShapeRegressionReport,
} from './report-contract-exporter-stdout-shape-regression.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8');
}

function readExporterSources() {
  return Object.fromEntries(REPORT_CONTRACT_MANIFEST.map((contract) => [
    contract.exporterPath,
    readSource(contract.exporterPath),
  ]));
}

function markdownFor(report) {
  const lines = [
    '# Report Contract Exporter Stdout Shape Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractExporterStdoutShapeRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual stdout shape ok: ${report.summary.actualOk}`,
    `- Contracts covered: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Source files: ${report.summary.sourceCount}/${report.summary.contractCount}`,
    `- JSON stdout writers: ${report.summary.stdoutJsonCount}/${report.summary.contractCount}`,
    `- Ok fields: ${report.summary.stdoutOkCount}/${report.summary.contractCount}`,
    `- Status fields: ${report.summary.stdoutStatusCount}/${report.summary.contractCount}`,
    `- Hash fields: ${report.summary.stdoutHashCount}/${report.summary.contractCount}`,
    `- Summary fields: ${report.summary.stdoutSummaryCount}/${report.summary.contractCount}`,
    `- Blocker code fields: ${report.summary.stdoutBlockersCount}/${report.summary.contractCount}`,
    `- Report file fields: ${report.summary.stdoutReportFilesCount}/${report.summary.contractCount}`,
    `- Strict exit checks: ${report.summary.strictExitCount}/${report.summary.contractCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Status | Exporter | Hash field |',
    '| --- | --- | --- | --- |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.exporterPath} | ${contract.stdoutHashField} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.contractId || item.scenarioId || ''} ${item.exporterPath || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads only local exporter source files and synthetic mutations.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-contract-exporter-stdout-shape-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractExporterStdoutShapeRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildReportContractExporterStdoutShapeRegressionReport({
    exporterSources: readExporterSources(),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractExporterStdoutShapeRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractExporterStdoutShapeRegressionHash: report.contractExporterStdoutShapeRegressionHash,
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
