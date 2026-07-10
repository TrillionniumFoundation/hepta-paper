import {
  CHANNEL_IDS,
  CORE_STAGES,
  EXTERNAL_ACTIONS,
  OUTPUT_MODES,
  PRODUCT_LINE_IDS,
  canonicalExternalAction,
  canonicalProductLineId,
  canonicalProductLineIdOrNull,
  createArtifactPackage,
  createChannelTask,
  createCreativeBrief,
  createProductionPlanEnvelope,
  createReviewReport,
  normalizeText,
} from './contracts.mjs';
import {
  EXECUTION_POLICIES,
  evaluateExecutionGate,
} from './execution-gates.mjs';
import {
  HUMAN_FEEDBACK_PREVIEW_CLASSES,
  createHumanFeedbackRevisionContract,
} from './human-feedback-contracts.mjs';
import {
  buildApprovalPacket,
  buildFreshEvidenceBundle,
} from './approval-packets.mjs';
import { applyStateTransition } from './state-machine.mjs';
import { buildChannelActionManifest } from './action-manifest.mjs';
import { buildAdapterRunPreview } from './adapter-runner.mjs';
import { buildExternalActionLedgerEntry } from './external-action-ledger.mjs';
import { buildAdapterHandoffOutboxItem } from './adapter-handoff-outbox.mjs';
import { buildExternalActionReplayGuardDecision } from './external-action-replay-guard.mjs';
import { buildAdapterDispatchEnvelope } from './adapter-dispatch-envelope.mjs';
import { buildAdapterRunnerCapability } from './adapter-runner-capabilities.mjs';
import { ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE } from './adapter-runner-location-boundary.mjs';
import {
  buildAdapterRunnerRegistry,
  selectAdapterRunnerCapability,
} from './adapter-runner-registry.mjs';
import { buildAdapterDispatchAssignment } from './adapter-dispatch-assignment.mjs';
import { buildAdapterDispatchReadinessReport } from './adapter-dispatch-readiness-report.mjs';
import { buildAdapterRunnerSdkContract } from './adapter-runner-sdk.mjs';
import { createGenerationJob } from './generation-contracts.mjs';
import { digest } from './hash-utils.mjs';

export const RUNTIME_DRY_RUN_HARNESS_VERSION = 1;

export const RUNTIME_DRY_RUN_HARNESS_STATUS = Object.freeze({
  PASS: 'pass_runtime_dry_run_harness',
  FAIL: 'fail_runtime_dry_run_harness',
});

const FIXED_CREATED_AT = '2026-06-08T04:00:00.000Z';

function actionToken(action) {
  return normalizeText(action || '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function readyHandoffScenario({
  channelId,
  action,
  adapterActionId = null,
  actionVariant = null,
  label = null,
  runnerLocation = null,
  fromStage = null,
  toStage = null,
  outputMode = null,
  productLineId = null,
  workflowId = null,
  artifactExtension = null,
  packageRole = null,
  humanFeedbackContract = null,
  humanFeedbackRevisionContract = null,
  deploymentTarget = null,
  buildEvidence = null,
  messagePreview = null,
} = {}) {
  const normalizedAction = canonicalExternalAction(action || EXTERNAL_ACTIONS.NONE);
  const normalizedProductLineId = canonicalProductLineIdOrNull(productLineId);
  const normalizedWorkflowId = canonicalProductLineIdOrNull(workflowId);
  const variantToken = actionVariant || adapterActionId || normalizedAction;
  return Object.freeze({
    scenarioId: `ready_${channelId}_${actionToken(variantToken)}_handoff`,
    label: label || `Ready ${channelId.toUpperCase()} ${String(variantToken).replace(/_/g, '-')} handoff reaches SDK contract without core execution`,
    channelId,
    action: normalizedAction,
    adapterActionId,
    actionVariant,
    runnerLocation,
    fromStage,
    toStage,
    outputMode,
    productLineId: normalizedProductLineId,
    workflowId: normalizedWorkflowId,
    artifactExtension,
    packageRole,
    humanFeedbackContract,
    humanFeedbackRevisionContract,
    deploymentTarget,
    buildEvidence,
    messagePreview,
    expectedReady: true,
    expectedBlockers: [],
  });
}

