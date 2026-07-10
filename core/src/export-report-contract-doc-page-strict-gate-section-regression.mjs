#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReportContractDocPageStrictGateSectionRegressionReport,
} from './report-contract-doc-page-strict-gate-section-regression.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');



function readText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function docsPathFor(contract = {}, overrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES) {
  if (overrides?.[contract.contractId]) return overrides[contract.contractId];
  return `docs/${String(contract.fileId || '').replace(/-latest\.json$/, '.md')}`;
}

function readDocsByPath() {
  return Object.fromEntries(REPORT_CONTRACT_MANIFEST.map((contract) => {
    const docsPath = docsPathFor(contract);
    return [docsPath, readText(path.join(packageRoot, docsPath), null)];
  }).filter(([, text]) => text !== null));
}

function markdownFor(report) {
  const lines = [
    '# Report Contract Doc Page Strict Gate Section Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractDocPageStrictGateSectionRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual doc page strict gate sections ok: ${report.summary.actualOk}`,
    `- Contracts covered: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Unique docs paths: ${report.summary.uniqueDocsPathCount}`,
    `- Docs files: ${report.summary.docsFileCount}/${report.summary.contractCount}`,
    `- Strict gate sections: ${report.summary.sectionCount}/${report.summary.contractCount}`,
    `- Strict gate commands: ${report.summary.commandCount}/${report.summary.contractCount}`,
    `- Gate participation statements: ${report.summary.participationCount}/${report.summary.contractCount}`,
    `- Closeout expectations: ${report.summary.closeoutCount}/${report.summary.contractCount}`,
    `- Recovery boundaries: ${report.summary.recoveryCount}/${report.summary.contractCount}`,
    `- Ordered sections: ${report.summary.orderCount}/${report.summary.contractCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Docs | Section | Command | Participation | Closeout | Recovery | Order |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.docsPath} | ${contract.sectionPresent} | ${contract.commandPresent} | ${contract.participationPresent} | ${contract.closeoutPresent} | ${contract.recoveryPresent} | ${contract.orderValid} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.contractId || item.scenarioId || ''} ${item.docsPath || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads local docs pages and the report contract manifest.',
    '- Synthetic fixture proves missing strict gate commands, participation wording, closeout probes, recovery boundaries, and order drift fail closed.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, local state transition, or execution permission grant.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-contract-doc-page-strict-gate-section-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractDocPageStrictGateSectionRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildReportContractDocPageStrictGateSectionRegressionReport({
    docsByPath: readDocsByPath(),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractDocPageStrictGateSectionRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractDocPageStrictGateSectionRegressionHash: report.contractDocPageStrictGateSectionRegressionHash,
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
