#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_DISPATCH_COMPLETION_DENIAL_SECTION_SENTENCES,
  buildReportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression.mjs';
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

function countLine(report = {}, binding = {}) {
  return `- ${binding.label} bindings: ${report.summary[`${binding.key}Count`]}/${report.summary.contractCount}`;
}

function contractCell(contract = {}, binding = {}) {
  return contract[`${binding.key}Present`];
}

function markdownFor(report) {
  const lines = [
    '# Report Contract Doc Page Release Post-Action Dispatch Completion Denial Section Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual doc page release post-action dispatch completion denial sections ok: ${report.summary.actualOk}`,
    `- Contracts covered: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Unique docs paths: ${report.summary.uniqueDocsPathCount}`,
    `- Docs files: ${report.summary.docsFileCount}/${report.summary.contractCount}`,
    `- Release post-action dispatch completion denial sections: ${report.summary.sectionCount}/${report.summary.contractCount}`,
    ...REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_DISPATCH_COMPLETION_DENIAL_SECTION_SENTENCES.map((binding) => countLine(report, binding)),
    `- Ordered sections: ${report.summary.orderCount}/${report.summary.contractCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    `| Contract | Docs | Section | ${REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_DISPATCH_COMPLETION_DENIAL_SECTION_SENTENCES.map((binding) => binding.label).join(' | ')} | Order |`,
    `| --- | --- | --- | ${REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_DISPATCH_COMPLETION_DENIAL_SECTION_SENTENCES.map(() => '---').join(' | ')} | --- |`,
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.docsPath} | ${contract.sectionPresent} | ${REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_DISPATCH_COMPLETION_DENIAL_SECTION_SENTENCES.map((binding) => contractCell(contract, binding)).join(' | ')} | ${contract.orderValid} |`),
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
    '- Synthetic fixture proves missing release post-action dispatch completion denial bindings, post-action background runner order drift, and shared-doc mapping drift fail closed.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, acceptance, payment, deployment, channel-state fetch, local state transition, queue consumption, background runner, dispatch completion, runner dispatch, queue ack, or execution permission grant.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildReportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionReport({
    docsByPath: readDocsByPath(),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionHash: report.contractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionHash,
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
