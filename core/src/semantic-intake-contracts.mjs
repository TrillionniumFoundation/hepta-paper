import { digest } from './hash-utils.mjs';

export const SEMANTIC_INTAKE_CONTRACT_VERSION = 1;
export const SEMANTIC_INTAKE_VERSION = 5;
export const SEMANTIC_CONTRACT_VERSION = 1;

export const MODEL_PROVIDER_PROMPT_ONLY = 'prompt-only';
export const MODEL_PROVIDER_OPENCLAW = 'openclaw-model';

export const SUBJECT_CRITICAL_WORKFLOWS = Object.freeze([
  'logo_brand',
  'packaging_design',
  'catalog_brochure',
  'poster_design',
  'product_design',
  'naming_text',
]);

export const SEMANTIC_WORKFLOW_IDS = Object.freeze([
  'logo_brand',
  'packaging_design',
  'catalog_brochure',
  'poster_design',
  'product_design',
  'proposal_board',
  'naming_text',
  'presentation_deck',
  'sculpture_design',
  'human_feedback',
  'post_submission_revision',
  'acceptance_delivery_package',
  'generic_design',
]);

const SEMANTIC_WORKFLOW_ID_SET = new Set(SEMANTIC_WORKFLOW_IDS);

export const GENERIC_SUBJECT_RE = /^(?:待确认|待提炼项目名|未发现卖家页补充需求|更新升级|升级|优化|视觉形象|企业介绍|业务范围|品牌文化|相关介绍|具体情况|公司全新|现有|我需要|结构不限|设计|图案|字体|标志|商标|英文|中文|个人纯中文|政府(?:\（\+标准字\）)?|[\s/+，、:：\-.]+)$/i;

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function uniqueStrings(values = [], limit = 24) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = normalizeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function contractHash(value) {
  return digest(value).replace(/^sha256:/, '');
}

function issue(id, message, details = {}) {
  return { id, message, details };
}

export function normalizeSemanticWorkflowId(value, fallback = 'generic_design') {
  const workflowId = normalizeText(value || fallback);
  if (workflowId === 'post_submission_revision') return 'human_feedback';
  return SEMANTIC_WORKFLOW_ID_SET.has(workflowId) ? workflowId : fallback;
}

export function isGenericSubject(value) {
  const text = normalizeText(value)
    .replace(/[“”"'「」『』]/g, '')
    .replace(/^[-_.、\s]+/, '')
    .trim();
  if (!text) return true;
  if (/^\d+$/.test(text)) return text.length < 2 || text.length > 8;
  if (/待确认|待提炼|未发现卖家页补充需求/.test(text)) return true;
  if (/(?:不要|不需要|不用|禁用|只要|简单的|风景图|卡通图设计就好)/.test(text)) return true;
  if (text.length > 60) return true;
  if (GENERIC_SUBJECT_RE.test(text)) return true;
  if (/^(?:产品|品牌|企业|公司|项目|全套|产品全套|品牌全套|企业全套|公司全套)$/i.test(text)) return true;
  if (/^(?:全新)?(?:企业|品牌|公司)?\s*(?:LOGO|logo|VI)?\s*(?:设计|升级|更新|优化)?\s*(?:需求)?$/i.test(text)) return true;
  return false;
}

function cleanConstraintText(item) {
  const raw = normalizeText(typeof item === 'string' ? item : (item?.text || item?.quote || JSON.stringify(item)));
  if (!raw) return '';
  if (/^[^：:\n]{1,16}[：:]\s*$/.test(raw)) return '';
  const hasPlaceholder = /[XxＸｘ]{2,}|某{2,}|待定|待填|待补|占位/.test(raw);
  let text = raw
    .replace(/[XxＸｘ]{2,}/g, '')
    .replace(/某{2,}/g, '')
    .replace(/(?:待定|待填|待补|占位)/g, '')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[，,、；;：:。\s]+$/g, '')
    .trim();
  if (!text) return '';
  if (/[：:]\s*$/.test(text)) return '';
  if (hasPlaceholder) {
    const value = text.includes('：') || text.includes(':')
      ? text.split(/[：:]/).slice(1).join(':').trim()
      : text;
    if (!value || /^(?:红茶|茶叶|产品|品牌|名称|产地|地址|电话|邮箱|执行标准)$/.test(value)) return '';
  }
  return text;
}

export function normalizeBuyerConstraintList(values, limit = 16) {
  return uniqueStrings(Array.isArray(values) ? values.map(cleanConstraintText).filter(Boolean) : [], limit);
}

function semanticEvidenceText({ subject = {}, industryEvidence = [] } = {}) {
  return [
    subject.industryCue,
    subject.projectText,
    subject.productText,
    ...(subject.mustUseText || []),
    ...(industryEvidence || []).map((item) => item.quote || item.excerpt || item.text || item.signal || ''),
  ].filter(Boolean).join('\n');
}

export function semanticIndustryContradictionChecks({ industryId = null, subject = {}, industryEvidence = [] } = {}) {
  const checks = [];
  const evidenceText = semanticEvidenceText({ subject, industryEvidence });
  const hasCeramicDecalCharacterCue = /陶瓷贴花|日用品陶瓷|陶瓷(?:类)?产品|陶瓷杯|马克杯|杯子.{0,16}(?:贴花|卡通|图案)|ceramic decal/i.test(evidenceText)
    && /卡通形象|平面卡通|原创卡通|女孩|男孩|英文名|欧美儿童|青少年|character/i.test(evidenceText);
  if (hasCeramicDecalCharacterCue && industryId && industryId !== 'ceramic_decal_character_design') {
    checks.push({
      id: 'semantic_industry_evidence_contradiction_ceramic_decal_character',
      status: 'fail',
      blocking: true,
      notes: `buyer evidence is ceramic decal character design but model industryId=${industryId}`,
    });
  }
  return checks;
}

function normalizeBrandParenthetical(value) {
  return normalizeText(value).replace(/[（(]\s*([^）)]{1,16})\s*[）)]/g, '（$1）');
}

