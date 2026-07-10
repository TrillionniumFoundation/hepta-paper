import {
  hashPromptCompiler,
  refreshPromptCompilerForPlan,
  stripPromptCompilerGuidance,
} from './prompt-artifact-compiler.mjs';
import { feedbackLearningBridgeHashFor } from './feedback-learning-bridge-contracts.mjs';

export const PROMPT_READINESS_GATE_VERSION = 1;
export const PROMPT_SET_STRATEGY_GATE_VERSION = 1;

const STRICT_PROMPT_STRATEGY_WORKFLOW_IDS = new Set([
  'logo_brand',
  'packaging_design',
  'poster_design',
  'presentation_deck',
  'catalog_brochure',
  'proposal_board',
  'product_design',
]);

function normalizePromptReadinessText(value) {
  return String(value || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function text(value) {
  return normalizePromptReadinessText(value);
}

function sectionById(compiler = {}, id) {
  return (compiler.sections || []).find((item) => item.id === id) || null;
}

function isStrictPromptStrategyWorkflow(plan = {}, artifactCount = 0) {
  if (artifactCount < 3) return false;
  if (plan.promptStrategyStrict === false || plan.workflowProfile?.promptStrategyStrict === false) return false;
  if (plan.promptStrategyStrict === true || plan.workflowProfile?.promptStrategyStrict === true) return true;
  return STRICT_PROMPT_STRATEGY_WORKFLOW_IDS.has(text(plan.workflowId || '').toLowerCase());
}

function compilerOutcomeEvidence(compiler = {}) {
  const outcome = sectionById(compiler, 'outcome_learning');
  const outcomeScore = compiler.metrics?.outcomeScore;
  return {
    hasOutcomeSection: !!outcome,
    outcomeItemCount: Number(outcome?.itemCount || outcome?.items?.length || 0),
    outcomeScore: outcomeScore === null || outcomeScore === undefined ? null : Number(outcomeScore),
    outcomeCaseCount: Number(compiler.metrics?.outcomeCaseCount || 0),
    outcomeLearningSignalCount: Number(compiler.metrics?.outcomeLearningSignalCount || 0),
  };
}

function promptRouteFocusText(artifact = {}) {
  if (artifact.routeStrategy?.focus) return text(artifact.routeStrategy.focus).slice(0, 420);
  const prompt = stripPromptCompilerGuidance(artifact.prompt || '');
  const markerPatterns = [
    /(?:^|[\s.。])Focus\s*:\s*([\s\S]*?)(?:\.\s+(?:This is|The designed|Each selected|Board may|Output should|Buyer task|Requirement summary|Do not render)|\n|$)/i,
    /(?:^|[\s.。])Page focus\s*:\s*([\s\S]*?)(?:\.\s+(?:Use|If the buyer|Do not render)|\n|$)/i,
    /(?:^|[\s.。])Board\s+\d+\s*:\s*([\s\S]*?)(?:\n|$)/i,
    /(?:^|[\s.。])Route\s+\d+\s*:\s*([\s\S]*?)(?:\n|$)/i,
  ];
  for (const pattern of markerPatterns) {
    const match = prompt.match(pattern);
    const value = text(match?.[1] || '');
    if (value) return value.slice(0, 420);
  }
  return text([
    artifact.role || '',
    ...(artifact.acceptance || []),
  ].filter(Boolean).join(' | ')).slice(0, 420);
}

function routeSignatureTokens(value = '') {
  const stop = new Set([
    'task', 'buyer', 'project', 'requirement', 'summary', 'create', 'polished',
    'client', 'facing', 'proposal', 'board', 'route', 'focus', 'flow',
    'finished', 'output', 'image', 'set', 'logo', 'vi', 'design',
    'the', 'and', 'with', 'for', 'this', 'that', 'must', 'use',
    'an', 'or', 'but', 'as', 'at', 'by', 'from', 'into', 'than', 'to',
    'rather', 'both', 'names',
    '方案', '设计', '项目', '客户', '买家', '需求', '稿件', '路线', '方向',
  ]);
  const seen = new Set();
  const tokens = [];
  for (const item of String(value || '')
    .toLowerCase()
    .replace(/sha256:[a-f0-9]+/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/task-\d+|\d{6,}/g, ' ')
    .split(/[^a-z0-9_\u4e00-\u9fa5]+/i)
    .map((item) => item.trim())) {
    if (item.length < 2 || stop.has(item) || seen.has(item)) continue;
    seen.add(item);
    tokens.push(item);
  }
  return tokens.sort((left, right) => left.localeCompare(right)).slice(0, 48);
}

function routeApplicationProofTokens(routeStrategy = {}) {
  const genericProof = new Set([
    'application', 'applications', 'proof', 'mockup', 'mockups', 'usage',
    'scene', 'scenes', 'brand', 'identity', 'board', 'boards', 'logo', 'vi',
    'full', 'complete', 'finished', 'final', 'route', 'routes', 'system',
    'systems', 'visual', 'rules', 'client', 'proposal',
    '应用', '证明', '样机', '场景', '品牌', '标识', '视觉', '系统', '方案',
  ]);
  return routeSignatureTokens([
    ...(routeStrategy?.applicationProof || []),
    ...(routeStrategy?.proofContexts || []),
  ].join(' | '))
    .filter((token) => !genericProof.has(token))
    .slice(0, 12);
}

function routeDifferentiationTokens(routeStrategy = {}) {
  const genericDifferentiation = new Set([
    'generic', 'general', 'strategic', 'strategy', 'route', 'routes',
    'direction', 'directions', 'option', 'options', 'concept', 'concepts',
    'polished', 'complete', 'finished', 'final', 'brand', 'identity',
    'logo', 'vi', 'board', 'system', 'design', 'visual', 'proof',
    'application', 'applications', 'mockup', 'mockups', 'usage',
    'scene', 'scenes', 'full', 'clearly', 'different', 'strongest',
    'alternate',
    '通用', '策略', '路线', '方向', '方案', '概念', '品牌', '标识',
    '视觉', '系统', '设计',
  ]);
  return routeSignatureTokens(routeStrategy?.differentiationKey || '')
    .filter((token) => !genericDifferentiation.has(token))
    .slice(0, 12);
}

function routeFocusTokens(focusText = '') {
  const genericFocus = new Set([
    'generic', 'general', 'strategic', 'strategy', 'route', 'routes',
    'direction', 'directions', 'option', 'options', 'concept', 'concepts',
    'polished', 'complete', 'finished', 'final', 'brand', 'identity',
    'logo', 'vi', 'board', 'system', 'design', 'visual', 'proof',
    'application', 'applications', 'mockup', 'mockups', 'usage',
    'scene', 'scenes', 'full', 'clearly', 'different', 'strongest',
    'alternate',
    '通用', '策略', '路线', '方向', '方案', '概念', '品牌', '标识',
    '视觉', '系统', '设计',
  ]);
  return routeSignatureTokens(focusText)
    .filter((token) => !genericFocus.has(token))
    .slice(0, 12);
}

function routeFocusAlignmentTokens({
  focusTokens = [],
  applicationProofTokens = [],
  differentiationTokens = [],
} = {}) {
  const supportTokens = new Set([
    ...applicationProofTokens,
    ...differentiationTokens,
  ]);
  return focusTokens
    .filter((token) => supportTokens.has(token))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 12);
}

function promptSetRouteRecord(artifact = {}) {
  const routeStrategy = artifact.routeStrategy || null;
  const focusText = promptRouteFocusText(artifact);
  const focusTokens = routeFocusTokens(focusText);
  const applicationProofTokens = routeApplicationProofTokens(routeStrategy || {});
  const differentiationTokens = routeDifferentiationTokens(routeStrategy || {});
  const focusAlignmentTokens = routeFocusAlignmentTokens({
    focusTokens,
    applicationProofTokens,
    differentiationTokens,
  });
  // Route ids are labels, not strategy evidence. Diversity must come from focus/proof.
  const signatureBasis = [
    artifact.role || '',
    focusText,
    routeStrategy?.differentiationKey || '',
    ...(routeStrategy?.applicationProof || []),
    ...(routeStrategy?.proofContexts || []),
    ...(artifact.acceptance || []),
  ].join(' | ');
  const tokens = routeSignatureTokens(signatureBasis);
  return {
    index: artifact.index ?? null,
    filename: artifact.filename || null,
    role: artifact.role || null,
    routeId: routeStrategy?.routeId || null,
    routeStrategyHash: routeStrategy?.routeStrategyHash || null,
    strategySource: routeStrategy ? 'structured_route_strategy' : 'prompt_text_fallback',
    structuredFocus: routeStrategy?.focus || null,
    focusText,
    focusTokens,
    focusTokenCount: focusTokens.length,
    focusAlignmentTokens,
    focusAlignmentTokenCount: focusAlignmentTokens.length,
    differentiationKey: routeStrategy?.differentiationKey || null,
    differentiationTokens,
    differentiationTokenCount: differentiationTokens.length,
    differentiationSignature: hashPromptCompiler({ tokens: differentiationTokens }),
    applicationProof: routeStrategy?.applicationProof || [],
    proofContexts: routeStrategy?.proofContexts || [],
    applicationProofTokens,
    applicationProofTokenCount: applicationProofTokens.length,
    tokenCount: tokens.length,
    applicationProofSignature: hashPromptCompiler({ tokens: applicationProofTokens }),
    signature: hashPromptCompiler({ role: artifact.role || null, tokens }),
  };
}

function promptSetApplicationProof({ plan = {}, prompts = [] } = {}) {
  const textBlob = text([
    plan.workflowId,
    plan.workflowProfile?.deliverableClass,
    ...(plan.qualityGates || []).map((item) => item.label || item.id),
    ...(plan.packageRules || []),
    ...(plan.qaChecklist || []),
    ...prompts.flatMap((artifact) => [
      artifact.role,
      artifact.prompt,
      ...(artifact.acceptance || []),
    ]),
  ].filter(Boolean).join('\n')).toLowerCase();
  return /(application|mockup|usage|use proof|scene proof|shelf|flat layout|proposal|overview|palette|reverse proof|应用|场景|落地|样机|货架|版式|应用证明|反白|黑白|色彩|材质|陈列|提案)/i.test(textBlob);
}

export function createPromptSetStrategyGate(plan = {}) {
  const prompts = Array.isArray(plan.prompts) ? plan.prompts : [];
  const routes = prompts.map((artifact) => promptSetRouteRecord(artifact));
  const signatureGroups = new Map();
  for (const route of routes) {
    const key = route.signature;
    if (!signatureGroups.has(key)) signatureGroups.set(key, []);
    signatureGroups.get(key).push(route);
  }
  const duplicateRouteGroups = [...signatureGroups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      signature: group[0].signature,
      count: group.length,
      artifacts: group.map((item) => ({ index: item.index, filename: item.filename, role: item.role })),
    }));
  const proofSignatureGroups = new Map();
  for (const route of routes.filter((item) => item.applicationProofTokenCount > 0)) {
    const key = route.applicationProofSignature;
    if (!proofSignatureGroups.has(key)) proofSignatureGroups.set(key, []);
    proofSignatureGroups.get(key).push(route);
  }
  const duplicateApplicationProofGroups = [...proofSignatureGroups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      signature: group[0].applicationProofSignature,
      count: group.length,
      tokens: group[0].applicationProofTokens,
      artifacts: group.map((item) => ({ index: item.index, filename: item.filename, role: item.role })),
    }));
  const differentiationSignatureGroups = new Map();
  for (const route of routes.filter((item) => item.differentiationTokenCount > 0)) {
    const key = route.differentiationSignature;
    if (!differentiationSignatureGroups.has(key)) differentiationSignatureGroups.set(key, []);
    differentiationSignatureGroups.get(key).push(route);
  }
  const duplicateDifferentiationGroups = [...differentiationSignatureGroups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      signature: group[0].differentiationSignature,
      count: group.length,
      tokens: group[0].differentiationTokens,
      artifacts: group.map((item) => ({ index: item.index, filename: item.filename, role: item.role })),
    }));
  const focusMissingArtifacts = routes.filter((route) => !route.focusText || route.tokenCount < 3);
  const thinRouteFocusArtifacts = routes.filter((route) => route.routeStrategyHash
    && route.structuredFocus
    && route.focusTokenCount < 2);
  const unalignedRouteFocusArtifacts = routes.filter((route) => route.routeStrategyHash
    && route.structuredFocus
    && route.focusTokenCount >= 2
    && (route.applicationProofTokenCount > 0 || route.differentiationTokenCount > 0)
    && route.focusAlignmentTokenCount <= 0);
  const structuredRouteCount = routes.filter((route) => route.routeStrategyHash).length;
  const missingStructuredRouteArtifacts = routes.filter((route) => !route.routeStrategyHash);
  const incompleteStructuredRouteArtifacts = routes.filter((route) => route.routeStrategyHash && (
    !route.structuredFocus
    || !route.differentiationKey
    || !route.applicationProof.length
  ));
  const genericApplicationProofArtifacts = routes.filter((route) => route.routeStrategyHash
    && route.applicationProof.length
    && route.applicationProofTokenCount <= 0);
  const thinApplicationProofArtifacts = routes.filter((route) => route.routeStrategyHash
    && route.applicationProof.length
    && route.applicationProofTokenCount > 0
    && route.applicationProofTokenCount < 2);
  const genericDifferentiationArtifacts = routes.filter((route) => route.routeStrategyHash
    && route.differentiationKey
    && route.differentiationTokenCount <= 0);
  const thinDifferentiationArtifacts = routes.filter((route) => route.routeStrategyHash
    && route.differentiationKey
    && route.differentiationTokenCount > 0
    && route.differentiationTokenCount < 2);
  const applicationProofTokenCounts = routes
    .filter((route) => route.routeStrategyHash && route.applicationProof.length)
    .map((route) => route.applicationProofTokenCount);
  const differentiationTokenCounts = routes
    .filter((route) => route.routeStrategyHash && route.differentiationKey)
    .map((route) => route.differentiationTokenCount);
  const routeFocusTokenCounts = routes
    .filter((route) => route.routeStrategyHash && route.structuredFocus)
    .map((route) => route.focusTokenCount);
  const routeFocusAlignmentTokenCounts = routes
    .filter((route) => route.routeStrategyHash && route.structuredFocus && route.focusTokenCount >= 2)
    .map((route) => route.focusAlignmentTokenCount);
  const artifactCount = prompts.length;
  const strictPromptStrategy = isStrictPromptStrategyWorkflow(plan, artifactCount);
  const routeSignatureCount = signatureGroups.size;
  const requiredRouteSignatureCount = artifactCount >= 3 ? Math.min(3, artifactCount) : artifactCount;
  const applicationProofSignatureCount = proofSignatureGroups.size;
  const requiredApplicationProofSignatureCount = artifactCount >= 3 ? Math.min(3, artifactCount) : artifactCount;
  const differentiationSignatureCount = differentiationSignatureGroups.size;
  const requiredDifferentiationSignatureCount = artifactCount >= 3 ? Math.min(3, artifactCount) : artifactCount;
  const blockers = [];
  const warnings = [];
  if (strictPromptStrategy && missingStructuredRouteArtifacts.length) {
    blockers.push({
      code: 'prompt_set_structured_strategy_missing',
      missingCount: missingStructuredRouteArtifacts.length,
    });
  } else if (artifactCount >= 3 && missingStructuredRouteArtifacts.length) {
    warnings.push({
      code: 'prompt_set_structured_strategy_missing',
      missingCount: missingStructuredRouteArtifacts.length,
    });
  }
  if (strictPromptStrategy && incompleteStructuredRouteArtifacts.length) {
    blockers.push({
      code: 'prompt_set_structured_strategy_incomplete',
      incompleteCount: incompleteStructuredRouteArtifacts.length,
    });
  } else if (artifactCount >= 3 && incompleteStructuredRouteArtifacts.length) {
    warnings.push({
      code: 'prompt_set_structured_strategy_incomplete',
      incompleteCount: incompleteStructuredRouteArtifacts.length,
    });
  }
  if (strictPromptStrategy && thinRouteFocusArtifacts.length) {
    blockers.push({
      code: 'prompt_set_route_focus_too_thin',
      thinCount: thinRouteFocusArtifacts.length,
    });
  } else if (artifactCount >= 3 && thinRouteFocusArtifacts.length) {
    warnings.push({
      code: 'prompt_set_route_focus_too_thin',
      thinCount: thinRouteFocusArtifacts.length,
    });
  }
  if (strictPromptStrategy && unalignedRouteFocusArtifacts.length) {
    blockers.push({
      code: 'prompt_set_route_focus_unaligned',
      unalignedCount: unalignedRouteFocusArtifacts.length,
    });
  } else if (artifactCount >= 3 && unalignedRouteFocusArtifacts.length) {
    warnings.push({
      code: 'prompt_set_route_focus_unaligned',
      unalignedCount: unalignedRouteFocusArtifacts.length,
    });
  }
  if (strictPromptStrategy && genericApplicationProofArtifacts.length) {
    blockers.push({
      code: 'prompt_set_application_proof_generic',
      genericCount: genericApplicationProofArtifacts.length,
    });
  } else if (artifactCount >= 3 && genericApplicationProofArtifacts.length) {
    warnings.push({
      code: 'prompt_set_application_proof_generic',
      genericCount: genericApplicationProofArtifacts.length,
    });
  }
  if (strictPromptStrategy && thinApplicationProofArtifacts.length) {
    blockers.push({
      code: 'prompt_set_application_proof_too_thin',
      thinCount: thinApplicationProofArtifacts.length,
    });
  } else if (artifactCount >= 3 && thinApplicationProofArtifacts.length) {
    warnings.push({
      code: 'prompt_set_application_proof_too_thin',
      thinCount: thinApplicationProofArtifacts.length,
    });
  }
  if (strictPromptStrategy && genericDifferentiationArtifacts.length) {
    blockers.push({
      code: 'prompt_set_differentiation_key_generic',
      genericCount: genericDifferentiationArtifacts.length,
    });
  } else if (artifactCount >= 3 && genericDifferentiationArtifacts.length) {
    warnings.push({
      code: 'prompt_set_differentiation_key_generic',
      genericCount: genericDifferentiationArtifacts.length,
    });
  }
  if (strictPromptStrategy && thinDifferentiationArtifacts.length) {
    blockers.push({
      code: 'prompt_set_differentiation_key_too_thin',
      thinCount: thinDifferentiationArtifacts.length,
    });
  } else if (artifactCount >= 3 && thinDifferentiationArtifacts.length) {
    warnings.push({
      code: 'prompt_set_differentiation_key_too_thin',
      thinCount: thinDifferentiationArtifacts.length,
    });
  }
  if (artifactCount >= 3 && routeSignatureCount < requiredRouteSignatureCount) {
    blockers.push({
      code: 'prompt_set_route_diversity_low',
      routeSignatureCount,
      requiredRouteSignatureCount,
    });
  }
  if (strictPromptStrategy && applicationProofSignatureCount < requiredApplicationProofSignatureCount) {
    blockers.push({
      code: 'prompt_set_application_proof_diversity_low',
      applicationProofSignatureCount,
      requiredApplicationProofSignatureCount,
    });
  } else if (artifactCount >= 3 && applicationProofSignatureCount < requiredApplicationProofSignatureCount) {
    warnings.push({
      code: 'prompt_set_application_proof_diversity_low',
      applicationProofSignatureCount,
      requiredApplicationProofSignatureCount,
    });
  }
  if (strictPromptStrategy && differentiationSignatureCount < requiredDifferentiationSignatureCount) {
    blockers.push({
      code: 'prompt_set_differentiation_diversity_low',
      differentiationSignatureCount,
      requiredDifferentiationSignatureCount,
    });
  } else if (artifactCount >= 3 && differentiationSignatureCount < requiredDifferentiationSignatureCount) {
    warnings.push({
      code: 'prompt_set_differentiation_diversity_low',
      differentiationSignatureCount,
      requiredDifferentiationSignatureCount,
    });
  }
  if (artifactCount >= 3 && focusMissingArtifacts.length === artifactCount) {
    warnings.push({ code: 'prompt_set_route_focus_missing' });
  }
  if (artifactCount >= 3 && duplicateRouteGroups.length) {
    warnings.push({
      code: 'prompt_set_duplicate_route_signatures',
      duplicateGroupCount: duplicateRouteGroups.length,
    });
  }
  if (artifactCount >= 3 && duplicateApplicationProofGroups.length) {
    warnings.push({
      code: 'prompt_set_duplicate_application_proof_signatures',
      duplicateGroupCount: duplicateApplicationProofGroups.length,
    });
  }
  if (artifactCount >= 3 && duplicateDifferentiationGroups.length) {
    warnings.push({
      code: 'prompt_set_duplicate_differentiation_signatures',
      duplicateGroupCount: duplicateDifferentiationGroups.length,
    });
  }
  const hasApplicationProof = promptSetApplicationProof({ plan, prompts });
  if (artifactCount >= 3 && !hasApplicationProof) {
    warnings.push({ code: 'prompt_set_application_proof_weak' });
  }
  const gate = {
    ok: blockers.length === 0,
    version: PROMPT_SET_STRATEGY_GATE_VERSION,
    kind: 'PromptSetStrategyGate',
    status: blockers.length ? 'blocked_prompt_set_strategy' : 'pass_prompt_set_strategy',
    workflowId: plan.workflowId || null,
    artifactCount,
    metrics: {
      artifactCount,
      strictPromptStrategy,
      routeSignatureCount,
      requiredRouteSignatureCount,
      applicationProofSignatureCount,
      requiredApplicationProofSignatureCount,
      differentiationSignatureCount,
      requiredDifferentiationSignatureCount,
      structuredRouteCount,
      missingStructuredRouteCount: missingStructuredRouteArtifacts.length,
      incompleteStructuredRouteCount: incompleteStructuredRouteArtifacts.length,
      thinRouteFocusCount: thinRouteFocusArtifacts.length,
      minRouteFocusTokenCount: routeFocusTokenCounts.length ? Math.min(...routeFocusTokenCounts) : null,
      unalignedRouteFocusCount: unalignedRouteFocusArtifacts.length,
      minRouteFocusAlignmentTokenCount: routeFocusAlignmentTokenCounts.length ? Math.min(...routeFocusAlignmentTokenCounts) : null,
      genericApplicationProofCount: genericApplicationProofArtifacts.length,
      thinApplicationProofCount: thinApplicationProofArtifacts.length,
      minApplicationProofTokenCount: applicationProofTokenCounts.length ? Math.min(...applicationProofTokenCounts) : null,
      genericDifferentiationCount: genericDifferentiationArtifacts.length,
      thinDifferentiationCount: thinDifferentiationArtifacts.length,
      minDifferentiationTokenCount: differentiationTokenCounts.length ? Math.min(...differentiationTokenCounts) : null,
      duplicateRouteGroupCount: duplicateRouteGroups.length,
      duplicateApplicationProofGroupCount: duplicateApplicationProofGroups.length,
      duplicateDifferentiationGroupCount: duplicateDifferentiationGroups.length,
      focusMissingCount: focusMissingArtifacts.length,
      hasApplicationProof,
    },
    routes,
    duplicateRouteGroups,
    duplicateApplicationProofGroups,
    duplicateDifferentiationGroups,
    blockers,
    warnings,
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
  };
  return {
    ...gate,
    strategyHash: hashPromptCompiler(gate),
  };
}

