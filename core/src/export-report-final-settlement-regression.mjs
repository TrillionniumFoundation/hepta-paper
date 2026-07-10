#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPORT_FINAL_SETTLEMENT_REGRESSION_REPORT_FILE_ID,
  buildReportFinalSettlementRegressionReport,
} from './report-final-settlement-regression.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function markdownFor(report) {
  const lines = [
    '# Report Final Settlement Regression',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.finalSettlementRegressionHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Actual policy ok: ${report.summary.actualOk}`,
    `- Settlement stages: ${report.summary.settlementStageCount}/${report.summary.expectedSettlementStageCount}`,
    `- Required scripts: ${report.summary.presentPackageScriptCount}/${report.summary.packageScriptCount}`,
    `- Mapped report writes after final gate: ${report.summary.mappedReportWriteAfterFinalGateCount}`,
    `- Failed-command validation skipped: ${report.summary.validationSkipsAfterFailedCommand}`,
    `- Failed-command stale latest validation possible: ${report.summary.failedCommandCanValidateStaleLatest}`,
    `- Final gate hash present: ${report.summary.finalGateHashPresent}`,
    `- Final freshness gate hash matches: ${report.summary.finalFreshnessGateHashMatches}`,
    `- Final freshness gate hash mismatches: ${report.summary.finalFreshnessGateHashMismatchCount}`,
    `- Checkpoint freshness hash matches: ${report.summary.checkpointFreshnessHashMatches}`,
    `- Post-action runtime status required metrics: ${report.summary.postActionRuntimeStatusRequiredSummaryMetricOk}/${report.summary.postActionRuntimeStatusRequiredSummaryMetrics}`,
    `- Post-action runtime status required metrics ok: ${report.summary.postActionRuntimeStatusRequiredSummaryMetricsOk}`,
    `- Read-only dispatch metrics: ${report.summary.readOnlyReportChainDispatchMetrics}/${report.summary.readOnlyReportChainExpectedDispatchMetrics}`,
    `- Read-only dispatch metrics ok: ${report.summary.readOnlyReportChainDispatchMetricsOk}`,
    `- Read-only dispatch handoffs: ready=${report.summary.readOnlyReportChainDispatchReadyHandoffs}, blocked=${report.summary.readOnlyReportChainDispatchBlockedHandoffs}, total=${report.summary.readOnlyReportChainDispatchTotalHandoffs}`,
    `- Clean seed writes: ${report.summary.seedWriteCount}`,
    `- Clean seed skips: ${report.summary.seedSkipCount}`,
    `- Active bootstrap seed reports: ${report.summary.activeBootstrapSeedReports}`,
    `- Placeholder token matches: ${report.summary.placeholderTokenMatches}`,
    `- Diff whitespace clean: ${report.summary.diffWhitespaceClean}`,
    `- Report-only dirty scan clean: ${report.summary.reportOnlyDirtyScanClean}`,
    `- Report dirty files: ${report.summary.reportDirtyFileCount}`,
    `- Allowed report dirty files: ${report.summary.allowedReportDirtyFileCount}`,
    `- Non-latest report dirty files: ${report.summary.nonLatestReportDirtyFileCount}`,
    `- Non-report dirty files: ${report.summary.nonReportDirtyFileCount}`,
    `- Latest report write integrity ok: ${report.summary.latestReportWriteIntegrityOk}`,
    `- Latest report hash matches: ${report.summary.latestReportHashMatches}`,
    `- Latest report Markdown binding present: ${report.summary.latestReportMarkdownBindingPresent}`,
    `- Retention ok: ${report.summary.retentionOk}`,
    `- Retention dry-run: ${report.summary.retentionDryRun}`,
    `- Retention archived candidates: ${report.summary.retentionArchivedCount}`,
    `- Scenarios: ${report.summary.passedScenarioCount}/${report.summary.scenarioCount}`,
    `- Expected blockers observed: ${report.summary.observedExpectedBlockerCount}/${report.summary.expectedScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Settlement Stages',
    '',
    '| Stage | Requirement |',
    '| --- | --- |',
    '| final_gate_strict | final strict integration gate snapshot exists before closeout checks |',
    '| report_retention_dry_run | retention/prune check passes, stays dry-run, and reports archivedCount=0 during settlement |',
    '| final_report_freshness_strict | final report freshness binds the final gate hash with zero mismatches |',
    '| architecture_checkpoint_strict | checkpoint binds the final report freshness hash, all post-action runtime required metrics, and read-only dispatch handoff metrics |',
    '| bootstrap_seed_clean_strict | clean seed check writes zero seeds and skips every allowlisted seed file |',
    '| active_seed_marker_scan | final latest-report scan finds zero active bootstrap seed markers |',
    '| placeholder_token_scan | final placeholder scan finds zero real placeholder tokens |',
    '| diff_whitespace_check | final local diff whitespace check passes after all local writes |',
    '| report_only_dirty_scan | final local dirty scan allows report output drift only |',
    '| release_final_settlement_latest_report | final latest JSON/Markdown report echoes hash/status/reportFiles and write integrity |',
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
      ? report.blockers.map((item) => `- ${item.code} ${item.scenarioId || item.fileId || item.stepId || item.scriptId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Uses synthetic final settlement fixtures and integration gate source inspection only.',
    '- Does not run the integration gate recursively.',
    '- Does not read or mutate real latest reports.',
    '- Does not rewrite report files except this exported latest report.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    fileId: 'report-final-settlement-regression-latest.json',
    report,
    markdown: markdownFor(report),
  });
}

export function buildReportFinalSettlementRegressionLatest({ generatedAt = new Date().toISOString() } = {}) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return buildReportFinalSettlementRegressionReport({
    gateSourceText: fs.readFileSync(path.join(packageRoot, 'src', 'integration-dependency-gate.mjs'), 'utf8'),
    releaseSourceText: fs.readFileSync(path.join(packageRoot, 'src', 'release-final-settlement.mjs'), 'utf8'),
    packageScripts: packageJson.scripts || {},
    generatedAt,
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildReportFinalSettlementRegressionLatest();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    finalSettlementRegressionHash: report.finalSettlementRegressionHash,
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
