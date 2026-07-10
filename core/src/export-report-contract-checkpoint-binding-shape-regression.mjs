#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CONTRACT_CHECKPOINT_BINDING_SHAPE_REGRESSION_REPORT_FILE_ID,
  buildReportContractCheckpointBindingShapeRegressionReport,
} from './report-contract-checkpoint-binding-shape-regression.mjs';
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
    '# Report Contract Checkpoint Binding Shape Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractCheckpointBindingShapeRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual checkpoint binding shape ok: ${report.summary.actualOk}`,
    `- Contracts covered: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Scenario contracts: ${report.summary.scenarioContractCount}`,
    `- Checkpoint bindings: ${report.summary.bindingCount}/${report.summary.contractCount}`,
    `- Binding filenames: ${report.summary.bindingFilenameCount}/${report.summary.contractCount}`,
    `- Required bindings: ${report.summary.bindingRequiredCount}/${report.summary.contractCount}`,
    `- Hash extractors: ${report.summary.hashExtractorCount}/${report.summary.contractCount}`,
    `- Summary hash keys: ${report.summary.summaryHashCount}/${report.summary.contractCount}`,
    `- Summary scenario keys: ${report.summary.summaryScenarioCount}/${report.summary.scenarioContractCount}`,
    `- Summary passed-scenario keys: ${report.summary.summaryPassedScenarioCount}/${report.summary.scenarioContractCount}`,
    `- Summary blocker keys: ${report.summary.summaryBlockerCount}/${report.summary.scenarioContractCount}`,
    `- Markdown hash lines: ${report.summary.markdownHashCount}/${report.summary.contractCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Status | Binding key | File | Hash field |',
    '| --- | --- | --- | --- | --- |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.baseKey} | ${contract.fileId} | ${contract.stdoutHashField} |`),
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
    fileId: 'report-contract-checkpoint-binding-shape-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractCheckpointBindingShapeRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildReportContractCheckpointBindingShapeRegressionReport({
    checkpointSourceText: readSource('src/export-architecture-checkpoint.mjs'),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractCheckpointBindingShapeRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractCheckpointBindingShapeRegressionHash: report.contractCheckpointBindingShapeRegressionHash,
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