const READY_HANDOFF_SCENARIOS = Object.freeze([
  Object.freeze({
    channelId: CHANNEL_IDS.ZBJ,
    action: EXTERNAL_ACTIONS.PROVIDER_SPEND,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.ZBJ,
    action: EXTERNAL_ACTIONS.MODEL_SPEND,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.ZBJ,
    action: EXTERNAL_ACTIONS.LIVE_PREPARE,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.ZBJ,
    action: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.ZBJ,
    action: EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
    packageRole: 'delivery',
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.ZBJ,
    action: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
    actionVariant: 'human_feedback_message',
    label: 'Ready ZBJ human feedback message handoff requires a complete revision contract',
    productLineId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    workflowId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    packageRole: 'human_feedback_revision',
    humanFeedbackContract: true,
    messagePreview: 'Customer-facing feedback revision preview.',
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.EPWK,
    action: EXTERNAL_ACTIONS.PROVIDER_SPEND,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.EPWK,
    action: EXTERNAL_ACTIONS.MODEL_SPEND,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.EPWK,
    action: EXTERNAL_ACTIONS.LIVE_PREPARE,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.EPWK,
    action: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.EPWK,
    action: EXTERNAL_ACTIONS.LIVE_SUBMIT,
    adapterActionId: 'epwk.workModifyLive',
    actionVariant: 'work_modify_live',
    label: 'Ready EPWK work modify handoff reaches SDK contract without core execution',
    fromStage: CORE_STAGES.SUBMITTED_VERIFIED,
    toStage: CORE_STAGES.SUBMITTED_VERIFIED,
    productLineId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    workflowId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    packageRole: 'human_feedback_revision',
    humanFeedbackContract: true,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.EPWK,
    action: EXTERNAL_ACTIONS.LIVE_SUBMIT,
    adapterActionId: 'epwk.bidSubmitLive',
    actionVariant: 'bid_submit_live',
    label: 'Ready EPWK bid submit handoff reaches SDK contract without core execution',
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.EPWK,
    action: EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
    packageRole: 'delivery',
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.EPWK,
    action: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.EPWK,
    action: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
    actionVariant: 'human_feedback_message',
    label: 'Ready EPWK human feedback message handoff requires a complete revision contract',
    productLineId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    workflowId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    packageRole: 'human_feedback_revision',
    humanFeedbackContract: true,
    messagePreview: 'Customer-facing EPWK feedback revision preview.',
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.HEPTA,
    action: EXTERNAL_ACTIONS.PROVIDER_SPEND,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.HEPTA,
    action: EXTERNAL_ACTIONS.MODEL_SPEND,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.HEPTA,
    action: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.HEPTA,
    action: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
    actionVariant: 'human_feedback_message',
    label: 'Ready HEPTA human feedback message handoff requires a complete revision contract',
    productLineId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    workflowId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    packageRole: 'human_feedback_revision',
    humanFeedbackContract: true,
    messagePreview: 'Customer-facing HEPTA feedback revision preview.',
  }),
  Object.freeze({
    channelId: CHANNEL_IDS.HEPTA,
    action: EXTERNAL_ACTIONS.DEPLOYMENT,
    outputMode: OUTPUT_MODES.VECTOR_PACKAGE,
    artifactExtension: 'zip',
    packageRole: 'delivery',
  }),
].map(readyHandoffScenario));

const FAIL_CLOSED_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'execute_flag_blocked_in_core',
    label: 'A core execute flag blocks before outbox and dispatch',
    execute: true,
    expectedReady: false,
    expectedBlockers: [
      'execute_not_allowed_in_core_stub',
      'preview_not_ready',
      'outbox_not_queued',
      'dispatch_readiness_not_ready',
    ],
  }),
  Object.freeze({
    scenarioId: 'missing_replay_guard_blocks_dispatch',
    label: 'Dispatch cannot become ready without replay guard evidence',
    omitReplayGuard: true,
    expectedReady: false,
    expectedBlockers: [
      'replay_guard_required',
      'dispatch_envelope_not_ready',
      'dispatch_readiness_not_ready',
    ],
  }),
  Object.freeze({
    scenarioId: 'unsupported_runner_route_blocks_assignment',
    label: 'A runner that does not own the action cannot receive dispatch',
    runnerActionOverride: 'zbj.pitchPrepareOnly',
    expectedReady: false,
    expectedBlockers: [
      'runner_route_not_found',
      'runner_action_not_supported',
      'dispatch_readiness_not_ready',
    ],
  }),
  Object.freeze({
    scenarioId: 'core_local_runner_location_blocks_handoff',
    label: 'A runner path inside core blocks before external handoff',
    runnerLocation: './src',
    expectedReady: false,
    expectedBlockers: [
      ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE,
      'runner_capability_not_ready',
      'runner_selection_not_ready',
      'dispatch_readiness_not_ready',
    ],
  }),
  Object.freeze({
    scenarioId: 'human_feedback_missing_contract_blocks_message',
    label: 'Human feedback message cannot leave core without a revision contract',
    channelId: CHANNEL_IDS.ZBJ,
    action: EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
    productLineId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    workflowId: PRODUCT_LINE_IDS.HUMAN_FEEDBACK,
    packageRole: 'human_feedback_revision',
    humanFeedbackContract: false,
    expectedReady: false,
    expectedBlockers: [
      'human_feedback_revision_contract_required',
      'execution_gate_not_allowed',
      'preview_not_ready',
      'outbox_not_queued',
      'dispatch_readiness_not_ready',
    ],
  }),
]);

const SCENARIOS = Object.freeze([
  ...READY_HANDOFF_SCENARIOS,
  ...FAIL_CLOSED_SCENARIOS,
]);

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes || '') || null,
  };
}

function policyForAction(action) {
  if (action === EXTERNAL_ACTIONS.DEPLOYMENT) return EXECUTION_POLICIES.DEPLOYMENT_ALLOWED;
  if (action === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) return EXECUTION_POLICIES.ACCEPTANCE_ALLOWED;
  if (action === EXTERNAL_ACTIONS.LIVE_PREPARE) return EXECUTION_POLICIES.PREPARE_ALLOWED;
  if (action === EXTERNAL_ACTIONS.PROVIDER_SPEND || action === EXTERNAL_ACTIONS.MODEL_SPEND) return EXECUTION_POLICIES.SPEND_ALLOWED;
  return EXECUTION_POLICIES.SUBMIT_ALLOWED;
}

