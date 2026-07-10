import { digest } from './hash-utils.mjs';

export const POST_ACTION_RUNTIME_STATUS_VERSION = 1;

export const POST_ACTION_RUNTIME_STATUS_STAGE_IDS = Object.freeze({
  RUNTIME_DRY_RUN_HARNESS: 'runtime_dry_run_harness',
  CHANNEL_RUNNER_COVERAGE_MATRIX: 'channel_runner_coverage_matrix',
  POST_ACTION_EVIDENCE_MATRIX: 'post_action_evidence_matrix',
  POST_ACTION_AUDIT_BUNDLE_MATRIX: 'post_action_audit_bundle_matrix',
  POST_ACTION_AUDIT_ARCHIVE_MATRIX: 'post_action_audit_archive_matrix',
  POST_ACTION_REPLAY_GUARD_MATRIX: 'post_action_replay_guard_matrix',
  POST_ACTION_DISPATCH_ENVELOPE_MATRIX: 'post_action_dispatch_envelope_matrix',
  POST_ACTION_DISPATCH_COMPLETION_MATRIX: 'post_action_dispatch_completion_matrix',
  POST_ACTION_RECONCILIATION_MATRIX: 'post_action_reconciliation_matrix',
});

export const POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES = 20;
export const POST_ACTION_RUNTIME_STATUS_EXPECTED_ACTION_CLASSES = 7;
export const POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES = 5;
export const POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_MESSAGE_ROUTES = 3;
export const POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES = 4;
export const POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES = 6;
export const POST_ACTION_RUNTIME_STATUS_EXPECTED_PACKAGE_ROLE_ROUTES = 20;

function metric(summaryKey) {
  return (report) => report?.summary?.[summaryKey] ?? null;
}

function requiredSummaryMetric(field, expectedValue, label = field) {
  return Object.freeze({
    field,
    expectedValue,
    label,
  });
}