function splitModelBrandText(value) {
  return uniqueStrings(String(value || '')
    .split(/(?:[；;,，、/]+|\s+(?:和|及)\s+|(?:和|及)(?=[\u4e00-\u9fa5A-Za-z]))/g)
    .map((item) => String(item || '').replace(/[（(]\s*(?:可选小字|可选英文|英文小字|小字|可选)[^）)]{0,40}[）)]/gi, ''))
    .map((item) => normalizeText(item).replace(/[（(].*$/g, '').replace(/(?:设计需求|设计|需求|全套)$/g, '').replace(/[\s/+，、:：\-.]+$/g, '').trim())
    .filter((item) => item && !isGenericSubject(item)), 12);
}

function subjectCoverageText(subject = {}) {
  return [
    subject.projectText,
    subject.brandText,
    subject.productText,
    subject.industryCue,
    ...(subject.mustUseText || []),
  ].filter(Boolean).join('\n');
}

function subjectHasExplicitMultiLogoIntent(subject = {}, rawBrandText = '') {
  const text = [
    subject.projectText,
    rawBrandText,
    subject.legalName,
    ...(subject.mustUseText || []),
  ].filter(Boolean).join('\n');
  return /(?:两个|两款|两家|多款|多个|多家|双|分别|各自|每个项目|项目一|项目二|一、|二、).{0,20}(?:LOGO|logo|标志|商标|品牌)|(?:LOGO|logo|标志|商标|品牌).{0,20}(?:两个|两款|两家|多款|多个|多家|分别|各自|每个项目)/.test(text);
}