function promptReadinessArtifact({ artifact = {}, refreshedArtifact = {}, plan = {} } = {}) {
  const blockers = [];
  const warnings = [];
  const compiler = artifact.promptCompiler || null;
  const refreshedCompiler = refreshedArtifact.promptCompiler || null;
  const label = artifact.filename || `artifact_${artifact.index ?? 'unknown'}`;
  const section = (id) => sectionById(compiler || {}, id);
  const sectionCount = (id) => Number(section(id)?.itemCount || section(id)?.items?.length || 0);

  if (!compiler) blockers.push('prompt_compiler_missing');
  if (compiler && compiler.status !== 'prompt_compiled') blockers.push('prompt_compiler_status_not_compiled');
  if (compiler && !compiler.compilerHash) blockers.push('prompt_compiler_hash_missing');
  if (compiler?.compilerHash && refreshedCompiler?.compilerHash && compiler.compilerHash !== refreshedCompiler.compilerHash) blockers.push('prompt_compiler_hash_stale');
  if (artifact.routeStrategy?.routeStrategyHash && compiler && compiler.routeStrategyHash !== artifact.routeStrategy.routeStrategyHash) blockers.push('prompt_compiler_route_strategy_hash_mismatch');
  if (compiler?.routeStrategyHash && refreshedCompiler?.routeStrategyHash && compiler.routeStrategyHash !== refreshedCompiler.routeStrategyHash) blockers.push('prompt_compiler_route_strategy_hash_stale');
  if (artifact.prompt && !String(artifact.prompt).includes('Design reference pack:')) blockers.push('compiled_reference_guidance_missing');
  if (compiler?.safety && (
    compiler.safety.localCompilationOnly !== true
    || compiler.safety.callsProviderOrModel !== false
    || compiler.safety.opensBrowserOrPlatform !== false
    || compiler.safety.uploadsOrSubmits !== false
    || compiler.safety.sendsMessages !== false
    || compiler.safety.grantsExecutionPermission !== false
  )) blockers.push('prompt_compiler_safety_flags_invalid');
  if (compiler?.refpackId && plan.designReferenceSpec?.id && compiler.refpackId !== plan.designReferenceSpec.id) blockers.push('prompt_compiler_refpack_mismatch');
  if (compiler?.retrievalHash && plan.designReferenceRetrieval?.retrievalHash && compiler.retrievalHash !== plan.designReferenceRetrieval.retrievalHash) blockers.push('prompt_compiler_retrieval_hash_mismatch');
  if (compiler && sectionCount('subject_lock') <= 0) blockers.push('subject_lock_section_empty');
  if (compiler && sectionCount('route_intent') <= 0) blockers.push('route_intent_section_empty');
  if (compiler && sectionCount('reference_grammar') <= 0) blockers.push('reference_grammar_section_empty');
  if (compiler && sectionCount('negative_constraints') <= 0) blockers.push('negative_constraints_section_empty');
  if (compiler && sectionCount('retrieval_evidence') <= 0) blockers.push('retrieval_evidence_section_empty');
  if (compiler && Number(compiler.metrics?.activeSectionCount || 0) < 5) blockers.push('prompt_compiler_active_sections_too_low');

  const outcome = compilerOutcomeEvidence(compiler || {});
  if (!outcome.hasOutcomeSection || outcome.outcomeItemCount <= 0) warnings.push('outcome_learning_section_empty_or_cold_start');
  if (outcome.outcomeScore !== null && outcome.outcomeScore < 55) warnings.push('outcome_score_watch_or_weak');
  const outcomeBlockers = (section('outcome_learning')?.items || [])
    .filter((item) => /^outcome blocker:/i.test(String(item || '')));
  if (outcomeBlockers.length) blockers.push('prompt_compiler_outcome_blocker_present');
  if (compiler?.promptBudget?.hardExceeded === true || compiler?.metrics?.promptBudgetExceeded === true) {
    blockers.push('prompt_compiler_budget_exceeded');
  } else if (compiler?.promptBudget?.warningExceeded === true || compiler?.metrics?.promptBudgetWarning === true) {
    warnings.push('prompt_compiler_budget_warning');
  }
  for (const lintBlocker of compiler?.semanticLint?.blockers || []) {
    blockers.push(lintBlocker?.code || 'prompt_semantic_lint_blocker_present');
  }
  for (const lintWarning of compiler?.semanticLint?.warnings || []) {
    warnings.push(lintWarning?.code || 'prompt_semantic_lint_warning_present');
  }

  return {
    ok: blockers.length === 0,
    index: artifact.index ?? null,
    filename: label,
    role: artifact.role || null,
    routeStrategy: artifact.routeStrategy || null,
    routeStrategyHash: artifact.routeStrategy?.routeStrategyHash || compiler?.routeStrategyHash || null,
    compilerHash: compiler?.compilerHash || null,
    refreshedCompilerHash: refreshedCompiler?.compilerHash || null,
    metrics: compiler?.metrics || {},
    sections: (compiler?.sections || []).map((item) => ({
      id: item.id,
      itemCount: Number(item.itemCount || item.items?.length || 0),
      blocking: !!item.blocking,
    })),
    outcome,
    promptBudget: compiler?.promptBudget || null,
    semanticLint: compiler?.semanticLint || null,
    blockers,
    warnings,
  };
}