export const POST_ACTION_RUNTIME_STATUS_STAGES = Object.freeze([
  Object.freeze({
    stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.RUNTIME_DRY_RUN_HARNESS,
    order: 1,
    label: 'Runtime dry-run handoff',
    reportFileId: 'runtime-dry-run-harness-latest.json',
    hashKey: 'runtimeDryRunHarnessHash',
    routeMetric: metric('readyScenarioCount'),
    completionMetric: metric('readyForExternalImplementationCount'),
    externalWorkspaceRunnerMetric: metric('readyScenarioExternalWorkspaceRunnerCount'),
    internalWorkspaceRunnerMetric: metric('readyScenarioInternalWorkspaceRunnerCount'),
    requiredSummaryMetrics: Object.freeze([
      requiredSummaryMetric(
        'readyScenarioPackageRoleCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PACKAGE_ROLE_ROUTES,
        'runtime ready package-role routes',
      ),
      requiredSummaryMetric(
        'readyScenarioHumanFeedbackPackageRoleCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'runtime human-feedback package-role routes',
      ),
    ]),
  }),
  Object.freeze({
    stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.CHANNEL_RUNNER_COVERAGE_MATRIX,
    order: 2,
    label: 'Channel runner coverage',
    reportFileId: 'channel-runner-coverage-matrix-latest.json',
    hashKey: 'channelRunnerCoverageMatrixHash',
    routeMetric: metric('routeCount'),
    completionMetric: metric('classifiedRouteCount'),
    requiredSummaryMetrics: Object.freeze([
      requiredSummaryMetric(
        'customerMessageHashBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'customer-message hash-bound routes',
      ),
      requiredSummaryMetric(
        'humanFeedbackMessageHashBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_MESSAGE_ROUTES,
        'human-feedback message hash-bound routes',
      ),
      requiredSummaryMetric(
        'packageRoleRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PACKAGE_ROLE_ROUTES,
        'package-role classified routes',
      ),
      requiredSummaryMetric(
        'humanFeedbackPackageRoleBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback package-role classified routes',
      ),
    ]),
    upstreamBindings: Object.freeze([
      Object.freeze({
        stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.RUNTIME_DRY_RUN_HARNESS,
        field: 'runtimeDryRunHarnessHash',
      }),
    ]),
  }),
  Object.freeze({
    stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_EVIDENCE_MATRIX,
    order: 3,
    label: 'Post-action evidence',
    reportFileId: 'post-action-evidence-matrix-latest.json',
    hashKey: 'postActionEvidenceMatrixHash',
    routeMetric: metric('routeCount'),
    actionClassMetric: metric('actionClassCount'),
    completionMetric: (report) => Math.min(
      report?.summary?.acceptedReceiptCount ?? 0,
      report?.summary?.verifiedStateProofCount ?? 0,
    ),
    requiredSummaryMetrics: Object.freeze([
      requiredSummaryMetric(
        'packageRoleRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PACKAGE_ROLE_ROUTES,
        'package-role evidence routes',
      ),
      requiredSummaryMetric(
        'humanFeedbackPackageRoleBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback package-role evidence routes',
      ),
    ]),
    upstreamBindings: Object.freeze([
      Object.freeze({
        stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.RUNTIME_DRY_RUN_HARNESS,
        field: 'runtimeDryRunHarnessHash',
      }),
    ]),
  }),
  Object.freeze({
    stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_AUDIT_BUNDLE_MATRIX,
    order: 4,
    label: 'Post-action audit bundle',
    reportFileId: 'post-action-audit-bundle-matrix-latest.json',
    hashKey: 'postActionAuditBundleMatrixHash',
    routeMetric: metric('routeCount'),
    actionClassMetric: metric('actionClassCount'),
    completionMetric: metric('verifiedAuditBundleCount'),
    requiredSummaryMetrics: Object.freeze([
      requiredSummaryMetric(
        'customerMessageHashBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'customer-message hash-bound audit bundles',
      ),
      requiredSummaryMetric(
        'humanFeedbackContractBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback contract-bound audit bundles',
      ),
      requiredSummaryMetric(
        'packageRoleRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PACKAGE_ROLE_ROUTES,
        'package-role audit bundles',
      ),
      requiredSummaryMetric(
        'humanFeedbackPackageRoleBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback package-role audit bundles',
      ),
      requiredSummaryMetric(
        'strippedPayloadMessageHashBundleBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'audit bundle stripped payload message hash blocked probes',
      ),
      requiredSummaryMetric(
        'strippedChainMessageHashBundleBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'audit bundle stripped chain message hash blocked probes',
      ),
      requiredSummaryMetric(
        'strippedPayloadContractHashBundleBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'audit bundle stripped payload feedback contract blocked probes',
      ),
      requiredSummaryMetric(
        'strippedChainContractHashBundleBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'audit bundle stripped chain feedback contract blocked probes',
      ),
      requiredSummaryMetric(
        'strippedPayloadPromptBindingBundleBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'audit bundle stripped payload prompt binding blocked probes',
      ),
      requiredSummaryMetric(
        'strippedChainPromptBindingBundleBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'audit bundle stripped chain prompt binding blocked probes',
      ),
    ]),
    upstreamBindings: Object.freeze([
      Object.freeze({
        stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_EVIDENCE_MATRIX,
        field: 'postActionEvidenceMatrixHash',
      }),
    ]),
  }),
  Object.freeze({
    stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_AUDIT_ARCHIVE_MATRIX,
    order: 5,
    label: 'Post-action audit archive',
    reportFileId: 'post-action-audit-archive-matrix-latest.json',
    hashKey: 'postActionAuditArchiveMatrixHash',
    routeMetric: metric('routeCount'),
    actionClassMetric: metric('actionClassCount'),
    completionMetric: metric('aggregateVerifiedEntries'),
    requiredSummaryMetrics: Object.freeze([
      requiredSummaryMetric(
        'aggregateCustomerMessagePreviewHashBoundEntries',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'customer-message preview-hash-bound archive entries',
      ),
      requiredSummaryMetric(
        'aggregateHumanFeedbackContractBoundEntries',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback contract-bound archive entries',
      ),
      requiredSummaryMetric(
        'packageRoleRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PACKAGE_ROLE_ROUTES,
        'package-role archive entries',
      ),
      requiredSummaryMetric(
        'humanFeedbackPackageRoleBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback package-role archive entries',
      ),
      requiredSummaryMetric(
        'strippedPayloadMessageHashArchiveBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'archive stripped payload message hash blocked probes',
      ),
      requiredSummaryMetric(
        'strippedBindingMessageHashArchiveBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'archive stripped binding message hash blocked probes',
      ),
      requiredSummaryMetric(
        'strippedPayloadContractHashArchiveBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'archive stripped payload feedback contract blocked probes',
      ),
      requiredSummaryMetric(
        'strippedBindingContractHashArchiveBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'archive stripped binding feedback contract blocked probes',
      ),
      requiredSummaryMetric(
        'strippedPayloadPromptBindingArchiveBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'archive stripped payload prompt binding blocked probes',
      ),
      requiredSummaryMetric(
        'strippedBindingPromptBindingArchiveBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'archive stripped binding prompt binding blocked probes',
      ),
    ]),
    upstreamBindings: Object.freeze([
      Object.freeze({
        stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_EVIDENCE_MATRIX,
        field: 'postActionEvidenceMatrixHash',
      }),
      Object.freeze({
        stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_AUDIT_BUNDLE_MATRIX,
        field: 'postActionAuditBundleMatrixHash',
      }),
    ]),
  }),
  Object.freeze({
    stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_REPLAY_GUARD_MATRIX,
    order: 6,
    label: 'Post-action replay guard',
    reportFileId: 'post-action-replay-guard-matrix-latest.json',
    hashKey: 'postActionReplayGuardMatrixHash',
    routeMetric: metric('routeCount'),
    actionClassMetric: metric('actionClassCount'),
    completionMetric: metric('repeatApprovedClearCount'),
    requiredSummaryMetrics: Object.freeze([
      requiredSummaryMetric(
        'packageRoleRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PACKAGE_ROLE_ROUTES,
        'package-role replay guard routes',
      ),
      requiredSummaryMetric(
        'humanFeedbackPackageRoleBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback package-role replay guard routes',
      ),
      requiredSummaryMetric(
        'strippedPayloadMessageHashReplayCandidateNullCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'replay guard stripped payload message hash null candidates',
      ),
      requiredSummaryMetric(
        'strippedPayloadMessageHashReplayBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'replay guard stripped payload message hash blocked probes',
      ),
      requiredSummaryMetric(
        'strippedPayloadContractHashReplayCandidateNullCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'replay guard stripped payload contract hash null candidates',
      ),
      requiredSummaryMetric(
        'strippedPayloadContractHashReplayBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'replay guard stripped payload contract hash blocked probes',
      ),
      requiredSummaryMetric(
        'strippedPayloadPromptBindingReplayCandidateNullCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'replay guard stripped payload prompt binding null candidates',
      ),
      requiredSummaryMetric(
        'strippedPayloadPromptBindingReplayBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'replay guard stripped payload prompt binding blocked probes',
      ),
    ]),
    upstreamBindings: Object.freeze([
      Object.freeze({
        stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_EVIDENCE_MATRIX,
        field: 'postActionEvidenceMatrixHash',
      }),
      Object.freeze({
        stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_AUDIT_ARCHIVE_MATRIX,
        field: 'postActionAuditArchiveMatrixHash',
      }),
    ]),
  }),
  Object.freeze({
    stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_DISPATCH_ENVELOPE_MATRIX,
    order: 7,
    label: 'Post-action dispatch envelope',
    reportFileId: 'post-action-dispatch-envelope-matrix-latest.json',
    hashKey: 'postActionDispatchEnvelopeMatrixHash',
    routeMetric: metric('routeCount'),
    actionClassMetric: metric('actionClassCount'),
    completionMetric: metric('readyEnvelopeCount'),
    requiredSummaryMetrics: Object.freeze([
      requiredSummaryMetric(
        'packageRoleRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PACKAGE_ROLE_ROUTES,
        'package-role dispatch envelope routes',
      ),
      requiredSummaryMetric(
        'humanFeedbackPackageRoleBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback package-role dispatch envelope routes',
      ),
      requiredSummaryMetric(
        'strippedOutboxAliasCandidateNullCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES,
        'dispatch envelope stripped outbox alias null candidates',
      ),
      requiredSummaryMetric(
        'strippedOutboxAliasEnvelopeBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES,
        'dispatch envelope stripped outbox alias blocked probes',
      ),
      requiredSummaryMetric(
        'strippedPayloadMessageHashReplayBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'dispatch envelope stripped payload message hash replay blockers',
      ),
      requiredSummaryMetric(
        'strippedPayloadContractHashReplayBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'dispatch envelope stripped payload contract hash replay blockers',
      ),
      requiredSummaryMetric(
        'strippedPayloadPromptBindingReplayBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'dispatch envelope stripped payload prompt binding replay blockers',
      ),
      requiredSummaryMetric(
        'strippedPayloadMessageHashBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'dispatch envelope stripped payload message hash blockers',
      ),
      requiredSummaryMetric(
        'strippedPayloadContractHashBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'dispatch envelope stripped payload contract hash blockers',
      ),
      requiredSummaryMetric(
        'strippedPayloadPromptBindingBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'dispatch envelope stripped payload prompt binding blockers',
      ),
    ]),
    upstreamBindings: Object.freeze([
      Object.freeze({
        stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_AUDIT_ARCHIVE_MATRIX,
        field: 'postActionAuditArchiveMatrixHash',
      }),
      Object.freeze({
        stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_REPLAY_GUARD_MATRIX,
        field: 'postActionReplayGuardMatrixHash',
      }),
    ]),
  }),
  Object.freeze({
    stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_DISPATCH_COMPLETION_MATRIX,
    order: 8,
    label: 'Post-action dispatch completion',
    reportFileId: 'post-action-dispatch-completion-matrix-latest.json',
    hashKey: 'postActionDispatchCompletionMatrixHash',
    routeMetric: metric('routeCount'),
    actionClassMetric: metric('actionClassCount'),
    completionMetric: metric('aggregateDispatchInboxChainEntries'),
    requiredSummaryMetrics: Object.freeze([
      requiredSummaryMetric(
        'customerMessageRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'customer-message dispatch-completion routes',
      ),
      requiredSummaryMetric(
        'customerMessageHashBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'customer-message dispatch-completion hash-bound routes',
      ),
      requiredSummaryMetric(
        'humanFeedbackContractBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback contract-bound dispatch-completion routes',
      ),
      requiredSummaryMetric(
        'packageRoleRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PACKAGE_ROLE_ROUTES,
        'package-role dispatch-completion routes',
      ),
      requiredSummaryMetric(
        'humanFeedbackPackageRoleBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback package-role dispatch-completion routes',
      ),
      requiredSummaryMetric(
        'promptGenerationBindingBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'prompt-generation dispatch-completion binding-bound routes',
      ),
      requiredSummaryMetric(
        'aggregatePromptGenerationBindingBoundEntries',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'prompt-generation aggregate archive binding-bound entries',
      ),
      requiredSummaryMetric(
        'strippedPayloadMessageHashReplayCandidateNullCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'dispatch completion stripped payload message hash null candidates',
      ),
      requiredSummaryMetric(
        'strippedPayloadMessageHashReplayBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'dispatch completion stripped payload message hash blocked probes',
      ),
      requiredSummaryMetric(
        'strippedPayloadContractHashReplayCandidateNullCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'dispatch completion stripped payload contract hash null candidates',
      ),
      requiredSummaryMetric(
        'strippedPayloadContractHashReplayBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'dispatch completion stripped payload contract hash blocked probes',
      ),
      requiredSummaryMetric(
        'strippedPayloadPromptBindingReplayCandidateNullCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'dispatch completion stripped payload prompt binding null candidates',
      ),
      requiredSummaryMetric(
        'strippedPayloadPromptBindingReplayBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'dispatch completion stripped payload prompt binding blocked probes',
      ),
      requiredSummaryMetric(
        'strippedBundleAliasCandidateNullCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES,
        'dispatch completion stripped bundle alias null candidates',
      ),
    ]),
    upstreamBindings: Object.freeze([
      Object.freeze({
        stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_DISPATCH_ENVELOPE_MATRIX,
        field: 'postActionDispatchEnvelopeMatrixHash',
      }),
    ]),
  }),
  Object.freeze({
    stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_RECONCILIATION_MATRIX,
    order: 9,
    label: 'Post-action reconciliation',
    reportFileId: 'post-action-reconciliation-matrix-latest.json',
    hashKey: 'postActionReconciliationMatrixHash',
    routeMetric: metric('routeCount'),
    actionClassMetric: metric('actionClassCount'),
    completionMetric: metric('reconciledRouteCount'),
    requiredSummaryMetrics: Object.freeze([
      requiredSummaryMetric(
        'customerMessageHashRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'customer-message reconciliation hash routes',
      ),
      requiredSummaryMetric(
        'customerMessageHashDriftBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_CUSTOMER_MESSAGE_ROUTES,
        'customer-message reconciliation hash drift probes',
      ),
      requiredSummaryMetric(
        'humanFeedbackContractRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback reconciliation contract routes',
      ),
      requiredSummaryMetric(
        'humanFeedbackContractDriftBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback reconciliation contract drift probes',
      ),
      requiredSummaryMetric(
        'promptGenerationBindingRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'prompt-generation reconciliation binding routes',
      ),
      requiredSummaryMetric(
        'promptGenerationBindingDriftBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PROMPT_GENERATION_ROUTES,
        'prompt-generation reconciliation binding drift probes',
      ),
      requiredSummaryMetric(
        'strippedBundleAliasBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES,
        'reconciliation stripped bundle alias probes',
      ),
      requiredSummaryMetric(
        'missingAggregateEntryBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES,
        'reconciliation missing aggregate probes',
      ),
      requiredSummaryMetric(
        'tamperedBundleBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES,
        'reconciliation tampered bundle probes',
      ),
      requiredSummaryMetric(
        'missingDispatchChainBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES,
        'reconciliation missing dispatch chain probes',
      ),
      requiredSummaryMetric(
        'missingBundleDispatchSourceBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES,
        'reconciliation missing bundle dispatch source probes',
      ),
      requiredSummaryMetric(
        'missingLedgerDispatchSourceBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES,
        'reconciliation missing ledger dispatch source probes',
      ),
      requiredSummaryMetric(
        'perRouteArchiveDriftBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES,
        'reconciliation per-route archive drift probes',
      ),
      requiredSummaryMetric(
        'packageRoleRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PACKAGE_ROLE_ROUTES,
        'package-role reconciliation routes',
      ),
      requiredSummaryMetric(
        'packageRoleDriftBlockedCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_PACKAGE_ROLE_ROUTES,
        'package-role reconciliation drift probes',
      ),
      requiredSummaryMetric(
        'humanFeedbackPackageRoleBoundRouteCount',
        POST_ACTION_RUNTIME_STATUS_EXPECTED_HUMAN_FEEDBACK_CUSTOMER_FACING_ROUTES,
        'human-feedback package-role reconciliation routes',
      ),
    ]),
    upstreamBindings: Object.freeze([
      Object.freeze({
        stageId: POST_ACTION_RUNTIME_STATUS_STAGE_IDS.POST_ACTION_DISPATCH_COMPLETION_MATRIX,
        field: 'postActionDispatchCompletionMatrixHash',
      }),
    ]),
  }),
]);

