import { canonicalProductLineIdOrNull, normalizeText, uniqueStrings } from './contracts.mjs';
import { feedbackLearningBridgeHashFor } from './feedback-learning-bridge-contracts.mjs';
import { digest } from './hash-utils.mjs';

export const PROMPT_PRODUCTION_CONTRACT_VERSION = 1;

export const PROMPT_PRODUCTION_STATUS = Object.freeze({
  PASS: 'pass_prompt_production_contract',
  BLOCKED: 'blocked_prompt_production_contract',
});

const HASH_PREFIX = 'sha256:';
const HASH_LENGTH = 71;
const REQUIRED_SECTION_IDS = Object.freeze([
  'subject_lock',
  'route_intent',
  'reference_grammar',
  'negative_constraints',
  'retrieval_evidence',
]);

const UNSAFE_SAFETY_FLAGS = Object.freeze([
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
]);

function list(value = [], limit = 64) {
  return uniqueStrings(Array.isArray(value) ? value : (value ? [value] : []), limit);
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isCanonicalHash(value) {
  const text = normalizeText(value || '');
  if (!text.startsWith(HASH_PREFIX) || text.length !== HASH_LENGTH) return false;
  for (const char of text.slice(HASH_PREFIX.length)) {
    if (!'0123456789abcdef'.includes(char)) return false;
  }
  return true;
}

function issue(code, notes = null, artifactIndex = null) {
  return {
    code,
    notes: notes || null,
    artifactIndex,
  };
}

function normalizeSafety(safety = {}) {
  return Object.fromEntries(Object.entries(safety || {})
    .filter(([key]) => key)
    .map(([key, value]) => [key, value === true]));
}

function safetyBlockers(safety = {}, prefix = 'prompt_contract_safety') {
  const normalized = normalizeSafety(safety);
  return UNSAFE_SAFETY_FLAGS
    .filter((key) => normalized[key] === true)
    .map((key) => issue(`${prefix}_flag_unsafe`, key));
}

function sectionIds(sections = []) {
  return list((sections || []).map((section) => section?.id || section?.sectionId || ''), 32);
}

function normalizePromptSections(sections = []) {
  return (sections || []).map((section) => ({
    id: normalizeText(section?.id || section?.sectionId || '') || null,
    title: normalizeText(section?.title || '') || null,
    itemCount: numberOrZero(section?.itemCount ?? (Array.isArray(section?.items) ? section.items.length : 0)),
    blocking: section?.blocking === true,
  })).filter((section) => section.id);
}

function normalizePromptCompilerArtifact(artifact = {}, indexFallback = null) {
  const index = artifact.index ?? artifact.artifactIndex ?? indexFallback;
  const compilerHash = normalizeText(artifact.compilerHash || artifact.promptCompiler?.compilerHash || '') || null;
  const sections = normalizePromptSections(artifact.sections || artifact.promptCompiler?.sections || []);
  return {
    index,
    filename: normalizeText(artifact.filename || artifact.name || '') || null,
    role: normalizeText(artifact.role || '') || null,
    compilerHash,
    routeStrategyHash: normalizeText(artifact.routeStrategyHash || artifact.promptCompiler?.routeStrategyHash || '') || null,
    sectionIds: sectionIds(sections),
    sections,
    metrics: {
      activeSectionCount: numberOrZero(artifact.metrics?.activeSectionCount || artifact.promptCompiler?.metrics?.activeSectionCount),
      negativeConstraintCount: numberOrZero(artifact.metrics?.negativeConstraintCount || artifact.promptCompiler?.metrics?.negativeConstraintCount),
      promptBudgetExceeded: artifact.metrics?.promptBudgetExceeded === true || artifact.promptCompiler?.metrics?.promptBudgetExceeded === true,
      semanticLintBlockerCount: numberOrZero(artifact.metrics?.semanticLintBlockerCount || artifact.promptCompiler?.metrics?.semanticLintBlockerCount),
    },
  };
}

function normalizeReadinessArtifact(artifact = {}, indexFallback = null) {
  const index = artifact.index ?? artifact.artifactIndex ?? indexFallback;
  return {
    index,
    filename: normalizeText(artifact.filename || artifact.name || '') || null,
    ok: artifact.ok === true,
    compilerHash: normalizeText(artifact.compilerHash || '') || null,
    refreshedCompilerHash: normalizeText(artifact.refreshedCompilerHash || artifact.refreshedHash || '') || null,
    blockers: list((artifact.blockers || []).map((blocker) => blocker?.code || blocker), 64),
    warnings: list((artifact.warnings || []).map((warning) => warning?.code || warning), 64),
    sectionIds: sectionIds(artifact.sections || []),
  };
}

function normalizeCompilerSummary(summary = {}) {
  return {
    version: numberOrZero(summary.version),
    kind: normalizeText(summary.kind || '') || null,
    status: normalizeText(summary.status || '') || null,
    taskId: normalizeText(summary.taskId || '') || null,
    orderId: normalizeText(summary.orderId || '') || null,
    workflowId: canonicalProductLineIdOrNull(summary.workflowId) || normalizeText(summary.workflowId || '') || null,
    industryId: normalizeText(summary.industryId || '') || null,
    refpackId: normalizeText(summary.refpackId || '') || null,
    feedbackLearningBridgeHash: normalizeText(summary.feedbackLearningBridgeHash || '') || null,
    retrievalHash: normalizeText(summary.retrievalHash || '') || null,
    routeContractHash: normalizeText(summary.routeContractHash || '') || null,
    routeStrategyHashes: list(summary.routeStrategyHashes, 128),
    artifactCount: numberOrZero(summary.artifactCount),
    compilerHashes: list(summary.compilerHashes, 256),
    promptCompilerHash: normalizeText(summary.promptCompilerHash || '') || null,
    safety: normalizeSafety(summary.safety || {}),
    metrics: {
      activeSectionCount: numberOrZero(summary.metrics?.activeSectionCount),
      negativeConstraintCount: numberOrZero(summary.metrics?.negativeConstraintCount),
      structuredRouteStrategyCount: numberOrZero(summary.metrics?.structuredRouteStrategyCount),
      promptBudgetExceededCount: numberOrZero(summary.metrics?.promptBudgetExceededCount),
      semanticLintBlockerCount: numberOrZero(summary.metrics?.semanticLintBlockerCount),
    },
  };
}

function normalizeCompilerReport(report = {}) {
  const summary = normalizeCompilerSummary(report.summary || report.promptCompiler || {});
  return {
    kind: normalizeText(report.kind || '') || null,
    status: normalizeText(report.status || '') || null,
    ok: report.ok === true,
    taskId: normalizeText(report.taskId || summary.taskId || '') || null,
    orderId: normalizeText(report.orderId || summary.orderId || '') || null,
    workflowId: canonicalProductLineIdOrNull(report.workflowId || summary.workflowId) || normalizeText(report.workflowId || summary.workflowId || '') || null,
    industryId: normalizeText(report.industryId || summary.industryId || '') || null,
    refpackId: normalizeText(report.refpackId || summary.refpackId || '') || null,
    feedbackLearningBridgeHash: normalizeText(report.feedbackLearningBridgeHash || summary.feedbackLearningBridgeHash || '') || null,
    retrievalHash: normalizeText(report.retrievalHash || summary.retrievalHash || '') || null,
    routeContractHash: normalizeText(report.routeContractHash || summary.routeContractHash || '') || null,
    summary,
    artifacts: (report.artifacts || []).map((artifact, index) => normalizePromptCompilerArtifact(artifact, index + 1)),
    reportHash: normalizeText(report.reportHash || report.promptCompilerReportHash || '') || null,
    safety: normalizeSafety(report.safety || {}),
  };
}

function normalizeReadinessReport(report = {}) {
  return {
    kind: normalizeText(report.kind || '') || null,
    status: normalizeText(report.status || '') || null,
    ok: report.ok === true,
    taskId: normalizeText(report.taskId || '') || null,
    orderId: normalizeText(report.orderId || '') || null,
    workflowId: canonicalProductLineIdOrNull(report.workflowId) || normalizeText(report.workflowId || '') || null,
    industryId: normalizeText(report.industryId || '') || null,
    refpackId: normalizeText(report.refpackId || '') || null,
    feedbackLearningBridgeHash: normalizeText(report.feedbackLearningBridgeHash || '') || null,
    retrievalHash: normalizeText(report.retrievalHash || '') || null,
    promptCompilerHash: normalizeText(report.promptCompilerHash || '') || null,
    refreshedPromptCompilerHash: normalizeText(report.refreshedPromptCompilerHash || '') || null,
    readinessHash: normalizeText(report.readinessHash || '') || null,
    reportHash: normalizeText(report.reportHash || '') || null,
    metrics: {
      artifactCount: numberOrZero(report.metrics?.artifactCount),
      passArtifactCount: numberOrZero(report.metrics?.passArtifactCount),
      blockerCount: numberOrZero(report.metrics?.blockerCount),
      warningCount: numberOrZero(report.metrics?.warningCount),
      routeSignatureCount: numberOrZero(report.metrics?.routeSignatureCount),
      applicationProofSignatureCount: numberOrZero(report.metrics?.applicationProofSignatureCount),
      differentiationSignatureCount: numberOrZero(report.metrics?.differentiationSignatureCount),
    },
    artifacts: (report.artifacts || []).map((artifact, index) => normalizeReadinessArtifact(artifact, index + 1)),
    promptSetStrategy: report.promptSetStrategy ? {
      ok: report.promptSetStrategy.ok === true,
      status: normalizeText(report.promptSetStrategy.status || '') || null,
      blockers: list((report.promptSetStrategy.blockers || []).map((blocker) => blocker?.code || blocker), 128),
      warnings: list((report.promptSetStrategy.warnings || []).map((warning) => warning?.code || warning), 128),
      metrics: report.promptSetStrategy.metrics || {},
    } : null,
    blockers: list((report.blockers || []).map((blocker) => blocker?.code || blocker), 128),
    warnings: list((report.warnings || []).map((warning) => warning?.code || warning), 128),
    safety: normalizeSafety(report.safety || {}),
  };
}

function normalizePlanDesignReferenceRetrieval(retrieval = {}) {
  const arbitration = retrieval?.industryArbitration || null;
  return {
    ok: retrieval?.ok === true,
    status: normalizeText(retrieval?.status || '') || null,
    routingMode: normalizeText(retrieval?.routingMode || '') || null,
    selectionAuthority: normalizeText(retrieval?.selectionAuthority || '') || null,
    indexRoutingActive: retrieval?.indexRoutingActive === true,
    indexOverrideAllowed: retrieval?.indexOverrideAllowed === true,
    retrievalHash: normalizeText(retrieval?.retrievalHash || '') || null,
    selectedRefpackId: normalizeText(retrieval?.selectedRefpackId || '') || null,
    staticRefpackId: normalizeText(retrieval?.staticRefpackId || '') || null,
    selectedIndustryId: normalizeText(retrieval?.selectedIndustryId || '') || null,
    blockerCodes: list((retrieval?.blockers || []).map((blocker) => blocker?.code || blocker), 64),
    industryArbitration: arbitration ? {
      ok: arbitration.ok === true,
      status: normalizeText(arbitration.status || '') || null,
      modelIndustryId: normalizeText(arbitration.modelIndustryId || '') || null,
      confidence: Number.isFinite(Number(arbitration.confidence)) ? Number(arbitration.confidence) : null,
      blockerCodes: list((arbitration.blockers || []).map((blocker) => blocker?.code || blocker), 64),
    } : null,
  };
}

function normalizePlanPromptBindings(plan = {}) {
  const designReferenceRetrieval = normalizePlanDesignReferenceRetrieval(plan.designReferenceRetrieval || {});
  return {
    taskId: normalizeText(plan.taskId || plan.externalId || '') || null,
    orderId: normalizeText(plan.orderId || '') || null,
    workflowId: canonicalProductLineIdOrNull(plan.workflowId) || normalizeText(plan.workflowId || '') || null,
    refpackId: normalizeText(plan.designReferenceSpec?.id || plan.designReferenceSpec?.selectedPackId || plan.designReferenceSpec?.referencePackage?.selectedPackId || '') || null,
    feedbackLearningBridgeHash: feedbackLearningBridgeHashFor(plan),
    retrievalHash: designReferenceRetrieval.retrievalHash,
    designReferenceRetrieval,
    promptCompilerHash: normalizeText(plan.promptCompiler?.promptCompilerHash || '') || null,
    readinessHash: normalizeText(plan.promptReadiness?.readinessHash || '') || null,
  };
}

function artifactBlockers(artifact) {
  const blockers = [];
  if (!artifact.compilerHash) blockers.push(issue('prompt_compiler_artifact_hash_missing', artifact.filename, artifact.index));
  if (artifact.compilerHash && !isCanonicalHash(artifact.compilerHash)) {
    blockers.push(issue('prompt_compiler_artifact_hash_not_canonical', artifact.compilerHash, artifact.index));
  }
  for (const sectionId of REQUIRED_SECTION_IDS) {
    if (!artifact.sectionIds.includes(sectionId)) {
      blockers.push(issue('prompt_compiler_required_section_missing', sectionId, artifact.index));
    }
  }
  if (artifact.metrics.activeSectionCount > 0 && artifact.metrics.activeSectionCount < REQUIRED_SECTION_IDS.length) {
    blockers.push(issue('prompt_compiler_active_sections_too_low', String(artifact.metrics.activeSectionCount), artifact.index));
  }
  if (artifact.metrics.promptBudgetExceeded) {
    blockers.push(issue('prompt_compiler_prompt_budget_exceeded', artifact.filename, artifact.index));
  }
  if (artifact.metrics.semanticLintBlockerCount > 0) {
    blockers.push(issue('prompt_compiler_semantic_lint_blocker_present', String(artifact.metrics.semanticLintBlockerCount), artifact.index));
  }
  return blockers;
}

function compilerReportBlockers(report) {
  const blockers = [
    ...(report.kind === 'PromptCompilerReport' ? [] : [issue('prompt_compiler_report_kind_invalid', report.kind)]),
    ...(report.status === 'prompt_compiler_report_ready' ? [] : [issue('prompt_compiler_report_status_not_ready', report.status)]),
    ...(report.ok ? [] : [issue('prompt_compiler_report_not_ok')]),
    ...(report.summary.kind === 'PromptCompilerPlanSummary' ? [] : [issue('prompt_compiler_summary_kind_invalid', report.summary.kind)]),
    ...(report.summary.status === 'prompt_compiler_ready' ? [] : [issue('prompt_compiler_summary_status_not_ready', report.summary.status)]),
    ...(report.summary.promptCompilerHash ? [] : [issue('prompt_compiler_summary_hash_missing')]),
    ...(report.summary.promptCompilerHash && !isCanonicalHash(report.summary.promptCompilerHash)
      ? [issue('prompt_compiler_summary_hash_not_canonical', report.summary.promptCompilerHash)]
      : []),
    ...(report.summary.feedbackLearningBridgeHash && !isCanonicalHash(report.summary.feedbackLearningBridgeHash)
      ? [issue('prompt_compiler_feedback_learning_bridge_hash_not_canonical', report.summary.feedbackLearningBridgeHash)]
      : []),
    ...(report.summary.refpackId ? [] : [issue('prompt_compiler_refpack_id_missing')]),
    ...(report.summary.retrievalHash ? [] : [issue('prompt_compiler_retrieval_hash_missing')]),
    ...(report.summary.artifactCount === report.artifacts.length ? [] : [issue('prompt_compiler_artifact_count_mismatch', `${report.summary.artifactCount}/${report.artifacts.length}`)]),
    ...(report.summary.compilerHashes.length === report.artifacts.length ? [] : [issue('prompt_compiler_hash_count_mismatch', `${report.summary.compilerHashes.length}/${report.artifacts.length}`)]),
    ...safetyBlockers(report.summary.safety, 'prompt_compiler_summary_safety'),
    ...safetyBlockers(report.safety, 'prompt_compiler_report_safety'),
  ];
  const summaryHashSet = new Set(report.summary.compilerHashes);
  for (const artifact of report.artifacts) {
    blockers.push(...artifactBlockers(artifact));
    if (artifact.compilerHash && !summaryHashSet.has(artifact.compilerHash)) {
      blockers.push(issue('prompt_compiler_artifact_hash_not_in_summary', artifact.compilerHash, artifact.index));
    }
  }
  return blockers;
}

function readinessReportBlockers(report, compiler) {
  const blockers = [
    ...(report.kind === 'PromptReadinessReport' ? [] : [issue('prompt_readiness_report_kind_invalid', report.kind)]),
    ...(report.status === 'pass_prompt_readiness' ? [] : [issue('prompt_readiness_status_not_pass', report.status)]),
    ...(report.ok ? [] : [issue('prompt_readiness_report_not_ok')]),
    ...(report.readinessHash ? [] : [issue('prompt_readiness_hash_missing')]),
    ...(report.readinessHash && !isCanonicalHash(report.readinessHash) ? [issue('prompt_readiness_hash_not_canonical', report.readinessHash)] : []),
    ...(report.promptCompilerHash ? [] : [issue('prompt_readiness_prompt_compiler_hash_missing')]),
    ...(report.promptCompilerHash && !isCanonicalHash(report.promptCompilerHash)
      ? [issue('prompt_readiness_prompt_compiler_hash_not_canonical', report.promptCompilerHash)]
      : []),
    ...(report.refreshedPromptCompilerHash ? [] : [issue('prompt_readiness_refreshed_compiler_hash_missing')]),
    ...(report.refreshedPromptCompilerHash && !isCanonicalHash(report.refreshedPromptCompilerHash)
      ? [issue('prompt_readiness_refreshed_compiler_hash_not_canonical', report.refreshedPromptCompilerHash)]
      : []),
    ...(report.refpackId ? [] : [issue('prompt_readiness_refpack_id_missing')]),
    ...(report.retrievalHash ? [] : [issue('prompt_readiness_retrieval_hash_missing')]),
    ...(report.retrievalHash && !isCanonicalHash(report.retrievalHash)
      ? [issue('prompt_readiness_retrieval_hash_not_canonical', report.retrievalHash)]
      : []),
    ...(report.feedbackLearningBridgeHash && !isCanonicalHash(report.feedbackLearningBridgeHash)
      ? [issue('prompt_readiness_feedback_learning_bridge_hash_not_canonical', report.feedbackLearningBridgeHash)]
      : []),
    ...(report.promptCompilerHash && compiler.summary.promptCompilerHash && report.promptCompilerHash !== compiler.summary.promptCompilerHash
      ? [issue('prompt_readiness_compiler_hash_mismatch', `${report.promptCompilerHash} != ${compiler.summary.promptCompilerHash}`)]
      : []),
    ...(report.refreshedPromptCompilerHash && compiler.summary.promptCompilerHash && report.refreshedPromptCompilerHash !== compiler.summary.promptCompilerHash
      ? [issue('prompt_readiness_refreshed_compiler_hash_mismatch', `${report.refreshedPromptCompilerHash} != ${compiler.summary.promptCompilerHash}`)]
      : []),
    ...(report.refpackId && compiler.summary.refpackId && report.refpackId !== compiler.summary.refpackId
      ? [issue('prompt_readiness_refpack_mismatch', `${report.refpackId} != ${compiler.summary.refpackId}`)]
      : []),
    ...(report.retrievalHash && compiler.summary.retrievalHash && report.retrievalHash !== compiler.summary.retrievalHash
      ? [issue('prompt_readiness_retrieval_hash_mismatch', `${report.retrievalHash} != ${compiler.summary.retrievalHash}`)]
      : []),
    ...(report.metrics.artifactCount === compiler.artifacts.length ? [] : [issue('prompt_readiness_artifact_count_mismatch', `${report.metrics.artifactCount}/${compiler.artifacts.length}`)]),
    ...(report.metrics.passArtifactCount === report.metrics.artifactCount ? [] : [issue('prompt_readiness_pass_artifact_count_mismatch', `${report.metrics.passArtifactCount}/${report.metrics.artifactCount}`)]),
    ...(report.metrics.blockerCount === 0 ? [] : [issue('prompt_readiness_blocker_count_nonzero', String(report.metrics.blockerCount))]),
    ...(report.blockers.length === 0 ? [] : report.blockers.map((code) => issue('prompt_readiness_blocker_present', code))),
    ...(report.promptSetStrategy && report.promptSetStrategy.ok !== true ? [issue('prompt_set_strategy_not_pass', report.promptSetStrategy.status)] : []),
    ...(report.promptSetStrategy?.blockers?.length ? report.promptSetStrategy.blockers.map((code) => issue('prompt_set_strategy_blocker_present', code)) : []),
    ...safetyBlockers(report.safety, 'prompt_readiness_safety'),
  ];
  const compilerHashSet = new Set(compiler.artifacts.map((artifact) => artifact.compilerHash).filter(Boolean));
  for (const artifact of report.artifacts) {
    if (!artifact.ok) blockers.push(issue('prompt_readiness_artifact_not_ok', artifact.filename, artifact.index));
    if (!artifact.compilerHash) blockers.push(issue('prompt_readiness_artifact_compiler_hash_missing', artifact.filename, artifact.index));
    if (artifact.compilerHash && !compilerHashSet.has(artifact.compilerHash)) {
      blockers.push(issue('prompt_readiness_artifact_hash_not_in_compiler_report', artifact.compilerHash, artifact.index));
    }
    if (artifact.refreshedCompilerHash && artifact.compilerHash && artifact.refreshedCompilerHash !== artifact.compilerHash) {
      blockers.push(issue('prompt_readiness_artifact_refreshed_hash_mismatch', artifact.refreshedCompilerHash, artifact.index));
    }
    for (const sectionId of REQUIRED_SECTION_IDS) {
      if (artifact.sectionIds.length && !artifact.sectionIds.includes(sectionId)) {
        blockers.push(issue('prompt_readiness_required_section_missing', sectionId, artifact.index));
      }
    }
    for (const code of artifact.blockers) {
      blockers.push(issue('prompt_readiness_artifact_blocker_present', code, artifact.index));
    }
  }
  return blockers;
}

function planBindingBlockers(planBindings, compiler, readiness) {
  return [
    ...(planBindings.retrievalHash ? [] : [issue('prompt_plan_retrieval_hash_missing')]),
    ...(planBindings.designReferenceRetrieval.ok === true ? [] : [issue('prompt_plan_retrieval_not_ok', planBindings.designReferenceRetrieval.status)]),
    ...(planBindings.designReferenceRetrieval.status === 'model_locked_static_refpack'
      ? []
      : [issue('prompt_plan_retrieval_status_not_model_locked', planBindings.designReferenceRetrieval.status)]),
    ...(planBindings.designReferenceRetrieval.routingMode === 'model_semantic_locked'
      ? []
      : [issue('prompt_plan_retrieval_routing_mode_invalid', planBindings.designReferenceRetrieval.routingMode)]),
    ...(planBindings.designReferenceRetrieval.selectionAuthority === 'semantic_intake'
      ? []
      : [issue('prompt_plan_retrieval_selection_authority_invalid', planBindings.designReferenceRetrieval.selectionAuthority)]),
    ...(planBindings.designReferenceRetrieval.indexRoutingActive === false ? [] : [issue('prompt_plan_retrieval_index_routing_active')]),
    ...(planBindings.designReferenceRetrieval.indexOverrideAllowed === false ? [] : [issue('prompt_plan_retrieval_index_override_allowed')]),
    ...(planBindings.designReferenceRetrieval.blockerCodes.length
      ? planBindings.designReferenceRetrieval.blockerCodes.map((code) => issue('prompt_plan_retrieval_blocker_present', code))
      : []),
    ...(planBindings.designReferenceRetrieval.industryArbitration
      ? []
      : [issue('prompt_plan_retrieval_arbitration_missing')]),
    ...(planBindings.designReferenceRetrieval.industryArbitration?.ok === true
      ? []
      : [issue('prompt_plan_retrieval_arbitration_blocked', planBindings.designReferenceRetrieval.industryArbitration?.status || null)]),
    ...(planBindings.designReferenceRetrieval.industryArbitration?.blockerCodes?.length
      ? planBindings.designReferenceRetrieval.industryArbitration.blockerCodes.map((code) => issue('prompt_plan_retrieval_arbitration_blocker_present', code))
      : []),
    ...(planBindings.workflowId && compiler.workflowId && planBindings.workflowId !== compiler.workflowId
      ? [issue('prompt_plan_workflow_mismatch', `${planBindings.workflowId} != ${compiler.workflowId}`)]
      : []),
    ...(planBindings.refpackId && compiler.summary.refpackId && planBindings.refpackId !== compiler.summary.refpackId
      ? [issue('prompt_plan_refpack_mismatch', `${planBindings.refpackId} != ${compiler.summary.refpackId}`)]
      : []),
    ...(planBindings.retrievalHash && compiler.summary.retrievalHash && planBindings.retrievalHash !== compiler.summary.retrievalHash
      ? [issue('prompt_plan_retrieval_hash_mismatch', `${planBindings.retrievalHash} != ${compiler.summary.retrievalHash}`)]
      : []),
    ...(planBindings.feedbackLearningBridgeHash && !compiler.summary.feedbackLearningBridgeHash
      ? [issue('prompt_compiler_feedback_learning_bridge_hash_missing')]
      : []),
    ...(planBindings.feedbackLearningBridgeHash && compiler.summary.feedbackLearningBridgeHash && planBindings.feedbackLearningBridgeHash !== compiler.summary.feedbackLearningBridgeHash
      ? [issue('prompt_plan_feedback_learning_bridge_hash_mismatch', `${planBindings.feedbackLearningBridgeHash} != ${compiler.summary.feedbackLearningBridgeHash}`)]
      : []),
    ...(planBindings.feedbackLearningBridgeHash && !readiness.feedbackLearningBridgeHash
      ? [issue('prompt_readiness_feedback_learning_bridge_hash_missing')]
      : []),
    ...(planBindings.feedbackLearningBridgeHash && readiness.feedbackLearningBridgeHash && planBindings.feedbackLearningBridgeHash !== readiness.feedbackLearningBridgeHash
      ? [issue('prompt_plan_readiness_feedback_learning_bridge_hash_mismatch', `${planBindings.feedbackLearningBridgeHash} != ${readiness.feedbackLearningBridgeHash}`)]
      : []),
    ...(planBindings.promptCompilerHash && compiler.summary.promptCompilerHash && planBindings.promptCompilerHash !== compiler.summary.promptCompilerHash
      ? [issue('prompt_plan_compiler_hash_mismatch', `${planBindings.promptCompilerHash} != ${compiler.summary.promptCompilerHash}`)]
      : []),
    ...(planBindings.readinessHash && readiness.readinessHash && planBindings.readinessHash !== readiness.readinessHash
      ? [issue('prompt_plan_readiness_hash_mismatch', `${planBindings.readinessHash} != ${readiness.readinessHash}`)]
      : []),
  ];
}

export function buildPromptProductionContract({
  plan = {},
  promptCompilerReport = {},
  promptReadinessReport = {},
  createdAt = new Date().toISOString(),
  evidenceRefs = [],
} = {}) {
  const planBindings = normalizePlanPromptBindings(plan);
  const compiler = normalizeCompilerReport(promptCompilerReport);
  const readiness = normalizeReadinessReport(promptReadinessReport);
  const blockers = [
    ...compilerReportBlockers(compiler),
    ...readinessReportBlockers(readiness, compiler),
    ...planBindingBlockers(planBindings, compiler, readiness),
  ];
  const warnings = [
    ...(readiness.warnings || []).map((code) => issue('prompt_readiness_warning_forwarded', code)),
  ];
  const contract = {
    version: PROMPT_PRODUCTION_CONTRACT_VERSION,
    kind: 'PromptProductionContract',
    ok: blockers.length === 0,
    status: blockers.length ? PROMPT_PRODUCTION_STATUS.BLOCKED : PROMPT_PRODUCTION_STATUS.PASS,
    createdAt,
    taskId: planBindings.taskId || compiler.taskId || readiness.taskId || null,
    orderId: planBindings.orderId || compiler.orderId || readiness.orderId || null,
    workflowId: planBindings.workflowId || compiler.workflowId || readiness.workflowId || null,
    refpackId: planBindings.refpackId || compiler.summary.refpackId || readiness.refpackId || null,
    feedbackLearningBridgeHash: planBindings.feedbackLearningBridgeHash || compiler.summary.feedbackLearningBridgeHash || readiness.feedbackLearningBridgeHash || null,
    retrievalHash: planBindings.retrievalHash || compiler.summary.retrievalHash || readiness.retrievalHash || null,
    promptCompilerHash: compiler.summary.promptCompilerHash || null,
    readinessHash: readiness.readinessHash || null,
    planBindings,
    compiler: {
      reportKind: compiler.kind,
      reportStatus: compiler.status,
      reportHash: compiler.reportHash,
      summary: compiler.summary,
      artifacts: compiler.artifacts,
    },
    readiness: {
      reportKind: readiness.kind,
      status: readiness.status,
      reportHash: readiness.reportHash,
      metrics: readiness.metrics,
      artifacts: readiness.artifacts,
      promptSetStrategy: readiness.promptSetStrategy,
    },
    evidenceRefs: (evidenceRefs || []).map((entry) => ({
      kind: normalizeText(entry?.kind || entry?.type || '') || null,
      ref: normalizeText(entry?.ref || entry?.path || entry?.hash || entry?.id || '') || null,
    })).filter((entry) => entry.kind || entry.ref),
    blockers,
    warnings,
    safety: {
      localContractOnly: true,
      validatesPromptCompilerReport: true,
      validatesPromptReadinessReport: true,
      executesExternalAction: false,
      callsProvider: false,
      callsModel: false,
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
  const promptProductionContractHash = digest({
    version: contract.version,
    kind: contract.kind,
    status: contract.status,
    taskId: contract.taskId,
    orderId: contract.orderId,
    workflowId: contract.workflowId,
    refpackId: contract.refpackId,
    feedbackLearningBridgeHash: contract.feedbackLearningBridgeHash,
    retrievalHash: contract.retrievalHash,
    promptCompilerHash: contract.promptCompilerHash,
    readinessHash: contract.readinessHash,
    planBindings: contract.planBindings,
    compiler: {
      reportKind: contract.compiler.reportKind,
      reportStatus: contract.compiler.reportStatus,
      summary: contract.compiler.summary,
      artifacts: contract.compiler.artifacts.map((artifact) => ({
        index: artifact.index,
        filename: artifact.filename,
        compilerHash: artifact.compilerHash,
        routeStrategyHash: artifact.routeStrategyHash,
        sectionIds: artifact.sectionIds,
      })),
    },
    readiness: {
      reportKind: contract.readiness.reportKind,
      status: contract.readiness.status,
      metrics: contract.readiness.metrics,
      artifacts: contract.readiness.artifacts.map((artifact) => ({
        index: artifact.index,
        filename: artifact.filename,
        ok: artifact.ok,
        compilerHash: artifact.compilerHash,
        refreshedCompilerHash: artifact.refreshedCompilerHash,
      })),
      promptSetStrategy: contract.readiness.promptSetStrategy,
    },
    evidenceRefs: contract.evidenceRefs,
    blockers: contract.blockers,
    warnings: contract.warnings,
    safety: contract.safety,
  });
  return {
    ...contract,
    promptProductionContractHash,
    hash: promptProductionContractHash,
  };
}

export function validatePromptProductionContract(contract = {}) {
  const blockers = [
    ...(contract.kind === 'PromptProductionContract' ? [] : [issue('prompt_production_contract_kind_invalid', contract.kind)]),
    ...(contract.status === PROMPT_PRODUCTION_STATUS.PASS && contract.ok === true ? [] : [issue('prompt_production_contract_not_pass', contract.status)]),
    ...(contract.promptProductionContractHash && isCanonicalHash(contract.promptProductionContractHash)
      ? []
      : [issue('prompt_production_contract_hash_missing_or_invalid', contract.promptProductionContractHash)]),
    ...safetyBlockers(contract.safety || {}, 'prompt_production_contract_safety'),
    ...((contract.blockers || []).length ? [issue('prompt_production_contract_embedded_blockers_present', String(contract.blockers.length))] : []),
  ];
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_prompt_production_contract_validation' : 'pass_prompt_production_contract_validation',
    contractHash: contract.promptProductionContractHash || null,
    blockers,
  };
}

export function summarizePromptProductionContracts(contracts = []) {
  const byStatus = {};
  const byWorkflow = {};
  for (const contract of contracts || []) {
    byStatus[contract.status || 'unknown'] = (byStatus[contract.status || 'unknown'] || 0) + 1;
    const workflowId = contract.workflowId || 'unknown';
    byWorkflow[workflowId] = (byWorkflow[workflowId] || 0) + 1;
  }
  return {
    version: PROMPT_PRODUCTION_CONTRACT_VERSION,
    count: contracts.length,
    passCount: contracts.filter((contract) => contract.ok === true).length,
    blockedCount: contracts.filter((contract) => contract.ok !== true).length,
    byStatus,
    byWorkflow,
    safety: {
      localSummaryOnly: true,
      executesExternalAction: false,
      grantsExecutionPermission: false,
    },
  };
}

export function buildPromptProductionContractGate({
  generatedAt = new Date().toISOString(),
} = {}) {
  const passFixture = buildPromptProductionContractFixture({ scenario: 'pass', createdAt: generatedAt });
  const passContract = buildPromptProductionContract({
    ...passFixture,
    createdAt: generatedAt,
    evidenceRefs: [{ kind: 'fixture', ref: 'prompt-production-contract-pass' }],
  });
  const scenarios = [
    'stale_readiness_compiler_hash',
    'unsafe_readiness_safety',
    'missing_artifact_compiler_hash',
    'missing_artifact_compiler_hash_alias_generic_present',
    'missing_compiler_summary_hash_alias_generic_present',
    'missing_readiness_hash',
    'missing_readiness_retrieval_hash',
    'missing_readiness_refreshed_compiler_hash',
    'compiler_semantic_lint_blocker',
    'compiler_prompt_budget_exceeded',
    'retrieval_arbitration_blocked',
    'retrieval_index_override_active',
    'feedback_learning_bridge_hash_mismatch',
  ].map((scenario) => {
    const fixture = buildPromptProductionContractFixture({ scenario, createdAt: generatedAt });
    const contract = buildPromptProductionContract({
      ...fixture,
      createdAt: generatedAt,
      evidenceRefs: [{ kind: 'fixture', ref: scenario }],
    });
    return {
      scenario,
      ok: contract.ok,
      status: contract.status,
      promptProductionContractHash: contract.promptProductionContractHash,
      blockerCodes: contract.blockers.map((blocker) => blocker.code),
    };
  });
  const validation = validatePromptProductionContract(passContract);
  const blockers = [
    ...(passContract.ok ? [] : passContract.blockers.map((blocker) => issue('prompt_production_contract_gate_pass_fixture_failed', blocker.code))),
    ...(validation.ok ? [] : validation.blockers.map((blocker) => issue('prompt_production_contract_gate_validation_failed', blocker.code))),
    ...scenarios.flatMap((scenario) => (
      scenario.ok
        ? [issue('prompt_production_contract_gate_negative_fixture_not_blocked', scenario.scenario)]
        : []
    )),
  ];
  const report = {
    version: PROMPT_PRODUCTION_CONTRACT_VERSION,
    kind: 'PromptProductionContractGate',
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_prompt_production_contract_gate' : 'pass_prompt_production_contract_gate',
    generatedAt,
    summary: {
      passFixtureOk: passContract.ok,
      negativeScenarioCount: scenarios.length,
      blockedNegativeScenarioCount: scenarios.filter((scenario) => scenario.ok === false).length,
      blockerCount: blockers.length,
    },
    passContract: {
      status: passContract.status,
      promptProductionContractHash: passContract.promptProductionContractHash,
      feedbackLearningBridgeHash: passContract.feedbackLearningBridgeHash,
      promptCompilerHash: passContract.promptCompilerHash,
      readinessHash: passContract.readinessHash,
      compilerArtifactCount: passContract.compiler.artifacts.length,
      readinessArtifactCount: passContract.readiness.artifacts.length,
    },
    validation,
    negativeScenarios: scenarios,
    blockers,
    safety: {
      localFixtureGateOnly: true,
      executesExternalAction: false,
      callsProvider: false,
      callsModel: false,
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
  return {
    ...report,
    promptProductionContractGateHash: digest({
      version: report.version,
      kind: report.kind,
      status: report.status,
      summary: report.summary,
      passContract: report.passContract,
      validation: report.validation,
      negativeScenarios: report.negativeScenarios,
      blockers: report.blockers,
      safety: report.safety,
    }),
  };
}

export function buildPromptProductionContractFixture({
  scenario = 'pass',
  createdAt = '2026-06-14T00:00:00.000Z',
} = {}) {
  const refpackId = 'refpack_general_business_service_v1';
  const retrievalHash = digest({ fixture: 'prompt-production-retrieval' });
  const feedbackLearningBridgeHash = digest({ fixture: 'prompt-production-feedback-learning-bridge' });
  const compilerHash = digest({ fixture: 'prompt-production-artifact', scenario: 'base' });
  const routeStrategyHash = digest({ fixture: 'prompt-production-route-strategy', scenario: 'base' });
  const promptCompilerHash = digest({
    fixture: 'prompt-production-compiler-summary',
    compilerHash,
    routeStrategyHash,
  });
  const readinessHash = digest({
    fixture: 'prompt-production-readiness',
    compilerHash,
    promptCompilerHash,
  });
  const sections = REQUIRED_SECTION_IDS.map((id) => ({
    id,
    title: id.replaceAll('_', ' '),
    itemCount: 2,
  }));
  const compilerSummary = {
    version: 1,
    kind: 'PromptCompilerPlanSummary',
    status: 'prompt_compiler_ready',
    taskId: 'prompt-production-contract-fixture',
    workflowId: 'logo_brand',
    industryId: 'general_business_service',
    refpackId,
    feedbackLearningBridgeHash,
    retrievalHash,
    routeStrategyHashes: [routeStrategyHash],
    artifactCount: 1,
    compilerHashes: [compilerHash],
    metrics: {
      activeSectionCount: REQUIRED_SECTION_IDS.length,
      negativeConstraintCount: 2,
      structuredRouteStrategyCount: 1,
    },
    safety: {
      localCompilationOnly: true,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
    promptCompilerHash,
  };
  const promptCompilerReport = {
    ok: true,
    version: 1,
    kind: 'PromptCompilerReport',
    status: 'prompt_compiler_report_ready',
    createdAt,
    taskId: compilerSummary.taskId,
    workflowId: compilerSummary.workflowId,
    industryId: compilerSummary.industryId,
    refpackId,
    feedbackLearningBridgeHash,
    retrievalHash,
    summary: compilerSummary,
    artifacts: [{
      index: 1,
      filename: 'prompt-production-route-01.png',
      role: 'primary',
      compilerHash,
      routeStrategyHash,
      metrics: {
        activeSectionCount: REQUIRED_SECTION_IDS.length,
        negativeConstraintCount: 2,
      },
      sections,
    }],
    safety: {
      localReportOnly: true,
      callsProviderOrModel: false,
      opensBrowserOrPlatform: false,
      uploadsOrSubmits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      paysOrDeploys: false,
      grantsExecutionPermission: false,
    },
    reportHash: digest({ fixture: 'prompt-production-compiler-report', compilerHash, promptCompilerHash }),
  };
  const promptReadinessReport = {
    ok: true,
    version: 1,
    kind: 'PromptReadinessReport',
    status: 'pass_prompt_readiness',
    createdAt,
    taskId: compilerSummary.taskId,
    workflowId: compilerSummary.workflowId,
    industryId: compilerSummary.industryId,
    refpackId,
    feedbackLearningBridgeHash,
    retrievalHash,
    promptCompilerHash,
    refreshedPromptCompilerHash: promptCompilerHash,
    readinessHash,
    metrics: {
      artifactCount: 1,
      passArtifactCount: 1,
      blockerCount: 0,
      warningCount: 0,
      routeSignatureCount: 1,
      applicationProofSignatureCount: 1,
      differentiationSignatureCount: 1,
    },
    artifacts: [{
      ok: true,
      index: 1,
      filename: 'prompt-production-route-01.png',
      compilerHash,
      refreshedCompilerHash: compilerHash,
      sections,
      blockers: [],
      warnings: [],
    }],
    promptSetStrategy: {
      ok: true,
      status: 'pass_prompt_set_strategy',
      blockers: [],
      warnings: [],
      metrics: {
        routeSignatureCount: 1,
        applicationProofSignatureCount: 1,
        differentiationSignatureCount: 1,
      },
    },
    blockers: [],
    warnings: [],
    safety: {
      localGateOnly: true,
      callsProviderOrModel: false,
      opensBrowserOrPlatform: false,
      uploadsOrSubmits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      paysOrDeploys: false,
      grantsExecutionPermission: false,
    },
    reportHash: digest({ fixture: 'prompt-production-readiness-report', readinessHash }),
  };
  const plan = {
    taskId: compilerSummary.taskId,
    workflowId: compilerSummary.workflowId,
    designReferenceSpec: { id: refpackId, feedbackLearningBridgeHash },
    feedbackLearningBridgeHash,
    designReferenceRetrieval: {
      ok: true,
      status: 'model_locked_static_refpack',
      routingMode: 'model_semantic_locked',
      selectionAuthority: 'semantic_intake',
      indexRoutingActive: false,
      indexOverrideAllowed: false,
      selectedRefpackId: refpackId,
      staticRefpackId: refpackId,
      selectedIndustryId: compilerSummary.industryId,
      retrievalHash,
      industryArbitration: {
        ok: true,
        status: 'pass_model_industry_arbitration',
        modelIndustryId: compilerSummary.industryId,
        confidence: 0.91,
        blockers: [],
      },
      blockers: [],
      warnings: [],
    },
    promptCompiler: { promptCompilerHash },
    promptReadiness: { readinessHash },
  };
  if (scenario === 'stale_readiness_compiler_hash') {
    promptReadinessReport.promptCompilerHash = digest({ fixture: 'stale-readiness-compiler-hash' });
  }
  if (scenario === 'unsafe_readiness_safety') {
    promptReadinessReport.safety.callsProviderOrModel = true;
  }
  if (scenario === 'missing_artifact_compiler_hash') {
    promptCompilerReport.artifacts[0].compilerHash = null;
  }
  if (scenario === 'missing_artifact_compiler_hash_alias_generic_present') {
    promptCompilerReport.artifacts[0].hash = promptCompilerReport.artifacts[0].compilerHash;
    promptCompilerReport.artifacts[0].compilerHash = null;
  }
  if (scenario === 'missing_compiler_summary_hash_alias_generic_present') {
    promptCompilerReport.summary.hash = promptCompilerReport.summary.promptCompilerHash;
    promptCompilerReport.summary.promptCompilerHash = null;
  }
  if (scenario === 'missing_readiness_hash') {
    promptReadinessReport.readinessHash = null;
  }
  if (scenario === 'missing_readiness_retrieval_hash') {
    promptReadinessReport.retrievalHash = null;
  }
  if (scenario === 'missing_readiness_refreshed_compiler_hash') {
    promptReadinessReport.refreshedPromptCompilerHash = null;
  }
  if (scenario === 'compiler_semantic_lint_blocker') {
    promptCompilerReport.artifacts[0].metrics.semanticLintBlockerCount = 1;
  }
  if (scenario === 'compiler_prompt_budget_exceeded') {
    promptCompilerReport.artifacts[0].metrics.promptBudgetExceeded = true;
  }
  if (scenario === 'retrieval_arbitration_blocked') {
    plan.designReferenceRetrieval.ok = false;
    plan.designReferenceRetrieval.status = 'blocked_model_industry_arbitration';
    plan.designReferenceRetrieval.industryArbitration.ok = false;
    plan.designReferenceRetrieval.industryArbitration.status = 'blocked_model_industry_arbitration';
    plan.designReferenceRetrieval.industryArbitration.blockers = [{ code: 'model_industry_confidence_below_floor' }];
    plan.designReferenceRetrieval.blockers = [{ code: 'model_industry_confidence_below_floor' }];
  }
  if (scenario === 'retrieval_index_override_active') {
    plan.designReferenceRetrieval.routingMode = 'index_routing';
    plan.designReferenceRetrieval.selectionAuthority = 'refpack_index';
    plan.designReferenceRetrieval.indexRoutingActive = true;
    plan.designReferenceRetrieval.indexOverrideAllowed = true;
  }
  if (scenario === 'feedback_learning_bridge_hash_mismatch') {
    promptReadinessReport.feedbackLearningBridgeHash = digest({ fixture: 'stale-feedback-learning-bridge' });
  }
  return {
    plan,
    promptCompilerReport,
    promptReadinessReport,
  };
}