export function semanticSubjectNormalizationDriftCheck({ rawModelBrandText = '', normalizedBrandText = '', subject = {} } = {}) {
  const raw = normalizeText(rawModelBrandText);
  const normalized = normalizeText(normalizedBrandText);
  const comparableRaw = normalizeBrandParenthetical(raw);
  const comparableNormalized = normalizeBrandParenthetical(normalized);
  if (!raw || isGenericSubject(raw) || subject.iconOnlyLogo || normalized === raw || comparableNormalized === comparableRaw) return null;
  const rawBrands = splitModelBrandText(raw);
  const coverage = subjectCoverageText(subject);
  const compactCoverage = coverage.replace(/\s+/g, '');
  const multiBrandPreserved = rawBrands.length > 1 && rawBrands.every((brand) => {
    const compactBrand = brand.replace(/\s+/g, '');
    return coverage.includes(brand) || compactCoverage.includes(compactBrand);
  });
  if (multiBrandPreserved) {
    return {
      id: 'semantic_subject_normalization_multibrand_preserved',
      status: 'pass',
      blocking: false,
      notes: `model brandText ${raw} normalized to ${normalized || '<empty>'}; all ${rawBrands.length} brand tokens remain in project/mustUse text`,
    };
  }
  return {
    id: 'semantic_subject_normalization_drift',
    status: 'fail',
    blocking: true,
    notes: `model brandText ${raw} was changed to ${normalized || '<empty>'} during normalization`,
  };
}

export function semanticIntakeNeedsModelRetry(semanticIntake = {}) {
  if (!semanticIntake || semanticIntake.provider !== MODEL_PROVIDER_OPENCLAW) return { retry: false, reason: null };
  const workflowId = semanticIntake.taskUnderstanding?.workflowId || '';
  const workflowCheck = (semanticIntake.checks || []).find((item) => item.id === 'semantic_workflow_understanding');
  const notes = String(workflowCheck?.notes || '');
  if (!workflowId || /missing_model_workflow/.test(notes)) {
    return { retry: true, reason: 'missing_model_workflow', workflowId: workflowId || null, notes };
  }
  if (workflowId === 'generic_design') {
    if (/generic_actionable_route_contract/.test(notes)) return { retry: false, reason: null, workflowId, notes };
    return { retry: true, reason: 'generic_model_workflow', workflowId, notes };
  }
  return { retry: false, reason: null, workflowId, notes };
}

function extractExplicitBrandFromSemanticConstraints(semantic = {}) {
  const lines = Array.isArray(semantic.mustUseText) ? semantic.mustUseText : [];
  for (const line of lines) {
    const match = String(line || '').match(/(?:品牌名称|品牌名|品牌|LOGO名称|logo名称|名称)\s*[：:\s]+([A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5 .&+\-]{1,24})/i);
    if (!match) continue;
    const cleaned = normalizeText(match[1])
      .replace(/[，,。；;].*$/, '')
      .replace(/\s*(?:设计格式|要求|需要|不要|不需要).*$/, '')
      .trim();
    if (/^\d{2,8}$/.test(cleaned)) return cleaned;
    if (cleaned && !isGenericSubject(cleaned)) return cleaned;
  }
  return null;
}

export function mergeSemanticSubject(ruleSubject = {}, semanticIntake = {}, workflowId = null) {
  const semantic = semanticIntake.subject || {};
  const critical = SUBJECT_CRITICAL_WORKFLOWS.includes(workflowId || semanticIntake.taskUnderstanding?.workflowId);
  const modelBacked = semanticIntake.provider === MODEL_PROVIDER_OPENCLAW;
  const semanticConstraintBrand = extractExplicitBrandFromSemanticConstraints(semantic);
  const semanticMain = normalizeText(semantic.brandText || semantic.productText || semantic.projectText || '');
  const ruleMain = normalizeText(ruleSubject.brandText || ruleSubject.productText || ruleSubject.projectText || '');
  const useSemantic = semanticMain && (modelBacked || !ruleMain || isGenericSubject(ruleMain) || critical);
  const projectText = useSemantic ? semanticMain : (ruleMain || semanticMain || '待提炼项目名');
  const semanticBrand = normalizeText(semantic.brandText || '');
  const ruleBrand = normalizeText(ruleSubject.brandText || '');
  const brandText = modelBacked
    ? (semanticBrand || semanticConstraintBrand || null)
    : (semanticBrand
      || (!semantic.iconOnlyLogo && ruleBrand && !isGenericSubject(ruleBrand) ? ruleSubject.brandText : null)
      || (workflowId === 'logo_brand' && !semantic.iconOnlyLogo ? projectText : null));
  return {
    ...ruleSubject,
    projectText,
    brandText,
    productText: modelBacked ? (semantic.productText || null) : (semantic.productText || ruleSubject.productText || null),
    mustUseText: modelBacked
      ? normalizeBuyerConstraintList([...(semantic.mustUseText || [])], 16)
      : normalizeBuyerConstraintList([...(ruleSubject.mustUseText || []), ...(semantic.mustUseText || [])], 16),
    forbiddenText: modelBacked
      ? normalizeBuyerConstraintList([...(semantic.forbiddenText || [])], 16)
      : normalizeBuyerConstraintList([...(ruleSubject.forbiddenText || []), ...(semantic.forbiddenText || [])], 16),
    audienceText: modelBacked ? null : (ruleSubject.audienceText || null),
    industryText: semantic.industryCue || ruleSubject.industryText || null,
    sourceFields: uniqueStrings([...(ruleSubject.sourceFields || []), 'semantic-intake'], 12),
    semanticLegalName: semantic.legalName || null,
    semanticAction: semantic.action || semanticIntake.taskUnderstanding?.action || null,
    semanticIndustryId: semantic.industryId || semanticIntake.taskUnderstanding?.industryId || null,
    semanticIndustryCue: semantic.industryCue || null,
    semanticIndustryConfidence: semanticIntake.taskUnderstanding?.industryConfidence ?? null,
    iconOnlyLogo: !!semantic.iconOnlyLogo,
    descriptiveSubjectEvidence: semantic.descriptiveSubjectEvidence || null,
  };
}