function promptReadinessRetrievalBlockers(retrieval = {}) {
  const blockers = [];
  if (!retrieval?.retrievalHash) blockers.push({ code: 'prompt_compiler_retrieval_hash_missing' });
  if (retrieval?.ok !== true) blockers.push({ code: 'prompt_compiler_retrieval_not_ok', status: retrieval?.status || null });
  if (text(retrieval?.status || '') !== 'model_locked_static_refpack') {
    blockers.push({ code: 'prompt_compiler_retrieval_status_not_model_locked', status: retrieval?.status || null });
  }
  if (text(retrieval?.routingMode || '') !== 'model_semantic_locked') {
    blockers.push({ code: 'prompt_compiler_retrieval_routing_mode_invalid', routingMode: retrieval?.routingMode || null });
  }
  if (text(retrieval?.selectionAuthority || '') !== 'semantic_intake') {
    blockers.push({ code: 'prompt_compiler_retrieval_selection_authority_invalid', selectionAuthority: retrieval?.selectionAuthority || null });
  }
  if (retrieval?.indexRoutingActive !== false) {
    blockers.push({ code: 'prompt_compiler_retrieval_index_routing_active' });
  }
  if (retrieval?.indexOverrideAllowed !== false) {
    blockers.push({ code: 'prompt_compiler_retrieval_index_override_allowed' });
  }
  if ((retrieval?.blockers || []).length) {
    blockers.push({ code: 'prompt_compiler_retrieval_blocker_present', count: retrieval.blockers.length });
  }
  if (!retrieval?.industryArbitration) {
    blockers.push({ code: 'prompt_compiler_retrieval_arbitration_missing' });
  } else {
    if (retrieval.industryArbitration.ok !== true) {
      blockers.push({ code: 'prompt_compiler_retrieval_arbitration_blocked', status: retrieval.industryArbitration.status || null });
    }
    if ((retrieval.industryArbitration.blockers || []).length) {
      blockers.push({ code: 'prompt_compiler_retrieval_arbitration_blocker_present', count: retrieval.industryArbitration.blockers.length });
    }
  }
  return blockers;
}