function runnerLocationForChannel(channelId) {
  if (channelId === CHANNEL_IDS.EPWK) return '../epwk-auto-intake';
  if (channelId === CHANNEL_IDS.HEPTA) return '../hepta';
  return '../zbj-auto-intake';
}

function defaultTransitionForAction(action) {
  const normalizedAction = canonicalExternalAction(action);
  if (normalizedAction === EXTERNAL_ACTIONS.PROVIDER_SPEND) {
    return {
      fromStage: CORE_STAGES.PLAN_READY,
      toStage: CORE_STAGES.GENERATION_READY,
    };
  }
  if (normalizedAction === EXTERNAL_ACTIONS.MODEL_SPEND) {
    return {
      fromStage: CORE_STAGES.PLAN_READY,
      toStage: CORE_STAGES.GENERATION_READY,
    };
  }
  if (normalizedAction === EXTERNAL_ACTIONS.LIVE_PREPARE) {
    return {
      fromStage: CORE_STAGES.REVIEW_READY,
      toStage: CORE_STAGES.PREPARE_READY,
    };
  }
  if (normalizedAction === EXTERNAL_ACTIONS.LIVE_SUBMIT) {
    return {
      fromStage: CORE_STAGES.SUBMIT_READY,
      toStage: CORE_STAGES.SUBMITTED_VERIFIED,
    };
  }
  if (normalizedAction === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) {
    return {
      fromStage: CORE_STAGES.DELIVERY_READY,
      toStage: CORE_STAGES.DELIVERY_READY,
    };
  }
  if (normalizedAction === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) {
    return {
      fromStage: CORE_STAGES.SUBMITTED_VERIFIED,
      toStage: CORE_STAGES.SUBMITTED_VERIFIED,
    };
  }
  if (normalizedAction === EXTERNAL_ACTIONS.DEPLOYMENT) {
    return {
      fromStage: CORE_STAGES.REVIEW_READY,
      toStage: CORE_STAGES.DELIVERY_READY,
    };
  }
  return {
    fromStage: CORE_STAGES.CHANNEL_DISCOVERED,
    toStage: CORE_STAGES.BRIEF_NORMALIZED,
  };
}

function isPromptGenerationSpendAction(action) {
  const normalizedAction = canonicalExternalAction(action);
  return normalizedAction === EXTERNAL_ACTIONS.PROVIDER_SPEND || normalizedAction === EXTERNAL_ACTIONS.MODEL_SPEND;
}

function promptGenerationPlanForScenario(plan, scenario = {}, action = EXTERNAL_ACTIONS.NONE) {
  if (!isPromptGenerationSpendAction(action)) return plan;
  const seed = {
    fixture: 'runtime-dry-run-harness',
    scenarioId: scenario.scenarioId,
    channelId: plan.channelId,
    action,
  };
  const retrievalHash = digest({ ...seed, kind: 'retrieval' });
  const compilerHash = digest({ ...seed, kind: 'artifact-compiler' });
  const promptCompilerHash = digest({ ...seed, kind: 'prompt-compiler', compilerHash });
  const readinessHash = digest({ ...seed, kind: 'readiness', promptCompilerHash });
  const promptProductionContractHash = digest({
    ...seed,
    kind: 'prompt-production-contract',
    promptCompilerHash,
    readinessHash,
    retrievalHash,
  });
  const routeStrategyHash = digest({ ...seed, kind: 'route-strategy' });
  const refpackId = 'refpack_general_technology_b2b_v1';
  const promptPlanBase = {
    ...plan,
    taskId: plan.taskKey,
    title: `Runtime dry-run ${plan.channelId} prompt generation fixture`,
    designReferenceSpec: { id: refpackId },
    designReferenceRetrieval: {
      ok: true,
      status: 'model_locked_static_refpack',
      routingMode: 'model_semantic_locked',
      selectionAuthority: 'semantic_intake',
      indexRoutingActive: false,
      indexOverrideAllowed: false,
      retrievalHash,
      selectedRefpackId: refpackId,
      staticRefpackId: refpackId,
      selectedIndustryId: 'general_technology_b2b',
      industryArbitration: {
        ok: true,
        status: 'pass_model_industry_arbitration',
        modelIndustryId: 'general_technology_b2b',
        confidence: 0.91,
        blockers: [],
      },
      blockers: [],
    },
    promptCompiler: {
      kind: 'PromptCompilerPlanSummary',
      status: 'prompt_compiler_ready',
      promptCompilerHash,
      retrievalHash,
      refpackId,
      compilerHashes: [compilerHash],
    },
    promptReadiness: {
      kind: 'PromptReadinessReport',
      ok: true,
      status: 'pass_prompt_readiness',
      readinessHash,
      promptCompilerHash,
      refreshedPromptCompilerHash: promptCompilerHash,
      retrievalHash,
      blockers: [],
      safety: { callsProviderOrModel: false, grantsExecutionPermission: false },
    },
    promptProductionContract: {
      kind: 'PromptProductionContract',
      ok: true,
      status: 'pass_prompt_production_contract',
      promptProductionContractHash,
      promptCompilerHash,
      readinessHash,
      retrievalHash,
      refpackId,
      blockers: [],
      safety: {
        executesExternalAction: false,
        callsProvider: false,
        callsModel: false,
        callsProviderOrModel: false,
        opensBrowser: false,
        uploads: false,
        submits: false,
        sendsMessage: false,
        acceptsDelivery: false,
        pays: false,
        deploys: false,
        fetchesChannelState: false,
        appliesLocalStateTransition: false,
        grantsExecutionPermission: false,
      },
    },
    prompts: [{
      index: 1,
      filename: `runtime-dry-run-${plan.channelId}-prompt-01.png`,
      role: 'finished_vi_board',
      prompt: 'Create a prompt-locked runtime dry-run fixture.',
      acceptance: ['application proof'],
      routeStrategy: {
        version: 1,
        routeId: 'runtime-dry-run-route',
        focus: 'wordmark-first route with application proof',
        differentiationKey: 'runtime dry-run prompt route',
        applicationProof: ['dashboard mockup', 'signage proof'],
        routeStrategyHash,
      },
      promptCompiler: {
        kind: 'PromptCompilerArtifact',
        status: 'prompt_compiled',
        compilerHash,
        routeStrategyHash,
      },
    }],
  };
  const generationJob = createGenerationJob({
    plan: promptPlanBase,
    providerSelection: { providerId: 'runtime-dry-run', kind: 'dryrun', externalCalls: false },
    execute: true,
    dryRun: false,
    now: 0,
  });
  return {
    ...promptPlanBase,
    generationJob,
  };
}