export function semanticWorkflowOverride({ ruleKind, semanticIntake, manualKind = false } = {}) {
  if (manualKind) return { kind: ruleKind, changed: false, reason: 'manual kind override' };
  const semanticWorkflow = semanticIntake?.taskUnderstanding?.workflowId || null;
  if (semanticWorkflow && semanticIntake?.provider === MODEL_PROVIDER_OPENCLAW) {
    if (semanticWorkflow !== ruleKind) {
      return { kind: semanticWorkflow, changed: true, reason: 'model semantic workflow primary ' + ruleKind + ' -> ' + semanticWorkflow };
    }
    return { kind: semanticWorkflow, changed: false, reason: 'model semantic workflow primary; rule audit agreed' };
  }
  return { kind: ruleKind, changed: false, reason: 'rule workflow retained' };
}

export function semanticIntakeBlocksPlanning(semanticIntake, { allowReview = false, allowPromptOnly = false } = {}) {
  if (!semanticIntake) return { blocked: true, reason: 'semantic intake missing' };
  const workflowId = semanticIntake.taskUnderstanding?.workflowId || '';
  const workflowCheck = (semanticIntake.checks || []).find((item) => item.id === 'semantic_workflow_understanding');
  if (
    semanticIntake.provider === MODEL_PROVIDER_OPENCLAW
    && (!workflowId || (workflowId === 'generic_design' && /missing_model_workflow/.test(String(workflowCheck?.notes || ''))))
  ) {
    return {
      blocked: true,
      reason: 'model semantic intake did not return an explicit workflowId; regex fallback is disabled',
    };
  }
  if (!allowPromptOnly && SUBJECT_CRITICAL_WORKFLOWS.includes(workflowId) && semanticIntake.provider !== MODEL_PROVIDER_OPENCLAW) {
    return {
      blocked: true,
      reason: 'subject-critical workflow requires model semantic intake; provider=' + (semanticIntake.provider || '<missing>'),
    };
  }
  if (semanticIntake.decision === 'fail') {
    return {
      blocked: true,
      reason: semanticIntake.checks?.filter((item) => item.blocking !== false && item.status === 'fail').map((item) => item.id + ': ' + item.notes).join('; ') || 'semantic intake failed',
    };
  }
  if (semanticIntake.decision === 'review' && !allowReview) {
    return {
      blocked: true,
      reason: semanticIntake.checks?.filter((item) => item.blocking !== false && item.status !== 'pass').map((item) => item.id + ': ' + item.notes).join('; ') || 'semantic intake needs review',
    };
  }
  return { blocked: false, reason: null };
}

