#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReportContractDocIndexAnchorRegressionReport,
} from './report-contract-doc-index-anchor-regression.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');

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
    '# Report Contract Doc Index Anchor Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractDocIndexAnchorRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual doc index anchors ok: ${report.summary.actualOk}`,
    `- Contracts covered: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Unique docs paths: ${report.summary.uniqueDocsPathCount}`,
    `- Docs files: ${report.summary.docsFileCount}/${report.summary.contractCount}`,
    `- Docs headings: ${report.summary.docsHeadingCount}/${report.summary.contractCount}`,
    `- Docs commands: ${report.summary.docsCommandCount}/${report.summary.contractCount}`,
    `- README docs anchors: ${report.summary.readmeDocsCount}/${report.summary.contractCount}`,
    `- README commands: ${report.summary.readmeCommandCount}/${report.summary.contractCount}`,
    `- README latest mentions: ${report.summary.readmeLatestCount}/${report.summary.contractCount}`,
    `- reports/README.md commands: ${report.summary.reportsReadmeCommandCount}/${report.summary.contractCount}`,
    `- reports/README.md latest mentions: ${report.summary.reportsReadmeLatestCount}/${report.summary.contractCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Docs | H1 | Docs command | README doc | README command | README latest | Reports command | Reports latest |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.docsPath} | ${contract.docsHeadingPresent} | ${contract.docsCommandPresent} | ${contract.readmeDocsPresent} | ${contract.readmeCommandPresent} | ${contract.readmeLatestPresent} | ${contract.reportsReadmeCommandPresent} | ${contract.reportsReadmeLatestPresent} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.contractId || item.scenarioId || ''} ${item.docsPath || item.fileId || item.scriptId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads local docs, README.md, reports/README.md, and the report contract manifest.',
    '- Synthetic fixture proves missing anchors, commands, and latest mentions fail closed.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-contract-doc-index-anchor-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractDocIndexAnchorRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildReportContractDocIndexAnchorRegressionReport({
    docsByPath: readDocsByPath(),
    readmeText: readText(path.join(packageRoot, 'README.md')),
    reportsReadmeText: readText(path.join(reportsDir, 'README.md')),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractDocIndexAnchorRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractDocIndexAnchorRegressionHash: report.contractDocIndexAnchorRegressionHash,
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