function humanFeedbackContractForScenario(scenario = {}, { channelTask } = {}) {
  if (scenario.humanFeedbackContract === false) return null;
  if (scenario.humanFeedbackRevisionContract) return scenario.humanFeedbackRevisionContract;
  if (scenario.humanFeedbackContract !== true) return null;
  return createHumanFeedbackRevisionContract({
    taskKey: channelTask?.taskKey || null,
    channelId: channelTask?.channelId || null,
    externalId: channelTask?.externalId || null,
    sourceSnapshot: {
      hash: `sha256:${'a'.repeat(64)}`,
      refreshedAt: FIXED_CREATED_AT,
      refs: [{ kind: 'fixture', ref: 'runtime-dry-run-harness/human-feedback-im-history', hash: `sha256:${'b'.repeat(64)}` }],
    },
    targetArtifact: {
      artifactId: 'fixture-01',
      filename: `runtime-dry-run-${channelTask?.channelId || 'zbj'}-01.png`,
      hash: `sha256:${'1'.repeat(64)}`,
    },
    baselineInvariantLock: {
      locked: true,
      lockedFacts: ['keep submitted layout, approved text, and buyer source materials unchanged'],
      invariantHashes: [`sha256:${'c'.repeat(64)}`],
    },
    atomicQueue: [
      { id: 'hfr-001', status: 'active', description: 'apply the one buyer feedback correction bound to the target artifact' },
      { id: 'hfr-002', status: 'pending', description: 'hold all later buyer feedback for the next iteration' },
    ],
    activeAtomicChange: 'hfr-001',
    unchangedRegressionChecklist: ['submitted artifact identity remains bound', 'unchanged baseline facts remain intact'],
    previewClass: HUMAN_FEEDBACK_PREVIEW_CLASSES.CUSTOMER_FACING_REVISION,
    exitAction: canonicalExternalAction(scenario.action || EXTERNAL_ACTIONS.CUSTOMER_MESSAGE),
    reviewGate: {
      kind: 'ReviewReport',
      ok: true,
      decision: 'pass',
      reviewType: 'human_feedback_revision',
      activeAtomicChangeId: 'hfr-001',
      targetArtifact: {
        artifactId: 'fixture-01',
        hash: `sha256:${'1'.repeat(64)}`,
      },
      artifactHashes: [{
        artifactId: 'fixture-01',
        filename: `runtime-dry-run-${channelTask?.channelId || 'zbj'}-01.png`,
        hash: `sha256:${'1'.repeat(64)}`,
      }],
      humanFeedbackRevisionContract: {
        kind: 'HumanFeedbackRevisionContract',
        activeAtomicChange: {
          id: 'hfr-001',
          description: 'apply the one buyer feedback correction bound to the target artifact',
        },
        targetArtifact: {
          artifactId: 'fixture-01',
          hash: `sha256:${'1'.repeat(64)}`,
        },
      },
    },
    generationPolicy: { localOnly: false },
    evidenceRefs: [{ kind: 'fixture', ref: 'runtime-dry-run-harness/human-feedback-contract' }],
    createdAt: FIXED_CREATED_AT,
  });
}

