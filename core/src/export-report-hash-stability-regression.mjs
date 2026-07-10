#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_HASH_STABILITY_REGRESSION_REPORT_FILE_ID,
  buildReportHashStabilityRegressionReport,
} from './report-hash-stability-regression.mjs';
import {
  expectedReportSchemaContractFileIds,
} from './report-schema-contract.mjs';
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

function expectedFileIds() {
  return expectedReportSchemaContractFileIds()
    .filter((fileId) => fileId !== REPORT_HASH_STABILITY_REGRESSION_REPORT_FILE_ID);
}

function readRecords(fileIds) {
  return fileIds.flatMap((fileId) => {
    const report = readJson(path.join(reportsDir, fileId));
    return report ? [{ fileId, report }] : [];
  });
}

function markdownFor(report) {
  const lines = [
    '# Report Hash Stability Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.hashStabilityRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual report inventory ok: ${report.summary.actualOk}`,
    `- Hashable reports: ${report.summary.hashableReportCount}/${report.summary.expectedReportCount}`,
    `- Missing reports: ${report.summary.missingReportCount}`,
    `- Duplicate stable hashes: ${report.summary.duplicateStableHashCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Noise scenarios: ${report.summary.noiseScenarioCount}`,
    `- Semantic scenarios: ${report.summary.semanticScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Actual Reports',
    '',
    '| Report | Status | Stable hash | Canonical hash |',
    '| --- | --- | --- | --- |',
    ...report.records.map((record) => `| ${record.fileId} | ${record.status || 'missing'} | ${record.stableHash || 'null'} | ${record.canonicalHash || 'null'} |`),
    '',
    '## Scenarios',
    '',
    '| Scenario | Status | Expected same hash | Same hash | Baseline hash | Mutated hash |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.scenarios.map((scenario) => `| ${scenario.scenarioId} | ${scenario.status} | ${scenario.expectedSameHash} | ${scenario.observed.sameHash} | ${scenario.observed.baselineHash} | ${scenario.observed.mutatedHash} |`),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code} ${item.fileId || item.scenarioId || item.stableHash || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads local latest JSON reports only.',
    '- Synthetic fixture proves generatedAt/output path/key-order noise stays hash-stable while summary/blocker/safety changes affect the canonical hash.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-hash-stability-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportHashStabilityRegressionLatest({ generatedAt = new Date().toISOString() } = {}) {
  const fileIds = expectedFileIds();
  return buildReportHashStabilityRegressionReport({
    expectedFileIds: fileIds,
    records: readRecords(fileIds),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportHashStabilityRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    hashStabilityRegressionHash: report.hashStabilityRegressionHash,
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
