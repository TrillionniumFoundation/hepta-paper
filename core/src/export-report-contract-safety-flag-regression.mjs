#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CONTRACT_SAFETY_FLAG_REGRESSION_REPORT_FILE_ID,
  buildReportContractSafetyFlagRegressionReport,
} from './report-contract-safety-flag-regression.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readManifestReports() {
  return Object.fromEntries(REPORT_CONTRACT_MANIFEST.map((contract) => [
    contract.fileId,
    readJson(path.join(reportsDir, contract.fileId)),
  ]));
}

function markdownFor(report) {
  const lines = [
    '# Report Contract Safety Flag Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractSafetyFlagRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual safety flags ok: ${report.summary.actualOk}`,
    `- Contracts covered: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Latest reports present: ${report.summary.reportCount}/${report.summary.contractCount}`,
    `- Safety blocks present: ${report.summary.safetyCount}/${report.summary.contractCount}`,
    `- Required true flags: ${report.summary.trueFlagCount}/${report.summary.requiredTrueFlagCount}`,
    `- Required false flags: ${report.summary.falseFlagCount}/${report.summary.requiredFalseFlagCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Required Flags',
    '',
    `- True: ${report.fixture.requiredTrueFlags.join(', ')}`,
    `- False: ${report.fixture.requiredFalseFlags.join(', ')}`,
    '',
    '## Contracts',
    '',
    '| Contract | Status | Latest | Safety | True flags | False flags |',
    '| --- | --- | --- | --- | ---: | ---: |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.reportPresent} | ${contract.safetyPresent} | ${contract.trueFlagCount}/${contract.requiredTrueFlagCount} | ${contract.falseFlagCount}/${contract.requiredFalseFlagCount} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.contractId || item.scenarioId || ''} ${item.fileId || ''} ${item.flagId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads only local latest report JSON files and synthetic mutations.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-contract-safety-flag-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractSafetyFlagRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildReportContractSafetyFlagRegressionReport({
    reportsByFileId: readManifestReports(),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractSafetyFlagRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractSafetyFlagRegressionHash: report.contractSafetyFlagRegressionHash,
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