function semanticSubjectPayload(subject = {}) {
  return {
    projectText: normalizeText(subject.projectText || subject.literalText || ''),
    brandText: normalizeText(subject.brandText || ''),
    productText: normalizeText(subject.productText || ''),
    legalName: normalizeText(subject.legalName || subject.semanticLegalName || ''),
    iconOnlyLogo: !!subject.iconOnlyLogo,
    mustUseText: uniqueStrings(subject.mustUseText || [], 32),
    forbiddenText: uniqueStrings(subject.forbiddenText || [], 32),
    industryCue: normalizeText(subject.industryCue || subject.industryText || ''),
    descriptiveSubjectEvidence: normalizeText(subject.descriptiveSubjectEvidence || ''),
  };
}

export function semanticContractRequired(workflowId) {
  return SUBJECT_CRITICAL_WORKFLOWS.includes(String(workflowId || ''));
}

export function semanticOperatorHardDoAccepted(source = {}) {
  const contract = source?.semanticContract || source || {};
  const payload = contract.payload || {};
  const override = source?.semanticOperatorOverride
    || source?.operatorSemanticOverride
    || source?.operatorOverride
    || contract.operatorOverride
    || payload.operatorOverride
    || null;
  const workflowId = source?.workflowId || contract.workflowId || payload.workflowId || null;
  const subject = source?.subject || contract.subject || payload.subject || {};
  const subjectText = [
    subject.projectText,
    subject.productText,
    ...(subject.mustUseText || []),
    ...(subject.forbiddenText || []),
  ].map((item) => String(item || '')).join('\n');
  const noInventedClaims = /(?:不得|禁止).*(?:虚构|自行).*(?:品牌|二维码|电话|地址|价格)/.test(subjectText)
    || /(?:不得|禁止).*(?:品牌名|活动名|价格|二维码|电话|地址|社交账号|促销)/.test(subjectText);
  return Boolean(
    override?.status === 'operator_hard_do_pass'
    && override?.scope === 'generic_livestream_background'
    && workflowId === 'poster_design'
    && /直播背景图/.test(subjectText)
    && noInventedClaims
  );
}

export function semanticIntakeAcceptedForGate({ plan = null, manifest = null } = {}) {
  if (semanticOperatorHardDoAccepted(plan) || semanticOperatorHardDoAccepted(manifest)) return true;
  const intake = plan?.semanticIntake || manifest?.semanticIntake || null;
  return Boolean(intake?.provider === MODEL_PROVIDER_OPENCLAW && intake.decision === 'pass');
}

export function buildSemanticContract({ plan = {}, semanticIntake = plan?.semanticIntake || null } = {}) {
  const workflowId = plan?.workflowId || semanticIntake?.taskUnderstanding?.workflowId || null;
  const subject = plan?.subject || semanticIntake?.subject || {};
  const payload = {
    version: SEMANTIC_CONTRACT_VERSION,
    taskId: String(plan?.taskId || ''),
    orderId: String(plan?.orderId || ''),
    workflowId,
    provider: semanticIntake?.provider || null,
    decision: semanticIntake?.decision || null,
    model: semanticIntake?.model || null,
    semanticVersion: semanticIntake?.version || null,
    semanticCreatedAt: semanticIntake?.createdAt || null,
    action: semanticIntake?.taskUnderstanding?.action || subject.semanticAction || null,
    confidence: Number.isFinite(Number(semanticIntake?.taskUnderstanding?.confidence)) ? Number(semanticIntake.taskUnderstanding.confidence) : null,
    subject: semanticSubjectPayload(subject),
    blockedTerms: uniqueStrings(semanticIntake?.blockedTerms || [], 32),
    attachmentSpecHash: plan?.attachmentSpec?.hash || null,
    industryId: plan?.industrySpec?.id || null,
    designReferenceId: plan?.designReferenceSpec?.id || null,
    submitRoute: plan?.submitLimitSpec?.route || plan?.deliverableSpec?.submitLimitRoute || null,
    operatorOverride: plan?.semanticOperatorOverride || semanticIntake?.operatorOverride || null,
  };
  const hashPayload = { ...payload, semanticCreatedAt: null };
  return {
    version: SEMANTIC_CONTRACT_VERSION,
    required: semanticContractRequired(workflowId),
    provider: payload.provider,
    decision: payload.decision,
    workflowId,
    taskId: payload.taskId || null,
    orderId: payload.orderId || null,
    subject: payload.subject,
    attachmentSpecHash: payload.attachmentSpecHash,
    industryId: payload.industryId,
    designReferenceId: payload.designReferenceId,
    operatorOverride: payload.operatorOverride,
    sourceHash: contractHash(hashPayload),
    payload,
  };
}

