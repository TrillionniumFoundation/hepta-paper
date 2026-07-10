import {
  CHANNEL_IDS,
  canonicalPackageRole,
  canonicalExternalAction,
  canonicalExternalActionOrNull,
  canonicalProductLineIdOrNull,
  computeCustomerMessagePreviewHash,
} from './contracts.mjs';
import { buildAdapterRunnerCapability } from './adapter-runner-capabilities.mjs';
import {
  buildAdapterRunnerRegistry,
  selectAdapterRunnerCapability,
} from './adapter-runner-registry.mjs';
import { buildAdapterDispatchAssignment } from './adapter-dispatch-assignment.mjs';
import { computeAdapterDispatchEnvelopeHash } from './adapter-dispatch-envelope.mjs';
import {
  buildAdapterDispatchReadinessReport,
  summarizeAdapterDispatchReadinessReports,
} from './adapter-dispatch-readiness-report.mjs';
import { summarizeDispatchReadinessOperatorHints } from './dispatch-readiness-operator-hints.mjs';
import { computeChannelActionManifestHash } from './action-manifest.mjs';
import { computeAdapterRunPreviewHash } from './adapter-runner.mjs';
import { digest } from './hash-utils.mjs';

export const READ_ONLY_CONTROL_SUMMARY_VERSION = 1;