function issue(code, notes = null, extra = {}) {
  return {
    code,
    notes,
    ...extra,
  };
}

function getReport(reportBindings = {}, stage) {
  return reportBindings[stage.stageId]
    || reportBindings[stage.reportFileId]
    || null;
}

function reportHash(report = {}, hashKey) {
  return report?.[hashKey] || null;
}

function reportField(report = {}, field) {
  return report?.[field]
    || report?.summary?.[field]
    || null;
}

function reportOk(report = {}) {
  return report?.ok === true || /^pass_/.test(String(report?.status || ''));
}

function blockerCount(report = {}) {
  return Number(
    report?.summary?.blockerCount
    ?? report?.summary?.routeBlockerCount
    ?? report?.blockerCount
    ?? (Array.isArray(report?.blockers) ? report.blockers.length : 0),
  );
}

function compactStage(stage, report, previousHashes) {
  const exists = Boolean(report);
  const hash = exists ? reportHash(report, stage.hashKey) : null;
  const ok = exists && reportOk(report);
  const routeCount = exists ? stage.routeMetric?.(report) : null;
  const actionClassCount = exists && stage.actionClassMetric ? stage.actionClassMetric(report) : null;
  const completionCount = exists ? stage.completionMetric?.(report) : null;
  const externalWorkspaceRunnerCount = exists && stage.externalWorkspaceRunnerMetric
    ? stage.externalWorkspaceRunnerMetric(report)
    : null;
  const internalWorkspaceRunnerCount = exists && stage.internalWorkspaceRunnerMetric
    ? stage.internalWorkspaceRunnerMetric(report)
    : null;
  const blockers = [
    ...(!exists ? [issue('post_action_runtime_stage_report_missing', `${stage.stageId} requires ${stage.reportFileId}.`)] : []),
    ...(exists && !ok ? [issue('post_action_runtime_stage_report_not_ok', `${stage.stageId} is ${report.status || 'not ok'}.`)] : []),
    ...(exists && !hash ? [issue('post_action_runtime_stage_hash_missing', `${stage.stageId} must expose ${stage.hashKey}.`)] : []),
    ...(exists && routeCount !== POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES ? [issue(
      'post_action_runtime_stage_route_count_mismatch',
      `${stage.stageId} expected ${POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES} ready routes, got ${routeCount ?? 'missing'}.`,
    )] : []),
    ...(exists && stage.actionClassMetric && actionClassCount !== POST_ACTION_RUNTIME_STATUS_EXPECTED_ACTION_CLASSES ? [issue(
      'post_action_runtime_stage_action_class_count_mismatch',
      `${stage.stageId} expected ${POST_ACTION_RUNTIME_STATUS_EXPECTED_ACTION_CLASSES} action classes, got ${actionClassCount ?? 'missing'}.`,
    )] : []),
    ...(exists && completionCount !== POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES ? [issue(
      'post_action_runtime_stage_completion_count_mismatch',
      `${stage.stageId} expected ${POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES} completed routes, got ${completionCount ?? 'missing'}.`,
    )] : []),
    ...(exists && stage.externalWorkspaceRunnerMetric && externalWorkspaceRunnerCount !== POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES ? [issue(
      'post_action_runtime_stage_external_workspace_runner_count_mismatch',
      `${stage.stageId} expected ${POST_ACTION_RUNTIME_STATUS_EXPECTED_READY_ROUTES} external-workspace ready runners, got ${externalWorkspaceRunnerCount ?? 'missing'}.`,
    )] : []),
    ...(exists && stage.internalWorkspaceRunnerMetric && internalWorkspaceRunnerCount !== 0 ? [issue(
      'post_action_runtime_stage_internal_workspace_runner_present',
      `${stage.stageId} must expose zero internal-workspace ready runners, got ${internalWorkspaceRunnerCount ?? 'missing'}.`,
    )] : []),
    ...(exists && blockerCount(report) !== 0 ? [issue(
      'post_action_runtime_stage_blockers_present',
      `${stage.stageId} has ${blockerCount(report)} blockers.`,
    )] : []),
  ];
  const requiredSummaryMetrics = (stage.requiredSummaryMetrics || []).map((requirement) => {
    const actualValue = exists ? report?.summary?.[requirement.field] : null;
    const okMetric = actualValue === requirement.expectedValue;
    if (!okMetric) {
      blockers.push(issue(
        'post_action_runtime_stage_required_summary_metric_mismatch',
        `${stage.stageId} expected ${requirement.label} (${requirement.field}) to be ${requirement.expectedValue}, got ${actualValue ?? 'missing'}.`,
        {
          field: requirement.field,
          expectedValue: requirement.expectedValue,
          actualValue,
        },
      ));
    }
    return {
      field: requirement.field,
      label: requirement.label,
      expectedValue: requirement.expectedValue,
      actualValue,
      ok: okMetric,
    };
  });

  const upstreamBindings = (stage.upstreamBindings || []).map((binding) => {
    const upstreamHash = previousHashes[binding.stageId] || null;
    const actualHash = exists ? reportField(report, binding.field) : null;
    const okBinding = Boolean(upstreamHash && actualHash && upstreamHash === actualHash);
    if (!okBinding) {
      blockers.push(issue(
        'post_action_runtime_stage_upstream_hash_mismatch',
        `${stage.stageId} must bind ${binding.field} from ${binding.stageId}.`,
        {
          upstreamStageId: binding.stageId,
          field: binding.field,
        },
      ));
    }
    return {
      upstreamStageId: binding.stageId,
      field: binding.field,
      expectedHash: upstreamHash,
      actualHash,
      ok: okBinding,
    };
  });

  return {
    stageId: stage.stageId,
    order: stage.order,
    label: stage.label,
    reportFileId: stage.reportFileId,
    hashKey: stage.hashKey,
    hash,
    exists,
    ok,
    status: report?.status || null,
    routeCount,
    actionClassCount,
    completionCount,
    externalWorkspaceRunnerCount,
    internalWorkspaceRunnerCount,
    blockerCount: exists ? blockerCount(report) : null,
    requiredSummaryMetrics,
    upstreamBindings,
    readyForDownstream: blockers.length === 0,
    blockers,
  };
}

