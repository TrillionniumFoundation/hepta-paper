import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS,
} from './report-bootstrap-seed-regression.mjs';
import {
  POST_ACTION_RUNTIME_STATUS_STAGES,
} from './post-action-runtime-status.mjs';
import { digest } from './hash-utils.mjs';
import {
  relativeToWorkspace,
  writeLatestReportPair,
} from './report-output-writer.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FINAL_SETTLEMENT_JSON_FILE_ID = 'release-final-settlement-latest.json';
const FINAL_SETTLEMENT_MD_FILE_ID = 'release-final-settlement-latest.md';
const EXPECTED_POST_ACTION_RUNTIME_STATUS_REQUIRED_SUMMARY_METRICS = POST_ACTION_RUNTIME_STATUS_STAGES
  .reduce((sum, stage) => sum + stage.requiredSummaryMetrics.length, 0);

const SETTLEMENT_STEPS = Object.freeze([
  Object.freeze({
    stepId: 'final_gate_strict',
    scriptId: 'gate:integration:strict',
    command: 'npm run gate:integration:strict',
    validate: validateFinalGate,
  }),
  Object.freeze({
    stepId: 'report_retention_dry_run',
    scriptId: 'reports:prune:dry-run',
    command: 'npm run reports:prune:dry-run',
    validate: validateRetentionDryRun,
  }),
  Object.freeze({
    stepId: 'final_report_freshness_strict',
    scriptId: 'reports:freshness',
    command: 'npm run reports:freshness',
    validate: validateFreshness,
  }),
  Object.freeze({
    stepId: 'architecture_checkpoint_strict',
    scriptId: 'checkpoint:architecture',
    command: 'npm run checkpoint:architecture',
    validate: validateArchitectureCheckpoint,
  }),
  Object.freeze({
    stepId: 'bootstrap_seed_clean_strict',
    scriptId: 'reports:bootstrap-seeds',
    command: 'npm run reports:bootstrap-seeds -- --strict',
    run: runBootstrapSeedCheck,
    validate: validateBootstrapSeedCheck,
  }),
  Object.freeze({
    stepId: 'active_seed_marker_scan',
    command: 'scan allowlisted latest reports for active bootstrap seeds',
    run: runActiveSeedMarkerScan,
  }),
  Object.freeze({
    stepId: 'placeholder_token_scan',
    command: 'rg placeholder tokens in docs, reports README, src, and package.json',
    run: runPlaceholderTokenScan,
  }),
  Object.freeze({
    stepId: 'diff_whitespace_check',
    command: 'git diff --check -- .',
    run: runDiffWhitespaceCheck,
  }),
  Object.freeze({
    stepId: 'report_only_dirty_scan',
    command: 'git status --short -- .',
    run: runReportOnlyDirtyScan,
  }),
]);

function readPackageScripts() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return packageJson.scripts || {};
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, relativePath), 'utf8'));
}

function isSha256Hash(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value || ''));
}

function reportHash(report = {}) {
  return report.gateHash
    || report.freshnessHash
    || report.checkpointHash
    || report.retentionHash
    || report.finalSettlementHash
    || null;
}

function requiredSemanticReportHash(report, {
  label,
  semanticKey,
  missingCode,
  genericMissingCode,
  mismatchCode,
}, blockers) {
  const semanticHash = report?.[semanticKey] || null;
  const genericHash = report?.hash || null;
  if (!isSha256Hash(semanticHash)) {
    blockers.push(block(
      missingCode,
      `${label} must expose a stable sha256 ${semanticKey}.`,
      { [semanticKey]: semanticHash },
    ));
  }
  if (!isSha256Hash(genericHash)) {
    blockers.push(block(
      genericMissingCode,
      `${label} must expose a stable sha256 generic hash.`,
      { hash: genericHash },
    ));
  }
  if (isSha256Hash(semanticHash) && isSha256Hash(genericHash) && semanticHash !== genericHash) {
    blockers.push(block(
      mismatchCode,
      `${label} ${semanticKey} must match its generic hash.`,
      { [semanticKey]: semanticHash, hash: genericHash },
    ));
  }
  return semanticHash;
}

function reportSafety() {
  return {
    localOnly: true,
    readOnlyFinalSettlement: true,
    executesExternalAction: false,
    providerSpend: false,
    browserAutomation: false,
    upload: false,
    submit: false,
    messaging: false,
    payment: false,
    acceptance: false,
    deployment: false,
    fetchesChannelState: false,
    appliesLocalStateTransition: false,
    grantsExecutionPermission: false,
  };
}

