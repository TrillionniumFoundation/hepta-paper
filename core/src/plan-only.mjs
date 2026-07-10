import {
  CHANNEL_IDS,
  OUTPUT_MODES,
  PRODUCT_LINE_IDS,
  canonicalProductLineId,
  createCreativeBrief,
  createProductionPlanEnvelope,
  normalizeText,
  validateWorkflowChain,
} from './contracts.mjs';
import { routeProductLine } from './product-router.mjs';
import {
  compactWorkflowProfile,
  workflowProfileForProductLine,
  workflowProfileForRoute,
} from './workflow-registry.mjs';
import {
  isHumanFeedbackWorkflow,
  validateHumanFeedbackRevisionContract,
} from './human-feedback-contracts.mjs';

export const PLAN_ONLY_VERSION = 1;

export const PLAN_ONLY_SAFETY = Object.freeze({
  readOnly: true,
  externalActions: false,
  providerSpend: false,
  modelSpend: false,
  livePrepare: false,
  liveSubmit: false,
  acceptanceApply: false,
  customerMessage: false,
  deployment: false,
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function firstText(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function workflowArtifactDefault(profile) {
  return firstNumber(profile?.artifactPolicy?.defaultCount);
}

function planArtifactCount({ artifactCount, liveRules, workflowProfile }) {
  return firstNumber(
    artifactCount,
    liveRules?.expectedFinalFiles,
    liveRules?.maxFilesPerSubmit,
    workflowArtifactDefault(workflowProfile),
  );
}

function profileReferencePolicy(profile) {
  const policy = profile?.referencePolicy || {};
  return {
    use: policy.required ? 'required_product_profile_reference_policy' : 'optional_product_profile_reference_policy',
    digestOnly: policy.digestOnly !== false,
    owner: policy.owner || 'design-production-core',
    usesRefpack: Boolean(policy.usesRefpack),
    mustNotCopy: [
      'third-party marks',
      'exact layouts',
      'proprietary fonts',
      'official trade dress',
      'demo dashboards',
      'sample data',
    ],
  };
}

function designReferenceSpecFromProfile(profile, designReferenceSpec = null) {
  if (designReferenceSpec) return designReferenceSpec;
  const policy = profile?.referencePolicy || {};
  return {
    source: 'workflow_profile',
    required: Boolean(policy.required),
    usesRefpack: Boolean(policy.usesRefpack),
    digestOnly: policy.digestOnly !== false,
    owner: policy.owner || 'design-production-core',
  };
}

function routeInputFromChannelTask(channelTask, routeInput = {}) {
  return {
    channelId: channelTask.channelId,
    title: channelTask.title,
    taskTitle: channelTask.title,
    rawCategory: channelTask.rawCategory,
    category: channelTask.rawCategory,
    ...routeInput,
  };
}

function channelSupported(profile, channelId) {
  return Boolean(profile?.channelPolicy?.supportedChannels?.includes(channelId));
}

function buildWarnings({ routeDecision, workflowProfile, channelTask, requestedOutputMode }) {
  return [
    routeDecision?.confidence < 0.6 ? 'route_confidence_low' : null,
    routeDecision?.warnings?.length ? `route_warnings:${routeDecision.warnings.join(',')}` : null,
    requestedOutputMode && requestedOutputMode !== workflowProfile.defaultOutputMode
      ? `requested_output_differs_from_profile_default:${requestedOutputMode}->${workflowProfile.defaultOutputMode}`
      : null,
    !channelSupported(workflowProfile, channelTask.channelId)
      ? `profile_not_declared_for_channel:${channelTask.channelId}`
      : null,
  ].filter(Boolean);
}

function buildBlockers({ routeDecision, workflowProfile, channelTask, humanFeedbackRevisionContract }) {
  const blockers = [
    routeDecision?.productLineId === PRODUCT_LINE_IDS.GENERIC_DESIGN ? 'generic_design_requires_clarification' : null,
    !channelSupported(workflowProfile, channelTask.channelId) ? 'unsupported_channel_for_product_profile' : null,
  ].filter(Boolean);
  if (isHumanFeedbackWorkflow(routeDecision?.productLineId || workflowProfile?.workflowId)) {
    const validation = validateHumanFeedbackRevisionContract(humanFeedbackRevisionContract, {
      context: {
        taskKey: channelTask.taskKey,
        channelId: channelTask.channelId,
        externalId: channelTask.externalId,
      },
    });
    blockers.push(...validation.blockers.map((blocker) => blocker.code));
  }
  return blockers;
}

export function buildPlanOnlyDraft({
  channelTask,
  routeInput = {},
  requirementText,
  subject = {},
  attachmentRefs = [],
  buyerConstraints = [],
  industrySpec = null,
  semanticContract = null,
  designReferenceSpec = null,
  liveRules = null,
  providerPolicy = null,
  qualityGates = null,
  artifactCount = null,
  humanFeedbackRevisionContract = null,
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!channelTask?.taskKey) throw new Error('PlanOnlyDraft requires channelTask');

  const routeDecision = routeProductLine(routeInputFromChannelTask(channelTask, routeInput));
  const workflowProfile = workflowProfileForRoute(routeDecision);
  const compactProfile = compactWorkflowProfile(workflowProfile);
  const productLineId = routeDecision.productLineId;
  const brief = createCreativeBrief({
    channelTask,
    productLineId,
    requirementText: firstText(requirementText, routeInput.requirementText, channelTask.title, 'Planning brief unavailable.'),
    subject: {
      projectText: firstText(subject.projectText, channelTask.title),
      brandText: subject.brandText || '',
      productText: subject.productText || '',
      mustUseText: subject.mustUseText || [],
      forbiddenText: subject.forbiddenText || [],
    },
    industrySpec,
    attachmentRefs,
    buyerConstraints,
    referencePolicy: profileReferencePolicy(workflowProfile),
    semanticContract,
    evidenceRefs,
    createdAt,
  });

  const requestedOutputMode = routeInput.outputMode || routeDecision.outputMode;
  const outputMode = workflowProfile.defaultOutputMode || requestedOutputMode || OUTPUT_MODES.MIXED;
  const plan = createProductionPlanEnvelope({
    brief,
    workflowId: workflowProfile.workflowId,
    outputMode,
    artifactCount: planArtifactCount({ artifactCount, liveRules, workflowProfile }),
    workflowProfile: compactProfile,
    humanFeedbackRevisionContract,
    designReferenceSpec: designReferenceSpecFromProfile(workflowProfile, designReferenceSpec),
    liveRules,
    providerPolicy: providerPolicy || {
      provider: 'auto',
      spendRequiresApproval: true,
      modelCacheAllowed: true,
      planOnly: true,
    },
    qualityGates: qualityGates || workflowProfile.qualityGates,
    externalActionPolicy: {
      providerSpendRequiresApproval: true,
      modelSpendRequiresApproval: true,
      prepareRequiresApproval: true,
      submitRequiresApproval: true,
      messageRequiresApproval: true,
      acceptanceRequiresApproval: true,
    },
    evidenceRefs,
    createdAt,
  });

  const validation = validateWorkflowChain({ channelTask, brief, plan });
  const warnings = buildWarnings({ routeDecision, workflowProfile, channelTask, requestedOutputMode });
  const blockers = buildBlockers({
    routeDecision,
    workflowProfile,
    channelTask,
    humanFeedbackRevisionContract,
  });

  return {
    version: PLAN_ONLY_VERSION,
    kind: 'PlanOnlyDraft',
    taskKey: channelTask.taskKey,
    channelId: channelTask.channelId,
    productLineId,
    workflowId: workflowProfile.workflowId,
    outputMode: plan.outputMode,
    status: blockers.length ? 'blocked_plan_only' : 'plan_only_ready',
    safety: PLAN_ONLY_SAFETY,
    routeDecision,
    workflowProfile: compactProfile,
    warnings,
    blockers,
    validation,
    nextAllowedActions: [
      'semantic_intake_plan',
      'reference_route_plan',
      'generation_plan',
      'review_plan',
    ],
    externalActionsRemainChannelOwned: true,
    contracts: {
      channelTask,
      brief,
      plan,
    },
  };
}

export function planOnlySummary(drafts = []) {
  const byChannel = {};
  const byProductLine = {};
  const byWorkflow = {};
  let blocked = 0;
  for (const draft of drafts) {
    byChannel[draft.channelId] = (byChannel[draft.channelId] || 0) + 1;
    const productLineId = canonicalProductLineId(draft.productLineId || '') || 'unknown';
    const workflowId = canonicalProductLineId(draft.workflowId || '') || 'unknown';
    byProductLine[productLineId] = (byProductLine[productLineId] || 0) + 1;
    byWorkflow[workflowId] = (byWorkflow[workflowId] || 0) + 1;
    if (draft.blockers?.length) blocked += 1;
  }
  return {
    count: drafts.length,
    byChannel,
    byProductLine,
    byWorkflow,
    blocked,
    ready: drafts.length - blocked,
    safety: PLAN_ONLY_SAFETY,
  };
}

export function sampleHeptaVectorizationDraft(channelTask) {
  if (channelTask?.channelId !== CHANNEL_IDS.HEPTA) return null;
  return buildPlanOnlyDraft({
    channelTask,
    routeInput: {
      productLineId: PRODUCT_LINE_IDS.VECTORIZATION,
      title: channelTask.title,
      requirementText: 'Hepta vectorization order.',
    },
    requirementText: 'Clean vector delivery for a buyer-uploaded source asset.',
    subject: {
      projectText: channelTask.title,
    },
  });
}

export function workflowProfileForPlanOnlyDraft(draft) {
  return workflowProfileForProductLine(draft?.productLineId);
}