export function createPromptReadinessGate(plan = {}, { createdAt = new Date().toISOString() } = {}) {
  const prompts = Array.isArray(plan.prompts) ? plan.prompts : [];
  const refreshed = refreshPromptCompilerForPlan(plan);
  const refreshedByIndex = new Map((refreshed.prompts || []).map((artifact) => [String(artifact.index ?? artifact.filename), artifact]));
  const blockers = [];
  const warnings = [];
  if (!plan.promptCompiler) blockers.push({ code: 'prompt_compiler_summary_missing' });
  if (plan.promptCompiler?.promptCompilerHash && refreshed.promptCompiler?.promptCompilerHash && plan.promptCompiler.promptCompilerHash !== refreshed.promptCompiler.promptCompilerHash) {
    blockers.push({
      code: 'prompt_compiler_summary_stale',
      expected: refreshed.promptCompiler.promptCompilerHash,
      actual: plan.promptCompiler.promptCompilerHash,
    });
  }
  if (!prompts.length) blockers.push({ code: 'prompt_compiler_no_prompt_artifacts' });
  if (!plan.designReferenceSpec?.id) blockers.push({ code: 'prompt_compiler_refpack_missing' });
  blockers.push(...promptReadinessRetrievalBlockers(plan.designReferenceRetrieval || {}));

  const artifacts = prompts.map((artifact) => {
    const refreshedArtifact = refreshedByIndex.get(String(artifact.index ?? artifact.filename)) || {};
    return promptReadinessArtifact({ artifact, refreshedArtifact, plan });
  });
  for (const artifact of artifacts) {
    for (const code of artifact.blockers) blockers.push({ code, artifactIndex: artifact.index, filename: artifact.filename });
    for (const code of artifact.warnings) warnings.push({ code, artifactIndex: artifact.index, filename: artifact.filename });
  }
  const promptSetStrategy = createPromptSetStrategyGate(plan);
  for (const blocker of promptSetStrategy.blockers || []) blockers.push(blocker);
  for (const warning of promptSetStrategy.warnings || []) warnings.push(warning);

  const outcomeScores = artifacts
    .map((artifact) => artifact.outcome.outcomeScore)
    .filter((value) => Number.isFinite(value));
  const gate = {
    ok: blockers.length === 0,
    version: PROMPT_READINESS_GATE_VERSION,
    kind: 'PromptReadinessGate',
    status: blockers.length ? 'blocked_prompt_readiness' : 'pass_prompt_readiness',
    createdAt,
    taskId: plan.taskId || null,
    orderId: plan.orderId || null,
    workflowId: plan.workflowId || null,
    industryId: plan.industrySpec?.id || null,
    refpackId: plan.designReferenceSpec?.id || null,
    feedbackLearningBridgeHash: feedbackLearningBridgeHashFor(plan),
    retrievalHash: plan.designReferenceRetrieval?.retrievalHash || null,
    promptCompilerHash: plan.promptCompiler?.promptCompilerHash || null,
    refreshedPromptCompilerHash: refreshed.promptCompiler?.promptCompilerHash || null,
    metrics: {
      artifactCount: prompts.length,
      passArtifactCount: artifacts.filter((item) => item.ok).length,
      blockerCount: blockers.length,
      warningCount: warnings.length,
      budgetExceededArtifactCount: artifacts.filter((item) => item.promptBudget?.hardExceeded === true).length,
      budgetWarningArtifactCount: artifacts.filter((item) => item.promptBudget?.warningExceeded === true).length,
      semanticLintBlockerCount: artifacts.reduce((sum, item) => sum + Number(item.semanticLint?.blockerCount || 0), 0),
      semanticLintWarningCount: artifacts.reduce((sum, item) => sum + Number(item.semanticLint?.warningCount || 0), 0),
      retrievalEvidenceOk: promptReadinessRetrievalBlockers(plan.designReferenceRetrieval || {}).length === 0,
      outcomeEvidenceArtifactCount: artifacts.filter((item) => item.outcome.outcomeItemCount > 0).length,
      minOutcomeScore: outcomeScores.length ? Math.min(...outcomeScores) : null,
      maxOutcomeScore: outcomeScores.length ? Math.max(...outcomeScores) : null,
      routeSignatureCount: promptSetStrategy.metrics.routeSignatureCount,
      requiredRouteSignatureCount: promptSetStrategy.metrics.requiredRouteSignatureCount,
      strictPromptStrategy: promptSetStrategy.metrics.strictPromptStrategy,
      applicationProofSignatureCount: promptSetStrategy.metrics.applicationProofSignatureCount,
      requiredApplicationProofSignatureCount: promptSetStrategy.metrics.requiredApplicationProofSignatureCount,
      differentiationSignatureCount: promptSetStrategy.metrics.differentiationSignatureCount,
      requiredDifferentiationSignatureCount: promptSetStrategy.metrics.requiredDifferentiationSignatureCount,
      structuredRouteCount: promptSetStrategy.metrics.structuredRouteCount,
      missingStructuredRouteCount: promptSetStrategy.metrics.missingStructuredRouteCount,
      incompleteStructuredRouteCount: promptSetStrategy.metrics.incompleteStructuredRouteCount,
      thinRouteFocusCount: promptSetStrategy.metrics.thinRouteFocusCount,
      minRouteFocusTokenCount: promptSetStrategy.metrics.minRouteFocusTokenCount,
      unalignedRouteFocusCount: promptSetStrategy.metrics.unalignedRouteFocusCount,
      minRouteFocusAlignmentTokenCount: promptSetStrategy.metrics.minRouteFocusAlignmentTokenCount,
      genericApplicationProofCount: promptSetStrategy.metrics.genericApplicationProofCount,
      thinApplicationProofCount: promptSetStrategy.metrics.thinApplicationProofCount,
      minApplicationProofTokenCount: promptSetStrategy.metrics.minApplicationProofTokenCount,
      genericDifferentiationCount: promptSetStrategy.metrics.genericDifferentiationCount,
      thinDifferentiationCount: promptSetStrategy.metrics.thinDifferentiationCount,
      minDifferentiationTokenCount: promptSetStrategy.metrics.minDifferentiationTokenCount,
      duplicateRouteGroupCount: promptSetStrategy.metrics.duplicateRouteGroupCount,
      duplicateApplicationProofGroupCount: promptSetStrategy.metrics.duplicateApplicationProofGroupCount,
      duplicateDifferentiationGroupCount: promptSetStrategy.metrics.duplicateDifferentiationGroupCount,
      focusMissingCount: promptSetStrategy.metrics.focusMissingCount,
      hasApplicationProof: promptSetStrategy.metrics.hasApplicationProof,
    },
    artifacts,
    promptSetStrategy,
    blockers,
    warnings,
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
  };
  return {
    ...gate,
    readinessHash: hashPromptCompiler({
      version: gate.version,
      kind: gate.kind,
      status: gate.status,
      taskId: gate.taskId,
      orderId: gate.orderId,
      workflowId: gate.workflowId,
      industryId: gate.industryId,
      refpackId: gate.refpackId,
      feedbackLearningBridgeHash: gate.feedbackLearningBridgeHash,
      retrievalHash: gate.retrievalHash,
      promptCompilerHash: gate.promptCompilerHash,
      refreshedPromptCompilerHash: gate.refreshedPromptCompilerHash,
      metrics: gate.metrics,
      artifacts: gate.artifacts,
      promptSetStrategy: gate.promptSetStrategy,
      blockers: gate.blockers,
      warnings: gate.warnings,
      safety: gate.safety,
    }),
  };
}