function block(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function commandForScript(scriptId) {
  return ['npm', 'run', scriptId];
}

function runCommand(command, args, { capture = false } = {}) {
  const startedMs = Date.now();
  const child = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
    encoding: capture ? 'utf8' : undefined,
  });
  const stdout = capture ? child.stdout || '' : '';
  const stderr = capture ? child.stderr || '' : '';
  if (capture) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  return {
    ok: !child.error && child.status === 0 && !child.signal,
    exitCode: typeof child.status === 'number' ? child.status : 1,
    signal: child.signal || null,
    error: child.error ? child.error.message : null,
    durationMs: Date.now() - startedMs,
    stdout,
    stderr,
  };
}

function runNpmStep(step) {
  const [command, ...args] = commandForScript(step.scriptId);
  return runCommand(command, args);
}

function extractLastJsonObject(text = '') {
  const trimmed = String(text || '').trim();
  for (let index = trimmed.lastIndexOf('\n{'); index >= 0; index = trimmed.lastIndexOf('\n{', index - 1)) {
    const candidate = trimmed.slice(index + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function runBootstrapSeedCheck() {
  const result = runCommand(process.execPath, ['src/export-report-bootstrap-seeds.mjs', '--strict'], {
    capture: true,
  });
  return {
    ...result,
    outputJson: extractLastJsonObject(result.stdout),
  };
}

function runActiveSeedMarkerScan() {
  const startedMs = Date.now();
  const activeReports = REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.flatMap((fileId) => {
    const report = readJson(path.join('reports', fileId));
    const active = report.bootstrapSeed === true
      || report.summary?.bootstrapSeed === true
      || String(report.status || '').includes('bootstrap_seed_report');
    return active ? [{
      fileId,
      status: report.status || null,
      hash: reportHash(report),
    }] : [];
  });
  return {
    ok: activeReports.length === 0,
    exitCode: activeReports.length === 0 ? 0 : 1,
    signal: null,
    error: null,
    durationMs: Date.now() - startedMs,
    activeBootstrapSeedReports: activeReports.length,
    activeReports,
  };
}

function runPlaceholderTokenScan() {
  const pattern = String.raw`\b(TODO|FIXME|XXX|TBD|REPLACE_ME|CHANGE_ME|YOUR_|PLACEHOLDER)\b`;
  const result = runCommand('rg', [
    '-n',
    pattern,
    '-g',
    '!src/release-final-settlement.mjs',
    'README.md',
    'docs',
    'reports/README.md',
    'src',
    'package.json',
  ], { capture: true });
  const matchCount = result.stdout.trim() ? result.stdout.trim().split('\n').length : 0;
  const ok = result.exitCode === 1 && matchCount === 0;
  return {
    ...result,
    ok,
    exitCode: ok ? 0 : (result.exitCode || 1),
    placeholderTokenMatches: matchCount,
  };
}

function runDiffWhitespaceCheck() {
  return runCommand('git', ['diff', '--check', '--', '.'], { capture: true });
}

function parseStatusLine(line) {
  const text = String(line || '');
  const match = text.match(/^(.{1,2})\s+(.*)$/);
  const status = (match ? match[1] : text.slice(0, 2)).padEnd(2, ' ');
  const rawPath = (match ? match[2] : text.slice(3)).trim();
  const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop().trim() : rawPath;
  const reportOnly = filePath === 'reports/README.md' || filePath.startsWith('reports/');
  const allowedReportOutput = filePath === 'reports/README.md'
    || /^reports\/[a-z0-9][a-z0-9-]*-latest\.(json|md)$/.test(filePath);
  return {
    status,
    path: filePath,
    reportOnly,
    allowedReportOutput,
  };
}

function runReportOnlyDirtyScan() {
  const result = runCommand('git', ['status', '--short', '--', '.'], { capture: true });
  const statusOutput = result.stdout.trimEnd();
  const entries = statusOutput
    ? statusOutput.split('\n').filter(Boolean).map(parseStatusLine)
    : [];
  const nonReportEntries = entries.filter((entry) => !entry.reportOnly);
  const nonLatestReportEntries = entries.filter((entry) => entry.reportOnly && !entry.allowedReportOutput);
  const ok = result.ok && nonReportEntries.length === 0 && nonLatestReportEntries.length === 0;
  return {
    ...result,
    ok,
    exitCode: ok ? 0 : (result.exitCode || 1),
    dirtyFileCount: entries.length,
    reportDirtyFileCount: entries.filter((entry) => entry.reportOnly).length,
    allowedReportDirtyFileCount: entries.filter((entry) => entry.allowedReportOutput).length,
    nonLatestReportDirtyFileCount: nonLatestReportEntries.length,
    nonReportDirtyFileCount: nonReportEntries.length,
    dirtyFiles: entries,
  };
}

function validateFinalGate() {
  const gate = readJson('reports/integration-dependency-gate-latest.json');
  const blockers = [];
  const gateHash = requiredSemanticReportHash(gate, {
    label: 'Final strict integration gate',
    semanticKey: 'gateHash',
    missingCode: 'release_final_settlement_final_gate_hash_missing',
    genericMissingCode: 'release_final_settlement_final_gate_generic_hash_missing',
    mismatchCode: 'release_final_settlement_final_gate_hash_alias_mismatch',
  }, blockers);
  if (gate.ok !== true) {
    blockers.push(block('release_final_settlement_final_gate_not_ok', 'Final strict integration gate must pass.'));
  }
  return {
    ok: blockers.length === 0,
    hash: gateHash,
    metrics: {
      blockerCount: Array.isArray(gate.blockers) ? gate.blockers.length : 0,
    },
    blockers,
  };
}

function validateRetentionDryRun() {
  const report = readJson('reports/report-retention-latest.json');
  const blockers = [];
  const retentionHash = requiredSemanticReportHash(report, {
    label: 'Report retention dry-run',
    semanticKey: 'retentionHash',
    missingCode: 'release_final_settlement_retention_hash_missing',
    genericMissingCode: 'release_final_settlement_retention_generic_hash_missing',
    mismatchCode: 'release_final_settlement_retention_hash_alias_mismatch',
  }, blockers);
  if (report.ok !== true) {
    blockers.push(block('release_final_settlement_retention_not_ok', 'Report retention dry-run must pass.'));
  }
  if (report.dryRun !== true) {
    blockers.push(block('release_final_settlement_retention_not_dry_run', 'Final settlement retention must be a dry-run.'));
  }
  if (Number(report.archivedCount || 0) !== 0) {
    blockers.push(block(
      'release_final_settlement_retention_archive_candidates',
      'Final settlement retention dry-run must have archivedCount=0.',
      { archivedCount: Number(report.archivedCount || 0) },
    ));
  }
  return {
    ok: blockers.length === 0,
    hash: retentionHash,
    metrics: {
      keptCount: Number(report.keptCount || 0),
      archivedCount: Number(report.archivedCount || 0),
    },
    blockers,
  };
}

function validateFreshness() {
  const report = readJson('reports/report-freshness-latest.json');
  const gate = readJson('reports/integration-dependency-gate-latest.json');
  const blockers = [];
  const freshnessHash = requiredSemanticReportHash(report, {
    label: 'Report freshness',
    semanticKey: 'freshnessHash',
    missingCode: 'release_final_settlement_freshness_hash_missing',
    genericMissingCode: 'release_final_settlement_freshness_generic_hash_missing',
    mismatchCode: 'release_final_settlement_freshness_hash_alias_mismatch',
  }, blockers);
  if (report.ok !== true) {
    blockers.push(block('release_final_settlement_freshness_not_ok', 'Report freshness must pass.'));
  }
  if (report.summary?.includeGateReport !== true) {
    blockers.push(block('release_final_settlement_freshness_gate_not_included', 'Report freshness must include the integration gate report.'));
  }
  if (Number(report.summary?.gateHashMismatchCount || 0) !== 0) {
    blockers.push(block(
      'release_final_settlement_freshness_gate_hash_mismatch',
      'Report freshness must have zero gate hash mismatches.',
      { gateHashMismatchCount: Number(report.summary.gateHashMismatchCount || 0) },
    ));
  }
  if (gate.gateHash && report.gateHash && gate.gateHash !== report.gateHash) {
    blockers.push(block(
      'release_final_settlement_freshness_final_gate_hash_drift',
      'Report freshness must bind the final integration gate hash.',
      { finalGateHash: gate.gateHash, freshnessGateHash: report.gateHash },
    ));
  }
  return {
    ok: blockers.length === 0,
    hash: freshnessHash,
    metrics: {
      reportCount: Number(report.summary?.reportCount || 0),
      okReportCount: Number(report.summary?.okReportCount || 0),
      gateHashMismatchCount: Number(report.summary?.gateHashMismatchCount || 0),
    },
    blockers,
  };
}

function validateArchitectureCheckpoint() {
  const checkpoint = readJson('reports/architecture-checkpoint-latest.json');
  const freshness = readJson('reports/report-freshness-latest.json');
  const blockers = [];
  const checkpointHash = requiredSemanticReportHash(checkpoint, {
    label: 'Architecture checkpoint',
    semanticKey: 'checkpointHash',
    missingCode: 'release_final_settlement_checkpoint_hash_missing',
    genericMissingCode: 'release_final_settlement_checkpoint_generic_hash_missing',
    mismatchCode: 'release_final_settlement_checkpoint_hash_alias_mismatch',
  }, blockers);
  const freshnessHash = freshness.freshnessHash || null;
  const postActionRequiredSummaryMetricCount = Number(
    checkpoint.summary?.postActionRuntimeStatusRequiredSummaryMetrics || 0,
  );
  const postActionRequiredSummaryMetricOkCount = Number(
    checkpoint.summary?.postActionRuntimeStatusRequiredSummaryMetricOk || 0,
  );
  const readOnlyDispatchMetricCount = Number(checkpoint.summary?.readOnlyReportChainDispatchMetrics || 0);
  const expectedReadOnlyDispatchMetricCount = Number(
    checkpoint.summary?.readOnlyReportChainExpectedDispatchMetrics || 0,
  );
  const readOnlyDispatchTotalHandoffs = Number(checkpoint.summary?.readOnlyReportChainDispatchTotalHandoffs || 0);
  const readOnlyDispatchReadyHandoffs = Number(checkpoint.summary?.readOnlyReportChainDispatchReadyHandoffs || 0);
  const readOnlyDispatchBlockedHandoffs = Number(checkpoint.summary?.readOnlyReportChainDispatchBlockedHandoffs || 0);
  const readOnlyDispatchApprovalProvenanceBoundHandoffs = Number(checkpoint.summary?.readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs || 0);
  if (checkpoint.ok !== true) {
    blockers.push(block('release_final_settlement_checkpoint_not_ok', 'Architecture checkpoint must pass.'));
  }
  if (!isSha256Hash(freshnessHash)) {
    blockers.push(block(
      'release_final_settlement_checkpoint_freshness_hash_missing',
      'Architecture checkpoint comparison requires the final report freshnessHash alias.',
      { freshnessHash },
    ));
  } else if (checkpoint.summary?.reportFreshnessHash !== freshnessHash) {
    blockers.push(block(
      'release_final_settlement_checkpoint_freshness_hash_mismatch',
      'Architecture checkpoint must bind the final report freshness hash.',
      {
        checkpointFreshnessHash: checkpoint.summary?.reportFreshnessHash || null,
        freshnessHash,
      },
    ));
  }
  if (
    checkpoint.summary?.postActionRuntimeStatusRequiredSummaryMetricsOk !== true
    || postActionRequiredSummaryMetricCount !== EXPECTED_POST_ACTION_RUNTIME_STATUS_REQUIRED_SUMMARY_METRICS
    || postActionRequiredSummaryMetricOkCount !== EXPECTED_POST_ACTION_RUNTIME_STATUS_REQUIRED_SUMMARY_METRICS
  ) {
    blockers.push(block(
      'release_final_settlement_post_action_runtime_status_required_metrics_missing',
      'Final settlement checkpoint must bind all post-action runtime required summary metrics, including packageRole and human-feedback packageRole coverage.',
      {
        expectedRequiredSummaryMetricCount: EXPECTED_POST_ACTION_RUNTIME_STATUS_REQUIRED_SUMMARY_METRICS,
        postActionRequiredSummaryMetricCount,
        postActionRequiredSummaryMetricOkCount,
        postActionRequiredSummaryMetricsOk: checkpoint.summary?.postActionRuntimeStatusRequiredSummaryMetricsOk === true,
      },
    ));
  }
  if (
    checkpoint.summary?.readOnlyReportChainDispatchMetricsOk !== true
    || expectedReadOnlyDispatchMetricCount <= 0
    || readOnlyDispatchMetricCount !== expectedReadOnlyDispatchMetricCount
    || readOnlyDispatchTotalHandoffs !== readOnlyDispatchReadyHandoffs + readOnlyDispatchBlockedHandoffs
    || readOnlyDispatchApprovalProvenanceBoundHandoffs !== readOnlyDispatchTotalHandoffs
  ) {
    blockers.push(block(
      'release_final_settlement_read_only_dispatch_metrics_missing',
      'Final settlement checkpoint must bind read-only archive closeout dispatch handoff metrics, including ready/blocked human-feedback handoffs.',
      {
        readOnlyDispatchMetricCount,
        expectedReadOnlyDispatchMetricCount,
        readOnlyDispatchMetricsOk: checkpoint.summary?.readOnlyReportChainDispatchMetricsOk === true,
        readOnlyDispatchTotalHandoffs,
        readOnlyDispatchReadyHandoffs,
        readOnlyDispatchBlockedHandoffs,
        readOnlyDispatchApprovalProvenanceBoundHandoffs,
      },
    ));
  }
  return {
    ok: blockers.length === 0,
    hash: checkpointHash,
    metrics: {
      blockers: Number(checkpoint.summary?.blockers || 0),
      reportFreshnessHash: checkpoint.summary?.reportFreshnessHash || null,
      postActionRuntimeStatusRequiredSummaryMetrics: postActionRequiredSummaryMetricCount,
      postActionRuntimeStatusRequiredSummaryMetricOk: postActionRequiredSummaryMetricOkCount,
      postActionRuntimeStatusRequiredSummaryMetricsOk: checkpoint.summary?.postActionRuntimeStatusRequiredSummaryMetricsOk === true,
      readOnlyReportChainDispatchMetrics: readOnlyDispatchMetricCount,
      readOnlyReportChainExpectedDispatchMetrics: expectedReadOnlyDispatchMetricCount,
      readOnlyReportChainDispatchMetricsOk: checkpoint.summary?.readOnlyReportChainDispatchMetricsOk === true,
      readOnlyReportChainDispatchTotalHandoffs: readOnlyDispatchTotalHandoffs,
      readOnlyReportChainDispatchReadyHandoffs: readOnlyDispatchReadyHandoffs,
      readOnlyReportChainDispatchBlockedHandoffs: readOnlyDispatchBlockedHandoffs,
      readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs: readOnlyDispatchApprovalProvenanceBoundHandoffs,
    },
    blockers,
  };
}

function validateBootstrapSeedCheck(result) {
  const output = result.outputJson || {};
  const blockers = [];
  if (output.ok !== true) {
    blockers.push(block('release_final_settlement_seed_check_not_ok', 'Bootstrap seed clean check must pass.'));
  }
  if (Number(output.seededFileCount || 0) !== 0) {
    blockers.push(block(
      'release_final_settlement_seed_written',
      'Bootstrap seed clean check must not write seed reports.',
      { seededFileCount: Number(output.seededFileCount || 0) },
    ));
  }
  if (Number(output.skippedFileCount || 0) !== REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.length) {
    blockers.push(block(
      'release_final_settlement_seed_skip_count_mismatch',
      'Bootstrap seed clean check must skip every allowlisted report.',
      {
        skippedFileCount: Number(output.skippedFileCount || 0),
        expectedSkippedFileCount: REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.length,
      },
    ));
  }
  return {
    ok: blockers.length === 0,
    hash: output.bootstrapSeedExportHash || null,
    metrics: {
      seededFileCount: Number(output.seededFileCount || 0),
      skippedFileCount: Number(output.skippedFileCount || 0),
    },
    blockers,
  };
}

function summarizeStep(step, runResult, validation) {
  const blockers = [
    ...(!runResult.ok ? [block(
      'release_final_settlement_command_failed',
      `${step.command} failed.`,
      {
        stepId: step.stepId,
        exitCode: runResult.exitCode,
        signal: runResult.signal,
        error: runResult.error,
      },
    )] : []),
    ...(validation?.blockers || []),
    ...(typeof runResult.nonReportDirtyFileCount === 'number' && runResult.nonReportDirtyFileCount > 0
      ? [block(
        'release_final_settlement_non_report_dirty_files',
        'Final settlement allows only report latest output drift after local checks.',
        {
          nonReportDirtyFileCount: runResult.nonReportDirtyFileCount,
          dirtyFiles: runResult.dirtyFiles
            .filter((entry) => !entry.reportOnly)
            .map((entry) => entry.path),
        },
      )]
      : []),
    ...(typeof runResult.nonLatestReportDirtyFileCount === 'number' && runResult.nonLatestReportDirtyFileCount > 0
      ? [block(
        'release_final_settlement_non_latest_report_dirty_files',
        'Final settlement allows only tracked latest report outputs and reports/README.md after local checks.',
        {
          nonLatestReportDirtyFileCount: runResult.nonLatestReportDirtyFileCount,
          dirtyFiles: runResult.dirtyFiles
            .filter((entry) => entry.reportOnly && !entry.allowedReportOutput)
            .map((entry) => entry.path),
        },
      )]
      : []),
  ];
  return {
    stepId: step.stepId,
    scriptId: step.scriptId || null,
    command: step.command,
    status: blockers.length ? 'blocked_release_final_settlement_step' : 'pass_release_final_settlement_step',
    ok: blockers.length === 0,
    durationMs: runResult.durationMs,
    exitCode: runResult.exitCode,
    signal: runResult.signal,
    error: runResult.error,
    hash: validation?.hash || null,
    metrics: {
      ...(validation?.metrics || {}),
      ...(typeof runResult.activeBootstrapSeedReports === 'number'
        ? { activeBootstrapSeedReports: runResult.activeBootstrapSeedReports }
        : {}),
      ...(typeof runResult.placeholderTokenMatches === 'number'
        ? { placeholderTokenMatches: runResult.placeholderTokenMatches }
        : {}),
      ...(typeof runResult.dirtyFileCount === 'number'
        ? {
          dirtyFileCount: runResult.dirtyFileCount,
          reportDirtyFileCount: runResult.reportDirtyFileCount,
          allowedReportDirtyFileCount: runResult.allowedReportDirtyFileCount,
          nonLatestReportDirtyFileCount: runResult.nonLatestReportDirtyFileCount,
          nonReportDirtyFileCount: runResult.nonReportDirtyFileCount,
        }
        : {}),
    },
    ...(typeof runResult.dirtyFileCount === 'number'
      ? { dirtyFiles: runResult.dirtyFiles }
      : {}),
    blockers,
  };
}

function finalSettlementHashFor(report) {
  return digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    ok: report.ok,
    summary: report.summary,
    steps: report.steps.map((step) => ({
      stepId: step.stepId,
      scriptId: step.scriptId,
      command: step.command,
      status: step.status,
      ok: step.ok,
      exitCode: step.exitCode,
      signal: step.signal,
      hash: step.hash,
      metrics: step.metrics,
      dirtyFiles: (step.dirtyFiles || []).map((entry) => ({
        status: entry.status,
        path: entry.path,
        reportOnly: entry.reportOnly,
        allowedReportOutput: entry.allowedReportOutput,
      })),
      blockers: step.blockers.map((item) => ({
        code: item.code,
        stepId: item.stepId || null,
        scriptId: item.scriptId || null,
        notes: item.notes || null,
      })),
    })),
    blockers: report.blockers.map((item) => ({
      code: item.code,
      stepId: item.stepId || null,
      scriptId: item.scriptId || null,
      notes: item.notes || null,
    })),
    safety: report.safety,
  });
}

function summarize({ status, ok, startedAt, completedAt = new Date().toISOString(), steps, blockers }) {
  const report = {
    version: 1,
    kind: 'ReleaseFinalSettlement',
    status,
    ok,
    startedAt,
    completedAt,
    summary: {
      stepCount: SETTLEMENT_STEPS.length,
      completedStepCount: steps.filter((step) => step.ok === true).length,
      blockerCount: blockers.length,
    },
    steps,
    blockers,
    safety: reportSafety(),
  };
  const finalSettlementHash = finalSettlementHashFor(report);
  return {
    ...report,
    finalSettlementHash,
    hash: finalSettlementHash,
    reportFiles: {
      json: `design-production-core/reports/${FINAL_SETTLEMENT_JSON_FILE_ID}`,
      md: `design-production-core/reports/${FINAL_SETTLEMENT_MD_FILE_ID}`,
    },
  };
}

function markdownFor(report) {
  const lines = [
    '# Release Final Settlement',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.finalSettlementHash}`,
    `Started: ${report.startedAt}`,
    `Completed: ${report.completedAt}`,
    '',
    '## Summary',
    '',
    `- Steps: ${report.summary.completedStepCount}/${report.summary.stepCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Steps',
    '',
    '| Step | Status | Hash | Metrics |',
    '| --- | --- | --- | --- |',
    ...report.steps.map((step) => {
      const metrics = Object.entries(step.metrics || {})
        .map(([key, value]) => `${key}=${value}`)
        .join('<br>') || 'none';
      return `| ${step.stepId} | ${step.status} | ${step.hash || 'null'} | ${metrics} |`;
    }),
    '',
    '## Dirty Files',
    '',
    ...report.steps
      .filter((step) => step.stepId === 'report_only_dirty_scan')
      .flatMap((step) => (step.dirtyFiles?.length
        ? step.dirtyFiles.map((entry) => `- ${entry.status} ${entry.path}`)
        : ['- none'])),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code} ${item.stepId || item.scriptId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Write Integrity',
    '',
    ...(report.writeIntegrity
      ? [
        `- Status: ${report.writeIntegrity.status}`,
        `- JSON hash matches: ${report.writeIntegrity.metrics?.jsonHashMatches === true}`,
        `- JSON report files match: ${report.writeIntegrity.metrics?.jsonReportFilesMatch === true}`,
        `- Markdown hash present: ${report.writeIntegrity.metrics?.mdHashPresent === true}`,
        `- Markdown status present: ${report.writeIntegrity.metrics?.mdStatusPresent === true}`,
        `- Blockers: ${report.writeIntegrity.blockers?.length || 0}`,
      ]
      : ['- pending until latest report write/readback completes']),
    '',
    '## Safety',
    '',
    '- Local final settlement report only.',
    '- Does not run adapters, upload, submit, message, accept delivery, pay, deploy, call provider/model, fetch channel state, apply local state transition, or grant execution permission.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { __readError: error.message };
  }
}

function verifyWrittenSettlementReports(report, reportFiles) {
  const latestJson = reportFiles.latestJson;
  const latestMd = reportFiles.latestMd;
  const jsonExists = fs.existsSync(latestJson);
  const mdExists = fs.existsSync(latestMd);
  const jsonReport = jsonExists ? readJsonFile(latestJson) : null;
  const mdText = mdExists ? fs.readFileSync(latestMd, 'utf8') : '';
  const jsonParseOk = Boolean(jsonReport && !jsonReport.__readError);
  const expectedJsonPath = relativeToWorkspace(latestJson);
  const expectedMdPath = relativeToWorkspace(latestMd);
  const metrics = {
    jsonExists,
    mdExists,
    jsonParseOk,
    jsonHashMatches: jsonParseOk
      && jsonReport.finalSettlementHash === report.finalSettlementHash
      && jsonReport.hash === report.finalSettlementHash,
    jsonStatusMatches: jsonParseOk
      && jsonReport.status === report.status
      && jsonReport.ok === report.ok,
    jsonReportFilesMatch: jsonParseOk
      && jsonReport.reportFiles?.json === expectedJsonPath
      && jsonReport.reportFiles?.md === expectedMdPath,
    mdHashPresent: mdText.includes(`Hash: ${report.finalSettlementHash}`),
    mdStatusPresent: mdText.includes(`Status: ${report.status}`),
  };
  const blockers = [
    ...(!metrics.jsonExists ? [block(
      'release_final_settlement_latest_json_missing',
      `${FINAL_SETTLEMENT_JSON_FILE_ID} was not written.`,
    )] : []),
    ...(!metrics.mdExists ? [block(
      'release_final_settlement_latest_markdown_missing',
      `${FINAL_SETTLEMENT_MD_FILE_ID} was not written.`,
    )] : []),
    ...(metrics.jsonExists && !metrics.jsonParseOk ? [block(
      'release_final_settlement_latest_json_unparseable',
      `${FINAL_SETTLEMENT_JSON_FILE_ID} could not be parsed.`,
      { error: jsonReport?.__readError || null },
    )] : []),
    ...(metrics.jsonParseOk && !metrics.jsonHashMatches ? [block(
      'release_final_settlement_latest_hash_mismatch',
      `${FINAL_SETTLEMENT_JSON_FILE_ID} must echo the computed finalSettlementHash/hash.`,
      {
        expectedHash: report.finalSettlementHash,
        finalSettlementHash: jsonReport.finalSettlementHash || null,
        hash: jsonReport.hash || null,
      },
    )] : []),
    ...(metrics.jsonParseOk && !metrics.jsonStatusMatches ? [block(
      'release_final_settlement_latest_status_mismatch',
      `${FINAL_SETTLEMENT_JSON_FILE_ID} must echo the final settlement status and ok flag.`,
      {
        expectedStatus: report.status,
        actualStatus: jsonReport.status || null,
        expectedOk: report.ok,
        actualOk: jsonReport.ok,
      },
    )] : []),
    ...(metrics.jsonParseOk && !metrics.jsonReportFilesMatch ? [block(
      'release_final_settlement_latest_report_files_mismatch',
      `${FINAL_SETTLEMENT_JSON_FILE_ID} must point at its own latest JSON/Markdown files.`,
      {
        expectedJsonPath,
        expectedMdPath,
        actualJsonPath: jsonReport.reportFiles?.json || null,
        actualMdPath: jsonReport.reportFiles?.md || null,
      },
    )] : []),
    ...(metrics.mdExists && !metrics.mdHashPresent ? [block(
      'release_final_settlement_latest_markdown_hash_missing',
      `${FINAL_SETTLEMENT_MD_FILE_ID} must include the computed finalSettlementHash.`,
    )] : []),
    ...(metrics.mdExists && !metrics.mdStatusPresent ? [block(
      'release_final_settlement_latest_markdown_status_missing',
      `${FINAL_SETTLEMENT_MD_FILE_ID} must include the final settlement status.`,
    )] : []),
  ];
  return {
    status: blockers.length
      ? 'blocked_release_final_settlement_write_integrity'
      : 'pass_release_final_settlement_write_integrity',
    ok: blockers.length === 0,
    metrics,
    blockers,
  };
}

function writeSettlementReports(report) {
  return writeLatestReportPair({
    report,
    fileId: FINAL_SETTLEMENT_JSON_FILE_ID,
    markdownFileId: FINAL_SETTLEMENT_MD_FILE_ID,
    markdown: markdownFor(report),
  });
}

function writePrintAndExit(report, exitCode = 0) {
  const reportFiles = writeSettlementReports(report);
  const initialWriteIntegrity = verifyWrittenSettlementReports(report, reportFiles);
  if (!initialWriteIntegrity.ok) {
    printJson({
      ...report,
      status: 'blocked_release_final_settlement_write_integrity',
      ok: false,
      writeIntegrity: initialWriteIntegrity,
      reportFiles: {
        json: relativeToWorkspace(reportFiles.latestJson),
        md: relativeToWorkspace(reportFiles.latestMd),
      },
    });
    process.exit(1);
  }
  const reportWithWriteIntegrity = {
    ...report,
    writeIntegrity: initialWriteIntegrity,
  };
  writeSettlementReports(reportWithWriteIntegrity);
  const finalWriteIntegrity = verifyWrittenSettlementReports(reportWithWriteIntegrity, reportFiles);
  const finalReport = {
    ...report,
    writeIntegrity: finalWriteIntegrity,
  };
  writeSettlementReports(finalReport);
  printJson({
    ...finalReport,
    ok: report.ok === true && finalWriteIntegrity.ok === true,
    status: finalWriteIntegrity.ok ? report.status : 'blocked_release_final_settlement_write_integrity',
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  });
  process.exit(finalWriteIntegrity.ok ? exitCode : 1);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function usage() {
  return [
    'Usage: node src/release-final-settlement.mjs [--list|--help]',
    '',
    'Runs local final settlement proof:',
    ...SETTLEMENT_STEPS.map((step) => `  - ${step.command}`),
  ].join('\n');
}

const argSet = new Set(process.argv.slice(2));
if (argSet.has('--help')) {
  console.log(usage());
  process.exit(0);
}

const packageScripts = readPackageScripts();
if (argSet.has('--list')) {
  printJson({
    version: 1,
    kind: 'ReleaseFinalSettlementPlan',
    status: 'pass_release_final_settlement_plan',
    ok: true,
    steps: SETTLEMENT_STEPS.map((step) => ({
      stepId: step.stepId,
      scriptId: step.scriptId || null,
      command: step.command,
      packageCommand: step.scriptId ? packageScripts[step.scriptId] || null : null,
      present: step.scriptId ? Boolean(packageScripts[step.scriptId]) : true,
    })),
    safety: reportSafety(),
  });
  process.exit(0);
}

const startedAt = new Date().toISOString();
const missingScriptIds = SETTLEMENT_STEPS
  .map((step) => step.scriptId)
  .filter(Boolean)
  .filter((scriptId) => !packageScripts[scriptId]);
if (missingScriptIds.length) {
  writePrintAndExit(summarize({
    status: 'blocked_release_final_settlement',
    ok: false,
    startedAt,
    steps: [],
    blockers: missingScriptIds.map((scriptId) => block(
      'release_final_settlement_package_script_missing',
      `${scriptId} must exist in package.json scripts before final settlement can run.`,
      { scriptId },
    )),
  }), 1);
}

const completedSteps = [];
for (const step of SETTLEMENT_STEPS) {
  const runResult = step.run ? step.run(step) : runNpmStep(step);
  const validation = step.validate
    ? (runResult.ok
      ? step.validate(runResult)
      : {
        ok: false,
        hash: null,
        metrics: {
          validationSkippedBecauseCommandFailed: true,
        },
        blockers: [],
      })
    : { ok: runResult.ok, blockers: [] };
  const completedStep = summarizeStep(step, runResult, validation);
  completedSteps.push(completedStep);
  if (!completedStep.ok) {
    const blockers = completedStep.blockers.map((item) => ({ ...item, stepId: completedStep.stepId }));
    writePrintAndExit(summarize({
      status: 'blocked_release_final_settlement',
      ok: false,
      startedAt,
      steps: completedSteps,
      blockers,
    }), completedStep.exitCode || 1);
  }
}

writePrintAndExit(summarize({
  status: 'pass_release_final_settlement',
  ok: true,
  startedAt,
  steps: completedSteps,
  blockers: [],
}));
