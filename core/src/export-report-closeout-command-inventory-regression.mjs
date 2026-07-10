#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_REPORT_FILE_ID,
  buildReportCloseoutCommandInventoryRegressionReport,
} from './report-closeout-command-inventory-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function docsText() {
  return [
    'README.md',
    'reports/README.md',
    'docs/integration-dependency-gate.md',
    'docs/report-final-settlement-regression.md',
    'docs/report-post-final-drift-regression.md',
    'docs/report-closeout-drift-classification-regression.md',
    'docs/report-closeout-command-inventory-regression.md',
  ].map((filePath) => readIfExists(path.join(packageRoot, filePath))).join('\n');
}

function markdownFor(report) {
  const lines = [
    '# Report Closeout Command Inventory Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.closeoutCommandInventoryRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual inventory ok: ${report.summary.actualOk}`,
    `- Classified commands: ${report.summary.classifiedCommandCount}`,
    `- Classified scripts: ${report.summary.classifiedScriptCount}`,
    `- Package closeout scripts: ${report.summary.packageCloseoutScriptCount}`,
    `- Docs closeout scripts: ${report.summary.docsCloseoutScriptCount}`,
    `- Guard scripts: ${report.summary.guardScriptCount}`,
    `- Blocked writer scripts: ${report.summary.blockedWriterScriptCount}`,
    `- Clean closeout scripts: ${report.summary.cleanCloseoutScriptCount}`,
    `- Read-only probes: ${report.summary.readOnlyProbeCount}`,
    `- Documented classified scripts: ${report.summary.documentedClassifiedScriptCount}/${report.summary.requiredDocumentedScriptCount}`,
    `- Unclassified package closeout scripts: ${report.summary.unclassifiedPackageCloseoutScriptCount}`,
    `- Unclassified docs closeout scripts: ${report.summary.unclassifiedDocCloseoutScriptCount}`,
    `- Required scripts: ${report.summary.presentPackageScriptCount}/${report.summary.packageScriptCount}`,
    `- Classification constants exported: ${report.summary.classificationExportsPresent}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Inventories',
    '',
    `- Package closeout scripts: ${report.actual.packageCloseoutScriptIds.join(', ') || 'none'}`,
    `- Docs closeout scripts: ${report.actual.docsCloseoutScriptIds.join(', ') || 'none'}`,
    `- Classified scripts: ${report.actual.classifiedScriptIds.join(', ') || 'none'}`,
    `- Guard scripts: ${report.actual.guardScriptIds.join(', ') || 'none'}`,
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
      ? report.blockers.map((item) => `- ${item.code} ${item.scenarioId || item.scriptId || item.commandId || item.stepId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Uses synthetic command inventory fixtures and local package/source/docs inspection only.',
    '- Does not run classified closeout commands.',
    '- Does not read or mutate real latest reports.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-closeout-command-inventory-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportCloseoutCommandInventoryRegressionLatest({ generatedAt = new Date().toISOString() } = {}) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return buildReportCloseoutCommandInventoryRegressionReport({
    gateSourceText: fs.readFileSync(path.join(packageRoot, 'src', 'integration-dependency-gate.mjs'), 'utf8'),
    packageScripts: packageJson.scripts || {},
    docsText: docsText(),
    classificationSourceText: fs.readFileSync(path.join(packageRoot, 'src', 'report-closeout-drift-classification-regression.mjs'), 'utf8'),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportCloseoutCommandInventoryRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    closeoutCommandInventoryRegressionHash: report.closeoutCommandInventoryRegressionHash,
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
