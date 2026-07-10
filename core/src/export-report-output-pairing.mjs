#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_OUTPUT_PAIRING_REPORT_FILE_ID,
  buildReportOutputPairingReport,
} from './report-output-pairing.mjs';
import {
  REPORT_FRESHNESS_REQUIRED_REPORTS,
} from './report-freshness.mjs';
import {
  expectedReportSchemaContractFileIds,
} from './report-schema-contract.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function markdownFileIdFor(fileId) {
  return String(fileId || '').replace(/\.json$/, '.md');
}

function latestReportFileIds() {
  const diskFileIds = fs.readdirSync(reportsDir)
    .filter((fileId) => fileId.endsWith('-latest.json'))
    .filter((fileId) => fileId !== REPORT_OUTPUT_PAIRING_REPORT_FILE_ID);
  return [...new Set([
    ...expectedReportSchemaContractFileIds(),
    ...diskFileIds,
  ].filter((fileId) => fileId !== REPORT_OUTPUT_PAIRING_REPORT_FILE_ID))]
    .sort((left, right) => left.localeCompare(right));
}

function readRecords(fileIds) {
  return fileIds.map((fileId) => {
    const jsonPath = path.join(reportsDir, fileId);
    const mdPath = path.join(reportsDir, markdownFileIdFor(fileId));
    return {
      fileId,
      jsonExists: fs.existsSync(jsonPath),
      mdExists: fs.existsSync(mdPath),
      report: readJson(jsonPath, null),
    };
  });
}

function readPackageScriptIds() {
  return Object.keys(readJson(path.join(packageRoot, 'package.json'), {}).scripts || {});
}

function markdownFor(report) {
  const lines = [
    '# Report Output Pairing',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.outputPairingHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual pairing ok: ${report.summary.actualOk}`,
    `- JSON reports: ${report.summary.jsonReportCount}/${report.summary.expectedJsonReportCount}`,
    `- Markdown reports: ${report.summary.markdownReportCount}/${report.summary.expectedJsonReportCount}`,
    `- README listed reports: ${report.summary.readmeListedReportCount}/${report.summary.expectedJsonReportCount}`,
    `- reportFiles.json pointers: ${report.summary.reportFilesJsonPointerCount}`,
    `- reportFiles.md pointers: ${report.summary.reportFilesMarkdownPointerCount}`,
    `- Required scripts: ${report.summary.presentRequiredScriptCount}/${report.summary.requiredScriptCount}`,
    `- Freshness self listed: ${report.summary.freshnessSelfPresent}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Reports',
    '',
    '| JSON report | Markdown report | JSON exists | Markdown exists | reportFiles.json | reportFiles.md |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.records.map((record) => `| ${record.fileId} | ${record.mdFileId} | ${record.jsonExists} | ${record.mdExists} | ${record.reportFilesJson || 'null'} | ${record.reportFilesMd || 'null'} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.fileId || item.scriptId || item.scenarioId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads local latest JSON/Markdown report files, reports/README.md, package scripts, and freshness inventory.',
    '- Synthetic fixture proves missing Markdown, drifted reportFiles pointers, missing README entries, missing scripts, and missing freshness inventory fail closed.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-output-pairing-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportOutputPairingLatest({ generatedAt = new Date().toISOString() } = {}) {
  const fileIds = latestReportFileIds();
  return buildReportOutputPairingReport({
    expectedFileIds: fileIds,
    records: readRecords(fileIds),
    readmeText: readText(path.join(reportsDir, 'README.md')),
    packageScriptIds: readPackageScriptIds(),
    freshnessRequiredFileIds: REPORT_FRESHNESS_REQUIRED_REPORTS.map((spec) => spec.fileId),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportOutputPairingLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    outputPairingHash: report.outputPairingHash,
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