function makeBaseRecords(scenario = {}) {
  const channelId = scenario.channelId || CHANNEL_IDS.ZBJ;
  const action = canonicalExternalAction(scenario.action || EXTERNAL_ACTIONS.LIVE_SUBMIT);
  const productLineId = canonicalProductLineId(scenario.productLineId || PRODUCT_LINE_IDS.LOGO_BRAND);
  const workflowId = canonicalProductLineId(scenario.workflowId || `${channelId}_runtime_dry_run`);
  const policy = scenario.policy || policyForAction(action);
  const transition = defaultTransitionForAction(action);
  const outputMode = scenario.outputMode || OUTPUT_MODES.IMAGE_SET;
  const artifactExtension = normalizeText(scenario.artifactExtension || 'png') || 'png';
  const artifactMimeType = artifactExtension === 'zip' ? 'application/zip' : 'image/png';
  const artifactCount = Number(scenario.artifactCount || 2);
  const packageRole = normalizeText(scenario.packageRole || '')
    || ([EXTERNAL_ACTIONS.ACCEPTANCE_APPLY, EXTERNAL_ACTIONS.DEPLOYMENT].includes(action) ? 'delivery' : undefined);
  const messagePreview = scenario.messagePreview || (action === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE
    ? `Runtime dry-run ${channelId} customer message preview.`
    : null);
  const deploymentTarget = scenario.deploymentTarget || (action === EXTERNAL_ACTIONS.DEPLOYMENT
    ? `runtime-dry-run-${channelId}-preview`
    : null);
  const buildEvidence = scenario.buildEvidence || (action === EXTERNAL_ACTIONS.DEPLOYMENT
    ? { ok: true, buildId: `runtime-dry-run-${channelId}-build`, target: deploymentTarget }
    : null);
  const channelTask = createChannelTask({
    channelId,
    externalId: scenario.externalId || `runtime-dry-run-${channelId}`,
    title: `Runtime dry-run fixture ${channelId}`,
    status: 'fixture_only',
    rawCategory: 'logo_brand',
    evidenceRefs: [{ kind: 'fixture', ref: 'runtime-dry-run-harness' }],
    createdAt: FIXED_CREATED_AT,
  });
  const humanFeedbackRevisionContract = humanFeedbackContractForScenario(scenario, { channelTask });
  const brief = createCreativeBrief({
    channelTask,
    productLineId,
    requirementText: 'Synthetic fixture used only to exercise the external runner handoff contract.',
    subject: {
      projectText: `Runtime dry-run fixture ${channelId}`,
      brandText: 'FIXTURE',
      mustUseText: ['FIXTURE'],
    },
    buyerConstraints: ['local fixture only', 'no external action'],
    evidenceRefs: [{ kind: 'fixture', ref: 'runtime-dry-run-harness' }],
    createdAt: FIXED_CREATED_AT,
  });
  const planBase = createProductionPlanEnvelope({
    brief,
    workflowId,
    outputMode,
    artifactCount,
    qualityGates: ['semantic_contract', 'visual_review', 'package_review'],
    liveRules: {
      expectedFinalFiles: artifactCount,
      maxFilesPerSubmit: 10,
      outputMode,
    },
    humanFeedbackRevisionContract,
    evidenceRefs: [{ kind: 'fixture', ref: 'runtime-dry-run-harness' }],
    createdAt: FIXED_CREATED_AT,
  });
  const plan = promptGenerationPlanForScenario(planBase, scenario, action);
  const artifacts = Array.from({ length: artifactCount }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, '0');
    return {
      id: `fixture-${ordinal}`,
      filename: `runtime-dry-run-${channelId}-${ordinal}.${artifactExtension}`,
      path: `fixtures/runtime-dry-run-${channelId}-${ordinal}.${artifactExtension}`,
      mimeType: artifactMimeType,
      sizeBytes: 1200 + (index * 100),
      hash: `sha256:${String(index + 1).repeat(64).slice(0, 64)}`,
    };
  });
  const artifactPackage = createArtifactPackage({
    plan,
    submitReady: true,
    packageRole,
    provenance: {
      providerId: 'fixture-provider',
      manualProvider: false,
      generatedByCore: true,
    },
    artifacts,
    humanFeedbackRevisionContract,
    evidenceRefs: [{ kind: 'fixture', ref: 'runtime-dry-run-harness' }],
    createdAt: FIXED_CREATED_AT,
  });
  const reviewReport = createReviewReport({
    artifactPackage,
    decision: 'pass',
    checks: [{ id: 'runtime_dry_run_fixture_review', status: 'pass' }],
    evidenceRefs: [{ kind: 'fixture', ref: 'runtime-dry-run-harness' }],
    createdAt: FIXED_CREATED_AT,
  });
  const prepareEvidence = {
    ok: true,
    filenames: artifactPackage.artifacts.map((artifact) => artifact.filename),
  };
  const duplicatePreflight = {
    ok: true,
    totalMyWorks: 0,
    existingMyWorks: false,
  };
  const approvalPacket = buildApprovalPacket({
    action,
    policy,
    channelTask,
    plan,
    artifactPackage,
    reviewReport,
    messagePreview,
    reason: 'Synthetic fixture approval used only to exercise hash-bound handoff plumbing.',
    requestedBy: 'runtime-dry-run-harness',
    approved: true,
    approvedBy: 'runtime-dry-run-harness',
    createdAt: FIXED_CREATED_AT,
  });
  const evidenceBundle = buildFreshEvidenceBundle({
    approvalPacket,
    action,
    channelTask,
    plan,
    artifactPackage,
    reviewReport,
    prepareEvidence,
    duplicatePreflight,
    messagePreview,
    deliveryArtifactBound: scenario.deliveryArtifactBound || [EXTERNAL_ACTIONS.ACCEPTANCE_APPLY, EXTERNAL_ACTIONS.DEPLOYMENT].includes(action),
    deploymentTarget,
    buildEvidence,
    evidenceRefs: [{ kind: 'fixture', ref: 'runtime-dry-run-harness' }],
    createdAt: FIXED_CREATED_AT,
  });
  const gateDecision = evaluateExecutionGate({
    action,
    policy,
    channelTask,
    plan,
    artifactPackage,
    reviewReport,
    approval: approvalPacket,
    evidenceBundle,
    prepareEvidence,
    duplicatePreflight,
    deploymentTarget,
    buildEvidence,
    messagePreview,
    humanFeedbackRevisionContract,
    deliveryArtifactBound: scenario.deliveryArtifactBound || [EXTERNAL_ACTIONS.ACCEPTANCE_APPLY, EXTERNAL_ACTIONS.DEPLOYMENT].includes(action),
    createdAt: FIXED_CREATED_AT,
  });
  const transitionResult = applyStateTransition({
    taskKey: channelTask.taskKey,
    fromStage: scenario.fromStage || transition.fromStage,
    toStage: scenario.toStage || transition.toStage,
    action,
    gateDecision,
    actor: 'runtime-dry-run-harness',
  });
  const manifest = buildChannelActionManifest({
    action,
    channelTask,
    plan,
    artifactPackage,
    reviewReport,
    gateDecision,
    transitionResult,
    approvalPacket,
    evidenceBundle,
    adapterHints: {
      adapterActionId: scenario.adapterActionId,
      actionVariant: scenario.actionVariant,
    },
    createdAt: FIXED_CREATED_AT,
  });
  return {
    channelTask,
    brief,
    plan,
    artifactPackage,
    reviewReport,
    prepareEvidence,
    duplicatePreflight,
    approvalPacket,
    evidenceBundle,
    gateDecision,
    transitionResult,
    manifest,
  };
}

