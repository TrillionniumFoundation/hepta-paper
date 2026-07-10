import { digest } from './hash-utils.mjs';
import {
  feedbackLearningBridgeHashFor,
  validateFeedbackLearningContinuity,
} from './feedback-learning-bridge-contracts.mjs';

export const GENERATION_CONTRACT_VERSION = 1;

export const GENERATION_STATUS = Object.freeze({
  PLANNED: 'planned',
  QUEUED: 'queued',
  GENERATING: 'generating',
  GENERATED: 'generated',
  QA_PENDING: 'qa_pending',
  QA_PASS: 'qa_pass',
  QA_FAILED: 'qa_failed',
  BLOCKED_PROVIDER: 'blocked_provider',
  BLOCKED_CONTRACT: 'blocked_contract',
  IMPORT_READY: 'import_ready',
});

export const QA_DECISION = Object.freeze({
  PENDING: 'pending',
  PASS: 'pass',
  FAIL: 'fail',
  REVIEW: 'review',
});

export const IMAGE_GENERATION_PROVIDER_POLICY_VERSION = 1;

export const IMAGE_GENERATION_PROVIDER_IDS = Object.freeze({
  CODEX_IMAGEGEN: 'codex-imagegen',
  OPENCLAW_IMAGE: 'openclaw-image',
  OPENAI_CODEX: 'openai-codex',
  VERTEX_WEB: 'vertex-web',
  MANUAL: 'manual',
  DRYRUN: 'dryrun',
});

export const IMAGE_GENERATION_EXECUTION_MODES = Object.freeze({
  AGENT_MEDIATED: 'agent-mediated',
  WORKER_EXECUTABLE: 'worker-executable',
  MANUAL_IMPORT: 'manual-import',
  DRYRUN: 'dryrun',
});

const DEFAULT_IMAGE_GENERATION_PROVIDER_PREFERENCE = Object.freeze([
  IMAGE_GENERATION_PROVIDER_IDS.CODEX_IMAGEGEN,
  IMAGE_GENERATION_PROVIDER_IDS.OPENCLAW_IMAGE,
  IMAGE_GENERATION_PROVIDER_IDS.OPENAI_CODEX,
  IMAGE_GENERATION_PROVIDER_IDS.VERTEX_WEB,
  IMAGE_GENERATION_PROVIDER_IDS.MANUAL,
  IMAGE_GENERATION_PROVIDER_IDS.DRYRUN,
]);

const DEFAULT_IMAGE_GENERATION_REQUIRED_DOWNSTREAM_GATES = Object.freeze([
  'generation_manifest_hash_binding',
  'case_manifest_import',
  'visual_qa_pass',
  'package_review_pass',
  'final_review_pass',
  'live_rules_current',
  'fresh_approval_evidence_before_external_action',
]);

