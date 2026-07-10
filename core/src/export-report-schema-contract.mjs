#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReportSchemaContractReport,
  expectedReportSchemaContractFileIds,
} from './report-schema-contract.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readRecords(expectedFileIds) {
  return expectedFileIds.flatMap((fileId) => {
    const report = readJson(path.join(reportsDir, fileId));
    return report ? [{ fileId, report }] : [];
  });
}

function markdownFor(report) {
  const lines = [
    '# Report Schema Contract',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.schemaContractHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual schema ok: ${report.summary.actualOk}`,
    `- Reports passing schema: ${report.summary.passedReportCount}/${report.summary.expectedReportCount}`,
    `- Missing reports: ${report.summary.missingReportCount}`,
    `- Hashable reports: ${report.summary.hashableReportCount}/${report.summary.analyzedReportCount}`,
    `- Safety-bearing reports: ${report.summary.safetyReportCount}/${report.summary.analyzedReportCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Reports',
    '',
    '| Report | Status | Kind | Hash | Blockers |',
    '| --- | --- | --- | --- | ---: |',
    ...report.records.map((record) => `| ${record.fileId} | ${record.status || 'missing'} | ${record.kind || 'null'} | ${record.stableHash || 'null'} | ${record.blockerCount} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.fileId || item.flagId || item.scenarioId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads local latest JSON reports only.',
    '- Synthetic fixture proves malformed report states fail closed.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'report-schema-contract-latest.json',
    markdown: markdownFor(report),
  });
}

export function buildReportSchemaContractLatest({
  generatedAt = new Date().toISOString(),
  includeGateReport = true,
} = {}) {
  const expectedFileIds = expectedReportSchemaContractFileIds(undefined, { includeGateReport });
  return buildReportSchemaContractReport({
    expectedFileIds,
    records: readRecords(expectedFileIds),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const includeGateReport = !process.argv.includes('--skip-gate');
  const report = buildReportSchemaContractLatest({ includeGateReport });
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    schemaContractHash: report.schemaContractHash,
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