export function applyPromptReadinessGateToPlan(plan = {}, gate = null) {
  const promptReadiness = gate || createPromptReadinessGate(plan);
  plan.promptReadiness = {
    version: promptReadiness.version,
    kind: 'PromptReadinessGate',
    status: promptReadiness.status,
    ok: promptReadiness.ok,
    readinessHash: promptReadiness.readinessHash,
    refpackId: promptReadiness.refpackId || null,
    feedbackLearningBridgeHash: promptReadiness.feedbackLearningBridgeHash || null,
    retrievalHash: promptReadiness.retrievalHash || null,
    promptCompilerHash: promptReadiness.promptCompilerHash || null,
    refreshedPromptCompilerHash: promptReadiness.refreshedPromptCompilerHash || null,
    reportHash: promptReadiness.reportHash || null,
    metrics: promptReadiness.metrics,
    blockers: promptReadiness.blockers,
    warnings: promptReadiness.warnings,
    promptSetStrategy: promptReadiness.promptSetStrategy || null,
    safety: promptReadiness.safety,
  };
  const blockerCodes = [...new Set((promptReadiness.blockers || []).map((item) => item.code || item).filter(Boolean))];
  if (blockerCodes.length) {
    plan.preGenerationBlockers = [...new Set([...(plan.preGenerationBlockers || []), ...blockerCodes])];
    plan.qaContract ||= {};
    plan.qaContract.importBlockers = [...new Set([...(plan.qaContract.importBlockers || []), 'prompt_readiness_pass_required'])];
  }
  return plan;
}

