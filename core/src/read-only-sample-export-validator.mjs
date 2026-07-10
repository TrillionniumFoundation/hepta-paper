import {
  PRODUCT_LINE_IDS,
  canonicalPackageRole,
  canonicalProductLineId,
  normalizeText,
} from './contracts.mjs';
import { digest } from './hash-utils.mjs';
import { buildReadOnlyDashboardSnapshot } from './read-only-dashboard-snapshot.mjs';
import { buildReadOnlySampleExportStatus } from './read-only-sample-export-status.mjs';

export const READ_ONLY_SAMPLE_EXPORT_VALIDATION_VERSION = 1;

export const READ_ONLY_SAMPLE_EXPORT_VALIDATION_STATUS = Object.freeze({
  PASS: 'pass_readonly_sample_export_validation',
  FAIL: 'fail_readonly_sample_export_validation',
});

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes) || null,
  };
}

function safeFalseSafety(extra = {}) {
  return {
    executesExternalAction: false,
    uploads: false,
    submits: false,
    sendsMessages: false,
    acceptsDelivery: false,
    pays: false,
    deploys: false,
    fetchesChannelState: false,
    appliesLocalStateTransition: false,
    grantsExecutionPermission: false,
    readyForExecution: false,
    ...extra,
  };
}

function unsafeSafetyRecords(records = []) {
  const unsafeKeys = [
    'executesExternalAction',
    'uploads',
    'submits',
    'sendsMessages',
    'acceptsDelivery',
    'pays',
    'deploys',
    'fetchesChannelState',
    'appliesLocalStateTransition',
    'grantsExecutionPermission',
    'readyForExecution',
    'externalActions',
    'providerSpend',
    'modelSpend',
    'livePrepare',
    'liveSubmit',
    'liveUpload',
    'acceptance',
    'payment',
    'deployment',
    'customerMessage',
  ];
  return records.filter((record) => unsafeKeys.some((key) => record?.[key] === true || record?.safety?.[key] === true));
}

function requiredHashValue(blockers, record, hashKey, aliasCode, genericCode, mismatchCode, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const semanticHash = normalizeText(record[hashKey]) || null;
  const genericHash = normalizeText(record.hash) || null;
  if (!semanticHash) blockers.push(issue(aliasCode, `${label} must preserve ${hashKey}.`));
  if (!genericHash) blockers.push(issue(genericCode, `${label} must preserve generic hash.`));
  if (semanticHash && genericHash && semanticHash !== genericHash) {
    blockers.push(issue(mismatchCode, `${hashKey} ${semanticHash} != hash ${genericHash}.`));
  }
  return semanticHash;
}

const REQUIRED_HUMAN_FEEDBACK_SAMPLE_SOURCES = Object.freeze(['zbj', 'epwk', 'hepta']);
const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isSha256Hash(value) {
  return SHA256_HASH_PATTERN.test(normalizeText(value || ''));
}

function isHumanFeedbackSample(sample = {}) {
  const identityFields = [
    sample.productLineId,
    sample.workflowId,
    sample.workflowProfile?.productLineId,
    sample.workflowProfile?.workflowId,
  ];
  const roleFields = [
    sample.packageRole,
    sample.reviewType,
    sample.role,
    sample.workflowProfile?.packageRole,
    sample.workflowProfile?.reviewType,
    sample.workflowProfile?.role,
    sample.humanFeedback?.packageRole,
    sample.humanFeedback?.reviewType,
    sample.humanFeedback?.role,
  ];
  return identityFields.some((value) => canonicalProductLineId(value) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK)
    || roleFields.some((value) => canonicalProductLineId(canonicalPackageRole(value)) === PRODUCT_LINE_IDS.HUMAN_FEEDBACK);
}

function canonicalIdentityIssue(value, code, owner) {
  const raw = normalizeText(value || '');
  if (!raw) return null;
  const canonical = canonicalProductLineId(raw);
  return canonical && canonical !== raw ? issue(code, `${owner}: ${raw} -> ${canonical}`) : null;
}

function canonicalPackageRoleIssue(value, code, owner) {
  const raw = normalizeText(value || '');
  if (!raw) return null;
  const canonical = canonicalPackageRole(raw);
  return canonical && canonical !== raw ? issue(code, `${owner}: ${raw} -> ${canonical}`) : null;
}

