#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReportContractDocCoverageRegressionReport,
} from './report-contract-doc-coverage-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function walkFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const filePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) return walkFiles(filePath);
    if (!entry.isFile()) return [];
    return [filePath];
  });
}

function markdownFor(report) {
  const lines = [
    '# Report Contract Doc Coverage Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractDocCoverageRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual coverage ok: ${report.summary.actualOk}`,
    `- Contracts covered: ${report.summary.coveredContractCount}/${report.summary.contractCount}`,
    `- Docs files: ${report.summary.docsFileCount}/${report.summary.contractCount}`,
    `- README scripts: ${report.summary.readmeScriptCount}/${report.summary.contractCount}`,
    `- README docs links: ${report.summary.readmeDocsCount}/${report.summary.contractCount}`,
    `- Reports README files: ${report.summary.reportsReadmeFileCount}/${report.summary.contractCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Status | Script | Docs | Latest report |',
    '| --- | --- | --- | --- | --- |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.scriptId} | ${contract.docsPath} | ${contract.fileId} |`),
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
      ? report.blockers.map((item) => `- ${item.code}: ${item.notes}`)
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local source, docs, and README inspection only.',
    '- Synthetic fixture only for bad states.',
    '- It only writes its own latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, messaging, payment, acceptance, deployment, channel-state fetch, or local state transition.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-contract-doc-coverage-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const docsFileIds = walkFiles(path.join(packageRoot, 'docs'))
    .filter((filePath) => filePath.endsWith('.md'))
    .map((filePath) => path.relative(packageRoot, filePath).replace(/\\/g, '/'));
  const report = buildReportContractDocCoverageRegressionReport({
    docsFileIds,
    readmeText: readText(path.join(packageRoot, 'README.md')),
    reportsReadmeText: readText(path.join(packageRoot, 'reports', 'README.md')),
  });
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractDocCoverageRegressionHash: report.contractDocCoverageRegressionHash,
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
