#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CONTRACT_AUDIT_FORWARDING_REGRESSION_REPORT_FILE_ID,
  buildReportContractAuditForwardingRegressionReport,
} from './report-contract-audit-forwarding-regression.mjs';
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
    '# Report Contract Audit Forwarding Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractAuditForwardingRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual forwarding ok: ${report.summary.actualOk}`,
    `- Contracts forwarded: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- buildBlockers parameters: ${report.summary.parameterCount}/${report.summary.contractCount}`,
    `- buildBlockers call bindings: ${report.summary.callBindingCount}/${report.summary.contractCount}`,
    `- Forwarding loops: ${report.summary.forwardingLoopCount}/${report.summary.contractCount}`,
    `- Blocker pushes: ${report.summary.blockerPushCount}/${report.summary.contractCount}`,
    `- Code prefixes: ${report.summary.prefixCount}/${report.summary.contractCount}`,
    `- Child code fields: ${report.summary.childCodeCount}/${report.summary.contractCount}`,
    `- Child notes fields: ${report.summary.notesCount}/${report.summary.contractCount}`,
    `- Owners: ${report.summary.ownerCount}/${report.summary.contractCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Status | Report key | Blocker variable |',
    '| --- | --- | --- | --- |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.reportKey} | ${contract.blockerVariable || 'n/a'} |`),
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
    fileId: 'report-contract-audit-forwarding-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractAuditForwardingRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildReportContractAuditForwardingRegressionReport({
    auditSourceText: readSource('src/integration-dependency-audit.mjs'),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractAuditForwardingRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractAuditForwardingRegressionHash: report.contractAuditForwardingRegressionHash,
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