export function normalizeSemanticIntakeContract({ plan = {}, semanticIntake = plan?.semanticIntake || null } = {}) {
  const workflowId = plan?.workflowId || semanticIntake?.taskUnderstanding?.workflowId || null;
  const contract = {
    version: SEMANTIC_INTAKE_CONTRACT_VERSION,
    kind: 'SemanticIntakeContract',
    workflowId,
    provider: semanticIntake?.provider || null,
    decision: semanticIntake?.decision || null,
    model: semanticIntake?.model || null,
    taskUnderstanding: {
      workflowId,
      confidence: Number.isFinite(Number(semanticIntake?.taskUnderstanding?.confidence)) ? Number(semanticIntake.taskUnderstanding.confidence) : null,
      action: semanticIntake?.taskUnderstanding?.action || null,
      industryId: semanticIntake?.taskUnderstanding?.industryId || semanticIntake?.subject?.industryId || null,
      industryConfidence: Number.isFinite(Number(semanticIntake?.taskUnderstanding?.industryConfidence)) ? Number(semanticIntake.taskUnderstanding.industryConfidence) : null,
    },
    subject: semanticSubjectPayload(plan?.subject || semanticIntake?.subject || {}),
    blockedTerms: uniqueStrings(semanticIntake?.blockedTerms || [], 32),
    checks: (semanticIntake?.checks || []).map((item) => ({
      id: normalizeText(item.id || ''),
      status: normalizeText(item.status || ''),
      blocking: item.blocking !== false,
      notes: normalizeText(item.notes || '') || null,
    })).filter((item) => item.id),
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
  return {
    ...contract,
    contractHash: digest(contract),
  };
}

export function validatePlanSemanticContract(plan = {}) {
  const workflowId = plan?.workflowId || plan?.semanticIntake?.taskUnderstanding?.workflowId || '';
  if (!semanticContractRequired(workflowId)) {
    return { ok: true, required: false, issues: [], expected: buildSemanticContract({ plan }) };
  }
  const expected = buildSemanticContract({ plan });
  const issues = [];
  const intake = plan?.semanticIntake || null;
  const operatorAccepted = semanticOperatorHardDoAccepted(plan);
  if (!intake) {
    issues.push(issue('semantic_intake_missing', 'subject-critical plan is missing semanticIntake'));
  } else {
    if (intake.provider !== MODEL_PROVIDER_OPENCLAW && !operatorAccepted) issues.push(issue('semantic_intake_provider_not_model', 'subject-critical semantic intake must use openclaw-model', { provider: intake.provider || null }));
    if (intake.decision !== 'pass' && !operatorAccepted) issues.push(issue('semantic_intake_not_pass', 'subject-critical semantic intake must be pass', { decision: intake.decision || null }));
  }
  if (!plan?.semanticContract?.sourceHash) {
    issues.push(issue('semantic_contract_missing', 'production plan is missing semanticContract.sourceHash'));
  } else if (plan.semanticContract.sourceHash !== expected.sourceHash) {
    issues.push(issue('semantic_contract_stale', 'production plan semanticContract does not match current semantic intake/plan payload', { expected: expected.sourceHash, actual: plan.semanticContract.sourceHash }));
  }
  return { ok: issues.length === 0, required: true, issues, expected };
}

export function validateGenerationSemanticContract({ plan = null, manifest = null, includeRequests = true } = {}) {
  const workflowId = plan?.workflowId || manifest?.workflowId || plan?.semanticIntake?.taskUnderstanding?.workflowId || '';
  if (!semanticContractRequired(workflowId)) return { ok: true, required: false, issues: [], expected: plan ? buildSemanticContract({ plan }) : null };
  const issues = [];
  const planGate = plan ? validatePlanSemanticContract(plan) : null;
  if (planGate && !planGate.ok) issues.push(...planGate.issues);
  const expectedHash = planGate?.expected?.sourceHash || plan?.semanticContract?.sourceHash || null;
  const manifestHash = manifest?.semanticContract?.sourceHash || manifest?.semanticContractHash || null;
  const operatorAccepted = semanticOperatorHardDoAccepted(plan) || semanticOperatorHardDoAccepted(manifest);
  if (!plan && manifest?.semanticContract) {
    if (manifest.semanticContract.provider !== MODEL_PROVIDER_OPENCLAW && !operatorAccepted) {
      issues.push(issue('semantic_contract_manifest_provider_not_model', 'manifest semantic contract must come from openclaw-model semantic intake', { provider: manifest.semanticContract.provider || null }));
    }
    if (manifest.semanticContract.decision !== 'pass' && !operatorAccepted) {
      issues.push(issue('semantic_contract_manifest_not_pass', 'manifest semantic contract must record a pass decision', { decision: manifest.semanticContract.decision || null }));
    }
  }
  if (!manifestHash) {
    issues.push(issue('semantic_contract_generation_lock_missing', 'generation manifest is missing the semantic contract hash captured at generation time'));
  } else if (expectedHash && manifestHash !== expectedHash) {
    issues.push(issue('semantic_contract_generation_lock_stale', 'generation manifest semantic contract hash differs from the current production plan', { expected: expectedHash, actual: manifestHash }));
  }
  if (includeRequests && manifestHash) {
    const badRequests = (manifest?.requests || [])
      .filter((request) => request?.semanticContractHash !== manifestHash)
      .map((request) => request.id || request.filename || '<unknown>');
    if (badRequests.length) {
      issues.push(issue('semantic_contract_request_lock_stale', 'one or more generation requests do not carry the manifest semantic contract hash', { requests: badRequests.slice(0, 20) }));
    }
  }
  return { ok: issues.length === 0, required: true, issues, expectedHash, manifestHash };
}

export function semanticContractPackageChecks({ plan = null, manifest = null } = {}) {
  if (!manifest && plan) {
    const planGate = validatePlanSemanticContract(plan);
    if (!planGate.required) {
      return [{ id: 'semantic_contract_not_required', status: 'pass', label: 'Semantic contract lock is not required for this workflow.', notes: 'not subject-critical workflow', blocking: true }];
    }
    if (planGate.ok) {
      return [{ id: 'semantic_contract_plan_current', status: 'pass', label: 'Production plan is locked to the current model semantic intake.', notes: planGate.expected?.sourceHash || null, blocking: true }];
    }
    return planGate.issues.map((item) => ({
      id: item.id,
      status: 'fail',
      label: 'Production plan is locked to the current model semantic intake.',
      notes: item.message + (item.details && Object.keys(item.details).length ? ': ' + JSON.stringify(item.details) : ''),
      blocking: true,
    }));
  }
  const gate = validateGenerationSemanticContract({ plan, manifest, includeRequests: true });
  if (!gate.required) {
    return [{ id: 'semantic_contract_not_required', status: 'pass', label: 'Semantic contract lock is not required for this workflow.', notes: 'not subject-critical workflow', blocking: true }];
  }
  if (gate.ok) {
    return [{ id: 'semantic_contract_generation_lock_current', status: 'pass', label: 'Generation manifest is locked to the current model semantic intake.', notes: gate.manifestHash || gate.expectedHash || null, blocking: true }];
  }
  return gate.issues.map((item) => ({
    id: item.id,
    status: 'fail',
    label: 'Generation manifest is locked to the current model semantic intake.',
    notes: item.message + (item.details && Object.keys(item.details).length ? ': ' + JSON.stringify(item.details) : ''),
    blocking: true,
  }));
}

export function semanticIntakeContractsSelftest() {
  const ceramicBriefSubject = {
    projectText: '2个用于陶瓷贴花的原创平面卡通形象',
    productText: '陶瓷贴花原创卡通形象',
    industryCue: '日用品陶瓷制造及销售公司',
    mustUseText: [
      '需要设计2个用于陶瓷贴花使用的原创平面卡通形象',
      '一个适合女孩的形象，一个适合男孩的形象',
      '为两个卡通形象冠上英文名',
    ],
  };
  const wrongIndustry = semanticIndustryContradictionChecks({
    industryId: 'home_furniture_bedding',
    subject: ceramicBriefSubject,
    industryEvidence: [{ quote: '我们是一家从事日用品陶瓷制造及销售公司，需要设计2个用于陶瓷贴花使用的原创平面卡通形象。' }],
  });
  const multiBrandPreserved = semanticSubjectNormalizationDriftCheck({
    rawModelBrandText: '零卡；零卡CK；维锐普 veripeix',
    normalizedBrandText: '零卡',
    subject: {
      projectText: '为零卡/零卡CK和维锐普 veripeix复印纸外包装、整箱盒子外观',
      brandText: '零卡',
      productText: 'A4/A5/A3规格复印纸单品外包装和整箱盒子',
      mustUseText: ['注册商标:零卡CK', '品牌:维锐普 veripeix', '维锐普 veripeix需要中英文两版'],
    },
  });
  const singleBrandLost = semanticSubjectNormalizationDriftCheck({
    rawModelBrandText: '维锐普 veripeix',
    normalizedBrandText: '零卡',
    subject: {
      projectText: '零卡复印纸包装',
      brandText: '零卡',
      productText: 'A4复印纸包装',
      mustUseText: ['注册商标:零卡CK'],
    },
  });
  const plan = {
    taskId: 1,
    orderId: 'o1',
    workflowId: 'logo_brand',
    subject: { projectText: '测试品牌', brandText: '测试品牌' },
    semanticIntake: {
      version: 2,
      provider: MODEL_PROVIDER_OPENCLAW,
      decision: 'pass',
      taskUnderstanding: { workflowId: 'logo_brand', confidence: 0.9, action: 'brand_new' },
      subject: { projectText: '测试品牌', brandText: '测试品牌', mustUseText: ['测试品牌'], forbiddenText: [] },
      blockedTerms: ['更新升级'],
      createdAt: '2026-05-17T00:00:00.000Z',
    },
    attachmentSpec: { hash: 'att1' },
    industrySpec: { id: 'general_business_service' },
    designReferenceSpec: { id: 'refpack_general_business_service_v1' },
  };
  plan.semanticContract = buildSemanticContract({ plan });
  const manifest = {
    workflowId: 'logo_brand',
    semanticContract: plan.semanticContract,
    semanticContractHash: plan.semanticContract.sourceHash,
    requests: [{ id: 'r1', semanticContractHash: plan.semanticContract.sourceHash }],
  };
  const passed = validateGenerationSemanticContract({ plan, manifest });
  const stale = validateGenerationSemanticContract({ plan, manifest: { ...manifest, semanticContractHash: 'wrong', semanticContract: { sourceHash: 'wrong' } } });
  const retry = semanticIntakeNeedsModelRetry({
    provider: MODEL_PROVIDER_OPENCLAW,
    taskUnderstanding: { workflowId: 'generic_design' },
    checks: [{ id: 'semantic_workflow_understanding', notes: 'generic_model_workflow_requires_review' }],
  });
  const block = semanticIntakeBlocksPlanning({
    provider: MODEL_PROVIDER_PROMPT_ONLY,
    decision: 'pass',
    taskUnderstanding: { workflowId: 'logo_brand' },
    checks: [],
  });
  const intakeContract = normalizeSemanticIntakeContract({ plan });
  const ok = wrongIndustry.some((item) => item.id === 'semantic_industry_evidence_contradiction_ceramic_decal_character' && item.status === 'fail' && item.blocking)
    && multiBrandPreserved?.id === 'semantic_subject_normalization_multibrand_preserved'
    && singleBrandLost?.id === 'semantic_subject_normalization_drift'
    && passed.ok
    && !stale.ok
    && stale.issues.some((item) => item.id === 'semantic_contract_generation_lock_stale')
    && retry.retry
    && block.blocked
    && intakeContract.contractHash?.startsWith('sha256:');
  return {
    ok,
    wrongIndustry,
    multiBrandPreserved,
    singleBrandLost,
    passed,
    stale,
    retry,
    block,
    intakeContract,
    semanticContractHash: plan.semanticContract.sourceHash,
  };
}