export function buildPromptReadinessReport(plan = {}, { planPath = null, caseDir = null, createdAt = new Date().toISOString() } = {}) {
  const gate = createPromptReadinessGate(plan, { createdAt });
  const report = {
    ...gate,
    kind: 'PromptReadinessReport',
    planPath,
    caseDir,
  };
  return {
    ...report,
    reportHash: hashPromptCompiler(report),
  };
}

export function promptReadinessReportMarkdown(report = {}) {
  const lines = [
    '# Prompt Readiness Gate',
    '',
    `- status: ${report.status || '-'}`,
    `- ok: ${report.ok}`,
    `- task: ${report.taskId || '-'}`,
    `- workflow: ${report.workflowId || '-'}`,
    `- refpack: ${report.refpackId || '-'}`,
    `- feedbackLearningBridgeHash: ${report.feedbackLearningBridgeHash || '-'}`,
    `- retrievalHash: ${report.retrievalHash || '-'}`,
    `- promptCompilerHash: ${report.promptCompilerHash || '-'}`,
    `- readinessHash: ${report.readinessHash || '-'}`,
    `- reportHash: ${report.reportHash || '-'}`,
    '',
    '## Metrics',
    '',
    ...Object.entries(report.metrics || {}).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Blockers',
    '',
    ...((report.blockers || []).length
      ? report.blockers.map((item) => `- ${item.code}${item.filename ? ` (${item.filename})` : ''}`)
      : ['- none']),
    '',
    '## Warnings',
    '',
    ...((report.warnings || []).length
      ? report.warnings.map((item) => `- ${item.code}${item.filename ? ` (${item.filename})` : ''}`)
      : ['- none']),
    '',
    '## Prompt Set Strategy',
    '',
    `- status: ${report.promptSetStrategy?.status || '-'}`,
    `- strategyHash: ${report.promptSetStrategy?.strategyHash || '-'}`,
    `- routeSignatureCount: ${report.promptSetStrategy?.metrics?.routeSignatureCount ?? '-'}`,
    `- requiredRouteSignatureCount: ${report.promptSetStrategy?.metrics?.requiredRouteSignatureCount ?? '-'}`,
    `- strictPromptStrategy: ${report.promptSetStrategy?.metrics?.strictPromptStrategy ?? '-'}`,
    `- applicationProofSignatureCount: ${report.promptSetStrategy?.metrics?.applicationProofSignatureCount ?? '-'}`,
    `- requiredApplicationProofSignatureCount: ${report.promptSetStrategy?.metrics?.requiredApplicationProofSignatureCount ?? '-'}`,
    `- differentiationSignatureCount: ${report.promptSetStrategy?.metrics?.differentiationSignatureCount ?? '-'}`,
    `- requiredDifferentiationSignatureCount: ${report.promptSetStrategy?.metrics?.requiredDifferentiationSignatureCount ?? '-'}`,
    `- structuredRouteCount: ${report.promptSetStrategy?.metrics?.structuredRouteCount ?? '-'}`,
    `- missingStructuredRouteCount: ${report.promptSetStrategy?.metrics?.missingStructuredRouteCount ?? '-'}`,
    `- incompleteStructuredRouteCount: ${report.promptSetStrategy?.metrics?.incompleteStructuredRouteCount ?? '-'}`,
    `- thinRouteFocusCount: ${report.promptSetStrategy?.metrics?.thinRouteFocusCount ?? '-'}`,
    `- minRouteFocusTokenCount: ${report.promptSetStrategy?.metrics?.minRouteFocusTokenCount ?? '-'}`,
    `- unalignedRouteFocusCount: ${report.promptSetStrategy?.metrics?.unalignedRouteFocusCount ?? '-'}`,
    `- minRouteFocusAlignmentTokenCount: ${report.promptSetStrategy?.metrics?.minRouteFocusAlignmentTokenCount ?? '-'}`,
    `- genericApplicationProofCount: ${report.promptSetStrategy?.metrics?.genericApplicationProofCount ?? '-'}`,
    `- thinApplicationProofCount: ${report.promptSetStrategy?.metrics?.thinApplicationProofCount ?? '-'}`,
    `- minApplicationProofTokenCount: ${report.promptSetStrategy?.metrics?.minApplicationProofTokenCount ?? '-'}`,
    `- genericDifferentiationCount: ${report.promptSetStrategy?.metrics?.genericDifferentiationCount ?? '-'}`,
    `- thinDifferentiationCount: ${report.promptSetStrategy?.metrics?.thinDifferentiationCount ?? '-'}`,
    `- minDifferentiationTokenCount: ${report.promptSetStrategy?.metrics?.minDifferentiationTokenCount ?? '-'}`,
    `- duplicateRouteGroupCount: ${report.promptSetStrategy?.metrics?.duplicateRouteGroupCount ?? '-'}`,
    `- duplicateApplicationProofGroupCount: ${report.promptSetStrategy?.metrics?.duplicateApplicationProofGroupCount ?? '-'}`,
    `- duplicateDifferentiationGroupCount: ${report.promptSetStrategy?.metrics?.duplicateDifferentiationGroupCount ?? '-'}`,
    `- focusMissingCount: ${report.promptSetStrategy?.metrics?.focusMissingCount ?? '-'}`,
    `- hasApplicationProof: ${report.promptSetStrategy?.metrics?.hasApplicationProof ?? '-'}`,
    '',
    '## Artifacts',
    '',
  ];
  if (!report.artifacts?.length) lines.push('- none');
  for (const artifact of report.artifacts || []) {
    lines.push(`- ${artifact.index ?? '-'} ${artifact.filename || '-'}: ${artifact.ok ? 'PASS' : 'BLOCKED'}; hash=${artifact.compilerHash || '-'}; routeStrategy=${artifact.routeStrategyHash || '-'}; outcome=${artifact.outcome?.outcomeScore ?? '-'}`);
  }
  lines.push('');
  lines.push('Safety: this report is a local generation-before-provider gate only. It does not permit provider generation, upload, submit, IM, acceptance, payment, or deployment.');
  return lines.join('\n') + '\n';
}