function statusOf(record) {
  return normalizeText(record?.status || record?.decision || '') || null;
}

function codeList(...records) {
  return records.flatMap((record) => (record?.blockers || []).map((blocker) => blocker.code));
}

function expectedBlockersObserved(actualBlockers, expectedBlockers) {
  return expectedBlockers.every((code) => actualBlockers.includes(code));
}

function unsafeCoreSideEffectRecords(records) {
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
  ];
  return records
    .filter(Boolean)
    .filter((record) => unsafeKeys.some((key) => record?.safety?.[key] === true || record?.[key] === true))
    .map((record) => ({
      kind: record.kind || 'unknown',
      status: record.status || record.decision || null,
      unsafeKeys: unsafeKeys.filter((key) => record?.safety?.[key] === true || record?.[key] === true),
    }));
}

function buildScenarioRecord(scenario) {
  const base = makeBaseRecords(scenario);
  const preview = buildAdapterRunPreview({
    manifest: base.manifest,
    execute: scenario.execute === true,
    runnerId: 'runtime-dry-run-harness.core-preview',
    createdAt: FIXED_CREATED_AT,
  });
  const ledgerEntry = buildExternalActionLedgerEntry({
    manifest: base.manifest,
    preview,
    actor: 'runtime-dry-run-harness.ledger',
    createdAt: FIXED_CREATED_AT,
  });
  const outboxItem = buildAdapterHandoffOutboxItem({
    manifest: base.manifest,
    preview,
    ledgerEntry,
    requestedBy: 'runtime-dry-run-harness.outbox',
    createdAt: FIXED_CREATED_AT,
  });
  const replayGuardDecision = scenario.omitReplayGuard
    ? null
    : buildExternalActionReplayGuardDecision({
      archive: null,
      candidate: outboxItem,
      requireReadyArchive: false,
      actor: 'runtime-dry-run-harness.replay-guard',
      createdAt: FIXED_CREATED_AT,
    });
  const dispatchEnvelope = buildAdapterDispatchEnvelope({
    outboxItem,
    replayGuardDecision,
    requestedBy: 'runtime-dry-run-harness.dispatch-envelope',
    createdAt: FIXED_CREATED_AT,
  });
  const runnerCapability = buildAdapterRunnerCapability({
    runnerId: 'runtime-dry-run-harness.external-runner',
    channelId: base.channelTask.channelId,
    runnerLocation: scenario.runnerLocation || runnerLocationForChannel(base.channelTask.channelId),
    supportsExecute: true,
    supportedActionIds: [scenario.runnerActionOverride || base.manifest.adapter.actionId],
    evidenceRefs: [{ kind: 'fixture', ref: scenario.scenarioId }],
    createdAt: FIXED_CREATED_AT,
  });
  const runnerRegistry = buildAdapterRunnerRegistry({
    capabilities: [runnerCapability],
    registryId: `runtime-dry-run-harness.${scenario.scenarioId}`,
    actor: 'runtime-dry-run-harness.runner-registry',
    createdAt: FIXED_CREATED_AT,
  });
  const runnerSelection = selectAdapterRunnerCapability({
    registry: runnerRegistry,
    channelId: base.channelTask.channelId,
    actionId: base.manifest.adapter.actionId,
    requestedBy: 'runtime-dry-run-harness.runner-selection',
    createdAt: FIXED_CREATED_AT,
  });
  const dispatchAssignment = buildAdapterDispatchAssignment({
    dispatchEnvelope,
    runnerCapability,
    runnerSelection,
    requestedBy: 'runtime-dry-run-harness.dispatch-assignment',
    createdAt: FIXED_CREATED_AT,
  });
  const readinessReport = buildAdapterDispatchReadinessReport({
    runnerRegistry,
    runnerSelection,
    dispatchEnvelope,
    dispatchAssignment,
    actor: 'runtime-dry-run-harness.readiness',
    createdAt: FIXED_CREATED_AT,
  });
  const sdkContract = buildAdapterRunnerSdkContract({
    readinessReport,
    actor: 'runtime-dry-run-harness.sdk',
    createdAt: FIXED_CREATED_AT,
  });
  const actualBlockers = codeList(
    base.gateDecision,
    base.transitionResult?.decision,
    base.manifest,
    preview,
    ledgerEntry,
    outboxItem,
    replayGuardDecision,
    dispatchEnvelope,
    runnerCapability,
    runnerRegistry,
    runnerSelection,
    dispatchAssignment,
    readinessReport,
    sdkContract,
  );
  const ready = readinessReport.readyForExternalRunner === true
    && sdkContract.readyForExternalImplementation === true;
  const negativeBlockedAsExpected = scenario.expectedReady === false
    && ready === false
    && expectedBlockersObserved(actualBlockers, scenario.expectedBlockers);
  const readyAsExpected = scenario.expectedReady === true
    && ready === true
    && actualBlockers.length === 0;
  const unsafeCoreSideEffects = unsafeCoreSideEffectRecords([
    preview,
    ledgerEntry,
    outboxItem,
    replayGuardDecision,
    dispatchEnvelope,
    runnerRegistry,
    runnerSelection,
    dispatchAssignment,
    readinessReport,
    sdkContract,
  ]);
  const passed = (readyAsExpected || negativeBlockedAsExpected) && unsafeCoreSideEffects.length === 0;
  const reportScenario = {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: passed ? 'pass' : 'fail',
    expectedReady: scenario.expectedReady,
    readyForExternalRunner: readinessReport.readyForExternalRunner,
    readyForExternalImplementation: sdkContract.readyForExternalImplementation,
    observedExpectedBlockers: expectedBlockersObserved(actualBlockers, scenario.expectedBlockers),
    stepStatuses: {
      gateDecision: base.gateDecision.decision,
      transition: base.transitionResult.decision?.decision || base.transitionResult.decision,
      manifest: statusOf(base.manifest),
      preview: statusOf(preview),
      ledger: statusOf(ledgerEntry),
      outbox: statusOf(outboxItem),
      replayGuard: statusOf(replayGuardDecision),
      dispatchEnvelope: statusOf(dispatchEnvelope),
      runnerCapability: statusOf(runnerCapability),
      runnerRegistry: statusOf(runnerRegistry),
      runnerSelection: statusOf(runnerSelection),
      dispatchAssignment: statusOf(dispatchAssignment),
      readinessReport: statusOf(readinessReport),
      sdkContract: statusOf(sdkContract),
    },
    hashes: {
      approvalHash: base.approvalPacket.approvalHash,
      evidenceHash: base.evidenceBundle.evidenceHash,
      humanFeedbackRevisionContractHash: readinessReport.handoff.humanFeedbackRevisionContractHash || null,
      manifestHash: base.manifest.manifestHash,
      previewHash: preview.previewHash,
      ledgerHash: ledgerEntry.ledgerHash,
      outboxHash: outboxItem.outboxHash,
      replayGuardHash: replayGuardDecision?.replayGuardHash || null,
      dispatchEnvelopeHash: dispatchEnvelope.dispatchEnvelopeHash,
      runnerCapabilityHash: runnerCapability.capabilityHash,
      runnerRegistryHash: runnerRegistry.registryHash,
      runnerSelectionHash: runnerSelection.selectionHash,
      dispatchAssignmentHash: dispatchAssignment.assignmentHash,
      readinessReportHash: readinessReport.reportHash,
      sdkHash: sdkContract.sdkHash,
    },
    handoff: {
      channelId: readinessReport.handoff.channelId,
      actionId: readinessReport.handoff.actionId,
      action: readinessReport.handoff.action,
      taskKey: readinessReport.handoff.taskKey,
      externalId: readinessReport.handoff.externalId,
      productLineId: readinessReport.handoff.productLineId,
      workflowId: readinessReport.handoff.workflowId,
      packageRole: readinessReport.handoff.packageRole || null,
      humanFeedbackRevisionContractHash: readinessReport.handoff.humanFeedbackRevisionContractHash || null,
      promptGenerationBinding: readinessReport.handoff.promptGenerationBinding || null,
      messagePreview: readinessReport.handoff.messagePreview || null,
      messagePreviewHash: readinessReport.handoff.messagePreviewHash || null,
      artifactCount: readinessReport.handoff.artifactCount,
      requiredHashes: readinessReport.hashBinding.requiredHashes || {},
      runnerId: readinessReport.runner.runnerId,
      runnerLocation: readinessReport.runner.runnerLocation,
      runnerLocationExternalWorkspace: readinessReport.runner.runnerLocationExternalWorkspace === true,
      commandPreview: preview.adapter.commandPreview,
      sdkHashBinding: sdkContract.hashBinding,
      sdkActionEvidenceContract: sdkContract.actionEvidenceContract,
      sdkPhaseOrder: (sdkContract.phases || []).map((phase) => phase.phaseId),
      sdkEvidenceKindsByPhase: Object.fromEntries((sdkContract.phases || []).map((phase) => [
        phase.phaseId,
        phase.requiredEvidenceKinds || [],
      ])),
    },
    actualBlockers,
    expectedBlockers: scenario.expectedBlockers,
    unsafeCoreSideEffects,
  };
  return {
    scenarioInput: scenario,
    base,
    preview,
    ledgerEntry,
    outboxItem,
    replayGuardDecision,
    dispatchEnvelope,
    runnerCapability,
    runnerRegistry,
    runnerSelection,
    dispatchAssignment,
    readinessReport,
    sdkContract,
    reportScenario,
  };
}