function summaryCanonicalBlockers(summary = {}) {
  const blockers = [];
  for (const key of Object.keys(summary.byProductLine || {})) {
    const blocker = canonicalIdentityIssue(key, 'summary_product_line_alias_not_canonical', 'summary.byProductLine');
    if (blocker) blockers.push(blocker);
  }
  for (const key of Object.keys(summary.byWorkflowProfile || {})) {
    const blocker = canonicalIdentityIssue(key, 'summary_workflow_alias_not_canonical', 'summary.byWorkflowProfile');
    if (blocker) blockers.push(blocker);
  }
  return blockers;
}

function sampleCanonicalBlockers(sample = {}) {
  const owner = sample.taskKey || sample.source || 'sample';
  return [
    canonicalIdentityIssue(sample.productLineId, 'sample_product_line_alias_not_canonical', owner),
    canonicalIdentityIssue(sample.workflowId, 'sample_workflow_alias_not_canonical', owner),
    canonicalIdentityIssue(sample.workflowProfile?.productLineId, 'sample_workflow_profile_product_line_alias_not_canonical', owner),
    canonicalIdentityIssue(sample.workflowProfile?.workflowId, 'sample_workflow_profile_workflow_alias_not_canonical', owner),
    canonicalPackageRoleIssue(sample.packageRole, 'sample_package_role_alias_not_canonical', owner),
    canonicalPackageRoleIssue(sample.reviewType, 'sample_review_type_alias_not_canonical', owner),
    canonicalPackageRoleIssue(sample.role, 'sample_role_alias_not_canonical', owner),
    canonicalPackageRoleIssue(sample.workflowProfile?.packageRole, 'sample_workflow_profile_package_role_alias_not_canonical', owner),
    canonicalPackageRoleIssue(sample.workflowProfile?.reviewType, 'sample_workflow_profile_review_type_alias_not_canonical', owner),
    canonicalPackageRoleIssue(sample.workflowProfile?.role, 'sample_workflow_profile_role_alias_not_canonical', owner),
  ].filter(Boolean);
}

function unsupportedInventoryCanonicalBlockers(item = {}) {
  const owner = item.taskKey || item.source || 'unsupportedInventory';
  return [
    canonicalIdentityIssue(item.productLineId, 'unsupported_inventory_product_line_alias_not_canonical', owner),
    canonicalIdentityIssue(item.workflowId, 'unsupported_inventory_workflow_alias_not_canonical', owner),
    canonicalPackageRoleIssue(item.packageRole, 'unsupported_inventory_package_role_alias_not_canonical', owner),
    canonicalPackageRoleIssue(item.reviewType, 'unsupported_inventory_review_type_alias_not_canonical', owner),
    canonicalPackageRoleIssue(item.role, 'unsupported_inventory_role_alias_not_canonical', owner),
  ].filter(Boolean);
}

