#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CONTRACT_MANIFEST_REPORT_FILE_ID,
  buildReportContractManifestReport,
} from './report-contract-manifest.mjs';
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
    '# Report Contract Manifest',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractManifestHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual manifest ok: ${report.summary.actualOk}`,
    `- Contracts: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Required contracts: ${report.summary.requiredContractCount}`,
    `- Step bindings: ${report.summary.stepBindingCount}`,
    `- Runner imports manifest: ${report.summary.runnerImportsManifest}`,
    `- Runner aliases manifest: ${report.summary.runnerAliasesManifest}`,
    `- Runner local list present: ${report.summary.runnerLocalListPresent}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Status | Script | Steps | Hash field | Report |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.manifest.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.scriptId} | ${contract.stepIds.join('<br>')} | ${contract.stdoutHashField} | ${contract.fileId} |`),
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
    '- Reads the local report contract manifest and runner regression source.',
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
    fileId: 'report-contract-manifest-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractManifestLatest({ generatedAt = new Date().toISOString() } = {}) {
  return buildReportContractManifestReport({
    runnerSourceText: readText('src/report-runner-contract-regression.mjs'),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractManifestLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractManifestHash: report.contractManifestHash,
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