function routeStrategyHash(routeStrategy = {}) {
  return hashPromptCompiler({
    version: routeStrategy.version || 1,
    routeId: routeStrategy.routeId || null,
    focus: routeStrategy.focus || null,
    differentiationKey: routeStrategy.differentiationKey || null,
    applicationProof: routeStrategy.applicationProof || [],
    proofContexts: routeStrategy.proofContexts || [],
  });
}

export function promptReadinessGateFixturePlan({ duplicate = false } = {}) {
  const context = {
    workflowId: 'logo_brand',
    subject: {
      brandText: '云启数科',
      projectText: '云启数科LOGO',
      mustUseText: ['企业软件平台'],
    },
    industrySpec: {
      id: 'general_technology_b2b',
      label: '科技企业',
      domain: 'technology',
      applicationContexts: ['product dashboard'],
    },
    designReferenceSpec: {
      id: 'refpack_general_technology_b2b_v1',
      label: 'General technology',
      sourcePolicy: { use: 'structure_and_design_grammar_only', mustNotCopy: ['third-party marks'] },
      designGrammar: ['wordmark-first credibility'],
      negativePatterns: ['blue-purple gradient tech template'],
      qaBlockers: ['exact wordmark must work at 32px'],
      successPatterns: ['large wordmark plus application proof wins more often'],
      rejectedPatterns: ['empty dark embossed mockup'],
      feedbackLearningBridgeHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    },
    designReferenceRetrieval: {
      ok: true,
      status: 'model_locked_static_refpack',
      routingMode: 'model_semantic_locked',
      selectionAuthority: 'semantic_intake',
      selectedRefpackId: 'refpack_general_technology_b2b_v1',
      staticRefpackId: 'refpack_general_technology_b2b_v1',
      selectedIndustryId: 'general_technology_b2b',
      indexRoutingActive: false,
      indexOverrideAllowed: false,
      retrievalHash: 'sha256:selftest',
      industryArbitration: {
        ok: true,
        status: 'pass_model_industry_arbitration',
        modelIndustryId: 'general_technology_b2b',
        confidence: 0.91,
        blockers: [],
        warnings: [],
      },
      blockers: [],
      warnings: [],
      selectedCandidate: {
        score: 120,
        outcomeScore: {
          status: 'outcome_learning_warm',
          score: 67,
          counts: { caseCount: 2, learningSignalCount: 3 },
          recommendations: ['promote strong wordmark proof'],
        },
      },
    },
    routeContract: { contractHash: 'sha256:route', finalArtifactShape: 'image_set', expectedFinalFiles: 3 },
  };
  const focuses = duplicate ? [
    'wordmark enterprise dashboard proof route',
    'wordmark enterprise dashboard proof route',
    'wordmark enterprise dashboard proof route',
  ] : [
    'wordmark-first enterprise route with dashboard and app icon application proof',
    'abstract technical mark route with documentation and developer console proof',
    'hardware platform hybrid route with device proof and signage application',
  ];
  const proofSets = duplicate ? [
    ['dashboard mockup', 'app icon proof'],
    ['dashboard mockup', 'app icon proof'],
    ['dashboard mockup', 'app icon proof'],
  ] : [
    ['dashboard mockup', 'app icon proof'],
    ['documentation page proof', 'developer console proof'],
    ['device proof', 'trade-show signage proof'],
  ];
  const prompts = focuses.map((focus, index) => {
    const routeStrategy = {
      version: 1,
      routeId: 'core-fixture-route-' + String(index + 1).padStart(2, '0'),
      focus,
      differentiationKey: duplicate ? 'wordmark enterprise route' : focus,
      applicationProof: proofSets[index],
      proofContexts: proofSets[index],
    };
    routeStrategy.routeStrategyHash = routeStrategyHash(routeStrategy);
    return {
      index: index + 1,
      filename: 'core-fixture-logo-' + String(index + 1).padStart(2, '0') + '.jpg',
      role: 'finished_vi_board',
      prompt: 'Create a polished VI board. Focus: ' + focus + '.',
      routeStrategy,
      acceptance: [
        'board includes colored logo plus VI/application proof',
        'route is strategically distinct from the other submitted boards',
      ],
    };
  });
  return refreshPromptCompilerForPlan({
    taskId: 999,
    workflowId: context.workflowId,
    subject: context.subject,
    industrySpec: context.industrySpec,
    designReferenceSpec: context.designReferenceSpec,
    designReferenceRetrieval: context.designReferenceRetrieval,
    routeContract: context.routeContract,
    prompts,
    workflowProfile: { deliverableClass: 'finished_logo_vi_board_set' },
    qualityGates: [{ id: 'route_diversity', label: 'Routes are meaningfully different.' }],
    packageRules: ['Submit meaningfully different VI boards with application proof.'],
  });
}