function buildScenario(scenario) {
  return buildScenarioRecord(scenario).reportScenario;
}

function summarize(scenarios) {
  const byStatus = {};
  const blockerCodes = {};
  const byReady = {
    readyForExternalRunner: 0,
    readyForExternalImplementation: 0,
  };
  const readyScenarios = scenarios.filter((scenario) => scenario.readyForExternalRunner === true);
  const humanFeedbackReadyScenarios = readyScenarios.filter((scenario) => (
    scenario.handoff?.humanFeedbackRevisionContractHash
  ));
  for (const scenario of scenarios) {
    byStatus[scenario.status] = (byStatus[scenario.status] || 0) + 1;
    if (scenario.readyForExternalRunner) byReady.readyForExternalRunner += 1;
    if (scenario.readyForExternalImplementation) byReady.readyForExternalImplementation += 1;
    for (const code of scenario.actualBlockers) {
      blockerCodes[code] = (blockerCodes[code] || 0) + 1;
    }
  }
  return {
    scenarioCount: scenarios.length,
    passedScenarioCount: scenarios.filter((scenario) => scenario.status === 'pass').length,
    failedScenarioCount: scenarios.filter((scenario) => scenario.status !== 'pass').length,
    readyScenarioCount: scenarios.filter((scenario) => scenario.readyForExternalRunner).length,
    blockedScenarioCount: scenarios.filter((scenario) => !scenario.readyForExternalRunner).length,
    readyForExternalImplementationCount: byReady.readyForExternalImplementation,
    readyScenarioExternalWorkspaceRunnerCount: readyScenarios.filter((scenario) => (
      scenario.handoff.runnerLocationExternalWorkspace === true
    )).length,
    readyScenarioInternalWorkspaceRunnerCount: readyScenarios.filter((scenario) => (
      scenario.handoff.runnerLocationExternalWorkspace !== true
    )).length,
    readyScenarioPackageRoleCount: readyScenarios.filter((scenario) => scenario.handoff?.packageRole).length,
    readyScenarioHumanFeedbackPackageRoleCount: humanFeedbackReadyScenarios.filter((scenario) => (
      scenario.handoff?.packageRole
    )).length,
    runnerLocationBoundaryBlockCount: blockerCodes[ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE] || 0,
    readyScenarioMissingActionEvidenceContractCount: scenarios.filter((scenario) => (
      scenario.readyForExternalRunner
      && (!scenario.handoff.sdkActionEvidenceContract?.receiptResultFields?.length
        || !scenario.handoff.sdkActionEvidenceContract?.stateProofFields?.length)
    )).length,
    byStatus,
    blockerCodes,
  };
}