export function createImageGenerationProviderPolicy(overrides = {}) {
  const preferredProviderIds = Array.isArray(overrides.preferredProviderIds)
    ? [...overrides.preferredProviderIds]
    : [...DEFAULT_IMAGE_GENERATION_PROVIDER_PREFERENCE];
  const agentMediatedProviderIds = Array.isArray(overrides.agentMediatedProviderIds)
    ? [...overrides.agentMediatedProviderIds]
    : [IMAGE_GENERATION_PROVIDER_IDS.CODEX_IMAGEGEN];
  const workerExecutableProviderIds = Array.isArray(overrides.workerExecutableProviderIds)
    ? [...overrides.workerExecutableProviderIds]
    : [IMAGE_GENERATION_PROVIDER_IDS.OPENCLAW_IMAGE];
  const fallbackProviderIds = Array.isArray(overrides.fallbackProviderIds)
    ? [...overrides.fallbackProviderIds]
    : [
        IMAGE_GENERATION_PROVIDER_IDS.OPENCLAW_IMAGE,
        IMAGE_GENERATION_PROVIDER_IDS.OPENAI_CODEX,
        IMAGE_GENERATION_PROVIDER_IDS.VERTEX_WEB,
        IMAGE_GENERATION_PROVIDER_IDS.MANUAL,
      ];
  const requiredDownstreamGates = Array.isArray(overrides.requiredDownstreamGates)
    ? [...overrides.requiredDownstreamGates]
    : [...DEFAULT_IMAGE_GENERATION_REQUIRED_DOWNSTREAM_GATES];
  return {
    version: IMAGE_GENERATION_PROVIDER_POLICY_VERSION,
    kind: 'ImageGenerationProviderPolicy',
    policyId: overrides.policyId || 'codex-imagegen-preferred-v1',
    preferredProviderId: overrides.preferredProviderId || preferredProviderIds[0] || IMAGE_GENERATION_PROVIDER_IDS.CODEX_IMAGEGEN,
    preferredProviderIds,
    fallbackProviderIds,
    compatibilityProviderIds: [
      IMAGE_GENERATION_PROVIDER_IDS.OPENCLAW_IMAGE,
      IMAGE_GENERATION_PROVIDER_IDS.OPENAI_CODEX,
      IMAGE_GENERATION_PROVIDER_IDS.VERTEX_WEB,
    ],
    agentMediatedProviderIds,
    workerExecutableProviderIds,
    executionModeByProviderId: {
      [IMAGE_GENERATION_PROVIDER_IDS.CODEX_IMAGEGEN]: IMAGE_GENERATION_EXECUTION_MODES.AGENT_MEDIATED,
      [IMAGE_GENERATION_PROVIDER_IDS.OPENCLAW_IMAGE]: IMAGE_GENERATION_EXECUTION_MODES.WORKER_EXECUTABLE,
      [IMAGE_GENERATION_PROVIDER_IDS.OPENAI_CODEX]: IMAGE_GENERATION_EXECUTION_MODES.AGENT_MEDIATED,
      [IMAGE_GENERATION_PROVIDER_IDS.VERTEX_WEB]: IMAGE_GENERATION_EXECUTION_MODES.MANUAL_IMPORT,
      [IMAGE_GENERATION_PROVIDER_IDS.MANUAL]: IMAGE_GENERATION_EXECUTION_MODES.MANUAL_IMPORT,
      [IMAGE_GENERATION_PROVIDER_IDS.DRYRUN]: IMAGE_GENERATION_EXECUTION_MODES.DRYRUN,
      ...(overrides.executionModeByProviderId || {}),
    },
    selectionRules: {
      defaultLocalImageGenerationProvider: IMAGE_GENERATION_PROVIDER_IDS.CODEX_IMAGEGEN,
      autoWorkerSelectionRequiresCapability: IMAGE_GENERATION_EXECUTION_MODES.WORKER_EXECUTABLE,
      autoAgentMediatedSelectionRequires: 'allowAgentMediated=true',
      neverTreatAgentMediatedAsWorkerExecutable: true,
      openClawImageFallbackWhen: [
        'worker execution is required',
        'the ZBJ flow requires OpenClaw provider receipts',
        'Codex imagegen is unavailable or blocked',
      ],
    },
    provenanceRules: {
      importRequired: true,
      manifestHashBindingRequired: true,
      providerReceiptRequiredWhenAvailable: true,
      agentMediatedOutputsMustBeAttachedThroughCaseImport: true,
      agentMediatedOutputsDoNotGrantSubmitReady: true,
    },
    requiredDownstreamGates,
    safety: {
      localPolicyOnly: true,
      callsProviderOrModel: false,
      opensBrowser: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      fetchesChannelState: false,
      mutatesChannelState: false,
      grantsExecutionPermission: false,
    },
  };
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PROMPT_PRODUCTION_PASS_STATUS = 'pass_prompt_production_contract';
const MODEL_LOCKED_RETRIEVAL_STATUS = 'model_locked_static_refpack';
const MODEL_LOCKED_ROUTING_MODE = 'model_semantic_locked';
const MODEL_LOCKED_SELECTION_AUTHORITY = 'semantic_intake';

function isCanonicalHash(value) {
  return HASH_PATTERN.test(String(value || ''));
}

export function generationJobId({ taskId, providerId = 'unknown', now = Date.now() }) {
  if (!taskId) throw new Error('generation job requires taskId');
  return `gen-${taskId}-${String(providerId).replace(/[^a-zA-Z0-9_-]+/g, '-')}-${now}`;
}

export function summarizeGenerationAttachmentSpec(spec) {
  if (!spec) return null;
  const required = !!spec.required;
  const generationUsage = spec.generationUsage || (required ? 'binding_reference' : null);
  const blockers = Array.isArray(spec.blockers) ? spec.blockers : [];
  return {
    version: spec.version || 1,
    required,
    generationUsage,
    generationUsageReason: spec.generationUsageReason || null,
    originalHash: spec.originalHash || null,
    hash: spec.hash || null,
    attachmentCount: Number(spec.attachmentCount || 0),
    downloadedCount: Number(spec.downloadedCount || 0),
    referenceCount: Number(spec.referenceCount || (spec.referenceImages || []).length || 0),
    referenceImages: Array.isArray(spec.referenceImages) ? spec.referenceImages : [],
    referenceFiles: Array.isArray(spec.referenceFiles) ? spec.referenceFiles : [],
    noCopyReferenceCount: Number(spec.noCopyReferenceCount || 0),
    noCopyReferenceImages: Array.isArray(spec.noCopyReferenceImages) ? spec.noCopyReferenceImages : [],
    noCopyReferenceFiles: Array.isArray(spec.noCopyReferenceFiles) ? spec.noCopyReferenceFiles : [],
    semanticReferenceImages: Array.isArray(spec.semanticReferenceImages) ? spec.semanticReferenceImages : [],
    semanticReferenceFiles: Array.isArray(spec.semanticReferenceFiles) ? spec.semanticReferenceFiles : [],
    blockers: required || generationUsage === 'negative_no_copy' ? blockers : [],
    nonBlockingAttachmentIssues: required || generationUsage === 'negative_no_copy' ? [] : blockers,
  };
}

function attachmentPromptGuard(attachmentSpec) {
  if (!attachmentSpec?.required && attachmentSpec?.generationUsage !== 'negative_no_copy') return '';
  if (attachmentSpec?.generationUsage === 'negative_no_copy') {
    const referenceFiles = (attachmentSpec.noCopyReferenceFiles || attachmentSpec.semanticReferenceFiles || attachmentSpec.noCopyReferenceImages || [])
      .slice(0, 8)
      .map((item, idx) => {
        if (typeof item === 'string') return `${idx + 1}. ${item}`;
        const label = item.originalName || item.name || item.filename || item.path || item.referencePath || item.file || 'old logo attachment';
        return `${idx + 1}. ${label}`;
      });
    return [
      '',
      'MANDATORY BUYER ATTACHMENT NO-COPY RULE:',
      'The buyer attached an existing/old logo while requesting a new logo. Treat the attachment as a negative reference: understand the brand context, but DO NOT copy, trace, reuse, simplify, recolor, or closely imitate its visible symbol geometry, four-part/cross-like composition, color placement, or lockup layout.',
      'Create a clearly new original enterprise identity for the exact required brand text. Use different mark construction, different symbol logic, and distinct visual proportions while staying professional and trademark-oriented.',
      referenceFiles.length ? `Old logo attachment to avoid copying: ${referenceFiles.join(' | ')}.` : 'Old logo attachment exists in the task record; do not reproduce it.',
      'If the result looks like the attachment with minor polish, color changes, rounded corners, gradients, or VI mockups around the same mark, it is QA FAIL.',
    ].join('\n');
  }
  const referenceFiles = (attachmentSpec.referenceFiles || attachmentSpec.referenceImages || [])
    .slice(0, 8)
    .map((item, idx) => {
      if (typeof item === 'string') return `${idx + 1}. ${item}`;
      const label = item.originalName || item.name || item.path || item.referencePath || item.file || 'attachment reference';
      const kind = item.kind || item.type || null;
      return `${idx + 1}. ${label}${kind ? ` (${kind})` : ''}`;
    });
  const blockers = Array.isArray(attachmentSpec.blockers) && attachmentSpec.blockers.length
    ? ` Attachment blockers currently present: ${attachmentSpec.blockers.join('; ')}.`
    : '';
  return [
    '',
    'MANDATORY BUYER ATTACHMENT REFERENCE RULE:',
    'The attached reference files are binding buyer source material, not optional mood references. The output must visibly derive from these references: preserve the concrete geometry, layout, product/form cues, colors, proportions, photographed/site context, or document content that the buyer supplied. Do not replace the attachment evidence with a generic AI concept, invented stock scene, unrelated mockup, or fabricated brand/project content.',
    referenceFiles.length ? `Reference files to use: ${referenceFiles.join(' | ')}.` : 'Reference files are attached in the provider call.',
    'If the requested deliverable is a deck, proposal, space, sculpture, logo, product, packaging, or board package, use the attachments as the source anchor and show attachment-specific proof in the composition. A result that could have been generated without seeing the attachments is QA FAIL.',
    blockers,
  ].filter(Boolean).join('\n');
}

export function createArtifactRequest({ plan, artifact, providerSelection, jobId }) {
  if (!plan?.taskId) throw new Error('artifact request requires plan.taskId');
  if (!artifact?.filename) throw new Error('artifact request requires artifact filename');
  if (!artifact?.prompt) throw new Error(`artifact request requires prompt: ${artifact?.filename || '<unknown>'}`);
  const artifactQualityChecks = (plan.qaContract?.artifactChecks || []).map((check) => ({
    id: check.id,
    label: check.label,
    source: check.source || 'quality_gate',
    severity: check.severity || 'normal',
    blocking: check.blocking !== false,
    appliesTo: check.appliesTo || 'artifact',
  }));
  const attachmentSpec = summarizeGenerationAttachmentSpec(plan.attachmentSpec || null);
  const guard = attachmentPromptGuard(attachmentSpec);
  const prompt = guard ? `${String(artifact.prompt || '').trim()}\n\n${guard}` : artifact.prompt;
  const generationReferenceImages = attachmentSpec?.generationUsage === 'negative_no_copy'
    ? []
    : (attachmentSpec?.referenceImages || []);
  return {
    id: `${jobId}-${String(artifact.index || 0).padStart(2, '0')}`,
    taskId: plan.taskId,
    orderId: plan.orderId ?? null,
    workflowId: plan.workflowId,
    artifactIndex: artifact.index ?? null,
    filename: artifact.filename,
    role: artifact.role || 'artifact',
    outputMode: artifact.outputMode || plan.outputMode || 'image_set',
    prompt,
    promptCompiler: artifact.promptCompiler || null,
    promptCompilerHash: artifact.promptCompiler?.compilerHash || null,
    routeStrategy: artifact.routeStrategy || null,
    routeStrategyHash: artifact.routeStrategy?.routeStrategyHash || artifact.promptCompiler?.routeStrategyHash || null,
    acceptance: Array.isArray(artifact.acceptance) ? artifact.acceptance : [],
    qualityChecks: artifactQualityChecks,
    providerHints: plan.providerHints || null,
    subject: plan.subject || null,
    industrySpec: plan.industrySpec || null,
    designReferenceSpec: plan.designReferenceSpec || null,
    designReferenceRetrieval: plan.designReferenceRetrieval || null,
    retrievalHash: plan.designReferenceRetrieval?.retrievalHash || null,
    feedbackLearningBridgeHash: feedbackLearningBridgeHashFor(plan),
    attachmentSpec,
    semanticContract: plan.semanticContract || null,
    semanticContractHash: plan.semanticContract?.sourceHash || null,
    routeContract: plan.routeContract || null,
    routeContractHash: plan.routeContract?.contractHash || null,
    promptProductionContractHash: plan.promptProductionContract?.promptProductionContractHash || null,
    referenceImages: generationReferenceImages,
    deliverableSpec: plan.deliverableSpec || null,
    provider: {
      id: providerSelection.providerId,
      kind: providerSelection.kind,
      authProfileId: providerSelection.authProfileId || null,
      model: providerSelection.model || null,
    },
    status: GENERATION_STATUS.PLANNED,
    result: null,
    createdAt: new Date().toISOString(),
  };
}

function requestQaChecks(request) {
  const checks = [
    ...(request.acceptance || []).map((label, idx) => ({ id: `acceptance_${idx + 1}`, label, source: 'artifact_acceptance', severity: 'normal', blocking: true })),
    ...(request.qualityChecks || []).map((check) => ({
      id: check.id?.startsWith('gate_') || check.id?.startsWith('drift_') ? check.id : `${check.source === 'drift_guard' ? 'drift' : 'gate'}_${check.id}`,
      label: check.label,
      source: check.source || 'quality_gate',
      severity: check.severity || 'normal',
      blocking: check.blocking !== false,
      appliesTo: check.appliesTo || 'artifact',
    })),
  ];
  if (request.attachmentSpec?.required) {
    checks.push({
      id: 'gate_attachment_reference_included',
      label: 'Generation request includes downloaded task attachment references',
      source: 'attachment_gate',
      severity: 'critical',
      blocking: true,
      appliesTo: 'artifact',
    });
  }
  if (request.attachmentSpec?.generationUsage === 'negative_no_copy') {
    checks.push({
      id: 'gate_attachment_logo_no_copy',
      label: 'Existing logo attachment is treated as a no-copy negative reference; output must not reuse its symbol geometry or lockup.',
      source: 'attachment_gate',
      severity: 'critical',
      blocking: true,
      appliesTo: 'artifact',
    });
  }
  return checks;
}

export function createQaRecord({ request, decision = QA_DECISION.PENDING, checks = [], reviewer = 'workflow-contract', notes = null }) {
  if (!request?.id) throw new Error('QA record requires request id');
  return {
    version: GENERATION_CONTRACT_VERSION,
    requestId: request.id,
    taskId: request.taskId,
    filename: request.filename,
    workflowId: request.workflowId,
    decision,
    reviewer,
    checks: checks.map((item) => ({
      id: item.id || item.name || 'check',
      label: item.label || item.name || item.id || 'check',
      status: item.status || QA_DECISION.PENDING,
      severity: item.severity || 'normal',
      source: item.source || null,
      appliesTo: item.appliesTo || null,
      blocking: item.blocking !== false,
      notes: item.notes || null,
    })),
    requiredAcceptance: request.acceptance || [],
    notes,
    createdAt: new Date().toISOString(),
  };
}

export function createGenerationJob({
  plan,
  providerSelection,
  artifacts = null,
  execute = false,
  dryRun = true,
  now = Date.now(),
} = {}) {
  if (!plan?.taskId) throw new Error('generation job requires plan.taskId');
  if (!plan?.workflowId) throw new Error('generation job requires plan.workflowId');
  if (!providerSelection?.providerId) throw new Error('generation job requires providerSelection.providerId');
  const selectedArtifacts = Array.isArray(artifacts) ? artifacts : (plan.prompts || []);
  if (!selectedArtifacts.length) throw new Error('generation job requires at least one artifact request');
  const jobId = generationJobId({ taskId: plan.taskId, providerId: providerSelection.providerId, now });
  const requests = selectedArtifacts.map((artifact) => createArtifactRequest({ plan, artifact, providerSelection, jobId }));
  const qa = requests.map((request) => createQaRecord({
    request,
    checks: requestQaChecks(request),
  }));
  return {
    version: GENERATION_CONTRACT_VERSION,
    id: jobId,
    taskId: plan.taskId,
    orderId: plan.orderId ?? null,
    title: plan.title ?? null,
    workflowId: plan.workflowId,
    workflowLabel: plan.workflowLabel ?? null,
    contractVersion: plan.contractVersion ?? null,
    planVersion: plan.version ?? null,
    outputMode: plan.outputMode,
    subject: plan.subject || null,
    industrySpec: plan.industrySpec || null,
    designReferenceSpec: plan.designReferenceSpec || null,
    designReferenceRetrieval: plan.designReferenceRetrieval || null,
    retrievalHash: plan.designReferenceRetrieval?.retrievalHash || null,
    feedbackLearningBridge: plan.feedbackLearningBridge || plan.designReferenceSpec?.feedbackLearningBridge || null,
    feedbackLearningBridgeHash: feedbackLearningBridgeHashFor(plan),
    promptCompiler: plan.promptCompiler || null,
    promptCompilerHash: plan.promptCompiler?.promptCompilerHash || null,
    promptReadiness: plan.promptReadiness || null,
    promptReadinessHash: plan.promptReadiness?.readinessHash || null,
    promptProductionContract: plan.promptProductionContract || null,
    promptProductionContractHash: plan.promptProductionContract?.promptProductionContractHash || null,
    attachmentSpec: summarizeGenerationAttachmentSpec(plan.attachmentSpec || null),
    semanticContract: plan.semanticContract || null,
    semanticContractHash: plan.semanticContract?.sourceHash || null,
    routeContract: plan.routeContract || null,
    routeContractHash: plan.routeContract?.contractHash || null,
    liveSubmitRules: plan.liveSubmitRules || null,
    submitLimitSpec: plan.submitLimitSpec || null,
    preGenerationBlockers: plan.preGenerationBlockers || [],
    deliverableSpec: plan.deliverableSpec || null,
    artifactPolicy: plan.artifactPolicy || null,
    qualityGates: plan.qualityGates || [],
    driftGuards: plan.driftGuards || [],
    qaContract: plan.qaContract || null,
    provider: providerSelection,
    execute: !!execute,
    dryRun: !!dryRun,
    status: execute ? GENERATION_STATUS.QUEUED : GENERATION_STATUS.PLANNED,
    requests,
    qa,
    importReadyFiles: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    safety: {
      localContractOnly: true,
      callsProviderOrModel: false,
      opensBrowser: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      fetchesChannelState: false,
      mutatesChannelState: false,
      grantsExecutionPermission: false,
    },
  };
}

function compactText(value) {
  return String(value || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}

function addMismatch(issues, id, message, details = {}) {
  issues.push({ id, message, details });
}

function valueMismatch(a, b) {
  return a !== undefined && a !== null && b !== undefined && b !== null && String(a) !== String(b);
}

function requiredPlanValueMismatch(planValue, manifestValue) {
  if (planValue === undefined || planValue === null || String(planValue) === '') return false;
  return manifestValue === undefined || manifestValue === null || String(manifestValue) === '' || String(planValue) !== String(manifestValue);
}

function promptByIndex(plan = {}) {
  const map = new Map();
  for (const prompt of Array.isArray(plan?.prompts) ? plan.prompts : []) {
    const index = Number(prompt?.index);
    if (!Number.isFinite(index)) continue;
    map.set(index, prompt);
  }
  return map;
}

function expectedFinalFileCount(plan = {}) {
  const number = Number(
    plan?.routeContract?.expectedFinalFiles
    ?? plan?.deliverableSpec?.expectedFileCount
    ?? plan?.qaContract?.expectedArtifactCount
  );
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number);
}

export function validateGenerationPlanSync({ plan = null, manifest = null, includePrompts = true, allowPartialRequestCount = false } = {}) {
  if (!plan || !manifest) return { ok: true, required: false, issues: [] };
  const issues = [];
  if (valueMismatch(plan.taskId, manifest.taskId)) addMismatch(issues, 'generation_manifest_task_mismatch', 'generation manifest taskId differs from production plan', { plan: plan.taskId ?? null, manifest: manifest.taskId ?? null });
  if (valueMismatch(plan.workflowId, manifest.workflowId)) addMismatch(issues, 'generation_manifest_workflow_mismatch', 'generation manifest workflowId differs from production plan', { plan: plan.workflowId ?? null, manifest: manifest.workflowId ?? null });
  if (valueMismatch(plan.version, manifest.planVersion)) addMismatch(issues, 'generation_manifest_plan_version_stale', 'generation manifest planVersion differs from production plan version', { plan: plan.version ?? null, manifest: manifest.planVersion ?? null });
  if (valueMismatch(plan.industrySpec?.id, manifest.industrySpec?.id)) addMismatch(issues, 'generation_manifest_industry_stale', 'generation manifest industrySpec.id differs from production plan', { plan: plan.industrySpec?.id ?? null, manifest: manifest.industrySpec?.id ?? null });
  if (valueMismatch(plan.designReferenceSpec?.id, manifest.designReferenceSpec?.id)) addMismatch(issues, 'generation_manifest_refpack_stale', 'generation manifest designReferenceSpec.id differs from production plan', { plan: plan.designReferenceSpec?.id ?? null, manifest: manifest.designReferenceSpec?.id ?? null });
  if (valueMismatch(plan.deliverableSpec?.industryId, manifest.deliverableSpec?.industryId)) addMismatch(issues, 'generation_manifest_deliverable_industry_stale', 'generation manifest deliverableSpec.industryId differs from production plan', { plan: plan.deliverableSpec?.industryId ?? null, manifest: manifest.deliverableSpec?.industryId ?? null });
  if (valueMismatch(plan.deliverableSpec?.designReferenceId, manifest.deliverableSpec?.designReferenceId)) addMismatch(issues, 'generation_manifest_deliverable_refpack_stale', 'generation manifest deliverableSpec.designReferenceId differs from production plan', { plan: plan.deliverableSpec?.designReferenceId ?? null, manifest: manifest.deliverableSpec?.designReferenceId ?? null });
  if (valueMismatch(plan.submitLimitSpec?.route, manifest.submitLimitSpec?.route)) addMismatch(issues, 'generation_manifest_submit_route_stale', 'generation manifest submitLimitSpec.route differs from production plan', { plan: plan.submitLimitSpec?.route ?? null, manifest: manifest.submitLimitSpec?.route ?? null });
  if (valueMismatch(plan.submitLimitSpec?.maxFilesPerSubmit, manifest.submitLimitSpec?.maxFilesPerSubmit)) addMismatch(issues, 'generation_manifest_submit_limit_stale', 'generation manifest submitLimitSpec.maxFilesPerSubmit differs from production plan', { plan: plan.submitLimitSpec?.maxFilesPerSubmit ?? null, manifest: manifest.submitLimitSpec?.maxFilesPerSubmit ?? null });
  if (valueMismatch(plan.submitLimitSpec?.expectedFinalFiles, manifest.submitLimitSpec?.expectedFinalFiles)) addMismatch(issues, 'generation_manifest_expected_final_count_stale', 'generation manifest submitLimitSpec.expectedFinalFiles differs from production plan', { plan: plan.submitLimitSpec?.expectedFinalFiles ?? null, manifest: manifest.submitLimitSpec?.expectedFinalFiles ?? null });
  if (valueMismatch(plan.routeContract?.contractHash, manifest.routeContract?.contractHash || manifest.routeContractHash)) addMismatch(issues, 'generation_manifest_route_contract_stale', 'generation manifest RouteContract differs from production plan', { plan: plan.routeContract?.contractHash ?? null, manifest: manifest.routeContract?.contractHash || manifest.routeContractHash || null });
  if (requiredPlanValueMismatch(plan.designReferenceRetrieval?.retrievalHash, manifest.retrievalHash || manifest.designReferenceRetrieval?.retrievalHash)) addMismatch(issues, 'generation_manifest_retrieval_hash_stale', 'generation manifest DesignReferenceRetrieval differs from production plan', { plan: plan.designReferenceRetrieval?.retrievalHash ?? null, manifest: manifest.retrievalHash || manifest.designReferenceRetrieval?.retrievalHash || null });
  const feedbackContinuity = validateFeedbackLearningContinuity({ plan, manifest });
  if (!feedbackContinuity.ok) {
    addMismatch(issues, 'generation_manifest_feedback_learning_bridge_stale', 'generation manifest FeedbackLearningBridge differs from production plan', {
      expectedHash: feedbackContinuity.expectedHash,
      actual: feedbackContinuity.actual,
      issues: feedbackContinuity.issues.map((item) => item.code),
    });
  }
  if (requiredPlanValueMismatch(plan.promptCompiler?.promptCompilerHash, manifest.promptCompilerHash || manifest.promptCompiler?.promptCompilerHash)) addMismatch(issues, 'generation_manifest_prompt_compiler_stale', 'generation manifest PromptCompiler summary differs from production plan', { plan: plan.promptCompiler?.promptCompilerHash ?? null, manifest: manifest.promptCompilerHash || manifest.promptCompiler?.promptCompilerHash || null });
  if (requiredPlanValueMismatch(plan.promptReadiness?.readinessHash, manifest.promptReadinessHash || manifest.promptReadiness?.readinessHash)) addMismatch(issues, 'generation_manifest_prompt_readiness_stale', 'generation manifest PromptReadiness differs from production plan', { plan: plan.promptReadiness?.readinessHash ?? null, manifest: manifest.promptReadinessHash || manifest.promptReadiness?.readinessHash || null });
  if (requiredPlanValueMismatch(plan.promptProductionContract?.promptProductionContractHash, manifest.promptProductionContractHash || manifest.promptProductionContract?.promptProductionContractHash)) addMismatch(issues, 'generation_manifest_prompt_production_contract_stale', 'generation manifest PromptProductionContract differs from production plan', { plan: plan.promptProductionContract?.promptProductionContractHash ?? null, manifest: manifest.promptProductionContractHash || manifest.promptProductionContract?.promptProductionContractHash || null });

  const planPrompts = promptByIndex(plan);
  const requests = Array.isArray(manifest.requests) ? manifest.requests : [];
  const routeExpected = expectedFinalFileCount(plan);
  const routeCountSatisfied = routeExpected !== null && requests.length === routeExpected;
  if (Array.isArray(plan.prompts) && plan.prompts.length && requests.length !== plan.prompts.length && !allowPartialRequestCount && !routeCountSatisfied) {
    addMismatch(issues, 'generation_manifest_request_count_stale', 'generation manifest request count differs from production plan prompts', { plan: plan.prompts.length, manifest: requests.length });
  }
  if (includePrompts && planPrompts.size && requests.length) {
    const staleRequests = [];
    for (const request of requests) {
      const expected = planPrompts.get(Number(request.artifactIndex));
      if (!expected?.prompt) continue;
      if (valueMismatch(expected.promptCompiler?.compilerHash, request.promptCompilerHash || request.promptCompiler?.compilerHash)) {
        staleRequests.push({
          artifactIndex: request.artifactIndex ?? null,
          requestId: request.id || null,
          filename: request.filename || null,
          reason: 'prompt_compiler_hash_mismatch',
        });
        continue;
      }
      if (valueMismatch(expected.routeStrategy?.routeStrategyHash, request.routeStrategyHash || request.routeStrategy?.routeStrategyHash)) {
        staleRequests.push({
          artifactIndex: request.artifactIndex ?? null,
          requestId: request.id || null,
          filename: request.filename || null,
          reason: 'route_strategy_hash_mismatch',
        });
        continue;
      }
      const actualPrompt = compactText(request.prompt);
      const expectedPrompt = compactText(expected.prompt);
      if (!actualPrompt.startsWith(expectedPrompt)) {
        staleRequests.push({
          artifactIndex: request.artifactIndex ?? null,
          requestId: request.id || null,
          filename: request.filename || null,
          reason: 'prompt_text_mismatch',
        });
      }
    }
    if (staleRequests.length) {
      addMismatch(issues, 'generation_manifest_prompt_stale', 'one or more generation request prompts no longer match the current production plan prompts', { requests: staleRequests.slice(0, 20) });
    }
  }
  return { ok: issues.length === 0, required: true, issues };
}

function semanticIssuesFromValidator(job, semanticValidator) {
  if (typeof semanticValidator !== 'function') {
    return ['semantic contract validator is required when qaContract.importBlockers contains semantic_contract_lock_required'];
  }
  const gate = semanticValidator({ manifest: job, includeRequests: true });
  if (gate?.ok) return [];
  const ids = Array.isArray(gate?.issues)
    ? gate.issues.map((item) => item.id || item.code || item.message || String(item)).filter(Boolean)
    : ['semantic_contract_gate_failed'];
  return [`semantic contract gate failed: ${ids.join(', ')}`];
}

function unsafePromptChainSafetyFlags(safety = {}) {
  const flags = [];
  for (const key of [
    'callsProvider',
    'callsModel',
    'callsProviderOrModel',
    'opensBrowser',
    'opensBrowserOrPlatform',
    'uploads',
    'submits',
    'uploadsOrSubmits',
    'sendsMessage',
    'sendsMessages',
    'acceptsDelivery',
    'pays',
    'deploys',
    'paysOrDeploys',
    'executesExternalAction',
    'fetchesChannelState',
    'appliesLocalStateTransition',
    'grantsExecutionPermission',
  ]) {
    if (safety?.[key] === true) flags.push(key);
  }
  return flags;
}

function executablePromptChainIssues(job = {}) {
  if (!job?.execute) return [];
  const issues = [];
  const retrieval = job.designReferenceRetrieval || {};
  const production = job.promptProductionContract || {};
  const compilerHash = job.promptCompilerHash || null;
  const compilerSourceHash = job.promptCompiler?.promptCompilerHash || null;
  const readinessHash = job.promptReadinessHash || null;
  const readinessSourceHash = job.promptReadiness?.readinessHash || null;
  const readinessPromptCompilerHash = job.promptReadiness?.promptCompilerHash || null;
  const readinessRefreshedPromptCompilerHash = job.promptReadiness?.refreshedPromptCompilerHash || null;
  const readinessRetrievalHash = job.promptReadiness?.retrievalHash || null;
  const productionHash = job.promptProductionContractHash || null;
  const productionSourceHash = production.promptProductionContractHash || null;
  const retrievalHash = job.retrievalHash || null;
  const retrievalSourceHash = retrieval.retrievalHash || null;
  const feedbackLearningBridgeHash = feedbackLearningBridgeHashFor(job);

  if (!job.promptCompiler) issues.push('missing promptCompiler for executable generation');
  if (!compilerHash) issues.push('missing promptCompilerHash for executable generation');
  if (compilerHash && !isCanonicalHash(compilerHash)) issues.push('promptCompilerHash must be canonical sha256');
  if (job.promptCompiler && !compilerSourceHash) issues.push('missing promptCompiler.promptCompilerHash for executable generation');
  if (compilerSourceHash && !isCanonicalHash(compilerSourceHash)) issues.push('promptCompiler.promptCompilerHash must be canonical sha256');
  if (compilerSourceHash && compilerHash && compilerSourceHash !== compilerHash) {
    issues.push('promptCompilerHash does not match promptCompiler.promptCompilerHash');
  }

  if (!job.promptReadiness) issues.push('missing promptReadiness for executable generation');
  if (job.promptReadiness?.ok !== true) issues.push(`promptReadiness blockers: ${(job.promptReadiness?.blockers || []).map((item) => item.code || item).join(', ')}`);
  if (!readinessHash) issues.push('missing promptReadinessHash for executable generation');
  if (readinessHash && !isCanonicalHash(readinessHash)) issues.push('promptReadinessHash must be canonical sha256');
  if (job.promptReadiness && !readinessSourceHash) issues.push('missing promptReadiness.readinessHash for executable generation');
  if (readinessSourceHash && !isCanonicalHash(readinessSourceHash)) issues.push('promptReadiness.readinessHash must be canonical sha256');
  if (readinessSourceHash && readinessHash && readinessSourceHash !== readinessHash) {
    issues.push('promptReadinessHash does not match promptReadiness.readinessHash');
  }
  if (job.promptReadiness && !readinessPromptCompilerHash) issues.push('missing promptReadiness.promptCompilerHash for executable generation');
  if (readinessPromptCompilerHash && !isCanonicalHash(readinessPromptCompilerHash)) issues.push('promptReadiness.promptCompilerHash must be canonical sha256');
  if (readinessPromptCompilerHash && compilerHash && readinessPromptCompilerHash !== compilerHash) {
    issues.push('promptReadiness promptCompilerHash does not match generation job');
  }
  if (job.promptReadiness && !readinessRefreshedPromptCompilerHash) issues.push('missing promptReadiness.refreshedPromptCompilerHash for executable generation');
  if (readinessRefreshedPromptCompilerHash && !isCanonicalHash(readinessRefreshedPromptCompilerHash)) issues.push('promptReadiness.refreshedPromptCompilerHash must be canonical sha256');
  if (readinessRefreshedPromptCompilerHash && compilerHash && readinessRefreshedPromptCompilerHash !== compilerHash) {
    issues.push('promptReadiness refreshedPromptCompilerHash does not match generation job');
  }
  if (job.promptReadiness && !readinessRetrievalHash) issues.push('missing promptReadiness.retrievalHash for executable generation');
  if (readinessRetrievalHash && !isCanonicalHash(readinessRetrievalHash)) issues.push('promptReadiness.retrievalHash must be canonical sha256');
  if (readinessRetrievalHash && retrievalHash && readinessRetrievalHash !== retrievalHash) {
    issues.push('promptReadiness retrievalHash does not match generation job');
  }

  if (!job.promptProductionContract) issues.push('missing promptProductionContract for executable generation');
  if (!productionHash) issues.push('missing promptProductionContractHash for executable generation');
  if (productionHash && !isCanonicalHash(productionHash)) issues.push('promptProductionContractHash must be canonical sha256');
  if (job.promptProductionContract && !productionSourceHash) issues.push('missing promptProductionContract.promptProductionContractHash for executable generation');
  if (productionSourceHash && !isCanonicalHash(productionSourceHash)) issues.push('promptProductionContract.promptProductionContractHash must be canonical sha256');
  if (productionSourceHash && productionHash && productionSourceHash !== productionHash) {
    issues.push('promptProductionContractHash does not match promptProductionContract.promptProductionContractHash');
  }
  if (production.ok !== true || production.status !== PROMPT_PRODUCTION_PASS_STATUS) {
    issues.push('promptProductionContract must be pass_prompt_production_contract for executable generation');
  }
  if ((production.blockers || []).length) issues.push(`promptProductionContract blockers: ${(production.blockers || []).map((item) => item.code || item).join(', ')}`);
  for (const flag of unsafePromptChainSafetyFlags(production.safety || {})) {
    issues.push(`promptProductionContract unsafe safety flag: ${flag}`);
  }
  if (job.promptProductionContract && !production.promptCompilerHash) issues.push('missing promptProductionContract.promptCompilerHash for executable generation');
  if (production.promptCompilerHash && !isCanonicalHash(production.promptCompilerHash)) issues.push('promptProductionContract.promptCompilerHash must be canonical sha256');
  if (production.promptCompilerHash && compilerHash && production.promptCompilerHash !== compilerHash) {
    issues.push('promptProductionContract promptCompilerHash does not match generation job');
  }
  if (job.promptProductionContract && !production.readinessHash) issues.push('missing promptProductionContract.readinessHash for executable generation');
  if (production.readinessHash && !isCanonicalHash(production.readinessHash)) issues.push('promptProductionContract.readinessHash must be canonical sha256');
  if (production.readinessHash && readinessHash && production.readinessHash !== readinessHash) {
    issues.push('promptProductionContract readinessHash does not match generation job');
  }
  if (job.promptProductionContract && !production.retrievalHash) issues.push('missing promptProductionContract.retrievalHash for executable generation');
  if (production.retrievalHash && !isCanonicalHash(production.retrievalHash)) issues.push('promptProductionContract.retrievalHash must be canonical sha256');
  if (production.retrievalHash && retrievalHash && production.retrievalHash !== retrievalHash) {
    issues.push('promptProductionContract retrievalHash does not match generation job');
  }
  if (production.refpackId && job.designReferenceSpec?.id && production.refpackId !== job.designReferenceSpec.id) {
    issues.push('promptProductionContract refpackId does not match generation job');
  }

  if (feedbackLearningBridgeHash) {
    if (!isCanonicalHash(feedbackLearningBridgeHash)) issues.push('feedbackLearningBridgeHash must be canonical sha256');
    if (job.designReferenceSpec?.feedbackLearningBridgeHash && job.feedbackLearningBridgeHash && job.designReferenceSpec.feedbackLearningBridgeHash !== job.feedbackLearningBridgeHash) {
      issues.push('feedbackLearningBridgeHash does not match designReferenceSpec.feedbackLearningBridgeHash');
    }
  }

  if (!retrievalHash) issues.push('missing DesignReferenceRetrieval hash for executable generation');
  if (retrievalHash && !isCanonicalHash(retrievalHash)) issues.push('DesignReferenceRetrieval hash must be canonical sha256');
  if (job.designReferenceRetrieval && !retrievalSourceHash) issues.push('missing DesignReferenceRetrieval.retrievalHash for executable generation');
  if (retrievalSourceHash && !isCanonicalHash(retrievalSourceHash)) issues.push('DesignReferenceRetrieval.retrievalHash must be canonical sha256');
  if (retrievalSourceHash && retrievalHash && retrievalSourceHash !== retrievalHash) {
    issues.push('DesignReferenceRetrieval retrievalHash does not match generation job');
  }
  if (retrieval.ok !== true) issues.push(`DesignReferenceRetrieval not ok: ${retrieval.status || 'missing'}`);
  if (retrieval.status !== MODEL_LOCKED_RETRIEVAL_STATUS) issues.push(`DesignReferenceRetrieval status must be ${MODEL_LOCKED_RETRIEVAL_STATUS}`);
  if (retrieval.routingMode !== MODEL_LOCKED_ROUTING_MODE) issues.push(`DesignReferenceRetrieval routingMode must be ${MODEL_LOCKED_ROUTING_MODE}`);
  if (retrieval.selectionAuthority !== MODEL_LOCKED_SELECTION_AUTHORITY) issues.push(`DesignReferenceRetrieval selectionAuthority must be ${MODEL_LOCKED_SELECTION_AUTHORITY}`);
  if (retrieval.indexRoutingActive !== false) issues.push('DesignReferenceRetrieval indexRoutingActive must be false');
  if (retrieval.indexOverrideAllowed !== false) issues.push('DesignReferenceRetrieval indexOverrideAllowed must be false');
  if ((retrieval.blockers || []).length) issues.push(`DesignReferenceRetrieval blockers: ${(retrieval.blockers || []).map((item) => item.code || item).join(', ')}`);
  if (!retrieval.industryArbitration) {
    issues.push('DesignReferenceRetrieval industryArbitration missing');
  } else {
    if (retrieval.industryArbitration.ok !== true) issues.push(`DesignReferenceRetrieval industryArbitration blocked: ${retrieval.industryArbitration.status || 'unknown'}`);
    if ((retrieval.industryArbitration.blockers || []).length) issues.push(`DesignReferenceRetrieval industryArbitration blockers: ${(retrieval.industryArbitration.blockers || []).map((item) => item.code || item).join(', ')}`);
  }

  for (const [idx, request] of (job.requests || []).entries()) {
    if (!request.promptCompilerHash) issues.push(`request[${idx}] missing promptCompilerHash for executable generation`);
    if (request.promptCompilerHash && !isCanonicalHash(request.promptCompilerHash)) issues.push(`request[${idx}] promptCompilerHash must be canonical sha256`);
    if (!request.promptProductionContractHash) issues.push(`request[${idx}] missing promptProductionContractHash for executable generation`);
    if (request.promptProductionContractHash && request.promptProductionContractHash !== productionHash) issues.push(`request[${idx}] promptProductionContractHash does not match generation job`);
    if (!request.retrievalHash) issues.push(`request[${idx}] missing retrievalHash for executable generation`);
    if (request.retrievalHash && retrievalHash && request.retrievalHash !== retrievalHash) issues.push(`request[${idx}] retrievalHash does not match generation job`);
    if (feedbackLearningBridgeHash) {
      if (!request.feedbackLearningBridgeHash) issues.push(`request[${idx}] missing feedbackLearningBridgeHash for executable generation`);
      if (request.feedbackLearningBridgeHash && request.feedbackLearningBridgeHash !== feedbackLearningBridgeHash) issues.push(`request[${idx}] feedbackLearningBridgeHash does not match generation job`);
    }
  }
  return issues;
}

export function validateGenerationJob(job, { semanticValidator = null } = {}) {
  const issues = [];
  if (job?.version !== GENERATION_CONTRACT_VERSION) issues.push(`version must be ${GENERATION_CONTRACT_VERSION}`);
  if (!job?.id) issues.push('missing id');
  if (!job?.taskId) issues.push('missing taskId');
  if (!job?.workflowId) issues.push('missing workflowId');
  if (!job?.provider?.providerId) issues.push('missing provider.providerId');
  if (!Array.isArray(job?.requests) || !job.requests.length) issues.push('missing requests');
  for (const [idx, request] of (job?.requests || []).entries()) {
    if (!request.id) issues.push(`request[${idx}] missing id`);
    if (!request.filename) issues.push(`request[${idx}] missing filename`);
    if (!request.prompt) issues.push(`request[${idx}] missing prompt`);
    if (job?.promptCompiler && !request.promptCompilerHash) issues.push(`request[${idx}] missing promptCompilerHash`);
    if (request.routeStrategy && !request.routeStrategyHash) issues.push(`request[${idx}] missing routeStrategyHash`);
    if (!Array.isArray(request.acceptance)) issues.push(`request[${idx}] acceptance must be array`);
    if (request.qualityChecks && !Array.isArray(request.qualityChecks)) issues.push(`request[${idx}] qualityChecks must be array`);
    if (job?.attachmentSpec?.required && (!Array.isArray(request.referenceImages) || request.referenceImages.length === 0)) {
      issues.push(`request[${idx}] missing attachment referenceImages`);
    }
  }
  issues.push(...executablePromptChainIssues(job));
  if (job?.attachmentSpec?.required && (!Array.isArray(job.attachmentSpec.referenceImages) || job.attachmentSpec.referenceImages.length === 0)) {
    issues.push('attachmentSpec.required=true but no referenceImages are available');
  }
  if (job?.attachmentSpec?.required && job.attachmentSpec?.blockers?.length) issues.push(`attachmentSpec blockers: ${job.attachmentSpec.blockers.join(', ')}`);
  if ((job?.qaContract?.importBlockers || []).includes('semantic_contract_lock_required')) {
    issues.push(...semanticIssuesFromValidator(job, semanticValidator));
  }
  if (!Array.isArray(job?.qa) || job.qa.length !== (job?.requests || []).length) issues.push('qa records must match requests length');
  const blockingArtifactChecks = (job?.qaContract?.artifactChecks || []).filter((check) => check.blocking !== false);
  if (blockingArtifactChecks.length && Array.isArray(job?.qa)) {
    for (const [idx, record] of job.qa.entries()) {
      const ids = new Set((record.checks || []).map((check) => check.id));
      for (const check of blockingArtifactChecks) {
        const prefixed = `${check.source === 'drift_guard' ? 'drift' : 'gate'}_${check.id}`;
        if (!ids.has(check.id) && !ids.has(prefixed)) issues.push(`qa[${idx}] missing blocking artifact check: ${check.id}`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

export function generationContractsSelftest() {
  const retrievalHash = digest({ fixture: 'generation-contracts', kind: 'retrieval' });
  const feedbackLearningBridgeHash = digest({ fixture: 'generation-contracts', kind: 'feedback-learning-bridge' });
  const compilerHash = digest({ fixture: 'generation-contracts', kind: 'artifact-compiler' });
  const promptCompilerHash = digest({ fixture: 'generation-contracts', kind: 'prompt-compiler', compilerHash });
  const readinessHash = digest({ fixture: 'generation-contracts', kind: 'readiness', promptCompilerHash });
  const routeStrategyHash = digest({ fixture: 'generation-contracts', kind: 'route-strategy' });
  const promptProductionContractHash = digest({
    fixture: 'generation-contracts',
    kind: 'prompt-production-contract',
    promptCompilerHash,
    readinessHash,
    retrievalHash,
  });
  const routeStrategy = {
    version: 1,
    routeId: 'route-a',
    focus: 'wordmark-first enterprise route with application proof',
    differentiationKey: 'wordmark-first enterprise route',
    applicationProof: ['dashboard mockup', 'signage proof'],
    routeStrategyHash,
  };
  const refpackId = 'refpack_general_technology_b2b_v1';
  const designReferenceRetrieval = {
    ok: true,
    status: MODEL_LOCKED_RETRIEVAL_STATUS,
    routingMode: MODEL_LOCKED_ROUTING_MODE,
    selectionAuthority: MODEL_LOCKED_SELECTION_AUTHORITY,
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
  };
  const promptCompiler = {
    kind: 'PromptCompilerPlanSummary',
    status: 'prompt_compiler_ready',
    promptCompilerHash,
    retrievalHash,
    refpackId,
    compilerHashes: [compilerHash],
  };
  const promptReadiness = {
    kind: 'PromptReadinessReport',
    ok: true,
    status: 'pass_prompt_readiness',
    readinessHash,
    promptCompilerHash,
    refreshedPromptCompilerHash: promptCompilerHash,
    retrievalHash,
    blockers: [],
    safety: { callsProviderOrModel: false, grantsExecutionPermission: false },
  };
  const promptProductionContract = {
    kind: 'PromptProductionContract',
    ok: true,
    status: PROMPT_PRODUCTION_PASS_STATUS,
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
  };
  const plan = {
    version: 4,
    taskId: 999,
    workflowId: 'logo_brand',
    outputMode: 'image_set',
    designReferenceSpec: {
      id: refpackId,
      feedbackLearningBridgeHash,
      feedbackLearningBridge: { bridgeHash: feedbackLearningBridgeHash, status: 'feedback_learning_ready' },
    },
    feedbackLearningBridge: { bridgeHash: feedbackLearningBridgeHash, status: 'feedback_learning_ready' },
    feedbackLearningBridgeHash,
    designReferenceRetrieval,
    promptCompiler,
    promptReadiness,
    promptProductionContract,
    prompts: [{
      index: 1,
      filename: '999-route-a.jpg',
      role: 'finished_vi_board',
      prompt: 'Create route A.',
      acceptance: ['application proof'],
      routeStrategy,
      promptCompiler: {
        kind: 'PromptCompilerArtifact',
        status: 'prompt_compiled',
        compilerHash,
        routeStrategyHash,
      },
    }],
    qaContract: { artifactChecks: [], importBlockers: [] },
  };
  const providerSelection = { providerId: 'dryrun', kind: 'dryrun', externalCalls: false };
  const providerPolicy = createImageGenerationProviderPolicy();
  const job = createGenerationJob({ plan, providerSelection, execute: false, dryRun: true, now: 0 });
  const valid = validateGenerationJob(job);
  const synced = validateGenerationPlanSync({ plan, manifest: job });
  const executableJob = createGenerationJob({ plan, providerSelection, execute: true, dryRun: false, now: 1 });
  const executableValid = validateGenerationJob(executableJob);
  const missingNestedCompilerHash = validateGenerationJob({
    ...executableJob,
    promptCompiler: {
      ...executableJob.promptCompiler,
      promptCompilerHash: null,
    },
  });
  const forgedReadiness = validateGenerationJob({
    ...executableJob,
    promptReadiness: { ok: true },
    promptReadinessHash: null,
  });
  const missingReadinessRetrievalHash = validateGenerationJob({
    ...executableJob,
    promptReadiness: {
      ...executableJob.promptReadiness,
      retrievalHash: null,
    },
  });
  const missingReadinessRefreshedCompilerHash = validateGenerationJob({
    ...executableJob,
    promptReadiness: {
      ...executableJob.promptReadiness,
      refreshedPromptCompilerHash: null,
    },
  });
  const missingNestedProductionCompilerHash = validateGenerationJob({
    ...executableJob,
    promptProductionContract: {
      ...executableJob.promptProductionContract,
      promptCompilerHash: null,
    },
  });
  const missingNestedRetrievalHash = validateGenerationJob({
    ...executableJob,
    designReferenceRetrieval: {
      ...executableJob.designReferenceRetrieval,
      retrievalHash: null,
    },
  });
  const missingProductionContract = validateGenerationJob({
    ...executableJob,
    promptProductionContract: null,
    promptProductionContractHash: null,
  });
  const overrideRetrieval = validateGenerationJob({
    ...executableJob,
    designReferenceRetrieval: {
      ...executableJob.designReferenceRetrieval,
      routingMode: 'index_routing',
      selectionAuthority: 'refpack_index',
      indexRoutingActive: true,
      indexOverrideAllowed: true,
    },
  });
  const missingCompilerSync = validateGenerationPlanSync({
    plan,
    manifest: {
      ...executableJob,
      promptCompiler: null,
      promptCompilerHash: null,
    },
  });
  const tampered = {
    ...job,
    requests: job.requests.map((request, index) => index === 0
      ? { ...request, routeStrategyHash: 'sha256:tampered-route-strategy' }
      : request),
  };
  const stale = validateGenerationPlanSync({ plan, manifest: tampered });
  const staleReason = stale.issues
    .flatMap((issue) => issue.details?.requests || [])
    .some((item) => item.reason === 'route_strategy_hash_mismatch');
  const staleFeedback = validateGenerationPlanSync({
    plan,
    manifest: {
      ...job,
      feedbackLearningBridgeHash: digest({ fixture: 'generation-contracts', kind: 'stale-feedback-learning-bridge' }),
      designReferenceSpec: {
        ...job.designReferenceSpec,
        feedbackLearningBridgeHash: digest({ fixture: 'generation-contracts', kind: 'stale-feedback-learning-bridge' }),
      },
    },
  });
  const semanticRequired = validateGenerationJob({
    ...job,
    qaContract: { importBlockers: ['semantic_contract_lock_required'] },
  });
  const semanticPassed = validateGenerationJob({
    ...job,
    qaContract: { importBlockers: ['semantic_contract_lock_required'] },
  }, {
    semanticValidator: () => ({ ok: true, issues: [] }),
  });
  return {
    ok: valid.ok
      && synced.ok
      && executableValid.ok
      && missingNestedCompilerHash.ok === false
      && missingNestedCompilerHash.issues.includes('missing promptCompiler.promptCompilerHash for executable generation')
      && forgedReadiness.ok === false
      && forgedReadiness.issues.includes('missing promptReadinessHash for executable generation')
      && missingReadinessRetrievalHash.ok === false
      && missingReadinessRetrievalHash.issues.includes('missing promptReadiness.retrievalHash for executable generation')
      && missingReadinessRefreshedCompilerHash.ok === false
      && missingReadinessRefreshedCompilerHash.issues.includes('missing promptReadiness.refreshedPromptCompilerHash for executable generation')
      && missingNestedProductionCompilerHash.ok === false
      && missingNestedProductionCompilerHash.issues.includes('missing promptProductionContract.promptCompilerHash for executable generation')
      && missingNestedRetrievalHash.ok === false
      && missingNestedRetrievalHash.issues.includes('missing DesignReferenceRetrieval.retrievalHash for executable generation')
      && missingProductionContract.ok === false
      && missingProductionContract.issues.includes('missing promptProductionContract for executable generation')
      && overrideRetrieval.ok === false
      && overrideRetrieval.issues.includes('DesignReferenceRetrieval indexOverrideAllowed must be false')
      && missingCompilerSync.ok === false
      && missingCompilerSync.issues.some((issue) => issue.id === 'generation_manifest_prompt_compiler_stale')
      && stale.ok === false
      && stale.issues.some((issue) => issue.id === 'generation_manifest_prompt_stale')
      && staleReason
      && staleFeedback.ok === false
      && staleFeedback.issues.some((issue) => issue.id === 'generation_manifest_feedback_learning_bridge_stale')
      && job.feedbackLearningBridgeHash === feedbackLearningBridgeHash
      && job.requests[0]?.feedbackLearningBridgeHash === feedbackLearningBridgeHash
      && job.requests[0]?.routeStrategyHash === routeStrategy.routeStrategyHash
      && semanticRequired.ok === false
      && semanticPassed.ok === true
      && providerPolicy.preferredProviderId === IMAGE_GENERATION_PROVIDER_IDS.CODEX_IMAGEGEN
      && providerPolicy.agentMediatedProviderIds.includes(IMAGE_GENERATION_PROVIDER_IDS.CODEX_IMAGEGEN)
      && !providerPolicy.workerExecutableProviderIds.includes(IMAGE_GENERATION_PROVIDER_IDS.CODEX_IMAGEGEN)
      && providerPolicy.workerExecutableProviderIds.includes(IMAGE_GENERATION_PROVIDER_IDS.OPENCLAW_IMAGE)
      && providerPolicy.requiredDownstreamGates.includes('final_review_pass')
      && providerPolicy.provenanceRules.importRequired === true
      && providerPolicy.safety.callsProviderOrModel === false
      && providerPolicy.safety.grantsExecutionPermission === false
      && job.safety?.localContractOnly === true
      && job.safety?.callsProviderOrModel === false
      && job.safety?.grantsExecutionPermission === false,
    valid,
    synced,
    executableValid,
    missingNestedCompilerHash,
    forgedReadiness,
    missingReadinessRetrievalHash,
    missingReadinessRefreshedCompilerHash,
    missingNestedProductionCompilerHash,
    missingNestedRetrievalHash,
    missingProductionContract,
    overrideRetrieval,
    missingCompilerSync,
    stale,
    staleFeedback,
    semanticRequired,
    semanticPassed,
    providerPolicy,
    requestRouteStrategyHash: job.requests[0]?.routeStrategyHash || null,
    safety: job.safety,
    manifestId: job.id,
  };
}