export function buildPostActionRuntimeStatus({
  reportBindings = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const previousHashes = {};
  const stages = POST_ACTION_RUNTIME_STATUS_STAGES.map((stage) => {
    const record = compactStage(stage, getReport(reportBindings, stage), previousHashes);
    if (record.hash) previousHashes[stage.stageId] = record.hash;
    return record;
  });
  const blockers = stages.flatMap((stage) => stage.blockers.map((blocker) => ({
    ...blocker,
    stageId: stage.stageId,
  })));
  const finalStage = stages[stages.length - 1] || null;
  const runtimeDryRunStage = stages.find((stage) => (
    stage.stageId === POST_ACTION_RUNTIME_STATUS_STAGE_IDS.RUNTIME_DRY_RUN_HARNESS
  )) || null;
  const status = blockers.length
    ? 'blocked_post_action_runtime_status'
    : 'pass_post_action_runtime_status';
  const report = {
    version: POST_ACTION_RUNTIME_STATUS_VERSION,
    kind: 'PostActionRuntimeStatus',
    status,
    ok: blockers.length === 0,
    generatedAt,
    stages,
    summary: {
      stageCount: stages.length,
      passedStages: stages.filter((stage) => stage.readyForDownstream).length,
      missingStageCount: stages.filter((stage) => !stage.exists).length,
      routeCount: finalStage?.routeCount ?? 0,
      actionClassCount: finalStage?.actionClassCount ?? 0,
      completedRouteCount: finalStage?.completionCount ?? 0,
      externalWorkspaceRunnerCount: runtimeDryRunStage?.externalWorkspaceRunnerCount ?? 0,
      internalWorkspaceRunnerCount: runtimeDryRunStage?.internalWorkspaceRunnerCount ?? 0,
      finalStageId: finalStage?.stageId || null,
      finalHash: finalStage?.hash || null,
      upstreamBindingCount: stages.reduce((sum, stage) => sum + stage.upstreamBindings.length, 0),
      upstreamBindingOkCount: stages.reduce(
        (sum, stage) => sum + stage.upstreamBindings.filter((binding) => binding.ok).length,
        0,
      ),
      requiredSummaryMetricCount: stages.reduce((sum, stage) => sum + stage.requiredSummaryMetrics.length, 0),
      requiredSummaryMetricOkCount: stages.reduce(
        (sum, stage) => sum + stage.requiredSummaryMetrics.filter((summaryMetric) => summaryMetric.ok).length,
        0,
      ),
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      reportSummaryOnly: true,
      syntheticReportInputsOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      dispatchesRunner: false,
      consumesQueue: false,
      grantsExecutionPermission: false,
      readyForExecution: false,
    },
  };
  const postActionRuntimeStatusHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    stages: report.stages.map((stage) => ({
      stageId: stage.stageId,
      order: stage.order,
      reportFileId: stage.reportFileId,
      hashKey: stage.hashKey,
      hash: stage.hash,
      exists: stage.exists,
      ok: stage.ok,
      status: stage.status,
      routeCount: stage.routeCount,
      actionClassCount: stage.actionClassCount,
      completionCount: stage.completionCount,
      externalWorkspaceRunnerCount: stage.externalWorkspaceRunnerCount,
      internalWorkspaceRunnerCount: stage.internalWorkspaceRunnerCount,
      requiredSummaryMetrics: stage.requiredSummaryMetrics,
      upstreamBindings: stage.upstreamBindings,
      readyForDownstream: stage.readyForDownstream,
      blockers: stage.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    postActionRuntimeStatusHash,
    hash: postActionRuntimeStatusHash,
  };
}

export function summarizePostActionRuntimeStatus(report = {}) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_post_action_runtime_status',
    ok: report?.ok === true,
    postActionRuntimeStatusHash: report?.postActionRuntimeStatusHash || null,
    stageCount: report?.summary?.stageCount || 0,
    passedStages: report?.summary?.passedStages || 0,
    routeCount: report?.summary?.routeCount || 0,
    actionClassCount: report?.summary?.actionClassCount || 0,
    completedRouteCount: report?.summary?.completedRouteCount || 0,
    externalWorkspaceRunnerCount: report?.summary?.externalWorkspaceRunnerCount || 0,
    internalWorkspaceRunnerCount: report?.summary?.internalWorkspaceRunnerCount || 0,
    finalStageId: report?.summary?.finalStageId || null,
    finalHash: report?.summary?.finalHash || null,
    upstreamBindingCount: report?.summary?.upstreamBindingCount || 0,
    upstreamBindingOkCount: report?.summary?.upstreamBindingOkCount || 0,
    requiredSummaryMetricCount: report?.summary?.requiredSummaryMetricCount || 0,
    requiredSummaryMetricOkCount: report?.summary?.requiredSummaryMetricOkCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      reportSummaryOnly: report?.safety?.reportSummaryOnly === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
      fetchesChannelState: report?.safety?.fetchesChannelState === true,
      appliesLocalStateTransition: report?.safety?.appliesLocalStateTransition === true,
      dispatchesRunner: report?.safety?.dispatchesRunner === true,
      grantsExecutionPermission: report?.safety?.grantsExecutionPermission === true,
    },
  };
}