function fixedTime() {
  return new Date(0).toISOString();
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

function messagePreviewHash(messagePreview) {
  return computeCustomerMessagePreviewHash(messagePreview);
}

function buildSyntheticDispatchEnvelope({
  name,
  channelId,
  actionId,
  action,
  status = 'ready_adapter_dispatch_envelope',
  readyForExternalRunner = true,
  taskKey,
  externalId,
  productLineId,
  workflowId,
  packageRole,
  reviewType,
  role,
  artifactNames = [],
  artifactCount = artifactNames.length,
  messagePreview = null,
  humanFeedbackRevisionContractHash = null,
}) {
  const normalizedAction = canonicalExternalAction(action);
  const normalizedProductLineId = canonicalProductLineIdOrNull(productLineId);
  const normalizedWorkflowId = canonicalProductLineIdOrNull(workflowId);
  const roleFields = {};
  for (const [key, value] of Object.entries({ packageRole, reviewType, role })) {
    const normalizedValue = canonicalPackageRole(value || '');
    if (normalizedValue) roleFields[key] = normalizedValue;
  }
  const suffix = name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const approvalHash = `sha256:${suffix}-approval`;
  const evidenceHash = `sha256:${suffix}-evidence`;
  const approvalProvenanceHash = digest({ kind: 'read-only-control-approval-provenance', name });
  const previewHash = messagePreviewHash(messagePreview);
  const manifest = {
    version: 1,
    kind: 'ChannelActionManifest',
    status: status === 'ready_adapter_dispatch_envelope' ? 'ready_for_adapter' : 'blocked_manifest',
    readyForAdapter: status === 'ready_adapter_dispatch_envelope',
    channelId,
    actionId,
    action: normalizedAction,
    taskKey,
    productLineId: normalizedProductLineId,
    workflowId: normalizedWorkflowId,
    adapter: {
      channelId,
      actionId,
      dryRunDefault: true,
      executeFlagRequired: true,
      sideEffectClass: normalizedAction,
    },
    payload: {
      externalId,
      artifactNames,
      artifactCount,
      ...roleFields,
      approvalHash,
      evidenceHash,
      approvalProvenanceHash,
      humanFeedbackRevisionContractHash,
      messagePreview,
      messagePreviewHash: previewHash,
      transition: null,
    },
    blockers: [],
    warnings: [],
    evidenceRefs: [],
  };
  manifest.manifestHash = computeChannelActionManifestHash(manifest);
  manifest.hash = manifest.manifestHash;
  const preview = {
    version: 1,
    kind: 'AdapterRunPreview',
    runnerId: `${channelId}.readonly-runner`,
    status: status === 'ready_adapter_dispatch_envelope' ? 'dry_run_ready' : 'blocked_run',
    readyForDryRun: status === 'ready_adapter_dispatch_envelope',
    readyForExecution: false,
    adapter: {
      channelId,
      actionId,
      command: [],
      commandPreview: 'readonly synthetic descriptor only',
      requiredFlags: ['--dry-run'],
      requiredHashes: {
        manifestHash: manifest.manifestHash,
        approvalHash,
        evidenceHash,
        approvalProvenanceHash,
        humanFeedbackRevisionContractHash,
        messagePreviewHash: previewHash,
      },
    },
    payload: {
      taskKey,
      externalId,
      action: normalizedAction,
      productLineId: normalizedProductLineId,
      workflowId: normalizedWorkflowId,
      ...roleFields,
      artifactCount,
      artifactNames,
      manifestHash: manifest.manifestHash,
      approvalHash,
      evidenceHash,
      approvalProvenanceHash,
      humanFeedbackRevisionContractHash,
      messagePreview,
      messagePreviewHash: previewHash,
    },
    blockers: [],
    warnings: [],
    safety: safeFalseSafety({
      dryRunOnly: true,
      requiresExternalAdapter: true,
    }),
  };
  preview.previewHash = computeAdapterRunPreviewHash(preview);
  preview.hash = preview.previewHash;
  const envelope = {
    version: 1,
    kind: 'AdapterDispatchEnvelope',
    requestedBy: 'design-production-core.readonly-export.synthetic',
    status,
    readyForExternalRunner,
    dispatchRole: 'readonly_control_summary_sample',
    channelId,
    actionId,
    action: normalizedAction,
    payload: {
      taskKey,
      externalId,
      productLineId: normalizedProductLineId,
      workflowId: normalizedWorkflowId,
      ...roleFields,
      artifactNames,
      artifactCount,
      approvalProvenanceHash,
      humanFeedbackRevisionContractHash,
      messagePreview,
      messagePreviewHash: previewHash,
    },
    runner: {
      commandPreview: 'readonly synthetic descriptor only',
      requiredFlags: ['--dry-run'],
      requiredHashes: {
        outboxHash: `sha256:${suffix}-outbox`,
        replayGuardHash: `sha256:${suffix}-replay-guard`,
        archiveHash: `sha256:${suffix}-archive`,
        manifestHash: manifest.manifestHash,
        previewHash: preview.previewHash,
        approvalHash,
        evidenceHash,
        approvalProvenanceHash,
        humanFeedbackRevisionContractHash,
        messagePreviewHash: previewHash,
      },
      handoffSnapshots: { manifest, preview },
    },
    blockers: status === 'ready_adapter_dispatch_envelope'
      ? []
      : [{ level: 'error', code: 'replay_guard_not_clear', notes: null }],
    warnings: [{ level: 'warning', code: 'synthetic_readonly_envelope', notes: 'Generated only for read-only export coverage.' }],
    evidenceRefs: [],
    safety: safeFalseSafety({
      dispatchEnvelopeOnly: true,
      readyForExternalRunner,
      externalRunnerMustRecheckApproval: true,
      externalRunnerMustRecheckReplayGuard: true,
      externalRunnerMustAppendReceipt: true,
    }),
    createdAt: fixedTime(),
  };
  const dispatchEnvelopeHash = computeAdapterDispatchEnvelopeHash(envelope);
  return {
    ...envelope,
    dispatchEnvelopeHash,
    hash: dispatchEnvelopeHash,
  };
}

function compactReadinessReport(report, name) {
  const blockerCodes = (report.blockers || []).map((blocker) => blocker.code);
  return {
    name,
    status: report.status,
    readyForExternalRunner: report.readyForExternalRunner,
    channelId: report.handoff.channelId,
    actionId: report.handoff.actionId,
    action: canonicalExternalActionOrNull(report.handoff.action),
    taskKey: report.handoff.taskKey,
    productLineId: canonicalProductLineIdOrNull(report.handoff.productLineId),
    workflowId: canonicalProductLineIdOrNull(report.handoff.workflowId),
    packageRole: canonicalPackageRole(report.handoff.packageRole || '') || null,
    reviewType: canonicalPackageRole(report.handoff.reviewType || '') || null,
    role: canonicalPackageRole(report.handoff.role || '') || null,
    approvalProvenanceHash: report.handoff.approvalProvenanceHash,
    humanFeedbackRevisionContractHash: report.handoff.humanFeedbackRevisionContractHash,
    messagePreviewHash: report.handoff.messagePreviewHash,
    runnerId: report.runner.runnerId,
    reportHash: report.reportHash,
    failedCheckIds: report.checkSummary.failedCheckIds,
    blockerCodes,
    operatorHintCodes: (report.operatorHints || []).map((hint) => hint.code),
    safety: {
      executesExternalAction: report.safety.executesExternalAction,
      grantsExecutionPermission: report.safety.grantsExecutionPermission,
      readyForExecution: report.safety.readyForExecution,
      fetchesChannelState: report.safety.fetchesChannelState,
      appliesLocalStateTransition: report.safety.appliesLocalStateTransition,
    },
  };
}

function dashboardStatusForDispatchReadiness(summary, operatorHintSummary) {
  const readyHandoffs = summary.byStatus?.ready_adapter_dispatch_readiness_report || 0;
  const blockedHandoffs = summary.byStatus?.blocked_adapter_dispatch_readiness_report || 0;
  const blockers = [];
  const warnings = [];
  if ((operatorHintSummary.unknownCount || 0) > 0) {
    blockers.push({ level: 'error', code: 'unknown_dispatch_readiness_operator_hints', notes: 'Dashboard hint codes must resolve through the catalog.' });
  }
  if (operatorHintSummary.safety?.executesExternalAction === true) {
    blockers.push({ level: 'error', code: 'operator_hint_executes_external_action', notes: 'Operator hints must remain labels only.' });
  }
  if (blockedHandoffs > 0) {
    warnings.push({ level: 'warning', code: 'blocked_dispatch_handoffs_present', notes: 'Some handoffs are blocked and should be shown as operator work, not hidden.' });
  }
  return {
    version: READ_ONLY_CONTROL_SUMMARY_VERSION,
    kind: 'ReadOnlyControlDashboardStatus',
    status: blockers.length ? 'blocked_readonly_control_dashboard_status' : 'ready_readonly_control_dashboard_status',
    readyForDashboard: blockers.length === 0,
    metrics: {
      totalHandoffs: summary.count || 0,
      readyHandoffs,
      blockedHandoffs,
      operatorHintCount: operatorHintSummary.count || 0,
      operatorHintCatalogCount: operatorHintSummary.catalogCount || 0,
      unknownOperatorHintCount: operatorHintSummary.unknownCount || 0,
    },
    blockers,
    warnings,
    safety: safeFalseSafety({
      dashboardStatusOnly: true,
      readOnlyControlSummary: true,
    }),
  };
}

export function buildDispatchReadinessControlSamples() {
  const capabilities = [
    buildAdapterRunnerCapability({
      runnerId: 'zbj-auto-intake.live-runner',
      channelId: CHANNEL_IDS.ZBJ,
      runnerLocation: '../zbj-auto-intake',
      supportsExecute: true,
      supportedActionIds: ['zbj.pitchPrepareOnly', 'zbj.pitchSubmitLive', 'zbj.customerMessagePreview'],
      createdAt: fixedTime(),
    }),
    buildAdapterRunnerCapability({
      runnerId: 'epwk-auto-intake.live-runner',
      channelId: CHANNEL_IDS.EPWK,
      runnerLocation: '../epwk-auto-intake',
      supportsExecute: true,
      supportedActionIds: ['epwk.prepareOnly', 'epwk.submitLive', 'epwk.workModifyLive', 'epwk.bidSubmitLive', 'epwk.customerMessageLive', 'epwk.acceptanceApplyLive'],
      createdAt: fixedTime(),
    }),
    buildAdapterRunnerCapability({
      runnerId: 'hepta.delivery-runner',
      channelId: CHANNEL_IDS.HEPTA,
      runnerLocation: '../hepta',
      supportsExecute: true,
      supportedActionIds: ['hepta.deliveryDeploy', 'hepta.customerMessagePreview'],
      createdAt: fixedTime(),
    }),
  ];
  const registry = buildAdapterRunnerRegistry({
    capabilities,
    registryId: 'readonly-export-runner-registry',
    createdAt: fixedTime(),
  });
  const heptaSelection = selectAdapterRunnerCapability({
    registry,
    channelId: CHANNEL_IDS.HEPTA,
    actionId: 'hepta.deliveryDeploy',
    createdAt: fixedTime(),
  });
  const zbjSelection = selectAdapterRunnerCapability({
    registry,
    channelId: CHANNEL_IDS.ZBJ,
    actionId: 'zbj.pitchSubmitLive',
    createdAt: fixedTime(),
  });
  const zbjCustomerMessageSelection = selectAdapterRunnerCapability({
    registry,
    channelId: CHANNEL_IDS.ZBJ,
    actionId: 'zbj.customerMessagePreview',
    createdAt: fixedTime(),
  });
  const unsupportedEpwkSubmitSelection = selectAdapterRunnerCapability({
    registry,
    channelId: CHANNEL_IDS.EPWK,
    actionId: 'epwk.pitchSubmitLive',
    createdAt: fixedTime(),
  });
  const heptaEnvelope = buildSyntheticDispatchEnvelope({
    name: 'hepta dispatch readiness ready',
    channelId: CHANNEL_IDS.HEPTA,
    actionId: 'hepta.deliveryDeploy',
    action: 'deployment',
    taskKey: 'hepta:readonly-delivery',
    externalId: 'readonly-delivery',
    productLineId: 'vectorization',
    workflowId: 'vectorization',
    artifactNames: ['hepta-delivery.zip'],
  });
  const blockedZbjEnvelope = buildSyntheticDispatchEnvelope({
    name: 'zbj replay conflict readiness blocked',
    channelId: CHANNEL_IDS.ZBJ,
    actionId: 'zbj.pitchSubmitLive',
    action: 'live_submit',
    status: 'blocked_adapter_dispatch_envelope',
    readyForExternalRunner: false,
    taskKey: 'zbj:readonly-replay-conflict',
    externalId: 'readonly-replay-conflict',
    productLineId: 'logo_brand',
    workflowId: 'logo_brand',
    artifactNames: ['logo-01.png', 'logo-02.png'],
  });
  const humanFeedbackContractHash = `sha256:${'c'.repeat(64)}`;
  const customerMessageEnvelope = buildSyntheticDispatchEnvelope({
    name: 'zbj human feedback message readiness ready',
    channelId: CHANNEL_IDS.ZBJ,
    actionId: 'zbj.customerMessagePreview',
    action: 'consumer-feedback-message',
    taskKey: 'zbj:readonly-human-feedback-message',
    externalId: 'readonly-human-feedback-message',
    productLineId: 'consumer_feedback',
    workflowId: 'consumer-feedback',
    messagePreview: 'Customer-facing feedback revision preview.',
    humanFeedbackRevisionContractHash: humanFeedbackContractHash,
  });
  const missingContractCustomerMessageEnvelope = buildSyntheticDispatchEnvelope({
    name: 'zbj human feedback message missing contract hash',
    channelId: CHANNEL_IDS.ZBJ,
    actionId: 'zbj.customerMessagePreview',
    action: 'buyer-feedback-message',
    taskKey: 'zbj:readonly-human-feedback-message-missing-contract',
    externalId: 'readonly-human-feedback-message-missing-contract',
    productLineId: 'buyer-feedback',
    workflowId: 'post-submission-revision',
    messagePreview: 'Customer-facing feedback revision preview.',
  });
  const roleOnlyMissingContractCustomerMessageEnvelope = buildSyntheticDispatchEnvelope({
    name: 'zbj role-only human feedback message missing contract hash',
    channelId: CHANNEL_IDS.ZBJ,
    actionId: 'zbj.customerMessagePreview',
    action: 'customer_message',
    taskKey: 'zbj:readonly-role-only-human-feedback-message-missing-contract',
    externalId: 'readonly-role-only-human-feedback-message-missing-contract',
    productLineId: 'logo_brand',
    workflowId: 'logo_brand',
    packageRole: 'human-feedback-review',
    messagePreview: 'Role-only customer-facing feedback revision preview.',
  });
  const heptaCapability = capabilities.find((capability) => capability.runnerId === 'hepta.delivery-runner');
  const zbjCapability = capabilities.find((capability) => capability.runnerId === 'zbj-auto-intake.live-runner');
  const cases = [
    {
      name: 'hepta dispatch readiness ready',
      runnerSelection: heptaSelection,
      dispatchEnvelope: heptaEnvelope,
      dispatchAssignment: buildAdapterDispatchAssignment({
        dispatchEnvelope: heptaEnvelope,
        runnerCapability: heptaCapability,
        runnerSelection: heptaSelection,
        createdAt: fixedTime(),
      }),
    },
    {
      name: 'readiness blocks mismatched runner selection',
      runnerSelection: zbjSelection,
      dispatchEnvelope: heptaEnvelope,
      dispatchAssignment: buildAdapterDispatchAssignment({
        dispatchEnvelope: heptaEnvelope,
        runnerCapability: heptaCapability,
        runnerSelection: zbjSelection,
        createdAt: fixedTime(),
      }),
    },
    {
      name: 'readiness blocks unsupported epwk submit selection',
      runnerSelection: unsupportedEpwkSubmitSelection,
      dispatchEnvelope: heptaEnvelope,
      dispatchAssignment: buildAdapterDispatchAssignment({
        dispatchEnvelope: heptaEnvelope,
        runnerCapability: heptaCapability,
        runnerSelection: unsupportedEpwkSubmitSelection,
        createdAt: fixedTime(),
      }),
    },
    {
      name: 'readiness blocks replay-conflict envelope',
      runnerSelection: zbjSelection,
      dispatchEnvelope: blockedZbjEnvelope,
      dispatchAssignment: buildAdapterDispatchAssignment({
        dispatchEnvelope: blockedZbjEnvelope,
        runnerCapability: zbjCapability,
        runnerSelection: zbjSelection,
        createdAt: fixedTime(),
      }),
    },
    {
      name: 'zbj human feedback message readiness ready',
      runnerSelection: zbjCustomerMessageSelection,
      dispatchEnvelope: customerMessageEnvelope,
      dispatchAssignment: buildAdapterDispatchAssignment({
        dispatchEnvelope: customerMessageEnvelope,
        runnerCapability: zbjCapability,
        runnerSelection: zbjCustomerMessageSelection,
        createdAt: fixedTime(),
      }),
    },
    {
      name: 'readiness blocks missing human feedback contract hash',
      runnerSelection: zbjCustomerMessageSelection,
      dispatchEnvelope: missingContractCustomerMessageEnvelope,
      dispatchAssignment: buildAdapterDispatchAssignment({
        dispatchEnvelope: missingContractCustomerMessageEnvelope,
        runnerCapability: zbjCapability,
        runnerSelection: zbjCustomerMessageSelection,
        createdAt: fixedTime(),
      }),
    },
    {
      name: 'readiness blocks role-only human feedback contract hash',
      runnerSelection: zbjCustomerMessageSelection,
      dispatchEnvelope: roleOnlyMissingContractCustomerMessageEnvelope,
      dispatchAssignment: buildAdapterDispatchAssignment({
        dispatchEnvelope: roleOnlyMissingContractCustomerMessageEnvelope,
        runnerCapability: zbjCapability,
        runnerSelection: zbjCustomerMessageSelection,
        createdAt: fixedTime(),
      }),
    },
  ];
  const reports = cases.map((item) => buildAdapterDispatchReadinessReport({
    runnerRegistry: registry,
    runnerSelection: item.runnerSelection,
    dispatchEnvelope: item.dispatchEnvelope,
    dispatchAssignment: item.dispatchAssignment,
    actor: 'design-production-core.readonly-export',
    createdAt: fixedTime(),
  }));
  const summary = summarizeAdapterDispatchReadinessReports(reports);
  const operatorHintSummary = summarizeDispatchReadinessOperatorHints(
    reports.flatMap((report) => report.operatorHints || []),
  );
  const dashboardStatus = dashboardStatusForDispatchReadiness(summary, operatorHintSummary);
  return {
    version: READ_ONLY_CONTROL_SUMMARY_VERSION,
    dispatchReadiness: {
      summary,
      operatorHintSummary,
      dashboardStatus,
      reports: reports.map((report, index) => compactReadinessReport(report, cases[index].name)),
    },
    safety: {
      readOnlyControlSummary: true,
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
    },
  };
}
