#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_SELF_REFERENCE_BOUNDARY_REGRESSION_REPORT_FILE_ID,
  buildReportSelfReferenceBoundaryRegressionReport,
} from './report-self-reference-boundary-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8');
}

function markdownFor(report) {
  const lines = [
    '# Report Self-Reference Boundary Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.selfReferenceBoundaryRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual boundary ok: ${report.summary.actualOk}`,
    `- Gate steps observed: ${report.summary.gateStepCount}`,
    `- Artifact actual ok with stale bindings: ${report.summary.artifactActualOk}`,
    `- Artifact gate drift observed: ${report.summary.artifactActualGateDriftObserved}`,
    `- Artifact checkpoint drift observed: ${report.summary.artifactActualCheckpointDriftObserved}`,
    `- Required gate drift blocked: ${report.summary.artifactRequiredGateDriftBlocked}`,
    `- Required checkpoint drift blocked: ${report.summary.artifactRequiredCheckpointDriftBlocked}`,
    `- Final freshness drift blocked: ${report.summary.finalFreshnessDriftBlocked}`,
    `- Skip-gate freshness ok: ${report.summary.skipGateFreshnessOk}`,
    `- Pre-tooling freshness uses skip-gate: ${report.summary.preToolingFreshnessSkipGate}`,
    `- Final gate-child freshness uses skip-gate: ${report.summary.finalFreshnessSkipGate}`,
    `- Artifact before pre-tooling freshness: ${report.summary.artifactBeforePreToolingFreshness}`,
    `- Self-reference boundary before pre-tooling freshness: ${report.summary.selfReferenceBeforePreToolingFreshness}`,
    `- Gate drift blocker requirement-gated: ${report.summary.gateDriftFilterRequirementGated}`,
    `- Checkpoint drift blocker requirement-gated: ${report.summary.checkpointDriftFilterRequirementGated}`,
    `- Artifact exporter requires live binding: ${report.summary.exporterRequiresLiveGateBinding}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Artifact Boundary',
    '',
    `- Actual status: ${report.artifact.actual.status}`,
    `- Actual blockers: ${report.artifact.actual.blockers.map((item) => item.code).join(', ') || 'none'}`,
    `- Required status: ${report.artifact.required.status}`,
    `- Required blockers: ${report.artifact.required.blockers.map((item) => item.code).join(', ') || 'none'}`,
    '',
    '## Freshness Boundary',
    '',
    `- Final status: ${report.freshness.final.status}`,
    `- Final blockers: ${report.freshness.final.blockerCodes.join(', ') || 'none'}`,
    `- Skip-gate status: ${report.freshness.skipGate.status}`,
    `- Skip-gate blockers: ${report.freshness.skipGate.blockerCodes.join(', ') || 'none'}`,
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
      ? report.blockers.map((item) => `- ${item.code} ${item.scenarioId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Reads local integration gate source, artifact reproducibility source, and artifact exporter source.',
    '- Uses synthetic report and freshness fixtures to prove self-reference boundaries without relying on live platform state.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-self-reference-boundary-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportSelfReferenceBoundaryRegressionLatest({ generatedAt = new Date().toISOString() } = {}) {
  return buildReportSelfReferenceBoundaryRegressionReport({
    gateSourceText: readText('src/integration-dependency-gate.mjs'),
    artifactSourceText: readText('src/report-artifact-reproducibility.mjs'),
    artifactExporterSourceText: readText('src/export-report-artifact-reproducibility.mjs'),
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportSelfReferenceBoundaryRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    selfReferenceBoundaryRegressionHash: report.selfReferenceBoundaryRegressionHash,
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
