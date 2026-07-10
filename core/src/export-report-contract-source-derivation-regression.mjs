#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CONTRACT_SOURCE_DERIVATION_REGRESSION_REPORT_FILE_ID,
  buildReportContractSourceDerivationRegressionReport,
} from './report-contract-source-derivation-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walkFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) return walkFiles(entryPath);
    if (!entry.isFile()) return [];
    return [entryPath];
  });
}

function relativeFiles(dirName, extension) {
  return walkFiles(path.join(packageRoot, dirName))
    .filter((filePath) => filePath.endsWith(extension))
    .map((filePath) => path.relative(packageRoot, filePath).replace(/\\/g, '/'));
}

function relativeFileTexts(dirName, extension) {
  return Object.fromEntries(walkFiles(path.join(packageRoot, dirName))
    .filter((filePath) => filePath.endsWith(extension))
    .map((filePath) => [
      path.relative(packageRoot, filePath).replace(/\\/g, '/'),
      fs.readFileSync(filePath, 'utf8'),
    ]));
}

function markdownFor(report) {
  const lines = [
    '# Report Contract Source Derivation Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractSourceDerivationRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual derivation ok: ${report.summary.actualOk}`,
    `- Contracts covered: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- File ids: ${report.summary.fileIdMatchCount}/${report.summary.contractCount}`,
    `- Markdown ids: ${report.summary.markdownFileIdMatchCount}/${report.summary.contractCount}`,
    `- Source paths: ${report.summary.sourcePathMatchCount}/${report.summary.contractCount}`,
    `- Exporter paths: ${report.summary.exporterPathMatchCount}/${report.summary.contractCount}`,
    `- Docs paths: ${report.summary.docsPathMatchCount}/${report.summary.contractCount}`,
    `- Script ids: ${report.summary.scriptIdMatchCount}/${report.summary.contractCount}`,
    `- Stdout hash fields: ${report.summary.stdoutHashFieldMatchCount}/${report.summary.contractCount}`,
    `- Gate summary hash keys: ${report.summary.gateSummaryHashKeyMatchCount}/${report.summary.contractCount}`,
    `- Primary export steps: ${report.summary.primaryStepCount}/${report.summary.contractCount}`,
    `- Syntax step ids: source=${report.summary.sourceSyntaxStepIdMatchCount}/${report.summary.contractCount}, exporter=${report.summary.exporterSyntaxStepIdMatchCount}/${report.summary.contractCount}`,
    `- Required gate args: ${report.summary.requiredGateArgsMatchCount}/${report.summary.contractCount}`,
    `- Freshness inventory flags: ${report.summary.freshnessInventoryFlagMatchCount}/${report.summary.contractCount}`,
    `- Special docs overrides: ${report.summary.specialDocOverridePresentCount}/${report.summary.specialDocOverrideCount}`,
    `- Existing files: source=${report.summary.sourceFileCount}/${report.summary.contractCount}, exporter=${report.summary.exporterFileCount}/${report.summary.contractCount}, docs=${report.summary.docsFileCount}/${report.summary.contractCount}`,
    `- Section core adoption ok: ${report.summary.sectionCoreActualOk}`,
    `- Section core modules: ${report.summary.sectionCoreOkContractCount}/${report.summary.sectionCoreContractCount}`,
    `- Section core imports: ${report.summary.sectionCoreImportCount}/${report.summary.sectionCoreContractCount}`,
    `- Section core helper usage: ${report.summary.sectionCoreHelperUsageCount}/${report.summary.sectionCoreRequiredHelperUsageCount}`,
    `- Section core private implementation free: ${report.summary.sectionCorePrivateImplementationFreeCount}/${report.summary.sectionCoreContractCount}`,
    `- Section core extra safety flags: ${report.summary.sectionCoreExtraSafetyFlagCount}/${report.summary.sectionCoreRequiredExtraSafetyFlagCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | Status | Script | Source | Exporter | Docs | Hash key |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.expected.scriptId} | ${contract.expected.sourcePath} | ${contract.expected.exporterPath} | ${contract.expected.docsPath} | ${contract.expected.gateSummaryHashKey} |`),
    '',
    '## Section Core Adoption',
    '',
    '| Contract | Status | Source | Core import | Helpers | Extra safety flags | Private helpers |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.actual.sectionCore.contracts.map((contract) => `| ${contract.contractId} | ${contract.status} | ${contract.sourcePath} | ${contract.importsSectionCore} | ${contract.helperUsageCount}/${contract.requiredHelperUsageCount} | ${contract.extraSafetyFlagCount}/${contract.requiredExtraSafetyFlagCount} | ${contract.privateImplementationSnippetCount} |`),
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
      ? report.blockers.map((item) => `- ${item.code} ${item.contractId || item.scenarioId || ''} ${item.fileId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads only local source/docs files and synthetic mutations.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-contract-source-derivation-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractSourceDerivationRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildReportContractSourceDerivationRegressionReport({
    sourceFileIds: relativeFiles('src', '.mjs'),
    docsFileIds: relativeFiles('docs', '.md'),
    sourceTextsByFileId: relativeFileTexts('src', '.mjs'),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractSourceDerivationRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractSourceDerivationRegressionHash: report.contractSourceDerivationRegressionHash,
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
