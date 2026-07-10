#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CONTRACT_SYNTAX_COVERAGE_REGRESSION_REPORT_FILE_ID,
  buildReportContractSyntaxCoverageRegressionReport,
} from './report-contract-syntax-coverage-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8');
}

function walkFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) return walkFiles(entryPath);
    if (!entry.isFile()) return [];
    return [entryPath];
  });
}

function markdownFor(report) {
  const lines = [
    '# Report Contract Syntax Coverage Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractSyntaxCoverageRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual coverage ok: ${report.summary.actualOk}`,
    `- Contracts covered: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Source files: ${report.summary.sourceFileCount}/${report.summary.contractCount}`,
    `- Exporter files: ${report.summary.exporterFileCount}/${report.summary.contractCount}`,
    `- Source syntax steps: ${report.summary.sourceSyntaxStepCount}/${report.summary.contractCount}`,
    `- Exporter syntax steps: ${report.summary.exporterSyntaxStepCount}/${report.summary.contractCount}`,
    `- Source syntax args: ${report.summary.sourceSyntaxArgCount}/${report.summary.contractCount}`,
    `- Exporter syntax args: ${report.summary.exporterSyntaxArgCount}/${report.summary.contractCount}`,
    `- Source-before-exporter order: ${report.summary.sourceBeforeExporterCount}/${report.summary.contractCount}`,
    `- Export steps: ${report.summary.presentExportStepCount}/${report.summary.exportStepCount}`,
    `- Exporter-before-export order: ${report.summary.exporterBeforeExportCount}/${report.summary.exportStepCount}`,
    `- CLI entrypoint helper sources: ${report.summary.cliEntrypointHelperCount}/${report.summary.cliEntrypointSourceCount}`,
    `- Raw CLI entrypoint sources: ${report.summary.rawCliEntrypointCount}`,
    `- URL pathname package-root sources: ${report.summary.urlPathnameSourceCount}`,
    `- Direct write sources: ${report.summary.allowedDirectWriteSourceCount}/${report.summary.directWriteSourceCount} allowed; disallowed ${report.summary.disallowedDirectWriteSourceCount}`,
    `- Filesystem mutation sources: ${report.summary.allowedFilesystemMutationSourceCount}/${report.summary.filesystemMutationSourceCount} allowed; disallowed ${report.summary.disallowedFilesystemMutationSourceCount}`,
    `- Child process sources: ${report.summary.allowedChildProcessSourceCount}/${report.summary.childProcessSourceCount} allowed; disallowed ${report.summary.disallowedChildProcessSourceCount}; approved commands ${report.summary.approvedChildProcessCommandCount}/${report.summary.childProcessCommandCount}; disallowed commands ${report.summary.disallowedChildProcessCommandCount}; approved argv ${report.summary.approvedChildProcessArgvCount}/${report.summary.childProcessCommandCount}; disallowed argv ${report.summary.disallowedChildProcessArgvCount}; approved options ${report.summary.approvedChildProcessOptionsCount}/${report.summary.childProcessCommandCount}; disallowed options ${report.summary.disallowedChildProcessOptionsCount}; result handling ${report.summary.approvedChildProcessResultCount}/${report.summary.childProcessSpawnCount}; disallowed results ${report.summary.disallowedChildProcessResultCount}`,
    `- External boundary sources: ${report.summary.externalBoundarySourceCount}; network ${report.summary.networkApiSourceCount}; browser automation ${report.summary.browserAutomationSourceCount}; process env ${report.summary.allowedProcessEnvSourceCount}/${report.summary.processEnvSourceCount} allowed; disallowed ${report.summary.disallowedProcessEnvSourceCount}`,
    `- Dynamic code sources: ${report.summary.dynamicCodeSourceCount}; dynamic import ${report.summary.allowedDynamicImportSourceCount}/${report.summary.dynamicImportSourceCount} allowed; disallowed ${report.summary.disallowedDynamicImportSourceCount}; unsafe dynamic code ${report.summary.unsafeDynamicCodeSourceCount}`,
    `- Randomness/crypto sources: ${report.summary.randomnessCryptoSourceCount}; crypto ${report.summary.allowedCryptoSourceCount}/${report.summary.cryptoSourceCount} allowed; disallowed ${report.summary.disallowedCryptoSourceCount}; randomness ${report.summary.randomnessSourceCount}`,
    `- Runtime side-effect sources: ${report.summary.runtimeSideEffectSourceCount}; direct process exit ${report.summary.allowedDirectProcessExitSourceCount}/${report.summary.directProcessExitSourceCount} allowed; disallowed ${report.summary.disallowedDirectProcessExitSourceCount}; env mutations ${report.summary.processEnvMutationSourceCount}; async timers ${report.summary.asyncTimerSourceCount}`,
    `- Command string sources: ${report.summary.commandStringSourceCount}; destructive ${report.summary.destructiveCommandStringSourceCount}; external ${report.summary.externalCommandStringSourceCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Status | Source syntax | Exporter syntax | Export steps |',
    '| --- | --- | --- | --- | ---: |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.sourceSyntaxStepId} | ${contract.exporterSyntaxStepId} | ${contract.presentExportStepCount}/${contract.exportStepCount} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.contractId || item.scenarioId || ''} ${item.stepId || item.fileId || ''}: ${item.notes}`.trim())
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
    fileId: 'report-contract-syntax-coverage-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractSyntaxCoverageRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  const sourceFileIds = walkFiles(path.join(packageRoot, 'src'))
    .filter((filePath) => filePath.endsWith('.mjs'))
    .map((filePath) => path.relative(packageRoot, filePath).replace(/\\/g, '/'));
  const sourceTextsByFileId = Object.fromEntries(sourceFileIds.map((fileId) => [
    fileId,
    readSource(fileId),
  ]));
  return buildReportContractSyntaxCoverageRegressionReport({
    gateSourceText: readSource('src/integration-dependency-gate.mjs'),
    sourceFileIds,
    sourceTextsByFileId,
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractSyntaxCoverageRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractSyntaxCoverageRegressionHash: report.contractSyntaxCoverageRegressionHash,
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
