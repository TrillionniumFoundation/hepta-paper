import { digest } from './hash-utils.mjs';

export const PROMPT_ARTIFACT_COMPILER_VERSION = 1;
export const PROMPT_COMPILER_VERSION = PROMPT_ARTIFACT_COMPILER_VERSION;

const PROMPT_COMPILER_WARNING_CHAR_BUDGET = 16000;
const PROMPT_COMPILER_HARD_CHAR_BUDGET = 24000;

export function normalizePromptArtifactText(value) {
  return String(value || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function list(value, limit = 12) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  const seen = new Set();
  const out = [];
  for (const item of values) {
    const normalized = normalizePromptArtifactText(item);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

export function hashPromptCompiler(value) {
  return digest(value);
}

export function stripPromptCompilerGuidance(prompt = '') {
  return String(prompt || '')
    .replace(/\n\nDesign reference pack:[\s\S]*?(?=\n\nIndustry classification:|$)/, '')
    .trim();
}

function tokenBiasLines(tokenBias = {}) {
  const lines = [];
  if (list(tokenBias.colorFamilies).length) lines.push(`color bias: ${list(tokenBias.colorFamilies, 8).join(', ')}`);
  if (tokenBias.typographyTone) lines.push(`typography: ${normalizePromptArtifactText(tokenBias.typographyTone)}`);
  if (tokenBias.density) lines.push(`density: ${normalizePromptArtifactText(tokenBias.density)}`);
  if (tokenBias.shapeLanguage) lines.push(`shape language: ${normalizePromptArtifactText(tokenBias.shapeLanguage)}`);
  return lines;
}

function section(id, title, items, { weight = 1, blocking = false } = {}) {
  const cleanItems = list(items, 20);
  return {
    id,
    title,
    weight,
    blocking,
    itemCount: cleanItems.length,
    items: cleanItems,
  };
}

function approxPromptTokenCount(value = '') {
  const normalized = normalizePromptArtifactText(value);
  if (!normalized) return 0;
  const latinTokens = normalized.match(/[a-z0-9_]+/gi) || [];
  const cjkChars = normalized.match(/[\u4e00-\u9fa5]/g) || [];
  return latinTokens.length + cjkChars.length;
}

function promptBudgetMetrics({ basePrompt = '', guidanceText = '', compiledPrompt = '' } = {}) {
  const basePromptCharCount = normalizePromptArtifactText(basePrompt).length;
  const guidanceCharCount = normalizePromptArtifactText(guidanceText).length;
  const compiledPromptCharCount = normalizePromptArtifactText(compiledPrompt).length;
  return {
    warningCharLimit: PROMPT_COMPILER_WARNING_CHAR_BUDGET,
    hardCharLimit: PROMPT_COMPILER_HARD_CHAR_BUDGET,
    basePromptCharCount,
    guidanceCharCount,
    compiledPromptCharCount,
    approxTokenCount: approxPromptTokenCount(compiledPrompt),
    warningExceeded: compiledPromptCharCount > PROMPT_COMPILER_WARNING_CHAR_BUDGET,
    hardExceeded: compiledPromptCharCount > PROMPT_COMPILER_HARD_CHAR_BUDGET,
  };
}

function hasUnnegatedPattern({ textValue = '', riskPattern, safePattern }) {
  const value = normalizePromptArtifactText(textValue);
  if (!value || !riskPattern.test(value)) return false;
  if (safePattern?.test(value)) return false;
  return true;
}

function promptSemanticLint({ basePrompt = '', subject = {}, designReferenceSpec = {} } = {}) {
  const blockers = [];
  const warnings = [];
  const baseText = normalizePromptArtifactText(basePrompt);
  const referenceCopyRisk = hasUnnegatedPattern({
    textValue: baseText,
    riskPattern: /\b(copy|clone|replicate|recreate|trace|match)\b.{0,80}\b(reference|logo|brand|mark|design)\b|\b(reference|logo|brand|mark|design)\b.{0,80}\b(exactly|1:1|unchanged|as-is)\b|照抄|抄袭|原样复制|一比一|完全复刻|复刻.{0,40}参考|参考.{0,40}复刻/i,
    safePattern: /\b(do not|don't|never|must not|avoid|forbid|forbidden|without)\b.{0,80}\b(copy|clone|replicate|recreate|trace|match)\b|禁止.{0,80}(照抄|抄袭|复制|复刻)|不要.{0,80}(照抄|抄袭|复制|复刻)|不得.{0,80}(照抄|抄袭|复制|复刻)|避免.{0,80}(照抄|抄袭|复制|复刻)/i,
  });
  if (referenceCopyRisk) {
    blockers.push({
      code: 'prompt_semantic_lint_reference_copy_risk',
      notes: 'base prompt asks to copy/clone/replicate a reference instead of using grammar-only reference policy',
    });
  }

  const placeholderRisk = hasUnnegatedPattern({
    textValue: baseText,
    riskPattern: /\b(lorem ipsum|placeholder|your brand|company name here|brand name here|sample text|demo data|dummy text|todo)\b|\[(brand|company|logo|text)\]|\{(brand|company|logo|text)\}|示例文字|占位|样例数据|请输入品牌/i,
    safePattern: /\b(no|not|avoid|without|remove|forbid|forbidden)\b.{0,80}\b(lorem|placeholder|sample|demo|dummy)\b|禁止.{0,80}(占位|样例|示例)|不要.{0,80}(占位|样例|示例)|不得.{0,80}(占位|样例|示例)|避免.{0,80}(占位|样例|示例)/i,
  });
  if (placeholderRisk) {
    blockers.push({
      code: 'prompt_semantic_lint_placeholder_risk',
      notes: 'base prompt still contains placeholder/demo text that can leak into production output',
    });
  }

  const subjectHasLockedText = !!(
    normalizePromptArtifactText(subject.brandText || '')
    || normalizePromptArtifactText(subject.productText || '')
    || normalizePromptArtifactText(subject.projectText || '')
  );
  const subjectInventionRisk = subjectHasLockedText && hasUnnegatedPattern({
    textValue: baseText,
    riskPattern: /\b(invent|make up|come up with)\b.{0,80}\b(brand name|company name|wordmark|logo text|slogan)\b|\b(create|generate)\b.{0,80}\b(brand name|company name|slogan)\b|自造.{0,40}(品牌|公司|名称|文字)|编造.{0,40}(品牌|公司|名称|文字)|随机.{0,40}(品牌|公司|名称|文字)/i,
    safePattern: /\b(do not|don't|never|must not|avoid|forbid|forbidden|without)\b.{0,80}\b(invent|create|generate|make up)\b.{0,80}\b(brand name|company name|wordmark|logo text|slogan)\b|禁止.{0,80}(自造|编造|随机)|不要.{0,80}(自造|编造|随机)|不得.{0,80}(自造|编造|随机)|避免.{0,80}(自造|编造|随机)/i,
  });
  if (subjectInventionRisk) {
    blockers.push({
      code: 'prompt_semantic_lint_subject_invention_risk',
      notes: 'base prompt conflicts with locked subject text by inviting invented brand/company wording',
    });
  }

  const basePromptActionableTokenCount = approxPromptTokenCount(baseText);
  if (baseText && basePromptActionableTokenCount < 6) {
    warnings.push({
      code: 'prompt_semantic_lint_base_prompt_too_thin',
      notes: 'base prompt is very short; compiler sections may carry the plan but artifact intent is weak',
    });
  }
  if (!list(designReferenceSpec.negativePatterns, 99).length && !list(designReferenceSpec.qaBlockers, 99).length) {
    warnings.push({
      code: 'prompt_semantic_lint_negative_constraints_cold_start',
      notes: 'reference spec has no negative patterns or QA blockers',
    });
  }

  const lint = {
    version: PROMPT_COMPILER_VERSION,
    kind: 'PromptSemanticLint',
    ok: blockers.length === 0,
    blockerCount: blockers.length,
    warningCount: warnings.length,
    blockers,
    warnings,
    safety: {
      localLintOnly: true,
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
    ...lint,
    lintHash: hashPromptCompiler(lint),
  };
}

function subjectItems(subject = {}) {
  return [
    subject.brandText ? `exact brand text: ${subject.brandText}` : null,
    subject.productText ? `product/object: ${subject.productText}` : null,
    subject.projectText ? `project subject: ${subject.projectText}` : null,
    ...(subject.mustUseText || []).map((item) => `must use: ${item}`),
    ...(subject.forbiddenText || []).map((item) => `buyer forbids: ${item}`),
  ].filter(Boolean);
}

function routeItems({ artifact = {}, routeContract = null, deliverableSpec = null } = {}) {
  const routeStrategy = artifact.routeStrategy || null;
  return [
    artifact.role ? `artifact role: ${artifact.role}` : null,
    artifact.filename ? `target filename: ${artifact.filename}` : null,
    routeStrategy?.routeId ? `route id: ${routeStrategy.routeId}` : null,
    routeStrategy?.focus ? `route focus: ${routeStrategy.focus}` : null,
    routeStrategy?.differentiationKey ? `route differentiation: ${routeStrategy.differentiationKey}` : null,
    (routeStrategy?.applicationProof || []).length ? `route application proof: ${routeStrategy.applicationProof.join('; ')}` : null,
    routeStrategy?.intendedContrast ? `route contrast: ${routeStrategy.intendedContrast}` : null,
    routeContract?.deliverableType ? `deliverable type: ${routeContract.deliverableType}` : null,
    routeContract?.finalArtifactShape ? `final artifact shape: ${routeContract.finalArtifactShape}` : null,
    routeContract?.submitRoute ? `submit route: ${routeContract.submitRoute}` : null,
    Number.isFinite(Number(routeContract?.expectedFinalFiles)) ? `expected final files: ${routeContract.expectedFinalFiles}` : null,
    deliverableSpec?.providerKind ? `provider kind: ${deliverableSpec.providerKind}` : null,
    deliverableSpec?.submitMode ? `submit mode: ${deliverableSpec.submitMode}` : null,
  ].filter(Boolean);
}

function industryItems(industrySpec = {}) {
  return [
    industrySpec.label ? `${industrySpec.label}${industrySpec.domain ? ` (${industrySpec.domain})` : ''}` : null,
    ...(industrySpec.promptHints || []),
    ...(industrySpec.visualCues || []).map((item) => `credible cue: ${item}`),
    ...(industrySpec.applicationContexts || []).map((item) => `application context: ${item}`),
    ...(industrySpec.forbiddenCliches || []).map((item) => `avoid cliche: ${item}`),
  ].filter(Boolean);
}

function referenceGrammarItems(spec = {}) {
  return [
    `Use references only as ${spec.sourcePolicy?.use || 'structure_and_design_grammar_only'}, never copy ${list(spec.sourcePolicy?.mustNotCopy, 8).join(', ') || 'third-party brands'}.`,
    (spec.referenceKeys || []).length ? `reference keys: ${(spec.referenceKeys || []).join(', ')}` : null,
    spec.referenceSourceStatus?.resolvedCount ? `source resolution: ${spec.referenceSourceStatus.resolvedCount}/${spec.referenceSourceStatus.total}; digest mode: ${spec.referenceSourceStatus.digestMode || 'record_only'}` : null,
    ...(spec.referenceSourceDigests || []).map((item) => `source digest ${item.key}: ${item.digest}`),
    ...(spec.designGrammar || []),
    ...tokenBiasLines(spec.tokenBias || {}),
    ...(spec.layoutPatterns || []).map((item) => `layout: ${item}`),
    ...(spec.surfacePatterns || []).map((item) => `surface: ${item}`),
    ...(spec.applicationScenes || []).map((item) => `application proof: ${item}`),
    ...(spec.materialPreferences || []).map((item) => `material: ${item}`),
    ...(spec.layoutPreferences || []).map((item) => `layout preference: ${item}`),
    ...(spec.typographyPreferences || []).map((item) => `typography preference: ${item}`),
  ].filter(Boolean);
}

function negativeItems(spec = {}) {
  return [
    ...(spec.avoidPatterns || []).map((item) => `avoid: ${item}`),
    ...(spec.negativePatterns || []).map((item) => `hard negative: ${item}`),
    ...(spec.qaBlockers || []).map((item) => `QA blocker: ${item}`),
  ];
}

function outcomeItems(spec = {}, retrieval = null) {
  const outcome = spec.outcomeScore || retrieval?.selectedCandidate?.outcomeScore || null;
  return [
    outcome?.score !== undefined && outcome?.score !== null ? `outcome score: ${outcome.score}/100 (${outcome.status || 'unknown'})` : null,
    outcome?.counts?.caseCount ? `outcome cases: ${outcome.counts.caseCount}` : null,
    outcome?.counts?.learningSignalCount ? `learning signals: ${outcome.counts.learningSignalCount}` : null,
    ...(outcome?.blockers || []).map((item) => `outcome blocker: ${item}`),
    ...(outcome?.recommendations || []).map((item) => `outcome recommendation: ${item}`),
    ...(spec.successPatterns || []).map((item) => `reuse winning pattern: ${item}`),
    ...(spec.rejectedPatterns || []).map((item) => `avoid rejected pattern: ${item}`),
    ...(spec.buyerCorrections || []).map((item) => `respect buyer correction: ${item}`),
  ].filter(Boolean);
}

function retrievalItems(retrieval = null) {
  if (!retrieval) return [];
  return [
    `retrieval status: ${retrieval.status || 'unknown'}`,
    `routing mode: ${retrieval.routingMode || retrieval.status || 'unknown'}`,
    `selection authority: ${retrieval.selectionAuthority || retrieval.selectionReason || 'unknown'}`,
    `index routing active: ${retrieval.indexRoutingActive === true ? 'yes' : 'no'}`,
    `index override allowed: ${retrieval.indexOverrideAllowed === true ? 'yes' : 'no'}`,
    retrieval.selectedRefpackId ? `selected refpack: ${retrieval.selectedRefpackId}` : null,
    retrieval.staticRefpackId ? `static refpack: ${retrieval.staticRefpackId}` : null,
    retrieval.topRefpackId ? `top index refpack: ${retrieval.topRefpackId}` : null,
    retrieval.industryArbitration ? `industry arbitration: ${retrieval.industryArbitration.status || 'unknown'}; confidence ${retrieval.industryArbitration.confidence ?? 'unknown'}` : null,
    retrieval.selectedCandidate?.score ? `selected score: ${retrieval.selectedCandidate.score}` : null,
    ...(retrieval.warnings || []).map((item) => `retrieval warning: ${item.code || item}`),
    ...(retrieval.blockers || []).map((item) => `retrieval blocker: ${item.code || item}`),
  ].filter(Boolean);
}

function promptGuidanceText({ designReferenceSpec = {}, sections = [] } = {}) {
  const sectionText = sections
    .filter((item) => item.items.length)
    .map((item) => `${item.title}: ${item.items.join('; ')}.`)
    .join(' ');
  return [
    `Design reference pack: ${designReferenceSpec.label || designReferenceSpec.id || 'unknown reference pack'}. Use references only as ${designReferenceSpec.sourcePolicy?.use || 'structure and grammar'}, never copy ${list(designReferenceSpec.sourcePolicy?.mustNotCopy, 8).join(', ') || 'third-party brands'}.`,
    sectionText,
  ].filter(Boolean).join(' ');
}

export function compilePromptArtifact({
  artifact = {},
  workflowId = null,
  subject = {},
  industrySpec = {},
  designReferenceSpec = {},
  designReferenceRetrieval = null,
  routeContract = null,
  deliverableSpec = null,
  requirementText = '',
} = {}) {
  const basePrompt = stripPromptCompilerGuidance(artifact.prompt || '');
  const sections = [
    section('subject_lock', 'Subject lock', subjectItems(subject), { weight: 1.25, blocking: true }),
    section('route_intent', 'Route intent', routeItems({ artifact, routeContract, deliverableSpec }), { weight: 0.9 }),
    section('industry_direction', 'Industry direction', industryItems(industrySpec), { weight: 0.9 }),
    section('reference_grammar', 'Reference grammar', referenceGrammarItems(designReferenceSpec), { weight: 1 }),
    section('negative_constraints', 'Negative constraints', negativeItems(designReferenceSpec), { weight: 1.2, blocking: true }),
    section('outcome_learning', 'Outcome learning', outcomeItems(designReferenceSpec, designReferenceRetrieval), { weight: 1.15 }),
    section('retrieval_evidence', 'Retrieval evidence', retrievalItems(designReferenceRetrieval), { weight: 0.6 }),
  ];
  const guidanceText = promptGuidanceText({ designReferenceSpec, sections });
  const compiledPrompt = `${basePrompt}\n\n${guidanceText}`.trim();
  const semanticLint = promptSemanticLint({ basePrompt, subject, designReferenceSpec });
  const promptBudget = promptBudgetMetrics({ basePrompt, guidanceText, compiledPrompt });
  const compiler = {
    version: PROMPT_COMPILER_VERSION,
    kind: 'PromptCompilerArtifact',
    status: 'prompt_compiled',
    workflowId: workflowId || null,
    artifactIndex: artifact.index ?? null,
    filename: artifact.filename || null,
    role: artifact.role || null,
    refpackId: designReferenceSpec.id || designReferenceRetrieval?.selectedRefpackId || null,
    industryId: industrySpec.id || designReferenceSpec.industryId || null,
    retrievalHash: designReferenceRetrieval?.retrievalHash || null,
    feedbackLearningBridgeHash: designReferenceSpec.feedbackLearningBridgeHash || null,
    routeContractHash: routeContract?.contractHash || null,
    routeStrategyHash: artifact.routeStrategy?.routeStrategyHash || null,
    source: {
      basePromptHash: hashPromptCompiler({ basePrompt }),
      requirementExcerptHash: hashPromptCompiler({ requirementText: String(requirementText || '').slice(0, 1400) }),
    },
    sections,
    metrics: {
      sectionCount: sections.length,
      activeSectionCount: sections.filter((item) => item.items.length).length,
      blockingSectionCount: sections.filter((item) => item.blocking && item.items.length).length,
      successPatternCount: list(designReferenceSpec.successPatterns, 99).length,
      rejectedPatternCount: list(designReferenceSpec.rejectedPatterns, 99).length,
      buyerCorrectionCount: list(designReferenceSpec.buyerCorrections, 99).length,
      outcomeScore: designReferenceSpec.outcomeScore?.score ?? designReferenceRetrieval?.selectedCandidate?.outcomeScore?.score ?? null,
      outcomeCaseCount: designReferenceSpec.outcomeScore?.counts?.caseCount ?? designReferenceRetrieval?.selectedCandidate?.outcomeScore?.counts?.caseCount ?? 0,
      outcomeLearningSignalCount: designReferenceSpec.outcomeScore?.counts?.learningSignalCount ?? designReferenceRetrieval?.selectedCandidate?.outcomeScore?.counts?.learningSignalCount ?? 0,
      negativeConstraintCount: negativeItems(designReferenceSpec).length,
      basePromptCharCount: promptBudget.basePromptCharCount,
      guidanceCharCount: promptBudget.guidanceCharCount,
      compiledPromptCharCount: promptBudget.compiledPromptCharCount,
      approxTokenCount: promptBudget.approxTokenCount,
      promptBudgetWarning: promptBudget.warningExceeded,
      promptBudgetExceeded: promptBudget.hardExceeded,
      semanticLintBlockerCount: semanticLint.blockerCount,
      semanticLintWarningCount: semanticLint.warningCount,
    },
    promptBudget,
    semanticLint,
    safety: {
      localCompilationOnly: true,
      callsProviderOrModel: false,
      opensBrowserOrPlatform: false,
      uploadsOrSubmits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      paysOrDeploys: false,
      grantsExecutionPermission: false,
      referenceSourcesAreGrammarOnly: true,
    },
  };
  const compilerHash = hashPromptCompiler({
    version: compiler.version,
    workflowId: compiler.workflowId,
    artifactIndex: compiler.artifactIndex,
    filename: compiler.filename,
    refpackId: compiler.refpackId,
    industryId: compiler.industryId,
    retrievalHash: compiler.retrievalHash,
    feedbackLearningBridgeHash: compiler.feedbackLearningBridgeHash,
    routeContractHash: compiler.routeContractHash,
    routeStrategyHash: compiler.routeStrategyHash,
    sections: compiler.sections,
    source: compiler.source,
    promptBudget: compiler.promptBudget,
    semanticLint: compiler.semanticLint,
    safety: compiler.safety,
  });
  return {
    ...compiler,
    guidanceText,
    compiledPrompt,
    compilerHash,
    hash: compilerHash,
  };
}

export function attachPromptCompilerToArtifacts(prompts = [], context = {}) {
  return (prompts || []).map((artifact) => {
    const compiler = compilePromptArtifact({ artifact, ...context });
    return {
      ...artifact,
      prompt: compiler.compiledPrompt,
      promptCompiler: {
        version: compiler.version,
        kind: compiler.kind,
        status: compiler.status,
        compilerHash: compiler.compilerHash,
        refpackId: compiler.refpackId,
        industryId: compiler.industryId,
        retrievalHash: compiler.retrievalHash,
        feedbackLearningBridgeHash: compiler.feedbackLearningBridgeHash,
        routeContractHash: compiler.routeContractHash,
        routeStrategyHash: compiler.routeStrategyHash,
        metrics: compiler.metrics,
        promptBudget: compiler.promptBudget,
        semanticLint: compiler.semanticLint,
        sections: compiler.sections,
        safety: compiler.safety,
      },
    };
  });
}

export function refreshPromptCompilerForPlan(plan = {}, {
  requirementText = null,
  designReferenceRetrieval = null,
} = {}) {
  const context = {
    workflowId: plan.workflowId || null,
    subject: plan.subject || {},
    industrySpec: plan.industrySpec || {},
    designReferenceSpec: plan.designReferenceSpec || {},
    designReferenceRetrieval: designReferenceRetrieval || plan.designReferenceRetrieval || null,
    routeContract: plan.routeContract || null,
    deliverableSpec: plan.deliverableSpec || null,
    requirementText: requirementText ?? plan.requirementExcerpt ?? '',
  };
  const prompts = attachPromptCompilerToArtifacts(plan.prompts || [], context);
  const compilers = prompts.map((item) => item.promptCompiler).filter(Boolean);
  const promptCompiler = {
    version: PROMPT_COMPILER_VERSION,
    kind: 'PromptCompilerPlanSummary',
    status: 'prompt_compiler_ready',
    taskId: plan.taskId || null,
    orderId: plan.orderId || null,
    workflowId: plan.workflowId || null,
    industryId: plan.industrySpec?.id || null,
    refpackId: plan.designReferenceSpec?.id || null,
    retrievalHash: context.designReferenceRetrieval?.retrievalHash || null,
    feedbackLearningBridgeHash: context.designReferenceSpec?.feedbackLearningBridgeHash || null,
    routeContractHash: plan.routeContract?.contractHash || null,
    routeStrategyHashes: compilers.map((item) => item.routeStrategyHash).filter(Boolean),
    artifactCount: prompts.length,
    compilerHashes: compilers.map((item) => item.compilerHash),
    metrics: {
      activeSectionCount: compilers.reduce((sum, item) => sum + Number(item.metrics?.activeSectionCount || 0), 0),
      negativeConstraintCount: compilers.reduce((sum, item) => sum + Number(item.metrics?.negativeConstraintCount || 0), 0),
      successPatternCount: Math.max(0, ...compilers.map((item) => Number(item.metrics?.successPatternCount || 0))),
      rejectedPatternCount: Math.max(0, ...compilers.map((item) => Number(item.metrics?.rejectedPatternCount || 0))),
      buyerCorrectionCount: Math.max(0, ...compilers.map((item) => Number(item.metrics?.buyerCorrectionCount || 0))),
      structuredRouteStrategyCount: compilers.filter((item) => item.routeStrategyHash).length,
      maxCompiledPromptCharCount: Math.max(0, ...compilers.map((item) => Number(item.metrics?.compiledPromptCharCount || 0))),
      maxApproxTokenCount: Math.max(0, ...compilers.map((item) => Number(item.metrics?.approxTokenCount || 0))),
      promptBudgetWarningCount: compilers.filter((item) => item.metrics?.promptBudgetWarning === true).length,
      promptBudgetExceededCount: compilers.filter((item) => item.metrics?.promptBudgetExceeded === true).length,
      semanticLintBlockerCount: compilers.reduce((sum, item) => sum + Number(item.metrics?.semanticLintBlockerCount || 0), 0),
      semanticLintWarningCount: compilers.reduce((sum, item) => sum + Number(item.metrics?.semanticLintWarningCount || 0), 0),
    },
    safety: {
      localCompilationOnly: true,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
  promptCompiler.promptCompilerHash = hashPromptCompiler(promptCompiler);
  return {
    ...plan,
    prompts,
    promptCompiler,
  };
}

export function buildPromptCompilerReport(plan = {}, { planPath = null, caseDir = null, createdAt = new Date().toISOString() } = {}) {
  const refreshed = refreshPromptCompilerForPlan(plan);
  const artifacts = (refreshed.prompts || []).map((artifact) => ({
    index: artifact.index,
    filename: artifact.filename,
    role: artifact.role,
    routeStrategy: artifact.routeStrategy || null,
    routeStrategyHash: artifact.routeStrategy?.routeStrategyHash || artifact.promptCompiler?.routeStrategyHash || null,
    compilerHash: artifact.promptCompiler?.compilerHash || null,
    feedbackLearningBridgeHash: artifact.promptCompiler?.feedbackLearningBridgeHash || null,
    metrics: artifact.promptCompiler?.metrics || {},
    promptBudget: artifact.promptCompiler?.promptBudget || null,
    semanticLint: artifact.promptCompiler?.semanticLint || null,
    sections: artifact.promptCompiler?.sections || [],
  }));
  const report = {
    ok: true,
    version: PROMPT_COMPILER_VERSION,
    kind: 'PromptCompilerReport',
    status: 'prompt_compiler_report_ready',
    createdAt,
    taskId: refreshed.taskId || null,
    orderId: refreshed.orderId || null,
    title: refreshed.title || null,
    workflowId: refreshed.workflowId || null,
    industryId: refreshed.industrySpec?.id || null,
    refpackId: refreshed.designReferenceSpec?.id || null,
    retrievalHash: refreshed.designReferenceRetrieval?.retrievalHash || null,
    feedbackLearningBridgeHash: refreshed.designReferenceSpec?.feedbackLearningBridgeHash || refreshed.feedbackLearningBridge?.bridgeHash || null,
    routeContractHash: refreshed.routeContract?.contractHash || null,
    planPath,
    caseDir,
    summary: refreshed.promptCompiler,
    artifacts,
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
  };
  return {
    ...report,
    reportHash: hashPromptCompiler(report),
    refreshedPlan: refreshed,
  };
}

export function promptCompilerReportMarkdown(report = {}) {
  const lines = [
    '# Prompt Compiler Report',
    '',
    `- status: ${report.status || '-'}`,
    `- task: ${report.taskId || '-'}`,
    `- workflow: ${report.workflowId || '-'}`,
    `- industry: ${report.industryId || '-'}`,
    `- refpack: ${report.refpackId || '-'}`,
    `- retrievalHash: ${report.retrievalHash || '-'}`,
    `- feedbackLearningBridgeHash: ${report.feedbackLearningBridgeHash || '-'}`,
    `- routeContractHash: ${report.routeContractHash || '-'}`,
    `- artifactCount: ${report.summary?.artifactCount ?? report.artifacts?.length ?? 0}`,
    `- reportHash: ${report.reportHash || '-'}`,
    '',
    '## Metrics',
    '',
    ...Object.entries(report.summary?.metrics || {}).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Artifacts',
    '',
  ];
  if (!report.artifacts?.length) lines.push('- none');
  for (const artifact of report.artifacts || []) {
    lines.push(`### ${artifact.index}. ${artifact.filename}`);
    lines.push('');
    lines.push(`- role: ${artifact.role || '-'}`);
    lines.push(`- routeStrategyHash: ${artifact.routeStrategyHash || '-'}`);
    if (artifact.routeStrategy?.focus) lines.push(`- routeFocus: ${artifact.routeStrategy.focus}`);
    lines.push(`- compilerHash: ${artifact.compilerHash || '-'}`);
    lines.push(`- feedbackLearningBridgeHash: ${artifact.feedbackLearningBridgeHash || '-'}`);
    lines.push(`- promptBudget: ${artifact.promptBudget?.compiledPromptCharCount ?? '-'} chars; hardExceeded=${artifact.promptBudget?.hardExceeded === true}`);
    lines.push(`- semanticLint: blockers=${artifact.semanticLint?.blockerCount ?? 0}; warnings=${artifact.semanticLint?.warningCount ?? 0}`);
    for (const sectionItem of artifact.sections || []) {
      if (!sectionItem.items?.length) continue;
      lines.push(`- ${sectionItem.title}: ${sectionItem.items.slice(0, 4).join(' | ')}`);
    }
    lines.push('');
  }
  lines.push('Safety: this report is local prompt compilation evidence only. It does not permit provider generation, upload, submit, IM, acceptance, payment, or deployment.');
  return lines.join('\n') + '\n';
}

export function promptArtifactCompilerSelftest() {
  const artifact = {
    index: 1,
    filename: '999-logo.jpg',
    role: 'finished_vi_board',
    prompt: 'Create a polished VI board.',
  };
  const modelLockedRetrieval = {
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
  };
  const compiler = compilePromptArtifact({
    artifact,
    workflowId: 'logo_brand',
    subject: { brandText: 'Yunqi Data', projectText: 'Yunqi Data LOGO', mustUseText: ['enterprise software platform'] },
    industrySpec: { id: 'general_technology_b2b', label: 'Technology B2B', domain: 'technology', applicationContexts: ['product dashboard'] },
    designReferenceSpec: {
      id: 'refpack_general_technology_b2b_v1',
      label: 'General technology',
      sourcePolicy: { use: 'structure_and_design_grammar_only', mustNotCopy: ['third-party marks'] },
      designGrammar: ['wordmark-first credibility'],
      negativePatterns: ['blue-purple gradient tech template'],
      qaBlockers: ['exact wordmark must work at 32px'],
      successPatterns: ['large wordmark plus application proof wins more often'],
      rejectedPatterns: ['empty dark embossed mockup'],
    },
    designReferenceRetrieval: {
      ...modelLockedRetrieval,
      selectedCandidate: {
        outcomeScore: {
          status: 'outcome_learning_warm',
          score: 67,
          counts: { caseCount: 2, learningSignalCount: 3 },
          recommendations: ['promote strong wordmark proof'],
        },
      },
    },
    routeContract: { contractHash: 'sha256:route', finalArtifactShape: 'image_set', expectedFinalFiles: 5 },
  });
  const recompiled = compilePromptArtifact({
    artifact: {
      ...artifact,
      prompt: compiler.compiledPrompt,
    },
    workflowId: 'logo_brand',
    subject: { brandText: 'Yunqi Data', projectText: 'Yunqi Data LOGO', mustUseText: ['enterprise software platform'] },
    industrySpec: { id: 'general_technology_b2b', label: 'Technology B2B', domain: 'technology', applicationContexts: ['product dashboard'] },
    designReferenceSpec: {
      id: 'refpack_general_technology_b2b_v1',
      label: 'General technology',
      sourcePolicy: { use: 'structure_and_design_grammar_only', mustNotCopy: ['third-party marks'] },
      designGrammar: ['wordmark-first credibility'],
      negativePatterns: ['blue-purple gradient tech template'],
      qaBlockers: ['exact wordmark must work at 32px'],
      successPatterns: ['large wordmark plus application proof wins more often'],
      rejectedPatterns: ['empty dark embossed mockup'],
    },
    designReferenceRetrieval: {
      ...modelLockedRetrieval,
      selectedCandidate: {
        outcomeScore: {
          status: 'outcome_learning_warm',
          score: 67,
          counts: { caseCount: 2, learningSignalCount: 3 },
          recommendations: ['promote strong wordmark proof'],
        },
      },
    },
    routeContract: { contractHash: 'sha256:route', finalArtifactShape: 'image_set', expectedFinalFiles: 5 },
  });
  const plan = refreshPromptCompilerForPlan({
    taskId: 999,
    workflowId: 'logo_brand',
    subject: { brandText: 'Yunqi Data', projectText: 'Yunqi Data LOGO', mustUseText: ['enterprise software platform'] },
    industrySpec: { id: 'general_technology_b2b', label: 'Technology B2B', domain: 'technology', applicationContexts: ['product dashboard'] },
    designReferenceSpec: {
      id: 'refpack_general_technology_b2b_v1',
      label: 'General technology',
      sourcePolicy: { use: 'structure_and_design_grammar_only', mustNotCopy: ['third-party marks'] },
      designGrammar: ['wordmark-first credibility'],
      negativePatterns: ['blue-purple gradient tech template'],
      qaBlockers: ['exact wordmark must work at 32px'],
    },
    designReferenceRetrieval: modelLockedRetrieval,
    routeContract: { contractHash: 'sha256:route', finalArtifactShape: 'image_set', expectedFinalFiles: 1 },
    prompts: [artifact],
  });
  const report = buildPromptCompilerReport(plan, { createdAt: '2026-06-14T00:00:00.000Z' });
  return {
    ok: compiler.compiledPrompt.includes('Design reference pack:')
      && compiler.compiledPrompt.includes('Outcome learning')
      && compiler.compiledPrompt.includes('outcome score: 67/100')
      && compiler.metrics.outcomeScore === 67
      && compiler.metrics.negativeConstraintCount >= 2
      && compiler.metrics.promptBudgetExceeded === false
      && compiler.promptBudget.hardExceeded === false
      && compiler.semanticLint.ok === true
      && compiler.compilerHash?.startsWith('sha256:')
      && compiler.compilerHash === recompiled.compilerHash
      && plan.promptCompiler?.promptCompilerHash?.startsWith('sha256:')
      && report.reportHash?.startsWith('sha256:')
      && report.safety.callsProviderOrModel === false,
    compiler,
    planHash: plan.promptCompiler?.promptCompilerHash || null,
    reportHash: report.reportHash || null,
  };
}
