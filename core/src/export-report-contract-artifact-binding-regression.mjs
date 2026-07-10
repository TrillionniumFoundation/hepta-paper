#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_CONTRACT_ARTIFACT_BINDING_REGRESSION_REPORT_FILE_ID,
  buildReportContractArtifactBindingRegressionReport,
} from './report-contract-artifact-binding-regression.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_FRESHNESS_REQUIRED_REPORTS,
} from './report-freshness.mjs';
import {
  INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS,
} from './integration-gate-tooling.mjs';
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

function markdownFileIdFor(fileId = '') {
  return String(fileId || '').replace(/\.json$/, '.md');
}

function readReportArtifacts() {
  return Object.fromEntries(REPORT_CONTRACT_MANIFEST.map((contract) => {
    const jsonPath = path.join(reportsDir, contract.fileId);
    const mdPath = path.join(reportsDir, markdownFileIdFor(contract.fileId));
    return [
      contract.fileId,
      {
        jsonExists: fs.existsSync(jsonPath),
        mdExists: fs.existsSync(mdPath),
      },
    ];
  }));
}

function expectedFileIdsFromReport(fileId) {
  const report = readJson(path.join(reportsDir, fileId), {});
  if (Array.isArray(report.expectedFileIds)) return report.expectedFileIds;
  if (Array.isArray(report.records)) return report.records.map((record) => record.fileId);
  return [];
}

function markdownFor(report) {
  const lines = [
    '# Report Contract Artifact Binding Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.contractArtifactBindingRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual artifact bindings ok: ${report.summary.actualOk}`,
    `- Contracts covered: ${report.summary.okContractCount}/${report.summary.contractCount}`,
    `- Latest JSON outputs: ${report.summary.jsonReportCount}/${report.summary.contractCount}`,
    `- Latest Markdown outputs: ${report.summary.markdownReportCount}/${report.summary.contractCount}`,
    `- reports/README.md bindings: ${report.summary.readmeBindingCount}/${report.summary.contractCount}`,
    `- Freshness bindings: ${report.summary.freshnessBindingCount}/${report.summary.freshnessExpectedCount}`,
    `- Tooling bindings: ${report.summary.toolingBindingCount}/${report.summary.toolingExpectedCount}`,
    `- Schema bindings: ${report.summary.schemaBindingCount}/${report.summary.schemaExpectedCount}`,
    `- Output pairing bindings: ${report.summary.outputPairingBindingCount}/${report.summary.outputPairingExpectedCount}`,
    `- Artifact reproducibility bindings: ${report.summary.artifactReproducibilityBindingCount}/${report.summary.artifactReproducibilityExpectedCount}`,
    `- Explicit self-cycle skips: ${report.summary.skippedBindingCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Contracts',
    '',
    '| Contract | JSON | Markdown | README | Freshness | Tooling | Schema | Output pairing | Artifact reproducibility |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.actual.contracts.map((contract) => `| ${contract.contractId} | ${contract.jsonExists} | ${contract.mdExists} | ${contract.readmeListed} | ${bindingCell(contract.bindings.freshness)} | ${bindingCell(contract.bindings.tooling)} | ${bindingCell(contract.bindings.schema)} | ${bindingCell(contract.bindings.outputPairing)} | ${bindingCell(contract.bindings.artifactReproducibility)} |`),
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
    '- Reads local latest JSON/Markdown report files, reports/README.md, and existing report inventories.',
    '- Synthetic fixture proves missing latest files and missing cross-report bindings fail closed.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function bindingCell(binding = {}) {
  if (binding.expected) return binding.present ? 'present' : 'missing';
  return `skip:${binding.skipReason || 'none'}`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-contract-artifact-binding-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportContractArtifactBindingRegressionLatest({
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildReportContractArtifactBindingRegressionReport({
    reportArtifactsByFileId: readReportArtifacts(),
    reportsReadmeText: readText(path.join(reportsDir, 'README.md')),
    freshnessRequiredFileIds: REPORT_FRESHNESS_REQUIRED_REPORTS.map((spec) => spec.fileId),
    toolingReportFileIds: INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS,
    schemaExpectedFileIds: expectedReportSchemaContractFileIds(),
    outputPairingExpectedFileIds: expectedFileIdsFromReport('report-output-pairing-latest.json'),
    artifactReproducibilityExpectedFileIds: expectedFileIdsFromReport('report-artifact-reproducibility-latest.json'),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportContractArtifactBindingRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    contractArtifactBindingRegressionHash: report.contractArtifactBindingRegressionHash,
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