export function validateReadOnlySampleExportPayload({
  payload = null,
  actor = 'design-production-core.readonly-sample-export-validator',
  generatedAt = null,
} = {}) {
  const blockers = [];
  const warnings = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    blockers.push(issue('payload_missing', 'Read-only sample export payload is required.'));
  }

  const summary = payload?.summary || null;
  const controlPlane = payload?.controlPlane || null;
  const dashboardSnapshot = payload?.dashboardSnapshot || null;
  const exportStatus = payload?.exportStatus || null;
  const unsupportedInventory = payload?.unsupportedInventory || null;
  const samples = Array.isArray(payload?.samples) ? payload.samples : [];

  if (payload && payload.version !== 1) {
    blockers.push(issue('payload_version_unsupported', `Expected payload version 1, got ${payload.version}.`));
  }
  if (!summary) blockers.push(issue('summary_missing', 'Payload is missing summary.'));
  if (!controlPlane) blockers.push(issue('control_plane_missing', 'Payload is missing controlPlane.'));
  if (!dashboardSnapshot) blockers.push(issue('dashboard_snapshot_missing', 'Payload is missing dashboardSnapshot.'));
  if (!exportStatus) blockers.push(issue('export_status_missing', 'Payload is missing exportStatus.'));
  if (!Array.isArray(payload?.samples)) blockers.push(issue('samples_missing', 'Payload is missing samples array.'));
  if (payload && !unsupportedInventory) blockers.push(issue('unsupported_inventory_missing', 'Payload is missing unsupportedInventory.'));

  if (unsafeSafetyRecords([payload, payload?.safety, summary, controlPlane, dashboardSnapshot, exportStatus]).length > 0) {
    blockers.push(issue('readonly_export_payload_claims_external_action', 'Read-only sample export payload must not claim external action capability.'));
  }
  if (payload?.safety?.readOnly !== true) {
    blockers.push(issue('payload_readonly_safety_missing', 'Payload safety.readOnly must be true.'));
  }
  const dashboardSnapshotHash = requiredHashValue(
    blockers,
    dashboardSnapshot,
    'snapshotHash',
    'dashboard_snapshot_hash_alias_required',
    'dashboard_snapshot_generic_hash_required',
    'dashboard_snapshot_hash_alias_mismatch',
    'Dashboard snapshot',
  );
  const exportStatusHash = requiredHashValue(
    blockers,
    exportStatus,
    'statusHash',
    'export_status_hash_alias_required',
    'export_status_generic_hash_required',
    'export_status_hash_alias_mismatch',
    'Export status',
  );

  if (summary && Array.isArray(payload?.samples) && Number(summary.sampleCount) !== samples.length) {
    blockers.push(issue('sample_count_mismatch', `summary.sampleCount=${summary.sampleCount}, samples.length=${samples.length}.`));
  }
  if (summary) blockers.push(...summaryCanonicalBlockers(summary));
  for (const sample of samples) {
    blockers.push(...sampleCanonicalBlockers(sample));
  }
  const humanFeedbackSamples = samples.filter(isHumanFeedbackSample);
  const humanFeedbackSummary = summary?.humanFeedback || null;
  if (summary && !humanFeedbackSummary) {
    blockers.push(issue('human_feedback_sample_coverage_missing', 'Payload summary must include human-feedback sample coverage.'));
  }
  if (humanFeedbackSummary) {
    const bySource = humanFeedbackSummary.bySource || {};
    const missingSources = (humanFeedbackSummary.requiredSources || REQUIRED_HUMAN_FEEDBACK_SAMPLE_SOURCES)
      .filter((source) => Number(bySource[source] || 0) < 1);
    if (Number(humanFeedbackSummary.sampleCount || 0) !== humanFeedbackSamples.length) {
      blockers.push(issue('human_feedback_sample_count_mismatch', `summary=${humanFeedbackSummary.sampleCount || 0}, samples=${humanFeedbackSamples.length}.`));
    }
    if (humanFeedbackSamples.length < REQUIRED_HUMAN_FEEDBACK_SAMPLE_SOURCES.length || missingSources.length) {
      blockers.push(issue('human_feedback_sample_source_coverage_required', missingSources.join(', ') || `sampleCount=${humanFeedbackSamples.length}`));
    }
    if (Number(humanFeedbackSummary.contractReadyCount || 0) !== humanFeedbackSamples.length) {
      blockers.push(issue('human_feedback_sample_contract_validation_required', `ready=${humanFeedbackSummary.contractReadyCount || 0}, total=${humanFeedbackSamples.length}`));
    }
    if (Number(humanFeedbackSummary.customerFacingReadyCount || 0) !== humanFeedbackSamples.length) {
      blockers.push(issue('human_feedback_sample_customer_facing_validation_required', `ready=${humanFeedbackSummary.customerFacingReadyCount || 0}, total=${humanFeedbackSamples.length}`));
    }
  }
  for (const sample of humanFeedbackSamples) {
    const feedback = sample.humanFeedback || {};
    if (!isSha256Hash(feedback.contractHash)) {
      blockers.push(issue('human_feedback_sample_contract_hash_required', sample.taskKey || sample.source || null));
    }
    if (!isSha256Hash(feedback.messagePreviewHash)) {
      blockers.push(issue('human_feedback_sample_message_preview_hash_required', sample.taskKey || sample.source || null));
    }
    if (feedback.contractValidation?.ok !== true) {
      blockers.push(issue('human_feedback_sample_contract_validation_required', sample.taskKey || sample.source || null));
    }
    if (feedback.customerFacingValidation?.ok !== true) {
      blockers.push(issue('human_feedback_sample_customer_facing_validation_required', sample.taskKey || sample.source || null));
    }
  }
  const unsupportedSamples = samples.filter((sample) => (sample.planOnly?.blockers || []).length > 0);
  if (unsupportedInventory) {
    const inventoryItems = Array.isArray(unsupportedInventory.items) ? unsupportedInventory.items : [];
    if (unsupportedInventory.safety?.grantsExecutionPermission === true || unsupportedInventory.safety?.externalActions === true) {
      blockers.push(issue('unsupported_inventory_claims_execution', 'Unsupported inventory must remain read-only and non-executing.'));
    }
    if (Number(unsupportedInventory.count || 0) !== inventoryItems.length) {
      blockers.push(issue('unsupported_inventory_count_mismatch', `unsupportedInventory.count=${unsupportedInventory.count}, items.length=${inventoryItems.length}.`));
    }
    if (Number(unsupportedInventory.count || 0) !== unsupportedSamples.length) {
      blockers.push(issue('unsupported_inventory_sample_mismatch', `unsupportedInventory.count=${unsupportedInventory.count}, blocked samples=${unsupportedSamples.length}.`));
    }
    const inventoryKeys = new Set(inventoryItems.map((item) => `${item.source || ''}:${item.taskKey || ''}`));
    for (const sample of unsupportedSamples) {
      const key = `${sample.source || ''}:${sample.taskKey || ''}`;
      if (!inventoryKeys.has(key)) {
        blockers.push(issue('unsupported_inventory_missing_sample', key));
      }
    }
    for (const item of inventoryItems) {
      blockers.push(...unsupportedInventoryCanonicalBlockers(item));
    }
  }

  let recomputedDashboardSnapshot = null;
  if (summary && controlPlane && dashboardSnapshot) {
    recomputedDashboardSnapshot = buildReadOnlyDashboardSnapshot({
      sampleSummary: summary,
      controlPlane,
      samples,
      actor: dashboardSnapshot.actor,
      generatedAt: dashboardSnapshot.generatedAt || payload?.generatedAt || generatedAt,
    });
    const expectedHash = recomputedDashboardSnapshot.snapshotHash;
    const actualHash = dashboardSnapshotHash;
    if (actualHash !== expectedHash) {
      blockers.push(issue('dashboard_snapshot_hash_mismatch', `Expected ${expectedHash}, got ${actualHash || 'missing'}.`));
    }
    if (dashboardSnapshot.status !== recomputedDashboardSnapshot.status) {
      blockers.push(issue('dashboard_snapshot_status_mismatch', `Expected ${recomputedDashboardSnapshot.status}, got ${dashboardSnapshot.status}.`));
    }
    if (dashboardSnapshot.readyForDashboard !== recomputedDashboardSnapshot.readyForDashboard) {
      blockers.push(issue('dashboard_snapshot_ready_mismatch', 'Dashboard snapshot readyForDashboard does not match recomputed value.'));
    }
  }

  let recomputedExportStatus = null;
  if (summary && dashboardSnapshot && exportStatus) {
    recomputedExportStatus = buildReadOnlySampleExportStatus({
      sampleSummary: summary,
      dashboardSnapshot,
      actor: exportStatus.actor,
      generatedAt: exportStatus.generatedAt || payload?.generatedAt || generatedAt,
    });
    const expectedHash = recomputedExportStatus.statusHash;
    const actualHash = exportStatusHash;
    if (actualHash !== expectedHash) {
      blockers.push(issue('export_status_hash_mismatch', `Expected ${expectedHash}, got ${actualHash || 'missing'}.`));
    }
    if (exportStatus.status !== recomputedExportStatus.status) {
      blockers.push(issue('export_status_status_mismatch', `Expected ${recomputedExportStatus.status}, got ${exportStatus.status}.`));
    }
    if (exportStatus.ok !== recomputedExportStatus.ok) {
      blockers.push(issue('export_status_ok_mismatch', 'Export status ok flag does not match recomputed value.'));
    }
  }

  if (payload && exportStatus) {
    if (payload.status !== exportStatus.status) {
      blockers.push(issue('payload_status_export_status_mismatch', `Payload status ${payload.status} does not match exportStatus ${exportStatus.status}.`));
    }
    if (payload.ok !== exportStatus.ok) {
      blockers.push(issue('payload_ok_export_status_mismatch', 'Payload ok flag does not match exportStatus ok flag.'));
    }
  }

  if (summary?.planOnlyBlocked > 0) {
    warnings.push(issue('plan_only_blocked_samples_present', `${summary.planOnlyBlocked} samples have plan-only blockers.`, 'warning'));
  }
  const dashboardWarningCount = Array.isArray(dashboardSnapshot?.warnings) ? dashboardSnapshot.warnings.length : 0;
  if (dashboardWarningCount > 0) {
    warnings.push(issue('dashboard_snapshot_warnings_present', `${dashboardWarningCount} dashboard warnings are present.`, 'warning'));
  }
  const dashboardMetrics = dashboardSnapshot?.metrics && typeof dashboardSnapshot.metrics === 'object'
    ? dashboardSnapshot.metrics
    : {};

  const status = blockers.length
    ? READ_ONLY_SAMPLE_EXPORT_VALIDATION_STATUS.FAIL
    : READ_ONLY_SAMPLE_EXPORT_VALIDATION_STATUS.PASS;
  const report = {
    version: READ_ONLY_SAMPLE_EXPORT_VALIDATION_VERSION,
    kind: 'ReadOnlySampleExportValidationReport',
    actor: normalizeText(actor) || 'design-production-core.readonly-sample-export-validator',
    status,
    ok: status === READ_ONLY_SAMPLE_EXPORT_VALIDATION_STATUS.PASS,
    metrics: {
      sampleCount: Number(summary?.sampleCount || 0),
      actualSampleCount: samples.length,
      planOnlyBlocked: Number(summary?.planOnlyBlocked || 0),
      humanFeedbackSampleCount: Number(humanFeedbackSummary?.sampleCount || 0),
      humanFeedbackActualSampleCount: humanFeedbackSamples.length,
      humanFeedbackContractReadyCount: Number(humanFeedbackSummary?.contractReadyCount || 0),
      humanFeedbackCustomerFacingReadyCount: Number(humanFeedbackSummary?.customerFacingReadyCount || 0),
      unsupportedInventoryCount: Number(unsupportedInventory?.count || 0),
      dispatchTotalHandoffs: Number(dashboardMetrics.dispatchReadyHandoffs || 0) + Number(dashboardMetrics.dispatchBlockedHandoffs || 0),
      dispatchReadyHandoffs: Number(dashboardMetrics.dispatchReadyHandoffs || 0),
      dispatchBlockedHandoffs: Number(dashboardMetrics.dispatchBlockedHandoffs || 0),
      dispatchApprovalProvenanceBoundHandoffs: Number(dashboardMetrics.dispatchApprovalProvenanceBoundHandoffs || 0),
      operatorHintCount: Number(dashboardMetrics.operatorHintCount || 0),
      unknownOperatorHintCount: Number(dashboardMetrics.unknownOperatorHintCount || 0),
      dashboardWarningCount,
      dashboardBlockerCount: Array.isArray(dashboardSnapshot?.blockers) ? dashboardSnapshot.blockers.length : 0,
      exportStatusBlockerCount: Array.isArray(exportStatus?.blockers) ? exportStatus.blockers.length : 0,
    },
    hashChecks: {
      dashboardSnapshotHash,
      recomputedDashboardSnapshotHash: recomputedDashboardSnapshot?.snapshotHash || null,
      exportStatusHash,
      recomputedExportStatusHash: recomputedExportStatus?.statusHash || null,
    },
    blockers,
    warnings,
    safety: safeFalseSafety({
      readOnlySampleExportValidation: true,
      validatesReportOnly: true,
      recomputesHashesOnly: true,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckEvidence: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustRecheckChannelState: true,
    }),
    generatedAt: generatedAt || new Date().toISOString(),
  };
  const validationHash = digest({
    version: report.version,
    kind: report.kind,
    actor: report.actor,
    status: report.status,
    ok: report.ok,
    metrics: report.metrics,
    hashChecks: report.hashChecks,
    blockers: report.blockers,
    warnings: report.warnings,
    safety: report.safety,
  });
  return {
    ...report,
    validationHash,
    hash: validationHash,
  };
}

export function summarizeReadOnlySampleExportValidations(reports = []) {
  const byStatus = {};
  let passCount = 0;
  let failCount = 0;
  for (const report of reports || []) {
    byStatus[report.status] = (byStatus[report.status] || 0) + 1;
    if (report.ok === true) passCount += 1;
    if ((report.blockers || []).length > 0) failCount += 1;
  }
  return {
    version: READ_ONLY_SAMPLE_EXPORT_VALIDATION_VERSION,
    count: reports.length,
    passCount,
    failCount,
    byStatus,
    safety: safeFalseSafety({
      readOnlySampleExportValidationSummary: true,
      executesExternalAction: reports.some((report) => report.safety?.executesExternalAction === true),
      fetchesChannelState: reports.some((report) => report.safety?.fetchesChannelState === true),
      appliesLocalStateTransition: reports.some((report) => report.safety?.appliesLocalStateTransition === true),
      grantsExecutionPermission: reports.some((report) => report.safety?.grantsExecutionPermission === true),
      readyForExecution: reports.some((report) => report.safety?.readyForExecution === true),
    }),
  };
}
