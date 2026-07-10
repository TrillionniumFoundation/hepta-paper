import { canonicalProductLineIdOrNull, normalizeText, uniqueStrings } from './contracts.mjs';
import { feedbackLearningBridgeHashFor } from './feedback-learning-bridge-contracts.mjs';
import { digest } from './hash-utils.mjs';

export const PRODUCTION_PLAN_CONSISTENCY_CONTRACT_VERSION = 1;

export const PRODUCTION_PLAN_CONSISTENCY_STATUS = Object.freeze({
  PASS: 'pass_production_plan_consistency',
  BLOCKED: 'blocked_production_plan_consistency',
});

const HASH_RE = /^(?:sha256:)?[0-9a-f]{64}$/;
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

function list(values = [], limit = 128) {
  return uniqueStrings(Array.isArray(values) ? values : (values ? [values] : []), limit);
}

function issue(code, notes = null) {
  return {
    code,
    notes: notes || null,
  };
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalHash(value) {
  const text = normalizeText(value || '').toLowerCase();
  return HASH_RE.test(text) ? text : null;
}

function hashRequired(value, code) {
  return canonicalHash(value) ? [] : [issue(code, normalizeText(value || '') || null)];
}

function safetyBlockers(safety = {}, prefix = 'production_plan_consistency_safety') {
  return UNSAFE_SAFETY_FLAGS
    .filter((key) => safety?.[key] === true)
    .map((key) => issue(`${prefix}_flag_unsafe`, key));
}

function normalizeRouteShape(routeContract = {}) {
  const finalArtifactShape = normalizeText(routeContract.finalArtifactShape || '') || null;
  const submitRoute = normalizeText(routeContract.submitRoute || routeContract.route || '') || null;
  let expectedSubmitMode = null;
  if (finalArtifactShape === 'text_form' || submitRoute === 'text_form') expectedSubmitMode = 'text_form';
  else if (finalArtifactShape === 'single_pdf' || submitRoute === 'pdf_booklet' || submitRoute === 'pdf_only') expectedSubmitMode = 'pdf_only';
  else if (finalArtifactShape === 'mixed' || submitRoute === 'mixed') expectedSubmitMode = 'mixed';
  else if (finalArtifactShape || submitRoute) expectedSubmitMode = 'file_upload';
  return {
    finalArtifactShape,
    submitRoute,
    expectedSubmitMode,
    expectedFinalFiles: numberOrNull(routeContract.expectedFinalFiles),
    contractHash: canonicalHash(routeContract.contractHash || routeContract.hash) || normalizeText(routeContract.contractHash || routeContract.hash || '') || null,
  };
}

function normalizePromptCompilerReport(report = {}) {
  const summary = report.summary || report.promptCompiler || {};
  return {
    kind: normalizeText(report.kind || '') || null,
    ok: report.ok === true,
    status: normalizeText(report.status || '') || null,
    taskId: normalizeText(report.taskId || summary.taskId || '') || null,
    orderId: normalizeText(report.orderId || summary.orderId || '') || null,
    workflowId: canonicalProductLineIdOrNull(report.workflowId || summary.workflowId) || normalizeText(report.workflowId || summary.workflowId || '') || null,
    refpackId: normalizeText(report.refpackId || summary.refpackId || '') || null,
    feedbackLearningBridgeHash: canonicalHash(report.feedbackLearningBridgeHash || summary.feedbackLearningBridgeHash)
      || normalizeText(report.feedbackLearningBridgeHash || summary.feedbackLearningBridgeHash || '') || null,
    retrievalHash: canonicalHash(report.retrievalHash || summary.retrievalHash) || normalizeText(report.retrievalHash || summary.retrievalHash || '') || null,
    routeContractHash: canonicalHash(report.routeContractHash || summary.routeContractHash) || normalizeText(report.routeContractHash || summary.routeContractHash || '') || null,
    promptCompilerHash: canonicalHash(summary.promptCompilerHash || report.promptCompilerHash) || normalizeText(summary.promptCompilerHash || report.promptCompilerHash || '') || null,
    artifactCount: numberOrNull(summary.artifactCount) ?? (Array.isArray(report.artifacts) ? report.artifacts.length : 0),
    compilerHashes: list(summary.compilerHashes || [], 256),
    artifactCompilerHashes: list((report.artifacts || []).map((artifact) => artifact?.compilerHash || artifact?.promptCompiler?.compilerHash || ''), 256),
    artifactCountActual: Array.isArray(report.artifacts) ? report.artifacts.length : 0,
    reportHash: canonicalHash(report.reportHash || report.promptCompilerReportHash) || normalizeText(report.reportHash || report.promptCompilerReportHash || '') || null,
    safety: report.safety || {},
  };
}

function normalizePromptReadinessReport(report = {}) {
  return {
    kind: normalizeText(report.kind || '') || null,
    ok: report.ok === true,
    status: normalizeText(report.status || '') || null,
    taskId: normalizeText(report.taskId || '') || null,
    orderId: normalizeText(report.orderId || '') || null,
    workflowId: canonicalProductLineIdOrNull(report.workflowId) || normalizeText(report.workflowId || '') || null,
    refpackId: normalizeText(report.refpackId || '') || null,
    feedbackLearningBridgeHash: canonicalHash(report.feedbackLearningBridgeHash) || normalizeText(report.feedbackLearningBridgeHash || '') || null,
    retrievalHash: canonicalHash(report.retrievalHash) || normalizeText(report.retrievalHash || '') || null,
    promptCompilerHash: canonicalHash(report.promptCompilerHash) || normalizeText(report.promptCompilerHash || '') || null,
    refreshedPromptCompilerHash: canonicalHash(report.refreshedPromptCompilerHash) || normalizeText(report.refreshedPromptCompilerHash || '') || null,
    readinessHash: canonicalHash(report.readinessHash) || normalizeText(report.readinessHash || '') || null,
    artifactCount: numberOrNull(report.metrics?.artifactCount) ?? (Array.isArray(report.artifacts) ? report.artifacts.length : 0),
    passArtifactCount: numberOrNull(report.metrics?.passArtifactCount) ?? 0,
    blockerCount: numberOrNull(report.metrics?.blockerCount) ?? (Array.isArray(report.blockers) ? report.blockers.length : 0),
    artifactCountActual: Array.isArray(report.artifacts) ? report.artifacts.length : 0,
    blockers: list((report.blockers || []).map((blocker) => blocker?.code || blocker), 128),
    reportHash: canonicalHash(report.reportHash) || normalizeText(report.reportHash || '') || null,
    safety: report.safety || {},
  };
}

function normalizePromptProductionContract(contract = {}) {
  return {
    kind: normalizeText(contract.kind || '') || null,
    ok: contract.ok === true,
    status: normalizeText(contract.status || '') || null,
    promptProductionContractHash: canonicalHash(contract.promptProductionContractHash || contract.contractHash || contract.hash)
      || normalizeText(contract.promptProductionContractHash || contract.contractHash || contract.hash || '') || null,
    promptCompilerHash: canonicalHash(contract.promptCompilerHash) || normalizeText(contract.promptCompilerHash || '') || null,
    readinessHash: canonicalHash(contract.readinessHash) || normalizeText(contract.readinessHash || '') || null,
    feedbackLearningBridgeHash: canonicalHash(contract.feedbackLearningBridgeHash) || normalizeText(contract.feedbackLearningBridgeHash || '') || null,
    retrievalHash: canonicalHash(contract.retrievalHash) || normalizeText(contract.retrievalHash || '') || null,
    refpackId: normalizeText(contract.refpackId || '') || null,
    blockers: list((contract.blockers || []).map((blocker) => blocker?.code || blocker), 128),
    safety: contract.safety || {},
  };
}

function normalizePlanBindings(plan = {}) {
  const prompts = Array.isArray(plan.prompts) ? plan.prompts : [];
  const outputCount = numberOrNull(plan.outputCount) ?? prompts.length;
  const route = normalizeRouteShape(plan.routeContract || {});
  const deliverableSpec = plan.deliverableSpec || {};
  const expectedFileCount = numberOrNull(deliverableSpec.expectedFileCount);
  const promptProductionContract = normalizePromptProductionContract(
    plan.promptProductionContract
      || plan.coreWorkflowContracts?.corePromptProductionContract
      || {},
  );
  return {
    taskId: normalizeText(plan.taskId || plan.externalId || '') || null,
    orderId: normalizeText(plan.orderId || '') || null,
    workflowId: canonicalProductLineIdOrNull(plan.workflowId) || normalizeText(plan.workflowId || '') || null,
    outputMode: normalizeText(plan.outputMode || '') || null,
    outputCount,
    promptCount: prompts.length,
    deliverableSpec: {
      submitMode: normalizeText(deliverableSpec.submitMode || '') || null,
      expectedFileCount,
      finalFormats: list(deliverableSpec.finalFormats || [], 24),
    },
    route,
    refpackId: normalizeText(plan.designReferenceSpec?.id || plan.designReferenceSpec?.selectedPackId || plan.designReferenceSpec?.referencePackage?.selectedPackId || '') || null,
    feedbackLearningBridgeHash: feedbackLearningBridgeHashFor(plan),
    retrievalHash: canonicalHash(plan.designReferenceRetrieval?.retrievalHash) || normalizeText(plan.designReferenceRetrieval?.retrievalHash || '') || null,
    retrieval: {
      ok: plan.designReferenceRetrieval?.ok === true,
      status: normalizeText(plan.designReferenceRetrieval?.status || '') || null,
      routingMode: normalizeText(plan.designReferenceRetrieval?.routingMode || '') || null,
      selectedRefpackId: normalizeText(plan.designReferenceRetrieval?.selectedRefpackId || '') || null,
      staticRefpackId: normalizeText(plan.designReferenceRetrieval?.staticRefpackId || '') || null,
      selectionAuthority: normalizeText(plan.designReferenceRetrieval?.selectionAuthority || '') || null,
      blockers: list((plan.designReferenceRetrieval?.blockers || []).map((blocker) => blocker?.code || blocker), 64),
    },
    promptCompilerHash: canonicalHash(plan.promptCompiler?.promptCompilerHash) || normalizeText(plan.promptCompiler?.promptCompilerHash || '') || null,
    readinessHash: canonicalHash(plan.promptReadiness?.readinessHash) || normalizeText(plan.promptReadiness?.readinessHash || '') || null,
    promptReadinessStatus: normalizeText(plan.promptReadiness?.status || '') || null,
    promptReadinessOk: plan.promptReadiness?.ok === true,
    promptProductionContract,
    promptProductionContractHash: canonicalHash(plan.promptProductionContractHash || plan.coreWorkflowContracts?.corePromptProductionContractHash)
      || normalizeText(plan.promptProductionContractHash || plan.coreWorkflowContracts?.corePromptProductionContractHash || '') || null,
    preGenerationReadinessOk: plan.preGenerationReadiness?.ok === true,
    preGenerationBlockers: list(plan.preGenerationBlockers || [], 256),
  };
}

function countsAreConsistent(planBindings) {
  if (planBindings.deliverableSpec.submitMode === 'text_form') {
    return planBindings.deliverableSpec.expectedFileCount === 0;
  }
  if (planBindings.deliverableSpec.expectedFileCount !== null && planBindings.route.expectedFinalFiles !== null) {
    return planBindings.deliverableSpec.expectedFileCount === planBindings.route.expectedFinalFiles;
  }
  if (planBindings.deliverableSpec.expectedFileCount !== null) {
    return planBindings.deliverableSpec.expectedFileCount === planBindings.promptCount;
  }
  return true;
}

function buildBlockers({ planBindings, compiler, readiness, promptProduction }) {
  const selectedRefpackId = planBindings.retrieval.selectedRefpackId || planBindings.retrieval.staticRefpackId || null;
  const blockers = [
    ...(planBindings.workflowId ? [] : [issue('production_plan_workflow_id_missing')]),
    ...(planBindings.outputCount === planBindings.promptCount ? [] : [issue('production_plan_output_count_mismatch', `${planBindings.outputCount}/${planBindings.promptCount}`)]),
    ...(planBindings.route.contractHash ? [] : [issue('production_plan_route_contract_hash_missing')]),
    ...hashRequired(planBindings.route.contractHash, 'production_plan_route_contract_hash_invalid'),
    ...(planBindings.route.expectedSubmitMode && planBindings.deliverableSpec.submitMode && planBindings.route.expectedSubmitMode !== planBindings.deliverableSpec.submitMode
      ? [issue('production_plan_route_submit_mode_mismatch', `${planBindings.route.expectedSubmitMode}/${planBindings.deliverableSpec.submitMode}`)]
      : []),
    ...(countsAreConsistent(planBindings) ? [] : [issue('production_plan_expected_file_count_mismatch', `${planBindings.deliverableSpec.expectedFileCount}/${planBindings.route.expectedFinalFiles}`)]),
    ...(planBindings.refpackId ? [] : [issue('production_plan_refpack_id_missing')]),
    ...(planBindings.retrievalHash ? [] : [issue('production_plan_retrieval_hash_missing')]),
    ...hashRequired(planBindings.retrievalHash, 'production_plan_retrieval_hash_invalid'),
    ...(planBindings.retrieval.ok === true ? [] : [issue('production_plan_retrieval_not_ok', planBindings.retrieval.status)]),
    ...(planBindings.retrieval.blockers.length ? planBindings.retrieval.blockers.map((code) => issue('production_plan_retrieval_blocker_present', code)) : []),
    ...(selectedRefpackId && planBindings.refpackId && selectedRefpackId !== planBindings.refpackId
      ? [issue('production_plan_refpack_selection_mismatch', `${selectedRefpackId}/${planBindings.refpackId}`)]
      : []),
    ...(planBindings.promptCompilerHash ? [] : [issue('production_plan_prompt_compiler_hash_missing')]),
    ...hashRequired(planBindings.promptCompilerHash, 'production_plan_prompt_compiler_hash_invalid'),
    ...(planBindings.readinessHash ? [] : [issue('production_plan_prompt_readiness_hash_missing')]),
    ...hashRequired(planBindings.readinessHash, 'production_plan_prompt_readiness_hash_invalid'),
    ...(planBindings.promptReadinessOk === true ? [] : [issue('production_plan_prompt_readiness_not_ok', planBindings.promptReadinessStatus)]),
    ...(planBindings.preGenerationReadinessOk === true ? [] : [issue('production_plan_pre_generation_readiness_not_ok')]),
    ...(planBindings.preGenerationBlockers.length
      ? planBindings.preGenerationBlockers.map((code) => issue('production_plan_pre_generation_blocker_present', code))
      : []),
    ...(compiler.kind === 'PromptCompilerReport' ? [] : [issue('production_plan_prompt_compiler_report_kind_invalid', compiler.kind)]),
    ...(compiler.ok === true ? [] : [issue('production_plan_prompt_compiler_report_not_ok', compiler.status)]),
    ...(compiler.promptCompilerHash ? [] : [issue('production_plan_prompt_compiler_report_hash_missing')]),
    ...hashRequired(compiler.promptCompilerHash, 'production_plan_prompt_compiler_report_hash_invalid'),
    ...(compiler.promptCompilerHash && planBindings.promptCompilerHash && compiler.promptCompilerHash !== planBindings.promptCompilerHash
      ? [issue('production_plan_prompt_compiler_hash_mismatch', `${planBindings.promptCompilerHash}/${compiler.promptCompilerHash}`)]
      : []),
    ...(compiler.refpackId && planBindings.refpackId && compiler.refpackId !== planBindings.refpackId
      ? [issue('production_plan_prompt_compiler_refpack_mismatch', `${planBindings.refpackId}/${compiler.refpackId}`)]
      : []),
    ...(planBindings.feedbackLearningBridgeHash && !compiler.feedbackLearningBridgeHash
      ? [issue('production_plan_prompt_compiler_feedback_learning_bridge_hash_missing')]
      : []),
    ...(planBindings.feedbackLearningBridgeHash && compiler.feedbackLearningBridgeHash && planBindings.feedbackLearningBridgeHash !== compiler.feedbackLearningBridgeHash
      ? [issue('production_plan_prompt_compiler_feedback_learning_bridge_hash_mismatch', `${planBindings.feedbackLearningBridgeHash}/${compiler.feedbackLearningBridgeHash}`)]
      : []),
    ...(compiler.retrievalHash && planBindings.retrievalHash && compiler.retrievalHash !== planBindings.retrievalHash
      ? [issue('production_plan_prompt_compiler_retrieval_hash_mismatch', `${planBindings.retrievalHash}/${compiler.retrievalHash}`)]
      : []),
    ...(compiler.routeContractHash && planBindings.route.contractHash && compiler.routeContractHash !== planBindings.route.contractHash
      ? [issue('production_plan_prompt_compiler_route_hash_mismatch', `${planBindings.route.contractHash}/${compiler.routeContractHash}`)]
      : []),
    ...(compiler.artifactCount === compiler.artifactCountActual ? [] : [issue('production_plan_prompt_compiler_artifact_count_mismatch', `${compiler.artifactCount}/${compiler.artifactCountActual}`)]),
    ...(compiler.artifactCountActual === planBindings.promptCount ? [] : [issue('production_plan_prompt_compiler_prompt_count_mismatch', `${compiler.artifactCountActual}/${planBindings.promptCount}`)]),
    ...(compiler.compilerHashes.length && compiler.compilerHashes.length !== compiler.artifactCountActual
      ? [issue('production_plan_prompt_compiler_hash_count_mismatch', `${compiler.compilerHashes.length}/${compiler.artifactCountActual}`)]
      : []),
    ...(readiness.kind === 'PromptReadinessReport' ? [] : [issue('production_plan_prompt_readiness_report_kind_invalid', readiness.kind)]),
    ...(readiness.ok === true ? [] : [issue('production_plan_prompt_readiness_report_not_ok', readiness.status)]),
    ...(readiness.readinessHash ? [] : [issue('production_plan_prompt_readiness_report_hash_missing')]),
    ...hashRequired(readiness.readinessHash, 'production_plan_prompt_readiness_report_hash_invalid'),
    ...(readiness.readinessHash && planBindings.readinessHash && readiness.readinessHash !== planBindings.readinessHash
      ? [issue('production_plan_prompt_readiness_hash_mismatch', `${planBindings.readinessHash}/${readiness.readinessHash}`)]
      : []),
    ...(readiness.promptCompilerHash && compiler.promptCompilerHash && readiness.promptCompilerHash !== compiler.promptCompilerHash
      ? [issue('production_plan_readiness_compiler_hash_mismatch', `${readiness.promptCompilerHash}/${compiler.promptCompilerHash}`)]
      : []),
    ...(readiness.refreshedPromptCompilerHash && compiler.promptCompilerHash && readiness.refreshedPromptCompilerHash !== compiler.promptCompilerHash
      ? [issue('production_plan_readiness_refreshed_compiler_hash_mismatch', `${readiness.refreshedPromptCompilerHash}/${compiler.promptCompilerHash}`)]
      : []),
    ...(readiness.refpackId && planBindings.refpackId && readiness.refpackId !== planBindings.refpackId
      ? [issue('production_plan_readiness_refpack_mismatch', `${planBindings.refpackId}/${readiness.refpackId}`)]
      : []),
    ...(planBindings.feedbackLearningBridgeHash && !readiness.feedbackLearningBridgeHash
      ? [issue('production_plan_readiness_feedback_learning_bridge_hash_missing')]
      : []),
    ...(planBindings.feedbackLearningBridgeHash && readiness.feedbackLearningBridgeHash && planBindings.feedbackLearningBridgeHash !== readiness.feedbackLearningBridgeHash
      ? [issue('production_plan_readiness_feedback_learning_bridge_hash_mismatch', `${planBindings.feedbackLearningBridgeHash}/${readiness.feedbackLearningBridgeHash}`)]
      : []),
    ...(readiness.retrievalHash && planBindings.retrievalHash && readiness.retrievalHash !== planBindings.retrievalHash
      ? [issue('production_plan_readiness_retrieval_hash_mismatch', `${planBindings.retrievalHash}/${readiness.retrievalHash}`)]
      : []),
    ...(readiness.artifactCount === readiness.artifactCountActual ? [] : [issue('production_plan_readiness_artifact_count_mismatch', `${readiness.artifactCount}/${readiness.artifactCountActual}`)]),
    ...(readiness.artifactCountActual === planBindings.promptCount ? [] : [issue('production_plan_readiness_prompt_count_mismatch', `${readiness.artifactCountActual}/${planBindings.promptCount}`)]),
    ...(readiness.passArtifactCount === readiness.artifactCount ? [] : [issue('production_plan_readiness_pass_count_mismatch', `${readiness.passArtifactCount}/${readiness.artifactCount}`)]),
    ...(readiness.blockerCount === 0 ? [] : [issue('production_plan_readiness_blocker_count_nonzero', String(readiness.blockerCount))]),
    ...(readiness.blockers.length ? readiness.blockers.map((code) => issue('production_plan_readiness_blocker_present', code)) : []),
    ...(promptProduction.kind === 'PromptProductionContract' ? [] : [issue('production_plan_prompt_production_contract_kind_invalid', promptProduction.kind)]),
    ...(promptProduction.ok === true ? [] : [issue('production_plan_prompt_production_contract_not_ok', promptProduction.status)]),
    ...(promptProduction.promptProductionContractHash ? [] : [issue('production_plan_prompt_production_contract_hash_missing')]),
    ...hashRequired(promptProduction.promptProductionContractHash, 'production_plan_prompt_production_contract_hash_invalid'),
    ...(planBindings.promptProductionContractHash && promptProduction.promptProductionContractHash && planBindings.promptProductionContractHash !== promptProduction.promptProductionContractHash
      ? [issue('production_plan_prompt_production_contract_hash_mismatch', `${planBindings.promptProductionContractHash}/${promptProduction.promptProductionContractHash}`)]
      : []),
    ...(promptProduction.promptCompilerHash && compiler.promptCompilerHash && promptProduction.promptCompilerHash !== compiler.promptCompilerHash
      ? [issue('production_plan_prompt_production_compiler_hash_mismatch', `${promptProduction.promptCompilerHash}/${compiler.promptCompilerHash}`)]
      : []),
    ...(promptProduction.readinessHash && readiness.readinessHash && promptProduction.readinessHash !== readiness.readinessHash
      ? [issue('production_plan_prompt_production_readiness_hash_mismatch', `${promptProduction.readinessHash}/${readiness.readinessHash}`)]
      : []),
    ...(promptProduction.retrievalHash && planBindings.retrievalHash && promptProduction.retrievalHash !== planBindings.retrievalHash
      ? [issue('production_plan_prompt_production_retrieval_hash_mismatch', `${promptProduction.retrievalHash}/${planBindings.retrievalHash}`)]
      : []),
    ...(promptProduction.refpackId && planBindings.refpackId && promptProduction.refpackId !== planBindings.refpackId
      ? [issue('production_plan_prompt_production_refpack_mismatch', `${promptProduction.refpackId}/${planBindings.refpackId}`)]
      : []),
    ...(planBindings.feedbackLearningBridgeHash && !promptProduction.feedbackLearningBridgeHash
      ? [issue('production_plan_prompt_production_feedback_learning_bridge_hash_missing')]
      : []),
    ...(planBindings.feedbackLearningBridgeHash && promptProduction.feedbackLearningBridgeHash && promptProduction.feedbackLearningBridgeHash !== planBindings.feedbackLearningBridgeHash
      ? [issue('production_plan_prompt_production_feedback_learning_bridge_hash_mismatch', `${promptProduction.feedbackLearningBridgeHash}/${planBindings.feedbackLearningBridgeHash}`)]
      : []),
    ...(promptProduction.blockers.length ? promptProduction.blockers.map((code) => issue('production_plan_prompt_production_blocker_present', code)) : []),
    ...safetyBlockers(compiler.safety, 'production_plan_prompt_compiler_report_safety'),
    ...safetyBlockers(readiness.safety, 'production_plan_prompt_readiness_report_safety'),
    ...safetyBlockers(promptProduction.safety, 'production_plan_prompt_production_contract_safety'),
  ];
  return blockers;
}

export function normalizeProductionPlanConsistency({
  plan = {},
  promptCompilerReport = {},
  promptReadinessReport = {},
  promptProductionContract = null,
  createdAt = new Date().toISOString(),
} = {}) {
  const planBindings = normalizePlanBindings(plan);
  const compiler = normalizePromptCompilerReport(promptCompilerReport);
  const readiness = normalizePromptReadinessReport(promptReadinessReport);
  const promptProduction = normalizePromptProductionContract(
    promptProductionContract
      || planBindings.promptProductionContract
      || {},
  );
  const blockers = buildBlockers({ planBindings, compiler, readiness, promptProduction });
  const contract = {
    version: PRODUCTION_PLAN_CONSISTENCY_CONTRACT_VERSION,
    kind: 'ProductionPlanConsistencyContract',
    ok: blockers.length === 0,
    status: blockers.length ? PRODUCTION_PLAN_CONSISTENCY_STATUS.BLOCKED : PRODUCTION_PLAN_CONSISTENCY_STATUS.PASS,
    createdAt,
    taskId: planBindings.taskId || compiler.taskId || readiness.taskId || null,
    orderId: planBindings.orderId || compiler.orderId || readiness.orderId || null,
    workflowId: planBindings.workflowId || compiler.workflowId || readiness.workflowId || null,
    refpackId: planBindings.refpackId || compiler.refpackId || readiness.refpackId || null,
    feedbackLearningBridgeHash: planBindings.feedbackLearningBridgeHash || compiler.feedbackLearningBridgeHash || readiness.feedbackLearningBridgeHash || promptProduction.feedbackLearningBridgeHash || null,
    retrievalHash: planBindings.retrievalHash || compiler.retrievalHash || readiness.retrievalHash || null,
    routeContractHash: planBindings.route.contractHash || compiler.routeContractHash || null,
    promptCompilerHash: planBindings.promptCompilerHash || compiler.promptCompilerHash || readiness.promptCompilerHash || null,
    readinessHash: planBindings.readinessHash || readiness.readinessHash || null,
    promptProductionContractHash: planBindings.promptProductionContractHash || promptProduction.promptProductionContractHash || null,
    planBindings,
    compiler,
    readiness,
    promptProduction,
    blockers,
    safety: {
      localContractOnly: true,
      validatesProductionPlanContinuity: true,
      validatesRoutePromptReadinessContinuity: true,
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
  const contractHash = digest({
    version: contract.version,
    kind: contract.kind,
    status: contract.status,
    taskId: contract.taskId,
    orderId: contract.orderId,
    workflowId: contract.workflowId,
    refpackId: contract.refpackId,
    feedbackLearningBridgeHash: contract.feedbackLearningBridgeHash,
    retrievalHash: contract.retrievalHash,
    routeContractHash: contract.routeContractHash,
    promptCompilerHash: contract.promptCompilerHash,
    readinessHash: contract.readinessHash,
    promptProductionContractHash: contract.promptProductionContractHash,
    planBindings: contract.planBindings,
    compiler: contract.compiler,
    readiness: contract.readiness,
    promptProduction: contract.promptProduction,
    blockers: contract.blockers,
    safety: contract.safety,
  });
  return {
    ...contract,
    contractHash,
    productionPlanConsistencyHash: contractHash,
    hash: contractHash,
  };
}

export function validateProductionPlanConsistencyContract(contract = {}) {
  const blockers = [
    ...(contract.kind === 'ProductionPlanConsistencyContract' ? [] : [issue('production_plan_consistency_contract_kind_invalid', contract.kind)]),
    ...(contract.status === PRODUCTION_PLAN_CONSISTENCY_STATUS.PASS && contract.ok === true ? [] : [issue('production_plan_consistency_contract_not_pass', contract.status)]),
    ...hashRequired(contract.contractHash || contract.productionPlanConsistencyHash || contract.hash, 'production_plan_consistency_contract_hash_missing_or_invalid'),
    ...safetyBlockers(contract.safety || {}, 'production_plan_consistency_contract_safety'),
    ...((contract.blockers || []).length ? [issue('production_plan_consistency_embedded_blockers_present', String(contract.blockers.length))] : []),
  ];
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_production_plan_consistency_validation' : 'pass_production_plan_consistency_validation',
    contractHash: contract.contractHash || contract.productionPlanConsistencyHash || contract.hash || null,
    blockers,
  };
}

function hashFixture(seed) {
  return digest({ fixture: 'production-plan-consistency', seed });
}

export function productionPlanConsistencyContractsSelftest() {
  const compilerHash = hashFixture('prompt-compiler');
  const artifactHashA = hashFixture('artifact-a');
  const artifactHashB = hashFixture('artifact-b');
  const readinessHash = hashFixture('readiness');
  const retrievalHash = hashFixture('retrieval');
  const feedbackLearningBridgeHash = hashFixture('feedback-learning-bridge');
  const routeHash = hashFixture('route-contract').replace(/^sha256:/, '');
  const promptProductionHash = hashFixture('prompt-production');
  const basePlan = {
    taskId: 'production-plan-consistency-fixture',
    orderId: 'fixture-order',
    workflowId: 'logo_brand',
    outputMode: 'image_set',
    outputCount: 2,
    prompts: [
      { index: 1, filename: 'fixture-01.png' },
      { index: 2, filename: 'fixture-02.png' },
    ],
    deliverableSpec: {
      submitMode: 'file_upload',
      expectedFileCount: 2,
      finalFormats: ['png', 'jpg'],
    },
    routeContract: {
      finalArtifactShape: 'image_set',
      submitRoute: 'file_set',
      expectedFinalFiles: 2,
      contractHash: routeHash,
    },
    designReferenceSpec: {
      id: 'refpack_general_business_service_v1',
      feedbackLearningBridgeHash,
    },
    feedbackLearningBridgeHash,
    designReferenceRetrieval: {
      ok: true,
      status: 'model_locked_static_refpack',
      routingMode: 'model_semantic_locked',
      selectionAuthority: 'semantic_intake',
      selectedRefpackId: 'refpack_general_business_service_v1',
      retrievalHash,
      blockers: [],
    },
    promptCompiler: {
      promptCompilerHash: compilerHash,
    },
    promptReadiness: {
      ok: true,
      status: 'pass_prompt_readiness',
      readinessHash,
    },
    preGenerationReadiness: {
      ok: true,
    },
    preGenerationBlockers: [],
    coreWorkflowContracts: {
      corePromptProductionContractHash: promptProductionHash,
      corePromptProductionContract: {
        kind: 'PromptProductionContract',
        ok: true,
        status: 'pass_prompt_production_contract',
        promptProductionContractHash: promptProductionHash,
        promptCompilerHash: compilerHash,
        readinessHash,
        feedbackLearningBridgeHash,
        retrievalHash,
        refpackId: 'refpack_general_business_service_v1',
        blockers: [],
        safety: {
          localContractOnly: true,
          callsProviderOrModel: false,
          grantsExecutionPermission: false,
        },
      },
    },
  };
  const promptCompilerReport = {
    kind: 'PromptCompilerReport',
    ok: true,
    status: 'prompt_compiler_report_ready',
    taskId: basePlan.taskId,
    orderId: basePlan.orderId,
    workflowId: basePlan.workflowId,
    refpackId: basePlan.designReferenceSpec.id,
    feedbackLearningBridgeHash,
    retrievalHash,
    routeContractHash: routeHash,
    summary: {
      promptCompilerHash: compilerHash,
      refpackId: basePlan.designReferenceSpec.id,
      feedbackLearningBridgeHash,
      retrievalHash,
      routeContractHash: routeHash,
      artifactCount: 2,
      compilerHashes: [artifactHashA, artifactHashB],
    },
    artifacts: [
      { index: 1, filename: 'fixture-01.png', compilerHash: artifactHashA },
      { index: 2, filename: 'fixture-02.png', compilerHash: artifactHashB },
    ],
    safety: {
      localReportOnly: true,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
    reportHash: hashFixture('compiler-report'),
  };
  const promptReadinessReport = {
    kind: 'PromptReadinessReport',
    ok: true,
    status: 'pass_prompt_readiness',
    taskId: basePlan.taskId,
    orderId: basePlan.orderId,
    workflowId: basePlan.workflowId,
    refpackId: basePlan.designReferenceSpec.id,
    feedbackLearningBridgeHash,
    retrievalHash,
    promptCompilerHash: compilerHash,
    refreshedPromptCompilerHash: compilerHash,
    readinessHash,
    metrics: {
      artifactCount: 2,
      passArtifactCount: 2,
      blockerCount: 0,
    },
    artifacts: [
      { index: 1, filename: 'fixture-01.png', ok: true },
      { index: 2, filename: 'fixture-02.png', ok: true },
    ],
    blockers: [],
    safety: {
      localReportOnly: true,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
    reportHash: hashFixture('readiness-report'),
  };
  const ready = normalizeProductionPlanConsistency({
    plan: basePlan,
    promptCompilerReport,
    promptReadinessReport,
    createdAt: '2026-06-21T00:00:00.000Z',
  });
  const stale = normalizeProductionPlanConsistency({
    plan: {
      ...basePlan,
      promptCompiler: {
        promptCompilerHash: hashFixture('stale-prompt-compiler'),
      },
    },
    promptCompilerReport,
    promptReadinessReport,
    createdAt: '2026-06-21T00:00:00.000Z',
  });
  const routeDrift = normalizeProductionPlanConsistency({
    plan: {
      ...basePlan,
      deliverableSpec: {
        ...basePlan.deliverableSpec,
        expectedFileCount: 1,
      },
    },
    promptCompilerReport,
    promptReadinessReport,
    createdAt: '2026-06-21T00:00:00.000Z',
  });
  const staleFeedbackBridge = normalizeProductionPlanConsistency({
    plan: basePlan,
    promptCompilerReport: {
      ...promptCompilerReport,
      feedbackLearningBridgeHash: hashFixture('stale-feedback-learning-bridge'),
      summary: {
        ...promptCompilerReport.summary,
        feedbackLearningBridgeHash: hashFixture('stale-feedback-learning-bridge'),
      },
    },
    promptReadinessReport,
    createdAt: '2026-06-21T00:00:00.000Z',
  });
  const validation = validateProductionPlanConsistencyContract(ready);
  return {
    ok: ready.ok === true
      && validation.ok === true
      && stale.ok === false
      && stale.blockers.some((blocker) => blocker.code === 'production_plan_prompt_compiler_hash_mismatch')
      && routeDrift.ok === false
      && routeDrift.blockers.some((blocker) => blocker.code === 'production_plan_expected_file_count_mismatch')
      && staleFeedbackBridge.ok === false
      && staleFeedbackBridge.blockers.some((blocker) => blocker.code === 'production_plan_prompt_compiler_feedback_learning_bridge_hash_mismatch'),
    ready,
    stale,
    routeDrift,
    staleFeedbackBridge,
    validation,
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
}
