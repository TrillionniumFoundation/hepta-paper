#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_ARTIFACT_REPRODUCIBILITY_REPORT_FILE_ID,
  buildReportArtifactReproducibilityReport,
} from './report-artifact-reproducibility.mjs';
import {
  REPORT_FRESHNESS_REQUIRED_REPORTS,
} from './report-freshness.mjs';
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

function expectedFileIds() {
  return expectedReportSchemaContractFileIds()
    .filter((fileId) => fileId !== REPORT_ARTIFACT_REPRODUCIBILITY_REPORT_FILE_ID)
    .sort((left, right) => left.localeCompare(right));
}

function readRecords(fileIds) {
  return fileIds.flatMap((fileId) => {
    const report = readJson(path.join(reportsDir, fileId));
    return report ? [{ fileId, report }] : [];
  });
}

function readGateSummaryHashes() {
  return readJson(path.join(reportsDir, 'integration-dependency-gate-latest.json'), {})?.summary || {};
}

function readCheckpointReports() {
  return readJson(path.join(reportsDir, 'architecture-checkpoint-latest.json'), {})?.reports || {};
}

function markdownFor(report) {
  const lines = [
    '# Report Artifact Reproducibility',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.artifactReproducibilityHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual reproducibility ok: ${report.summary.actualOk}`,
    `- Reports: ${report.summary.analyzedReportCount}/${report.summary.expectedReportCount}`,
    `- Stable hashes: ${report.summary.stableHashCount}/${report.summary.expectedReportCount}`,
    `- Artifact digests: ${report.summary.artifactDigestCount}/${report.summary.expectedReportCount}`,
    `- Artifact inventory hash: ${report.summary.artifactInventoryHash}`,
    `- Gate bindings: ${report.summary.gateBindingMatchCount}/${report.summary.gateComparableBindingCount}`,
    `- Checkpoint bindings: ${report.summary.checkpointBindingMatchCount}/${report.summary.checkpointComparableBindingCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Reports',
    '',
    '| Report | Stable hash | Artifact digest | Status |',
    '| --- | --- | --- | --- |',
    ...report.records.map((record) => `| ${record.fileId} | ${record.stableHash || 'null'} | ${record.artifactDigest || 'null'} | ${record.status || 'null'} |`),
    '',
    '## Gate Bindings',
    '',
    '| Report | Hash key | Actual hash | Gate hash | Matches |',
    '| --- | --- | --- | --- | --- |',
    ...report.gateBindings.map((binding) => `| ${binding.fileId} | ${binding.gateSummaryHashKey || 'null'} | ${binding.actualHash || 'null'} | ${binding.expectedGateHash || 'null'} | ${binding.matches} |`),
    '',
    '## Checkpoint Bindings',
    '',
    '| Report | Key | Actual hash | Checkpoint hash | Matches |',
    '| --- | --- | --- | --- | --- |',
    ...report.checkpointBindings.map((binding) => `| ${binding.fileId} | ${binding.key || 'null'} | ${binding.actualHash || 'null'} | ${binding.checkpointHash || 'null'} | ${binding.matches} |`),
    '',
    '## Scenarios',
    '',
    '| Scenario | Status | Expected blocker | Same digest | Observed blockers |',
    '| --- | --- | --- | --- | --- |',
    ...report.scenarios.map((scenario) => `| ${scenario.scenarioId} | ${scenario.status} | ${scenario.expectedBlockerCode} | ${scenario.observed.sameDigest} | ${scenario.observedBlockerCodes.join('<br>') || 'none'} |`),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code} ${item.fileId || item.scenarioId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads local latest JSON report files, integration gate summary hashes, and architecture checkpoint report bindings.',
    '- Actual gate hash drift is owned by reports:freshness; this report records current gate/checkpoint binding comparisons without creating a stale-gate cycle.',
    '- Synthetic fixture proves volatile report metadata and output paths do not affect reproducible artifact digests, while semantic and binding drift fail closed.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-artifact-reproducibility-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportArtifactReproducibilityLatest({ generatedAt = new Date().toISOString() } = {}) {
  const fileIds = expectedFileIds();
  return buildReportArtifactReproducibilityReport({
    expectedFileIds: fileIds,
    records: readRecords(fileIds),
    freshnessReports: REPORT_FRESHNESS_REQUIRED_REPORTS,
    gateSummaryHashes: readGateSummaryHashes(),
    checkpointReports: readCheckpointReports(),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportArtifactReproducibilityLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    artifactReproducibilityHash: report.artifactReproducibilityHash,
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
