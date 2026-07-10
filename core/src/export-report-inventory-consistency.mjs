#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReportInventoryConsistencyReport } from './report-inventory-consistency.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPackageScriptIds() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return Object.keys(packageJson.scripts || {});
}

function markdownFor(report) {
  const lines = [
    '# Report Inventory Consistency',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.inventoryConsistencyHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual inventory ok: ${report.summary.actualOk}`,
    `- Freshness required reports: ${report.summary.freshnessRequiredReportCount}`,
    `- Tooling reports: ${report.summary.toolingReportCount}/${report.summary.expectedToolingReportCount}`,
    `- Checkpoint bindings: ${report.summary.checkpointBindingCount}/${report.summary.expectedCheckpointBindingCount}`,
    `- Gate hash keys: ${report.summary.gateSummaryHashKeyCount}/${report.summary.requiredGateSummaryHashKeyCount}`,
    `- Required scripts: ${report.summary.presentRequiredScriptCount}/${report.summary.requiredScriptCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Inventory',
    '',
    `- Freshness required report files: ${report.inventory.freshnessRequiredReportFileIds.join(', ')}`,
    `- Tooling report files: ${report.inventory.toolingReportFileIds.join(', ')}`,
    `- Checkpoint report files: ${report.inventory.checkpointFileIds.join(', ')}`,
    `- Required gate summary hash keys: ${report.inventory.requiredGateSummaryHashKeys.join(', ')}`,
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
      ? report.blockers.map((item) => `- ${item.code} ${item.fileId || item.key || item.scriptId || item.scenarioId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Source inspection and synthetic fixture only.',
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
    fileId: 'report-inventory-consistency-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportInventoryConsistencyReport({
    checkpointSourceText: fs.readFileSync(path.join(packageRoot, 'src', 'export-architecture-checkpoint.mjs'), 'utf8'),
    gateSourceText: fs.readFileSync(path.join(packageRoot, 'src', 'integration-dependency-gate.mjs'), 'utf8'),
    packageScriptIds: readPackageScriptIds(),
  });
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    inventoryConsistencyHash: report.inventoryConsistencyHash,
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