export function buildRuntimeDryRunHarnessReport({
  scenarios = SCENARIOS,
  generatedAt = new Date().toISOString(),
} = {}) {
  const { scenarioResults } = buildRuntimeDryRunHarnessRecords({ scenarios });
  const summary = summarize(scenarioResults);
  const blockers = [
    ...(summary.failedScenarioCount ? [issue('runtime_dry_run_scenario_failed')] : []),
    ...(scenarioResults.some((scenario) => scenario.unsafeCoreSideEffects.length)
      ? [issue('runtime_dry_run_core_side_effect_claim_detected')]
      : []),
    ...(summary.readyScenarioCount < 1 ? [issue('runtime_dry_run_ready_scenario_required')] : []),
    ...(summary.blockedScenarioCount < 1 ? [issue('runtime_dry_run_blocked_scenario_required')] : []),
    ...(summary.readyScenarioInternalWorkspaceRunnerCount > 0 ? [issue('runtime_dry_run_ready_runner_location_not_external_workspace')] : []),
    ...(summary.readyScenarioMissingActionEvidenceContractCount > 0 ? [issue('runtime_dry_run_action_evidence_contract_missing')] : []),
  ];
  const report = {
    version: RUNTIME_DRY_RUN_HARNESS_VERSION,
    kind: 'RuntimeDryRunHarnessReport',
    status: blockers.length
      ? RUNTIME_DRY_RUN_HARNESS_STATUS.FAIL
      : RUNTIME_DRY_RUN_HARNESS_STATUS.PASS,
    ok: blockers.length === 0,
    summary,
    scenarios: scenarioResults,
    blockers,
    warnings: [
      issue('runtime_dry_run_harness_local_only', 'Harness builds synthetic handoff records only; it never calls a runner, browser, API, provider, or platform.', 'warning'),
      issue('ready_for_external_runner_is_not_execution_permission', 'A ready handoff means an external runner can recheck the bundle; core still grants no execution permission.', 'warning'),
    ],
    safety: {
      harnessOnly: true,
      syntheticFixturesOnly: true,
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
    generatedAt,
  };
  const runtimeDryRunHarnessHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    ok: report.ok,
    summary: report.summary,
    scenarios: report.scenarios,
    blockers: report.blockers,
    warnings: report.warnings,
    safety: report.safety,
  });
  return {
    ...report,
    runtimeDryRunHarnessHash,
    hash: runtimeDryRunHarnessHash,
  };
}

export function buildRuntimeDryRunHarnessRecords({
  scenarios = SCENARIOS,
} = {}) {
  const records = scenarios.map(buildScenarioRecord);
  return {
    records,
    scenarioResults: records.map((record) => record.reportScenario),
  };
}
