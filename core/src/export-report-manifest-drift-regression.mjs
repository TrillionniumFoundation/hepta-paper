#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  buildReportManifestDriftRegressionReport,
} from './report-manifest-drift-regression.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8');
}

function readExporterSources() {
  return Object.fromEntries(REPORT_CONTRACT_MANIFEST.map((contract) => {
    const sourcePath = path.join(packageRoot, contract.exporterPath);
    return [
      contract.exporterPath,
      fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '',
    ];
  }));
}

function markdownFor(report) {
  const lines = [
    '# Report Manifest Drift Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.manifestDriftRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual manifest drift ok: ${report.summary.actualOk}`,
    `- Contracts: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Package scripts: ${report.summary.packageScriptCount}/${report.summary.contractCount}`,
    `- Tooling scripts: ${report.summary.toolingScriptCount}/${report.summary.contractCount}`,
    `- Tooling reports: ${report.summary.toolingReportCount}/${report.summary.contractCount}`,
    `- Freshness inventory: ${report.summary.freshnessInventoryCount}/${report.summary.contractCount}`,
    `- Checkpoint bindings: ${report.summary.checkpointBindingCount}/${report.summary.contractCount}`,
    `- Gate summary hash keys: ${report.summary.gateSummaryHashKeyCount}/${report.summary.contractCount}`,
    `- Gate steps: ${report.summary.gateStepBindingCount}/${report.summary.expectedGateStepBindingCount}`,
    `- Gate arg bindings: ${report.summary.gateArgBindingCount}/${report.summary.requiredGateArgBindingCount}`,
    `- Exporter sources: ${report.summary.exporterSourceCount}/${report.summary.contractCount}`,
    `- Stdout hash fields: ${report.summary.stdoutHashFieldCount}/${report.summary.contractCount}`,
    `- Stdout reportFiles: ${report.summary.stdoutReportFilesCount}/${report.summary.contractCount}`,
    `- Latest writes: ${report.summary.latestWriteCount}/${report.summary.contractCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Status | Script | Report | Steps |',
    '| --- | --- | --- | --- | --- |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.scriptId} | ${contract.fileId} | ${contract.stepIds.join('<br>')} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.contractId || item.scenarioId || item.fileId || item.scriptId || item.exporterPath || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads local source, package scripts, and report inventories.',
    '- Uses source inspection and synthetic manifest drift only.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-manifest-drift-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportManifestDriftRegressionLatest({ generatedAt = new Date().toISOString() } = {}) {
  const packageJson = readJson('package.json');
  return buildReportManifestDriftRegressionReport({
    gateSourceText: readText('src/integration-dependency-gate.mjs'),
    checkpointSourceText: readText('src/export-architecture-checkpoint.mjs'),
    packageScripts: packageJson.scripts || {},
    exporterSources: readExporterSources(),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportManifestDriftRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    manifestDriftRegressionHash: report.manifestDriftRegressionHash,
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