function promptReadinessGatePlanWithoutStructuredRoutes({ workflowId = 'poster_design' } = {}) {
  const plan = promptReadinessGateFixturePlan();
  return refreshPromptCompilerForPlan({
    ...plan,
    workflowId,
    prompts: (plan.prompts || []).map((artifact) => ({
      ...artifact,
      routeStrategy: null,
      promptCompiler: null,
    })),
  });
}

function promptReadinessGateSemanticLintPlan() {
  const plan = promptReadinessGateFixturePlan();
  return refreshPromptCompilerForPlan({
    ...plan,
    prompts: (plan.prompts || []).map((artifact, index) => ({
      ...artifact,
      promptCompiler: null,
      prompt: index === 0
        ? 'Copy the reference logo exactly and keep the same brand mark.'
        : artifact.prompt,
    })),
  });
}

function promptReadinessGateBudgetPlan() {
  const plan = promptReadinessGateFixturePlan();
  return refreshPromptCompilerForPlan({
    ...plan,
    workflowId: 'generic_design',
    prompts: [{
      ...plan.prompts[0],
      index: 1,
      routeStrategy: null,
      promptCompiler: null,
      prompt: `Create a polished production board. ${'high fidelity visual direction '.repeat(5200)}`,
    }],
  });
}

function promptReadinessGateBlockedRetrievalPlan() {
  const plan = promptReadinessGateFixturePlan();
  return refreshPromptCompilerForPlan({
    ...plan,
    designReferenceRetrieval: {
      ...plan.designReferenceRetrieval,
      ok: false,
      status: 'blocked_model_industry_arbitration',
      industryArbitration: {
        ...plan.designReferenceRetrieval.industryArbitration,
        ok: false,
        status: 'blocked_model_industry_arbitration',
        blockers: [{ code: 'model_industry_confidence_below_floor' }],
      },
      blockers: [{ code: 'model_industry_confidence_below_floor' }],
    },
    prompts: (plan.prompts || []).map((artifact) => ({
      ...artifact,
      promptCompiler: null,
    })),
  });
}

export function promptReadinessGateSelftest() {
  const passPlan = promptReadinessGateFixturePlan();
  const passA = createPromptReadinessGate(passPlan, { createdAt: '2026-06-14T00:00:00.000Z' });
  const passB = createPromptReadinessGate(passPlan, { createdAt: '2026-06-14T00:01:00.000Z' });
  const stalePlan = structuredClone(passPlan);
  stalePlan.promptCompiler.promptCompilerHash = 'sha256:stale';
  const stale = createPromptReadinessGate(stalePlan, { createdAt: '2026-06-14T00:00:00.000Z' });
  const duplicate = createPromptReadinessGate(promptReadinessGateFixturePlan({ duplicate: true }), { createdAt: '2026-06-14T00:00:00.000Z' });
  const posterMissingStructuredRoutes = createPromptReadinessGate(promptReadinessGatePlanWithoutStructuredRoutes(), { createdAt: '2026-06-14T00:00:00.000Z' });
  const semanticLint = createPromptReadinessGate(promptReadinessGateSemanticLintPlan(), { createdAt: '2026-06-14T00:00:00.000Z' });
  const budget = createPromptReadinessGate(promptReadinessGateBudgetPlan(), { createdAt: '2026-06-14T00:00:00.000Z' });
  const blockedRetrieval = createPromptReadinessGate(promptReadinessGateBlockedRetrievalPlan(), { createdAt: '2026-06-14T00:00:00.000Z' });
  return {
    ok: passA.ok === true
      && passA.readinessHash === passB.readinessHash
      && passA.promptSetStrategy?.metrics?.strictPromptStrategy === true
      && passA.promptSetStrategy?.metrics?.structuredRouteCount === 3
      && passA.promptSetStrategy?.metrics?.routeSignatureCount === 3
      && stale.ok === false
      && stale.blockers.some((item) => item.code === 'prompt_compiler_summary_stale')
      && duplicate.ok === false
      && duplicate.blockers.some((item) => item.code === 'prompt_set_route_diversity_low')
      && posterMissingStructuredRoutes.ok === false
      && posterMissingStructuredRoutes.blockers.some((item) => item.code === 'prompt_set_structured_strategy_missing')
      && semanticLint.ok === false
      && semanticLint.blockers.some((item) => item.code === 'prompt_semantic_lint_reference_copy_risk')
      && budget.ok === false
      && budget.blockers.some((item) => item.code === 'prompt_compiler_budget_exceeded')
      && blockedRetrieval.ok === false
      && blockedRetrieval.blockers.some((item) => item.code === 'prompt_compiler_retrieval_arbitration_blocked'),
    passA,
    stale,
    duplicate,
    posterMissingStructuredRoutes,
    semanticLint,
    budget,
    blockedRetrieval,
  };
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const result = promptReadinessGateSelftest();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
