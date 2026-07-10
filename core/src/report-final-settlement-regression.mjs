import { digest } from './hash-utils.mjs';
import {
  extractIntegrationGateStepSpecs,
} from './integration-gate-sequence-regression.mjs';
import {
  REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS,
} from './report-bootstrap-seed-regression.mjs';
import {
  POST_ACTION_RUNTIME_STATUS_STAGES,
} from './post-action-runtime-status.mjs';

export const REPORT_FINAL_SETTLEMENT_REGRESSION_VERSION = 1;

export const REPORT_FINAL_SETTLEMENT_REGRESSION_REPORT_FILE_ID = 'report-final-settlement-regression-latest.json';

export const REPORT_FINAL_SETTLEMENT_REGRESSION_SCRIPT_ID = 'reports:final-settlement-regression';

const FINAL_SETTLEMENT_STEP_ID = 'report_final_settlement_regression_export';
const RELEASE_FINAL_SETTLEMENT_JSON_FILE_ID = 'release-final-settlement-latest.json';
const RELEASE_FINAL_SETTLEMENT_MD_FILE_ID = 'release-final-settlement-latest.md';
const EXPECTED_POST_ACTION_RUNTIME_STATUS_REQUIRED_SUMMARY_METRICS = POST_ACTION_RUNTIME_STATUS_STAGES
  .reduce((sum, stage) => sum + stage.requiredSummaryMetrics.length, 0);
const EXPECTED_READ_ONLY_DISPATCH_METRIC_COUNT = 9;

const EXPECTED_SETTLEMENT_STAGE_IDS = Object.freeze([
  'final_gate_strict',
  'report_retention_dry_run',
  'final_report_freshness_strict',
  'architecture_checkpoint_strict',
  'bootstrap_seed_clean_strict',
  'active_seed_marker_scan',
  'placeholder_token_scan',
  'diff_whitespace_check',
  'report_only_dirty_scan',
]);

const REQUIRED_PACKAGE_SCRIPTS = Object.freeze({
  [REPORT_FINAL_SETTLEMENT_REGRESSION_SCRIPT_ID]: 'node src/export-report-final-settlement-regression.mjs --strict',
  'gate:integration:strict': 'node src/integration-dependency-gate.mjs --strict',
  'reports:prune:dry-run': 'node src/prune-reports.mjs --dry-run',
  'reports:freshness': 'node src/export-report-freshness.mjs --strict',
  'checkpoint:architecture': 'node src/export-architecture-checkpoint.mjs --strict',
  'reports:bootstrap-seeds': 'node src/export-report-bootstrap-seeds.mjs',
});

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'missing_final_settlement_gate_step',
    label: 'The final settlement regression gate step is missing',
    expectedBlockerCode: 'report_final_settlement_gate_step_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps
        .filter((step) => step.stepId !== FINAL_SETTLEMENT_STEP_ID);
    },
  }),
  Object.freeze({
    scenarioId: 'final_settlement_gate_step_without_strict',
    label: 'The final settlement regression gate step loses strict mode',
    expectedBlockerCode: 'report_final_settlement_gate_step_arg_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps.map((step) => (step.stepId === FINAL_SETTLEMENT_STEP_ID
        ? { ...step, args: step.args.filter((arg) => arg !== '--strict') }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'final_settlement_gate_step_without_parse_json',
    label: 'The final settlement regression gate step stops parsing JSON stdout',
    expectedBlockerCode: 'report_final_settlement_gate_step_parse_json_missing',
    mutate(input) {
      input.sourceSteps = input.sourceSteps.map((step) => (step.stepId === FINAL_SETTLEMENT_STEP_ID
        ? { ...step, parseJsonOutput: false }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'final_settlement_after_runner_contract',
    label: 'The final settlement guard moves after runner contract validation',
    expectedBlockerCode: 'report_final_settlement_order_drift',
    mutate(input) {
      input.sourceSteps = moveStepAfter(input.sourceSteps, FINAL_SETTLEMENT_STEP_ID, 'report_runner_contract_regression_export');
    },
  }),
  Object.freeze({
    scenarioId: 'clean_idempotence_after_final_settlement',
    label: 'The clean gate idempotence guard moves after final settlement validation',
    expectedBlockerCode: 'report_final_settlement_order_drift',
    mutate(input) {
      input.sourceSteps = moveStepAfter(input.sourceSteps, 'report_clean_gate_idempotence_regression_export', FINAL_SETTLEMENT_STEP_ID);
    },
  }),
  Object.freeze({
    scenarioId: 'mapped_report_after_final_gate',
    label: 'A mapped latest report is written after the final gate snapshot',
    expectedBlockerCode: 'report_final_settlement_mapped_report_after_final_gate',
    mutate(input) {
      input.settlement.mappedReportWritesAfterFinalGate.push({
        fileId: 'report-output-pairing-latest.json',
        stageId: 'post_final_gate_noise',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'failed_command_validation_reads_stale_latest',
    label: 'A failed settlement command still validates stale latest report files',
    expectedBlockerCode: 'report_final_settlement_failed_command_validation_not_skipped',
    mutate(input) {
      input.releaseSource.validationSkipsAfterFailedCommand = false;
      input.releaseSource.failedCommandCanValidateStaleLatest = true;
    },
  }),
  Object.freeze({
    scenarioId: 'final_settlement_semantic_hash_alias_fallback',
    label: 'Final settlement validators accept generic hashes after semantic aliases are stripped',
    expectedBlockerCode: 'report_final_settlement_semantic_hash_alias_fallback',
    mutate(input) {
      input.releaseSource.semanticHashFallbacks = [
        { patternId: 'gateHash_generic_fallback' },
      ];
      input.releaseSource.semanticHashFallbackCount = 1;
    },
  }),
  Object.freeze({
    scenarioId: 'final_freshness_before_final_gate',
    label: 'Final report freshness runs before the final gate',
    expectedBlockerCode: 'report_final_settlement_stage_order_drift',
    mutate(input) {
      input.settlement.stages = moveStageBefore(input.settlement.stages, 'final_report_freshness_strict', 'final_gate_strict');
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_before_final_freshness',
    label: 'Architecture checkpoint runs before final report freshness',
    expectedBlockerCode: 'report_final_settlement_stage_order_drift',
    mutate(input) {
      input.settlement.stages = moveStageBefore(input.settlement.stages, 'architecture_checkpoint_strict', 'final_report_freshness_strict');
    },
  }),
  Object.freeze({
    scenarioId: 'final_freshness_gate_hash_mismatch',
    label: 'Final report freshness does not bind the final gate hash',
    expectedBlockerCode: 'report_final_settlement_freshness_gate_hash_mismatch',
    mutate(input) {
      stageById(input.settlement.stages).final_report_freshness_strict.gateHash = hashFor('wrong_gate_hash');
      stageById(input.settlement.stages).final_report_freshness_strict.gateHashMismatchCount = 1;
    },
  }),
  Object.freeze({
    scenarioId: 'final_gate_hash_missing_after_settlement',
    label: 'The final strict gate step loses its stable gate hash binding',
    expectedBlockerCode: 'report_final_settlement_final_gate_hash_missing',
    mutate(input) {
      stageById(input.settlement.stages).final_gate_strict.hash = null;
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_freshness_hash_mismatch',
    label: 'Architecture checkpoint binds a stale report freshness hash',
    expectedBlockerCode: 'report_final_settlement_checkpoint_freshness_hash_mismatch',
    mutate(input) {
      stageById(input.settlement.stages).architecture_checkpoint_strict.reportFreshnessHash = hashFor('stale_freshness_hash');
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_post_action_runtime_status_required_metrics_missing',
    label: 'Architecture checkpoint no longer proves post-action runtime status required metrics',
    expectedBlockerCode: 'report_final_settlement_post_action_runtime_status_required_metrics_missing',
    mutate(input) {
      const checkpoint = stageById(input.settlement.stages).architecture_checkpoint_strict;
      checkpoint.postActionRuntimeStatusRequiredSummaryMetricsOk = false;
      checkpoint.postActionRuntimeStatusRequiredSummaryMetricOk = EXPECTED_POST_ACTION_RUNTIME_STATUS_REQUIRED_SUMMARY_METRICS - 1;
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_read_only_dispatch_metrics_missing',
    label: 'Architecture checkpoint no longer proves read-only dispatch handoff metrics',
    expectedBlockerCode: 'report_final_settlement_read_only_dispatch_metrics_missing',
    mutate(input) {
      const checkpoint = stageById(input.settlement.stages).architecture_checkpoint_strict;
      checkpoint.readOnlyReportChainDispatchMetricsOk = false;
      checkpoint.readOnlyReportChainDispatchMetrics = EXPECTED_READ_ONLY_DISPATCH_METRIC_COUNT - 1;
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_read_only_dispatch_approval_provenance_mismatch',
    label: 'Architecture checkpoint loses read-only dispatch approval provenance coverage',
    expectedBlockerCode: 'report_final_settlement_read_only_dispatch_metrics_missing',
    mutate(input) {
      const checkpoint = stageById(input.settlement.stages).architecture_checkpoint_strict;
      checkpoint.readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs = checkpoint.readOnlyReportChainDispatchTotalHandoffs - 1;
    },
  }),
  Object.freeze({
    scenarioId: 'bootstrap_seed_written_after_settlement',
    label: 'Clean bootstrap seed check writes a seed after final settlement',
    expectedBlockerCode: 'report_final_settlement_seed_written_after_settlement',
    mutate(input) {
      stageById(input.settlement.stages).bootstrap_seed_clean_strict.seededFileCount = 1;
    },
  }),
  Object.freeze({
    scenarioId: 'retention_not_ok',
    label: 'The closeout retention dry-run report is not ok',
    expectedBlockerCode: 'report_final_settlement_retention_not_ok',
    mutate(input) {
      stageById(input.settlement.stages).report_retention_dry_run.ok = false;
    },
  }),
  Object.freeze({
    scenarioId: 'retention_not_dry_run',
    label: 'The closeout retention check is not dry-run',
    expectedBlockerCode: 'report_final_settlement_retention_not_dry_run',
    mutate(input) {
      stageById(input.settlement.stages).report_retention_dry_run.dryRun = false;
    },
  }),
  Object.freeze({
    scenarioId: 'retention_archive_candidates_after_settlement',
    label: 'The closeout retention dry-run still has archive candidates',
    expectedBlockerCode: 'report_final_settlement_retention_archive_candidates',
    mutate(input) {
      stageById(input.settlement.stages).report_retention_dry_run.archivedCount = 1;
    },
  }),
  Object.freeze({
    scenarioId: 'bootstrap_seed_script_missing',
    label: 'The package loses the bootstrap seed recovery script',
    expectedBlockerCode: 'report_final_settlement_package_script_missing',
    mutate(input) {
      delete input.packageScripts['reports:bootstrap-seeds'];
    },
  }),
  Object.freeze({
    scenarioId: 'active_seed_marker_after_settlement',
    label: 'The final active seed marker scan finds an active seed marker',
    expectedBlockerCode: 'report_final_settlement_active_seed_marker_leak',
    mutate(input) {
      stageById(input.settlement.stages).active_seed_marker_scan.activeBootstrapSeedReports = 1;
    },
  }),
  Object.freeze({
    scenarioId: 'placeholder_token_after_settlement',
    label: 'The final placeholder scan finds a real placeholder token',
    expectedBlockerCode: 'report_final_settlement_placeholder_tokens_present',
    mutate(input) {
      stageById(input.settlement.stages).placeholder_token_scan.placeholderTokenMatches = 1;
    },
  }),
  Object.freeze({
    scenarioId: 'diff_whitespace_after_settlement',
    label: 'The final diff whitespace check fails',
    expectedBlockerCode: 'report_final_settlement_diff_check_not_clean',
    mutate(input) {
      stageById(input.settlement.stages).diff_whitespace_check.diffClean = false;
    },
  }),
  Object.freeze({
    scenarioId: 'non_report_dirty_after_settlement',
    label: 'The final dirty scan finds source or docs drift after settlement',
    expectedBlockerCode: 'report_final_settlement_non_report_dirty_files',
    mutate(input) {
      stageById(input.settlement.stages).report_only_dirty_scan.nonReportDirtyFileCount = 1;
    },
  }),
  Object.freeze({
    scenarioId: 'non_latest_report_dirty_after_settlement',
    label: 'The final dirty scan finds non-latest report scratch drift after settlement',
    expectedBlockerCode: 'report_final_settlement_non_latest_report_dirty_files',
    mutate(input) {
      stageById(input.settlement.stages).report_only_dirty_scan.nonLatestReportDirtyFileCount = 1;
    },
  }),
  Object.freeze({
    scenarioId: 'latest_report_json_missing_after_settlement',
    label: 'The final settlement latest JSON report is missing after settlement',
    expectedBlockerCode: 'report_final_settlement_latest_report_missing',
    mutate(input) {
      input.settlement.latestReport.jsonExists = false;
    },
  }),
  Object.freeze({
    scenarioId: 'latest_report_hash_mismatch_after_settlement',
    label: 'The final settlement latest JSON report no longer echoes its stable hash',
    expectedBlockerCode: 'report_final_settlement_latest_report_hash_mismatch',
    mutate(input) {
      input.settlement.latestReport.hash = hashFor('tampered_release_final_settlement_latest');
    },
  }),
  Object.freeze({
    scenarioId: 'latest_report_markdown_hash_missing_after_settlement',
    label: 'The final settlement latest Markdown report loses the final hash binding',
    expectedBlockerCode: 'report_final_settlement_latest_report_markdown_binding_missing',
    mutate(input) {
      input.settlement.latestReport.markdownHashPresent = false;
    },
  }),
  Object.freeze({
    scenarioId: 'latest_report_write_integrity_not_ok_after_settlement',
    label: 'The final settlement latest report write/readback integrity is not ok',
    expectedBlockerCode: 'report_final_settlement_latest_report_write_integrity_not_ok',
    mutate(input) {
      input.settlement.latestReport.writeIntegrityOk = false;
    },
  }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function hashFor(value) {
  return digest({
    fixture: 'report_final_settlement_regression',
    value,
  });
}

function isSha256(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value || ''));
}

function reportSafety(extra = {}) {
  return {
    localOnly: true,
    readOnly: true,
    syntheticFixtureOnly: true,
    sourceInspectionOnly: true,
    mutatesReportFiles: false,
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
    ...extra,
  };
}

function stageById(stages = []) {
  return Object.fromEntries(stages.map((stage) => [stage.stageId, stage]));
}

function sourceStepIndex(sourceSteps = [], stepId) {
  return sourceSteps.findIndex((step) => step.stepId === stepId);
}

function stageIndex(stages = [], stageId) {
  return stages.findIndex((stage) => stage.stageId === stageId);
}

function moveStepAfter(steps, movingStepId, anchorStepId) {
  const moving = steps.find((step) => step.stepId === movingStepId);
  if (!moving) return steps;
  const withoutMoving = steps.filter((step) => step.stepId !== movingStepId);
  const anchorIndex = withoutMoving.findIndex((step) => step.stepId === anchorStepId);
  if (anchorIndex < 0) return withoutMoving;
  return [
    ...withoutMoving.slice(0, anchorIndex + 1),
    moving,
    ...withoutMoving.slice(anchorIndex + 1),
  ];
}

function moveStageBefore(stages, movingStageId, anchorStageId) {
  const moving = stages.find((stage) => stage.stageId === movingStageId);
  if (!moving) return stages;
  const withoutMoving = stages.filter((stage) => stage.stageId !== movingStageId);
  const anchorIndex = withoutMoving.findIndex((stage) => stage.stageId === anchorStageId);
  if (anchorIndex < 0) return withoutMoving;
  return [
    ...withoutMoving.slice(0, anchorIndex),
    moving,
    ...withoutMoving.slice(anchorIndex),
  ];
}

function ensureSourceOrder(sourceSteps, beforeStepId, afterStepId, blockers) {
  const beforeIndex = sourceStepIndex(sourceSteps, beforeStepId);
  const afterIndex = sourceStepIndex(sourceSteps, afterStepId);
  if (beforeIndex < 0 || afterIndex < 0) return;
  if (beforeIndex > afterIndex) {
    blockers.push(blocker(
      'report_final_settlement_order_drift',
      `${beforeStepId} must run before ${afterStepId}.`,
      { beforeStepId, afterStepId },
    ));
  }
}

function ensureStageOrder(stages, beforeStageId, afterStageId, blockers) {
  const beforeIndex = stageIndex(stages, beforeStageId);
  const afterIndex = stageIndex(stages, afterStageId);
  if (beforeIndex < 0 || afterIndex < 0) return;
  if (beforeIndex > afterIndex) {
    blockers.push(blocker(
      'report_final_settlement_stage_order_drift',
      `${beforeStageId} must run before ${afterStageId}.`,
      { beforeStageId, afterStageId },
    ));
  }
}

function buildSettlementFixture() {
  const finalGateHash = hashFor('final_gate_strict');
  const finalFreshnessHash = hashFor('final_report_freshness_strict');
  const releaseFinalSettlementHash = hashFor('release_final_settlement_latest');
  return {
    stages: [
      {
        stageId: 'final_gate_strict',
        label: 'Run final strict integration gate',
        ok: true,
        command: 'npm run gate:integration:strict',
        fileId: 'integration-dependency-gate-latest.json',
        hash: finalGateHash,
      },
      {
        stageId: 'report_retention_dry_run',
        label: 'Run closeout retention dry-run',
        ok: true,
        dryRun: true,
        command: 'npm run reports:prune:dry-run',
        archivedCount: 0,
        hash: hashFor('report_retention_dry_run'),
      },
      {
        stageId: 'final_report_freshness_strict',
        label: 'Run final report freshness with gate binding',
        ok: true,
        command: 'npm run reports:freshness',
        includeGateReport: true,
        gateHash: finalGateHash,
        gateHashMismatchCount: 0,
        gateHashMatchCount: 31,
        hash: finalFreshnessHash,
      },
      {
        stageId: 'architecture_checkpoint_strict',
        label: 'Run architecture checkpoint after final freshness',
        ok: true,
        command: 'npm run checkpoint:architecture',
        reportFreshnessHash: finalFreshnessHash,
        postActionRuntimeStatusRequiredSummaryMetrics: EXPECTED_POST_ACTION_RUNTIME_STATUS_REQUIRED_SUMMARY_METRICS,
        postActionRuntimeStatusRequiredSummaryMetricOk: EXPECTED_POST_ACTION_RUNTIME_STATUS_REQUIRED_SUMMARY_METRICS,
        postActionRuntimeStatusRequiredSummaryMetricsOk: true,
        readOnlyReportChainDispatchMetrics: EXPECTED_READ_ONLY_DISPATCH_METRIC_COUNT,
        readOnlyReportChainExpectedDispatchMetrics: EXPECTED_READ_ONLY_DISPATCH_METRIC_COUNT,
        readOnlyReportChainDispatchMetricsOk: true,
        readOnlyReportChainDispatchTotalHandoffs: 7,
        readOnlyReportChainDispatchReadyHandoffs: 2,
        readOnlyReportChainDispatchBlockedHandoffs: 5,
        readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs: 7,
        hash: hashFor('architecture_checkpoint_strict'),
      },
      {
        stageId: 'bootstrap_seed_clean_strict',
        label: 'Run clean bootstrap seed check',
        ok: true,
        strict: true,
        command: 'npm run reports:bootstrap-seeds -- --strict',
        seededFileCount: 0,
        skippedFileCount: REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.length,
        hash: hashFor('bootstrap_seed_clean_strict'),
      },
      {
        stageId: 'active_seed_marker_scan',
        label: 'Scan final latest reports for active bootstrap seed markers',
        ok: true,
        command: 'scan allowlisted latest reports for active bootstrap seeds',
        activeBootstrapSeedReports: 0,
        hash: hashFor('active_seed_marker_scan'),
      },
      {
        stageId: 'placeholder_token_scan',
        label: 'Scan docs, reports README, source, and package metadata for placeholder tokens',
        ok: true,
        command: 'rg placeholder tokens in docs, reports README, src, and package.json',
        placeholderTokenMatches: 0,
        hash: hashFor('placeholder_token_scan'),
      },
      {
        stageId: 'diff_whitespace_check',
        label: 'Run final local diff whitespace check',
        ok: true,
        command: 'git diff --check -- .',
        diffClean: true,
        hash: hashFor('diff_whitespace_check'),
      },
      {
        stageId: 'report_only_dirty_scan',
        label: 'Verify any remaining local drift is limited to report outputs',
        ok: true,
        command: 'git status --short -- .',
        dirtyFileCount: 8,
        reportDirtyFileCount: 8,
        allowedReportDirtyFileCount: 8,
        nonLatestReportDirtyFileCount: 0,
        nonReportDirtyFileCount: 0,
        hash: hashFor('report_only_dirty_scan'),
      },
    ],
    mappedReportWritesAfterFinalGate: [],
    finalBootstrapMarkerLeakCount: 0,
    latestReport: {
      fileId: RELEASE_FINAL_SETTLEMENT_JSON_FILE_ID,
      mdFileId: RELEASE_FINAL_SETTLEMENT_MD_FILE_ID,
      jsonExists: true,
      mdExists: true,
      ok: true,
      status: 'pass_release_final_settlement',
      hash: releaseFinalSettlementHash,
      finalSettlementHash: releaseFinalSettlementHash,
      reportFilesJsonMatches: true,
      reportFilesMarkdownMatches: true,
      markdownHashPresent: true,
      markdownStatusPresent: true,
      writeIntegrityOk: true,
    },
  };
}

function analyzeReleaseFinalSettlementSource(sourceText = '') {
  const text = String(sourceText || '');
  const validationSkipsAfterFailedCommand = text.includes('runResult.ok')
    && text.includes('validationSkippedBecauseCommandFailed')
    && /runResult\.ok\s*\?\s*step\.validate\(runResult\)/.test(text);
  const failedCommandCanValidateStaleLatest = /const\s+validation\s*=\s*step\.validate\s*\?\s*step\.validate\(runResult\)\s*:/.test(text);
  const semanticHashFallbackPatterns = [
    ['gateHash_generic_fallback', /gate\.gateHash\s*\|\|\s*gate\.hash/],
    ['retentionHash_generic_fallback', /report\.retentionHash\s*\|\|\s*report\.hash/],
    ['freshnessHash_generic_fallback', /report\.freshnessHash\s*\|\|\s*report\.hash/],
    ['checkpointHash_generic_fallback', /checkpoint\.checkpointHash\s*\|\|\s*checkpoint\.hash/],
    ['checkpoint_freshnessHash_generic_fallback', /freshness\.freshnessHash\s*\|\|\s*freshness\.hash/],
    ['semantic_report_hash_generic_tail_fallback', /\|\|\s*report\.hash/],
    ['generic_hash_precedes_semantic_hash', /report\.hash\s*\|\|\s*report\.gateHash/],
  ];
  const semanticHashFallbacks = semanticHashFallbackPatterns.flatMap(([patternId, pattern]) => (
    pattern.test(text) ? [{ patternId }] : []
  ));
  return {
    validationSkipsAfterFailedCommand,
    failedCommandCanValidateStaleLatest,
    semanticHashFallbackCount: semanticHashFallbacks.length,
    semanticHashFallbacks,
  };
}

function buildActualInput({
  gateSourceText = '',
  releaseSourceText = '',
  packageScripts = {},
} = {}) {
  return {
    sourceSteps: extractIntegrationGateStepSpecs(gateSourceText),
    releaseSource: analyzeReleaseFinalSettlementSource(releaseSourceText),
    packageScripts: { ...(packageScripts || {}) },
    settlement: buildSettlementFixture(),
  };
}

function analyzeInput(input = {}) {
  const blockers = [];
  const sourceSteps = input.sourceSteps || [];
  const releaseSource = input.releaseSource || {};
  const stages = input.settlement?.stages || [];
  const stagesById = stageById(stages);
  const finalGate = stagesById.final_gate_strict || null;
  const finalFreshness = stagesById.final_report_freshness_strict || null;
  const checkpoint = stagesById.architecture_checkpoint_strict || null;
  const cleanSeedCheck = stagesById.bootstrap_seed_clean_strict || null;
  const activeSeedScan = stagesById.active_seed_marker_scan || null;
  const placeholderScan = stagesById.placeholder_token_scan || null;
  const diffCheck = stagesById.diff_whitespace_check || null;
  const reportOnlyDirtyScan = stagesById.report_only_dirty_scan || null;
  const retention = stagesById.report_retention_dry_run || null;
  const latestReport = input.settlement?.latestReport || null;

  for (const [scriptId, expectedCommand] of Object.entries(REQUIRED_PACKAGE_SCRIPTS)) {
    const actualCommand = input.packageScripts?.[scriptId] || null;
    if (!actualCommand) {
      blockers.push(blocker(
        'report_final_settlement_package_script_missing',
        `${scriptId} must be present before final settlement can be replayed.`,
        { scriptId },
      ));
    } else if (actualCommand !== expectedCommand) {
      blockers.push(blocker(
        'report_final_settlement_package_script_command_drift',
        `${scriptId} must run ${expectedCommand}.`,
        { scriptId, expectedCommand, actualCommand },
      ));
    }
  }

  for (const stageId of EXPECTED_SETTLEMENT_STAGE_IDS) {
    if (!stagesById[stageId]) {
      blockers.push(blocker(
        'report_final_settlement_stage_missing',
        `${stageId} is required in the final settlement sequence.`,
        { stageId },
      ));
    }
  }

  for (let index = 1; index < EXPECTED_SETTLEMENT_STAGE_IDS.length; index += 1) {
    ensureStageOrder(stages, EXPECTED_SETTLEMENT_STAGE_IDS[index - 1], EXPECTED_SETTLEMENT_STAGE_IDS[index], blockers);
  }

  const finalSettlementStep = sourceSteps.find((step) => step.stepId === FINAL_SETTLEMENT_STEP_ID);
  if (!finalSettlementStep) {
    blockers.push(blocker(
      'report_final_settlement_gate_step_missing',
      `Integration gate must run ${FINAL_SETTLEMENT_STEP_ID}.`,
      { stepId: FINAL_SETTLEMENT_STEP_ID },
    ));
  } else {
    for (const arg of ['src/export-report-final-settlement-regression.mjs', '--strict']) {
      if (!finalSettlementStep.args.includes(arg)) {
        blockers.push(blocker(
          'report_final_settlement_gate_step_arg_missing',
          `${FINAL_SETTLEMENT_STEP_ID} must include ${arg}.`,
          { stepId: FINAL_SETTLEMENT_STEP_ID, arg },
        ));
      }
    }
    if (finalSettlementStep.parseJsonOutput !== true) {
      blockers.push(blocker(
        'report_final_settlement_gate_step_parse_json_missing',
        `${FINAL_SETTLEMENT_STEP_ID} must parse JSON output.`,
        { stepId: FINAL_SETTLEMENT_STEP_ID },
      ));
    }
  }

  ensureSourceOrder(sourceSteps, 'report_clean_gate_idempotence_regression_export', FINAL_SETTLEMENT_STEP_ID, blockers);
  ensureSourceOrder(sourceSteps, FINAL_SETTLEMENT_STEP_ID, 'report_runner_contract_regression_export', blockers);
  ensureSourceOrder(sourceSteps, FINAL_SETTLEMENT_STEP_ID, 'report_freshness_export_pre_tooling', blockers);

  if (releaseSource.validationSkipsAfterFailedCommand !== true) {
    blockers.push(blocker(
      'report_final_settlement_failed_command_validation_not_skipped',
      'Final settlement must not validate latest report files after the settlement command has already failed.',
    ));
  }
  if (releaseSource.failedCommandCanValidateStaleLatest === true) {
    blockers.push(blocker(
      'report_final_settlement_failed_command_stale_validation_possible',
      'A failed settlement command must not read stale latest reports and attach their hashes to the failed step.',
    ));
  }
  if (Number(releaseSource.semanticHashFallbackCount || 0) !== 0) {
    blockers.push(blocker(
      'report_final_settlement_semantic_hash_alias_fallback',
      'Final settlement validators must require semantic hash aliases and may not fall back to generic hash values.',
      {
        fallbackCount: Number(releaseSource.semanticHashFallbackCount || 0),
        fallbackPatternIds: (releaseSource.semanticHashFallbacks || [])
          .map((item) => item.patternId)
          .filter(Boolean),
      },
    ));
  }

  if (retention) {
    if (retention.ok !== true) {
      blockers.push(blocker(
        'report_final_settlement_retention_not_ok',
        'Closeout retention dry-run must pass in the final settlement proof.',
        { stageId: retention.stageId },
      ));
    }
    if (retention.dryRun !== true) {
      blockers.push(blocker(
        'report_final_settlement_retention_not_dry_run',
        'Closeout retention must be dry-run in the final settlement proof.',
        { stageId: retention.stageId },
      ));
    }
    if (Number(retention.archivedCount || 0) !== 0) {
      blockers.push(blocker(
        'report_final_settlement_retention_archive_candidates',
        'Closeout retention dry-run must report archivedCount=0 before final settlement passes.',
        {
          stageId: retention.stageId,
          archivedCount: Number(retention.archivedCount || 0),
        },
      ));
    }
  }

  if (finalGate && finalGate.ok !== true) {
    blockers.push(blocker(
      'report_final_settlement_final_gate_not_ok',
      'Final strict integration gate must pass before settlement can continue.',
      { stageId: finalGate.stageId },
    ));
  }
  if (finalGate && !isSha256(finalGate.hash)) {
    blockers.push(blocker(
      'report_final_settlement_final_gate_hash_missing',
      'Final strict integration gate step must expose a stable sha256 gate hash.',
      { stageId: finalGate.stageId, gateHash: finalGate.hash || null },
    ));
  }

  if (finalFreshness) {
    if (finalFreshness.ok !== true || finalFreshness.includeGateReport !== true) {
      blockers.push(blocker(
        'report_final_settlement_final_freshness_not_final_mode',
        'Final report freshness must pass with includeGateReport=true.',
        { stageId: finalFreshness.stageId },
      ));
    }
    if (!finalGate?.hash || finalFreshness.gateHash !== finalGate.hash || finalFreshness.gateHashMismatchCount !== 0) {
      blockers.push(blocker(
        'report_final_settlement_freshness_gate_hash_mismatch',
        'Final report freshness must bind the final integration gate hash with zero mismatches.',
        { expectedGateHash: finalGate?.hash || null, actualGateHash: finalFreshness.gateHash || null },
      ));
    }
  }

  if (checkpoint && finalFreshness) {
    if (checkpoint.ok !== true) {
      blockers.push(blocker(
        'report_final_settlement_checkpoint_not_ok',
        'Architecture checkpoint must pass after final freshness.',
        { stageId: checkpoint.stageId },
      ));
    }
    if (checkpoint.reportFreshnessHash !== finalFreshness.hash) {
      blockers.push(blocker(
        'report_final_settlement_checkpoint_freshness_hash_mismatch',
        'Architecture checkpoint must bind the final report freshness hash.',
        {
          expectedFreshnessHash: finalFreshness.hash || null,
          actualFreshnessHash: checkpoint.reportFreshnessHash || null,
        },
      ));
    }
    if (
      checkpoint.postActionRuntimeStatusRequiredSummaryMetricsOk !== true
      || Number(checkpoint.postActionRuntimeStatusRequiredSummaryMetrics || 0) !== EXPECTED_POST_ACTION_RUNTIME_STATUS_REQUIRED_SUMMARY_METRICS
      || Number(checkpoint.postActionRuntimeStatusRequiredSummaryMetricOk || 0) !== EXPECTED_POST_ACTION_RUNTIME_STATUS_REQUIRED_SUMMARY_METRICS
    ) {
      blockers.push(blocker(
        'report_final_settlement_post_action_runtime_status_required_metrics_missing',
        'Final settlement checkpoint must prove every post-action runtime required summary metric, including packageRole and human-feedback packageRole coverage.',
        {
          expectedRequiredSummaryMetricCount: EXPECTED_POST_ACTION_RUNTIME_STATUS_REQUIRED_SUMMARY_METRICS,
          postActionRuntimeStatusRequiredSummaryMetrics: Number(checkpoint.postActionRuntimeStatusRequiredSummaryMetrics || 0),
          postActionRuntimeStatusRequiredSummaryMetricOk: Number(checkpoint.postActionRuntimeStatusRequiredSummaryMetricOk || 0),
          postActionRuntimeStatusRequiredSummaryMetricsOk: checkpoint.postActionRuntimeStatusRequiredSummaryMetricsOk === true,
        },
      ));
    }
    if (
      checkpoint.readOnlyReportChainDispatchMetricsOk !== true
      || Number(checkpoint.readOnlyReportChainDispatchMetrics || 0) !== EXPECTED_READ_ONLY_DISPATCH_METRIC_COUNT
      || Number(checkpoint.readOnlyReportChainExpectedDispatchMetrics || 0) !== EXPECTED_READ_ONLY_DISPATCH_METRIC_COUNT
      || Number(checkpoint.readOnlyReportChainDispatchTotalHandoffs || 0)
        !== Number(checkpoint.readOnlyReportChainDispatchReadyHandoffs || 0)
          + Number(checkpoint.readOnlyReportChainDispatchBlockedHandoffs || 0)
      || Number(checkpoint.readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs || 0)
        !== Number(checkpoint.readOnlyReportChainDispatchTotalHandoffs || 0)
    ) {
      blockers.push(blocker(
        'report_final_settlement_read_only_dispatch_metrics_missing',
        'Final settlement checkpoint must prove read-only archive closeout dispatch handoff metrics, including ready/blocked human-feedback handoffs.',
        {
          expectedReadOnlyDispatchMetricCount: EXPECTED_READ_ONLY_DISPATCH_METRIC_COUNT,
          readOnlyReportChainDispatchMetrics: Number(checkpoint.readOnlyReportChainDispatchMetrics || 0),
          readOnlyReportChainExpectedDispatchMetrics: Number(checkpoint.readOnlyReportChainExpectedDispatchMetrics || 0),
          readOnlyReportChainDispatchMetricsOk: checkpoint.readOnlyReportChainDispatchMetricsOk === true,
          readOnlyReportChainDispatchTotalHandoffs: Number(checkpoint.readOnlyReportChainDispatchTotalHandoffs || 0),
          readOnlyReportChainDispatchReadyHandoffs: Number(checkpoint.readOnlyReportChainDispatchReadyHandoffs || 0),
          readOnlyReportChainDispatchBlockedHandoffs: Number(checkpoint.readOnlyReportChainDispatchBlockedHandoffs || 0),
          readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs: Number(checkpoint.readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs || 0),
        },
      ));
    }
  }

  if (cleanSeedCheck) {
    if (cleanSeedCheck.strict !== true) {
      blockers.push(blocker(
        'report_final_settlement_seed_check_not_strict',
        'The final clean bootstrap seed check must run strict.',
        { stageId: cleanSeedCheck.stageId },
      ));
    }
    if (Number(cleanSeedCheck.seededFileCount || 0) !== 0) {
      blockers.push(blocker(
        'report_final_settlement_seed_written_after_settlement',
        'Clean settlement must not write bootstrap seeds after final freshness/checkpoint.',
        { seededFileCount: Number(cleanSeedCheck.seededFileCount || 0) },
      ));
    }
    if (Number(cleanSeedCheck.skippedFileCount || 0) !== REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.length) {
      blockers.push(blocker(
        'report_final_settlement_seed_skip_count_mismatch',
        'Clean settlement must skip every allowlisted bootstrap seed file.',
        {
          skippedFileCount: Number(cleanSeedCheck.skippedFileCount || 0),
          expectedSkippedFileCount: REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS.length,
        },
      ));
    }
  }

  if (activeSeedScan) {
    if (activeSeedScan.ok !== true || Number(activeSeedScan.activeBootstrapSeedReports || 0) !== 0) {
      blockers.push(blocker(
        'report_final_settlement_active_seed_marker_leak',
        'Final settlement must leave zero active bootstrap seed markers in latest reports.',
        {
          activeBootstrapSeedReports: Number(activeSeedScan.activeBootstrapSeedReports || 0),
          stageId: activeSeedScan.stageId,
        },
      ));
    }
  }

  if (placeholderScan) {
    if (placeholderScan.ok !== true || Number(placeholderScan.placeholderTokenMatches || 0) !== 0) {
      blockers.push(blocker(
        'report_final_settlement_placeholder_tokens_present',
        'Final settlement placeholder scan must find zero real placeholder tokens.',
        {
          placeholderTokenMatches: Number(placeholderScan.placeholderTokenMatches || 0),
          stageId: placeholderScan.stageId,
        },
      ));
    }
  }

  if (diffCheck) {
    if (diffCheck.ok !== true || diffCheck.diffClean !== true) {
      blockers.push(blocker(
        'report_final_settlement_diff_check_not_clean',
        'Final settlement diff whitespace check must pass after all local writes.',
        { stageId: diffCheck.stageId },
      ));
    }
  }

  if (reportOnlyDirtyScan) {
    if (reportOnlyDirtyScan.ok !== true || Number(reportOnlyDirtyScan.nonReportDirtyFileCount || 0) !== 0) {
      blockers.push(blocker(
        'report_final_settlement_non_report_dirty_files',
        'Final settlement may leave report outputs dirty, but source/docs/package/fixture drift must be closed before settlement passes.',
        {
          nonReportDirtyFileCount: Number(reportOnlyDirtyScan.nonReportDirtyFileCount || 0),
          stageId: reportOnlyDirtyScan.stageId,
        },
      ));
    }
    if (Number(reportOnlyDirtyScan.nonLatestReportDirtyFileCount || 0) !== 0) {
      blockers.push(blocker(
        'report_final_settlement_non_latest_report_dirty_files',
        'Final settlement may leave latest report outputs dirty, but timestamped or scratch report drift must be closed before settlement passes.',
        {
          nonLatestReportDirtyFileCount: Number(reportOnlyDirtyScan.nonLatestReportDirtyFileCount || 0),
          stageId: reportOnlyDirtyScan.stageId,
        },
      ));
    }
  }

  for (const write of input.settlement?.mappedReportWritesAfterFinalGate || []) {
    blockers.push(blocker(
      'report_final_settlement_mapped_report_after_final_gate',
      `${write.fileId || 'unknown report'} was written after the final gate snapshot.`,
      { fileId: write.fileId || null, stageId: write.stageId || null },
    ));
  }

  if (Number(input.settlement?.finalBootstrapMarkerLeakCount || 0) !== 0) {
    blockers.push(blocker(
      'report_final_settlement_bootstrap_marker_leak',
      'Final settlement must not leave bootstrap seed markers in latest reports.',
      { finalBootstrapMarkerLeakCount: Number(input.settlement.finalBootstrapMarkerLeakCount || 0) },
    ));
  }

  if (!latestReport || latestReport.jsonExists !== true || latestReport.mdExists !== true) {
    blockers.push(blocker(
      'report_final_settlement_latest_report_missing',
      'Final settlement must write release-final-settlement-latest JSON and Markdown reports.',
      {
        fileId: latestReport?.fileId || RELEASE_FINAL_SETTLEMENT_JSON_FILE_ID,
        mdFileId: latestReport?.mdFileId || RELEASE_FINAL_SETTLEMENT_MD_FILE_ID,
      },
    ));
  } else {
    if (latestReport.ok !== true || latestReport.status !== 'pass_release_final_settlement') {
      blockers.push(blocker(
        'report_final_settlement_latest_report_not_ok',
        'Final settlement latest report must remain pass_release_final_settlement.',
        {
          fileId: latestReport.fileId,
          status: latestReport.status || null,
        },
      ));
    }
    if (!latestReport.hash || latestReport.hash !== latestReport.finalSettlementHash) {
      blockers.push(blocker(
        'report_final_settlement_latest_report_hash_mismatch',
        'Final settlement latest report must expose matching hash and finalSettlementHash values.',
        {
          fileId: latestReport.fileId,
          hash: latestReport.hash || null,
          finalSettlementHash: latestReport.finalSettlementHash || null,
        },
      ));
    }
    if (latestReport.reportFilesJsonMatches !== true || latestReport.reportFilesMarkdownMatches !== true) {
      blockers.push(blocker(
        'report_final_settlement_latest_report_files_mismatch',
        'Final settlement latest report must point reportFiles at its own JSON/Markdown artifacts.',
        {
          fileId: latestReport.fileId,
          reportFilesJsonMatches: latestReport.reportFilesJsonMatches === true,
          reportFilesMarkdownMatches: latestReport.reportFilesMarkdownMatches === true,
        },
      ));
    }
    if (latestReport.markdownHashPresent !== true || latestReport.markdownStatusPresent !== true) {
      blockers.push(blocker(
        'report_final_settlement_latest_report_markdown_binding_missing',
        'Final settlement Markdown report must echo the final hash and status.',
        {
          fileId: latestReport.mdFileId,
          markdownHashPresent: latestReport.markdownHashPresent === true,
          markdownStatusPresent: latestReport.markdownStatusPresent === true,
        },
      ));
    }
    if (latestReport.writeIntegrityOk !== true) {
      blockers.push(blocker(
        'report_final_settlement_latest_report_write_integrity_not_ok',
        'Final settlement latest report must include a passing write/readback integrity check.',
        { fileId: latestReport.fileId },
      ));
    }
  }

  return {
    status: blockers.length ? 'blocked_report_final_settlement_analysis' : 'pass_report_final_settlement_analysis',
    ok: blockers.length === 0,
    stageCount: stages.length,
    expectedStageCount: EXPECTED_SETTLEMENT_STAGE_IDS.length,
    stageIds: stages.map((stage) => stage.stageId),
    packageScriptCount: Object.keys(REQUIRED_PACKAGE_SCRIPTS).length,
    presentPackageScriptCount: Object.keys(REQUIRED_PACKAGE_SCRIPTS)
      .filter((scriptId) => input.packageScripts?.[scriptId]).length,
    mappedReportWriteAfterFinalGateCount: (input.settlement?.mappedReportWritesAfterFinalGate || []).length,
    validationSkipsAfterFailedCommand: releaseSource.validationSkipsAfterFailedCommand === true,
    failedCommandCanValidateStaleLatest: releaseSource.failedCommandCanValidateStaleLatest === true,
    semanticHashFallbackCount: Number(releaseSource.semanticHashFallbackCount || 0),
    finalFreshnessGateHashMatches: Boolean(finalGate?.hash && finalFreshness?.gateHash === finalGate.hash),
    finalGateHashPresent: isSha256(finalGate?.hash),
    finalFreshnessGateHashMismatchCount: Number(finalFreshness?.gateHashMismatchCount || 0),
    checkpointFreshnessHashMatches: Boolean(finalFreshness?.hash && checkpoint?.reportFreshnessHash === finalFreshness.hash),
    postActionRuntimeStatusRequiredSummaryMetrics: Number(checkpoint?.postActionRuntimeStatusRequiredSummaryMetrics || 0),
    postActionRuntimeStatusRequiredSummaryMetricOk: Number(checkpoint?.postActionRuntimeStatusRequiredSummaryMetricOk || 0),
    postActionRuntimeStatusRequiredSummaryMetricsOk: checkpoint?.postActionRuntimeStatusRequiredSummaryMetricsOk === true,
    readOnlyReportChainDispatchMetrics: Number(checkpoint?.readOnlyReportChainDispatchMetrics || 0),
    readOnlyReportChainExpectedDispatchMetrics: Number(checkpoint?.readOnlyReportChainExpectedDispatchMetrics || 0),
    readOnlyReportChainDispatchMetricsOk: checkpoint?.readOnlyReportChainDispatchMetricsOk === true,
    readOnlyReportChainDispatchTotalHandoffs: Number(checkpoint?.readOnlyReportChainDispatchTotalHandoffs || 0),
    readOnlyReportChainDispatchReadyHandoffs: Number(checkpoint?.readOnlyReportChainDispatchReadyHandoffs || 0),
    readOnlyReportChainDispatchBlockedHandoffs: Number(checkpoint?.readOnlyReportChainDispatchBlockedHandoffs || 0),
    readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs: Number(checkpoint?.readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs || 0),
    seedWriteCount: Number(cleanSeedCheck?.seededFileCount || 0),
    seedSkipCount: Number(cleanSeedCheck?.skippedFileCount || 0),
    activeBootstrapSeedReports: Number(activeSeedScan?.activeBootstrapSeedReports || 0),
    placeholderTokenMatches: Number(placeholderScan?.placeholderTokenMatches || 0),
    diffWhitespaceClean: diffCheck?.diffClean === true,
    reportOnlyDirtyScanClean: Number(reportOnlyDirtyScan?.nonReportDirtyFileCount || 0) === 0
      && Number(reportOnlyDirtyScan?.nonLatestReportDirtyFileCount || 0) === 0,
    reportDirtyFileCount: Number(reportOnlyDirtyScan?.reportDirtyFileCount || 0),
    allowedReportDirtyFileCount: Number(reportOnlyDirtyScan?.allowedReportDirtyFileCount || 0),
    nonLatestReportDirtyFileCount: Number(reportOnlyDirtyScan?.nonLatestReportDirtyFileCount || 0),
    nonReportDirtyFileCount: Number(reportOnlyDirtyScan?.nonReportDirtyFileCount || 0),
    latestReportWriteIntegrityOk: latestReport?.writeIntegrityOk === true,
    latestReportHashMatches: Boolean(latestReport?.hash && latestReport.hash === latestReport.finalSettlementHash),
    latestReportMarkdownBindingPresent: latestReport?.markdownHashPresent === true
      && latestReport?.markdownStatusPresent === true,
    retentionOk: retention?.ok === true,
    retentionDryRun: retention?.dryRun === true,
    retentionArchivedCount: Number(retention?.archivedCount || 0),
    blockers,
  };
}

function evaluateScenario(input, scenario) {
  const mutated = clone(input);
  scenario.mutate(mutated);
  const analysis = analyzeInput(mutated);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const expectedObserved = observedBlockerCodes.includes(scenario.expectedBlockerCode);
  const blockers = [
    ...(analysis.ok ? [blocker(
      'report_final_settlement_scenario_unexpectedly_passed',
      `${scenario.scenarioId} passed unexpectedly.`,
      { scenarioId: scenario.scenarioId },
    )] : []),
    ...(!expectedObserved ? [blocker(
      'report_final_settlement_expected_blocker_missing',
      `${scenario.scenarioId} did not produce ${scenario.expectedBlockerCode}.`,
      { scenarioId: scenario.scenarioId, observedBlockerCodes },
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_final_settlement_scenario' : 'pass_report_final_settlement_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    blockers,
  };
}

export function buildReportFinalSettlementRegressionReport({
  gateSourceText = '',
  releaseSourceText = '',
  packageScripts = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const actualInput = buildActualInput({ gateSourceText, releaseSourceText, packageScripts });
  const actual = analyzeInput(actualInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => evaluateScenario(actualInput, scenario));
  const blockers = [
    ...actual.blockers,
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const summary = {
    actualOk: actual.ok,
    settlementStageCount: actual.stageCount,
    expectedSettlementStageCount: actual.expectedStageCount,
    packageScriptCount: actual.packageScriptCount,
    presentPackageScriptCount: actual.presentPackageScriptCount,
    mappedReportWriteAfterFinalGateCount: actual.mappedReportWriteAfterFinalGateCount,
    validationSkipsAfterFailedCommand: actual.validationSkipsAfterFailedCommand,
    failedCommandCanValidateStaleLatest: actual.failedCommandCanValidateStaleLatest,
    semanticHashFallbackCount: actual.semanticHashFallbackCount,
    finalGateHashPresent: actual.finalGateHashPresent,
    finalFreshnessGateHashMatches: actual.finalFreshnessGateHashMatches,
    finalFreshnessGateHashMismatchCount: actual.finalFreshnessGateHashMismatchCount,
    checkpointFreshnessHashMatches: actual.checkpointFreshnessHashMatches,
    postActionRuntimeStatusRequiredSummaryMetrics: actual.postActionRuntimeStatusRequiredSummaryMetrics,
    postActionRuntimeStatusRequiredSummaryMetricOk: actual.postActionRuntimeStatusRequiredSummaryMetricOk,
    postActionRuntimeStatusRequiredSummaryMetricsOk: actual.postActionRuntimeStatusRequiredSummaryMetricsOk,
    readOnlyReportChainDispatchMetrics: actual.readOnlyReportChainDispatchMetrics,
    readOnlyReportChainExpectedDispatchMetrics: actual.readOnlyReportChainExpectedDispatchMetrics,
    readOnlyReportChainDispatchMetricsOk: actual.readOnlyReportChainDispatchMetricsOk,
    readOnlyReportChainDispatchTotalHandoffs: actual.readOnlyReportChainDispatchTotalHandoffs,
    readOnlyReportChainDispatchReadyHandoffs: actual.readOnlyReportChainDispatchReadyHandoffs,
    readOnlyReportChainDispatchBlockedHandoffs: actual.readOnlyReportChainDispatchBlockedHandoffs,
    readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs: actual.readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs,
    seedWriteCount: actual.seedWriteCount,
    seedSkipCount: actual.seedSkipCount,
    activeBootstrapSeedReports: actual.activeBootstrapSeedReports,
    placeholderTokenMatches: actual.placeholderTokenMatches,
    diffWhitespaceClean: actual.diffWhitespaceClean,
    reportOnlyDirtyScanClean: actual.reportOnlyDirtyScanClean,
    reportDirtyFileCount: actual.reportDirtyFileCount,
    allowedReportDirtyFileCount: actual.allowedReportDirtyFileCount,
    nonLatestReportDirtyFileCount: actual.nonLatestReportDirtyFileCount,
    nonReportDirtyFileCount: actual.nonReportDirtyFileCount,
    latestReportWriteIntegrityOk: actual.latestReportWriteIntegrityOk,
    latestReportHashMatches: actual.latestReportHashMatches,
    latestReportMarkdownBindingPresent: actual.latestReportMarkdownBindingPresent,
    retentionOk: actual.retentionOk,
    retentionDryRun: actual.retentionDryRun,
    retentionArchivedCount: actual.retentionArchivedCount,
    expectedScenarioCount: NEGATIVE_SCENARIOS.length,
    scenarioCount: scenarios.length,
    passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
    failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
    observedExpectedBlockerCount: scenarios.filter((scenario) => (
      scenario.observedBlockerCodes.includes(scenario.expectedBlockerCode)
    )).length,
    blockerCount: blockers.length,
  };
  const finalSettlementRegressionHash = digest({
    version: REPORT_FINAL_SETTLEMENT_REGRESSION_VERSION,
    kind: 'ReportFinalSettlementRegression',
    summary,
    actual: {
      stageIds: actual.stageIds,
      packageScriptCount: actual.packageScriptCount,
      mappedReportWriteAfterFinalGateCount: actual.mappedReportWriteAfterFinalGateCount,
      validationSkipsAfterFailedCommand: actual.validationSkipsAfterFailedCommand,
      failedCommandCanValidateStaleLatest: actual.failedCommandCanValidateStaleLatest,
      semanticHashFallbackCount: actual.semanticHashFallbackCount,
      finalGateHashPresent: actual.finalGateHashPresent,
      finalFreshnessGateHashMatches: actual.finalFreshnessGateHashMatches,
      checkpointFreshnessHashMatches: actual.checkpointFreshnessHashMatches,
      postActionRuntimeStatusRequiredSummaryMetrics: actual.postActionRuntimeStatusRequiredSummaryMetrics,
      postActionRuntimeStatusRequiredSummaryMetricOk: actual.postActionRuntimeStatusRequiredSummaryMetricOk,
      postActionRuntimeStatusRequiredSummaryMetricsOk: actual.postActionRuntimeStatusRequiredSummaryMetricsOk,
      readOnlyReportChainDispatchMetrics: actual.readOnlyReportChainDispatchMetrics,
      readOnlyReportChainExpectedDispatchMetrics: actual.readOnlyReportChainExpectedDispatchMetrics,
      readOnlyReportChainDispatchMetricsOk: actual.readOnlyReportChainDispatchMetricsOk,
      readOnlyReportChainDispatchTotalHandoffs: actual.readOnlyReportChainDispatchTotalHandoffs,
      readOnlyReportChainDispatchReadyHandoffs: actual.readOnlyReportChainDispatchReadyHandoffs,
      readOnlyReportChainDispatchBlockedHandoffs: actual.readOnlyReportChainDispatchBlockedHandoffs,
      readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs: actual.readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs,
      seedWriteCount: actual.seedWriteCount,
      seedSkipCount: actual.seedSkipCount,
      activeBootstrapSeedReports: actual.activeBootstrapSeedReports,
      placeholderTokenMatches: actual.placeholderTokenMatches,
      diffWhitespaceClean: actual.diffWhitespaceClean,
      reportOnlyDirtyScanClean: actual.reportOnlyDirtyScanClean,
      reportDirtyFileCount: actual.reportDirtyFileCount,
      allowedReportDirtyFileCount: actual.allowedReportDirtyFileCount,
      nonLatestReportDirtyFileCount: actual.nonLatestReportDirtyFileCount,
      nonReportDirtyFileCount: actual.nonReportDirtyFileCount,
      latestReportWriteIntegrityOk: actual.latestReportWriteIntegrityOk,
      latestReportHashMatches: actual.latestReportHashMatches,
      latestReportMarkdownBindingPresent: actual.latestReportMarkdownBindingPresent,
      retentionOk: actual.retentionOk,
      retentionDryRun: actual.retentionDryRun,
      retentionArchivedCount: actual.retentionArchivedCount,
    },
    scenarios: scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      ok: scenario.ok,
      expectedBlockerCode: scenario.expectedBlockerCode,
      observedBlockerCodes: scenario.observedBlockerCodes,
    })),
    blockers: blockers.map((item) => item.code),
  });
  return {
    version: REPORT_FINAL_SETTLEMENT_REGRESSION_VERSION,
    kind: 'ReportFinalSettlementRegression',
    status: blockers.length ? 'blocked_report_final_settlement_regression' : 'pass_report_final_settlement_regression',
    ok: blockers.length === 0,
    generatedAt,
    finalSettlementRegressionHash,
    hash: finalSettlementRegressionHash,
    summary,
    fixture: {
      expectedSettlementStageIds: [...EXPECTED_SETTLEMENT_STAGE_IDS],
      requiredPackageScripts: { ...REQUIRED_PACKAGE_SCRIPTS },
      allowedBootstrapSeedFileIds: [...REPORT_BOOTSTRAP_SEED_ALLOWED_FILE_IDS],
    },
    actual,
    scenarios,
    blockers,
    safety: reportSafety(),
  };
}

export function summarizeReportFinalSettlementRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || 'missing_report_final_settlement_regression',
    finalSettlementRegressionHash: report.finalSettlementRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    settlementStageCount: Number(report.summary?.settlementStageCount || 0),
    mappedReportWriteAfterFinalGateCount: Number(report.summary?.mappedReportWriteAfterFinalGateCount || 0),
    validationSkipsAfterFailedCommand: report.summary?.validationSkipsAfterFailedCommand === true,
    failedCommandCanValidateStaleLatest: report.summary?.failedCommandCanValidateStaleLatest === true,
    semanticHashFallbackCount: Number(report.summary?.semanticHashFallbackCount || 0),
    finalGateHashPresent: report.summary?.finalGateHashPresent === true,
    finalFreshnessGateHashMatches: report.summary?.finalFreshnessGateHashMatches === true,
    checkpointFreshnessHashMatches: report.summary?.checkpointFreshnessHashMatches === true,
    postActionRuntimeStatusRequiredSummaryMetrics: Number(report.summary?.postActionRuntimeStatusRequiredSummaryMetrics || 0),
    postActionRuntimeStatusRequiredSummaryMetricOk: Number(report.summary?.postActionRuntimeStatusRequiredSummaryMetricOk || 0),
    postActionRuntimeStatusRequiredSummaryMetricsOk: report.summary?.postActionRuntimeStatusRequiredSummaryMetricsOk === true,
    readOnlyReportChainDispatchMetrics: Number(report.summary?.readOnlyReportChainDispatchMetrics || 0),
    readOnlyReportChainExpectedDispatchMetrics: Number(report.summary?.readOnlyReportChainExpectedDispatchMetrics || 0),
    readOnlyReportChainDispatchMetricsOk: report.summary?.readOnlyReportChainDispatchMetricsOk === true,
    readOnlyReportChainDispatchTotalHandoffs: Number(report.summary?.readOnlyReportChainDispatchTotalHandoffs || 0),
    readOnlyReportChainDispatchReadyHandoffs: Number(report.summary?.readOnlyReportChainDispatchReadyHandoffs || 0),
    readOnlyReportChainDispatchBlockedHandoffs: Number(report.summary?.readOnlyReportChainDispatchBlockedHandoffs || 0),
    readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs: Number(report.summary?.readOnlyReportChainDispatchApprovalProvenanceBoundHandoffs || 0),
    seedWriteCount: Number(report.summary?.seedWriteCount || 0),
    seedSkipCount: Number(report.summary?.seedSkipCount || 0),
    activeBootstrapSeedReports: Number(report.summary?.activeBootstrapSeedReports || 0),
    placeholderTokenMatches: Number(report.summary?.placeholderTokenMatches || 0),
    diffWhitespaceClean: report.summary?.diffWhitespaceClean === true,
    reportOnlyDirtyScanClean: report.summary?.reportOnlyDirtyScanClean === true,
    reportDirtyFileCount: Number(report.summary?.reportDirtyFileCount || 0),
    allowedReportDirtyFileCount: Number(report.summary?.allowedReportDirtyFileCount || 0),
    nonLatestReportDirtyFileCount: Number(report.summary?.nonLatestReportDirtyFileCount || 0),
    nonReportDirtyFileCount: Number(report.summary?.nonReportDirtyFileCount || 0),
    latestReportWriteIntegrityOk: report.summary?.latestReportWriteIntegrityOk === true,
    latestReportHashMatches: report.summary?.latestReportHashMatches === true,
    latestReportMarkdownBindingPresent: report.summary?.latestReportMarkdownBindingPresent === true,
    retentionOk: report.summary?.retentionOk === true,
    retentionDryRun: report.summary?.retentionDryRun === true,
    retentionArchivedCount: Number(report.summary?.retentionArchivedCount || 0),
    scenarioCount: Number(report.summary?.scenarioCount || 0),
    passedScenarioCount: Number(report.summary?.passedScenarioCount || 0),
    blockerCount: Number(report.summary?.blockerCount || 0),
    safety: report.safety || {},
  };
}
