import path from 'node:path';
import { digest } from './hash-utils.mjs';
import {
  buildStructuredQaBlockers,
  summarizeStructuredQaBlockers,
} from './structured-qa-blocker-contracts.mjs';

export const SEMANTIC_VISUAL_REFEREE_CONTRACT_VERSION = 1;

export const SEMANTIC_VISUAL_REFEREE_SAFETY = Object.freeze({
  localContractOnly: true,
  readsFiles: false,
  writesFiles: false,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  uploads: false,
  submits: false,
  sendsMessages: false,
  acceptsDelivery: false,
  pays: false,
  grantsExecutionPermission: false,
});

export const SEMANTIC_VISUAL_REFEREE_CHECK_IDS = Object.freeze([
  'semantic_subject_lock',
  'semantic_brand_text_accuracy',
  'semantic_industry_fit',
  'semantic_reference_negative_patterns',
  'semantic_application_scene_fit',
  'semantic_professional_finish',
  'semantic_template_filler_absence',
]);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif']);
const POSTER_NON_VISIBLE_CONSTRAINT_RE = /横版|竖版|横向|竖向|横幅|横屏|竖屏|延展|主\s*KV|KV|KT\s*板|墙头|遮挡|20\s*米|20m|2\.2\s*米|2\.2m|海报图两边|主画面|排版|设计方案|海报方案|工厂车间|用途|用于|尺寸|长\s*\d|宽\s*\d/i;
const POSTER_DELIVERABLE_ONLY_RE = /^(?:主题为)?(?:电商)?(?:横版|竖版|横向|竖向|横幅|横屏|竖屏|延展)?(?:主\s*)?K?V?海报(?:设计|方案)?$/i;

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function semanticVisualRefereeArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== '');
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

export function compactSemanticVisualRefereeArray(values, limit = 8) {
  return (Array.isArray(values) ? values : [])
    .map((item) => typeof item === 'string' ? item : (item?.label || item?.id || item?.notes || ''))
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

export function semanticVisualRefereeUniqueFiles(files, { imageOnly = false, limit = null } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of semanticVisualRefereeArray(files)) {
    const file = typeof raw === 'string' ? raw : (raw?.path || raw?.file || raw?.filename || '');
    if (!file) continue;
    const normalized = path.resolve(String(file));
    if (imageOnly && !IMAGE_EXTENSIONS.has(path.extname(normalized).toLowerCase())) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (limit && out.length >= limit) break;
  }
  return out;
}

function semanticSubjectForContract(contract = {}) {
  return contract?.semanticIntake?.subject
    || contract?.semanticContract?.subject
    || contract?.semanticContract?.payload?.subject
    || {};
}

function subjectForContract(contract = {}) {
  return contract?.semanticIntake?.subject || contract?.subject || {};
}

function contractTextHaystack(contract = {}) {
  const subject = subjectForContract(contract);
  const semanticSubject = semanticSubjectForContract(contract);
  return [
    contract?.requirementExcerpt,
    contract?.title,
    semanticSubject.legalName,
    subject.legalName,
    subject.semanticLegalName,
    ...(Array.isArray(semanticSubject.mustUseText) ? semanticSubject.mustUseText : []),
    ...(Array.isArray(subject.mustUseText) ? subject.mustUseText : []),
  ].filter(Boolean).join('\n');
}

export function allowsBuyerSuppliedProductionInfo(contract) {
  if (contract?.workflowId !== 'packaging_design') return false;
  return /(?:文字)?生产信息不变|保留.{0,12}(?:生产信息|公司信息|公司名|公司名称|企业名|企业名称|条码|条形码|执行标准|生产商|地址|电话|许可证|货号|保质期|有效期)|(?:公司信息|公司名|公司名称|企业名|企业名称|条码|条形码|执行标准|生产商|地址|电话|许可证|货号|保质期|有效期).{0,12}(?:不变|保留|照旧|按原|包含|体现)|我们是.{0,40}公司|(?:必须|需要|要求|包含|采用|使用|体现|突出|保留).{0,18}(?:公司信息|公司名|公司名称|企业名|企业名称|协会|官方合作品牌|官方授权|认证|资质|许可证|专利成分|执行标准)/i.test(contractTextHaystack(contract));
}

export const packagingBuyerProductionInfoAllowed = allowsBuyerSuppliedProductionInfo;

export function buyerSuppliedPackagingText(contract) {
  if (contract?.workflowId !== 'packaging_design') return [];
  const subject = subjectForContract(contract);
  const semanticSubject = semanticSubjectForContract(contract);
  const legalName = semanticSubject.legalName || subject.legalName || subject.semanticLegalName || '';
  const haystack = [
    contract?.requirementExcerpt,
    legalName,
    ...(Array.isArray(semanticSubject.mustUseText) ? semanticSubject.mustUseText : []),
    ...(Array.isArray(subject.mustUseText) ? subject.mustUseText : []),
  ].filter(Boolean).join('\n');
  return [...new Set([
    legalName,
    ...String(haystack || '')
      .split(/[\n。；;]/)
      .map((line) => line.trim())
      .filter((line) => /产品名[称稱]|卖点|賣點|公司信息|公司名|公司名称|企业名|企业名称|我们是.{0,40}公司|生产商|厂家|官方合作品牌|官方授权|协会|认证|资质|许可证|专利成分|执行标准|抗牙结石|牙周护理|功效型牙膏/i.test(line)),
  ].filter(Boolean).slice(0, 8))];
}

export function packagingBuyerSizeSpecText(contract) {
  if (contract?.workflowId !== 'packaging_design') return [];
  const subject = subjectForContract(contract);
  const semanticSubject = semanticSubjectForContract(contract);
  const haystack = [
    contract?.requirementExcerpt,
    ...(Array.isArray(semanticSubject.mustUseText) ? semanticSubject.mustUseText : []),
    ...(Array.isArray(subject.mustUseText) ? subject.mustUseText : []),
  ].filter(Boolean).join('\n');
  return [...new Set(String(haystack || '')
    .split(/[\n。；;]/)
    .map((line) => line.trim())
    .filter((line) => /(?:规格|容量|净含量|克重|尺寸|SKU|品项|瓶器|瓶型|面霜|面膜|精华|精油|乳液|水乳|喷头|dropper|jar|bottle|tube|box)|\b\d+(?:\.\d+)?\s*(?:g|kg|ml|mL|ML|L|oz)\b/i.test(line))
    .slice(0, 8))];
}

export function blankBuyerContactLabels(textValue) {
  const labels = [];
  for (const line of String(textValue || '').split(/\r?\n/)) {
    const match = line.match(/^\s*((?:公司)?(?:邮箱|电话|手机号|联系方式)|email|e-?mail|phone|tel)\s*[：:]\s*(.*)$/i);
    if (!match) continue;
    const value = String(match[2] || '').trim();
    if (!value) labels.push(match[1]);
  }
  return [...new Set(labels)];
}

export function buyerContactValuePolicy(contract) {
  const subject = subjectForContract(contract);
  const semanticSubject = semanticSubjectForContract(contract);
  const requirementText = [
    contract?.requirementExcerpt,
    ...(Array.isArray(subject.mustUseText) ? subject.mustUseText : []),
    ...(Array.isArray(semanticSubject.mustUseText) ? semanticSubject.mustUseText : []),
  ].filter(Boolean).join('\n');
  const blankLabels = blankBuyerContactLabels(requirementText);
  return {
    blankLabels,
    allowMissingBlankContactValues: blankLabels.length > 0,
  };
}

export function hasPosterContentPreservation(contract) {
  if (contract?.workflowId !== 'poster_design') return false;
  const subject = subjectForContract(contract);
  const semanticSubject = semanticSubjectForContract(contract);
  const haystack = [
    contract?.title,
    contract?.requirementExcerpt,
    ...(Array.isArray(subject.mustUseText) ? subject.mustUseText : []),
    ...(Array.isArray(semanticSubject.mustUseText) ? semanticSubject.mustUseText : []),
  ].filter(Boolean).join('\n');
  return /不改变内容|内容不变|保留(?:原有|现有)?.{0,8}(?:内容|文案|文字|信息)|原(?:图|稿|设计|海报).{0,8}(?:内容|文案|文字|信息)|原设计|原图|附件|优化图文排版|延展海报|电商详情页/i.test(haystack);
}

export function cleanPosterVisibleSubjectText(value) {
  return String(value || '')
    .replace(/(?:^|[\/／|｜\-\s]+)(?:电商)?(?:横版|竖版|横向|竖向|横幅|横屏|竖屏|延展)?(?:主\s*)?K?V?海报(?:设计|方案)?(?:（[^）]*）)?/gi, '')
    .replace(/(?:电商)?(?:横版|竖版|横向|竖向|横幅|横屏|竖屏|延展)?(?:主\s*)?K?V?海报(?:设计|方案)?/gi, '')
    .replace(/(?:横版|竖版|横向|竖向|横幅|横屏|竖屏|延展|主\s*KV|KV|KT\s*板|墙头|遮挡|20\s*米|20m|2\.2\s*米|2\.2m|电商海报|排版|主画面|海报图两边|设计方案|海报方案)/gi, '')
    .replace(/(?:主题)?海报(?:设计)?$/gi, '')
    .replace(/主题/g, '')
    .replace(/[（）()【】\[\]：:；;，,\s]+$/g, '')
    .replace(/^[（）()【】\[\]：:；;，,\s]+/g, '')
    .trim();
}

export function splitPosterVisibleCopyConstraints(contract, items) {
  const raw = semanticVisualRefereeArray(items).map((item) => String(item || '').trim()).filter(Boolean);
  if (contract?.workflowId !== 'poster_design') return { visible: raw, nonVisible: [] };
  const visible = [];
  const nonVisible = [];
  for (const item of raw) {
    if (POSTER_DELIVERABLE_ONLY_RE.test(item) || POSTER_NON_VISIBLE_CONSTRAINT_RE.test(item)) nonVisible.push(item);
    else visible.push(item);
  }
  return { visible, nonVisible };
}

export function normalizeVisualConstraintText(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .replace(/的/g, '')
    .replace(/[\s\u200b\u200c\u200d\ufeff"'“”‘’「」『』《》〈〉（）()\[\]{}:：,，.。;；!！?？、/\\|_-]+/g, '')
    .toLowerCase();
}

export function filterForbiddenAgainstVisibleMustUse(forbiddenItems = [], visibleMustUseItems = []) {
  const visibleNorms = semanticVisualRefereeArray(visibleMustUseItems).map(normalizeVisualConstraintText).filter(Boolean);
  return semanticVisualRefereeArray(forbiddenItems).filter((item) => {
    const norm = normalizeVisualConstraintText(item);
    if (!norm) return false;
    return !visibleNorms.some((visible) => visible.includes(norm) || norm.includes(visible));
  });
}

export function posterVisibleSubject(input, maybeContract = null) {
  const contract = maybeContract || input;
  const subject = maybeContract ? (input || {}) : subjectForContract(input);
  if (contract?.workflowId !== 'poster_design') return subject || {};
  const cleanedProduct = cleanPosterVisibleSubjectText(subject.productText || subject.projectText || '');
  const cleanedProject = cleanPosterVisibleSubjectText(subject.projectText || subject.productText || '');
  const cleanedDeliverable = cleanPosterVisibleSubjectText(subject.deliverableText || '');
  return {
    ...subject,
    projectText: cleanedProject || subject.projectText || null,
    productText: cleanedProduct || subject.productText || null,
    deliverableText: cleanedDeliverable || subject.deliverableText || null,
  };
}

function attachmentFiles(contract, keys) {
  const spec = contract?.attachmentSpec || {};
  return keys.flatMap((key) => (
    Array.isArray(spec[key])
      ? spec[key].map((item) => item?.path || item)
      : []
  ));
}

export function posterSemanticReferenceFiles(contract, { limit = 3, imageOnly = true, requireContentPreservation = true } = {}) {
  if (contract?.workflowId !== 'poster_design') return [];
  if (requireContentPreservation && !hasPosterContentPreservation(contract)) return [];
  return semanticVisualRefereeUniqueFiles(attachmentFiles(contract, [
    'semanticReferenceImages',
    'referenceImages',
    'semanticReferenceFiles',
    'referenceFiles',
  ]), { imageOnly, limit });
}

export function posterContentPreservationPolicy(contract, options = {}) {
  const files = posterSemanticReferenceFiles(contract, {
    limit: options.limit ?? 3,
    imageOnly: options.imageOnly ?? true,
    requireContentPreservation: options.requireContentPreservation ?? true,
  });
  const enabled = hasPosterContentPreservation(contract);
  return {
    enabled,
    sourceReferenceFiles: files.map((file) => path.basename(file)),
    referenceFiles: files,
    referenceCount: enabled ? files.length : 0,
    instruction: files.length
      ? 'Review image 1 as the generated poster and following image(s) as buyer source attachment(s). Promotional, discount, footer, brand, and product copy visibly present in the buyer source attachment is buyer-supplied preservation copy and must not be failed as invented. Fail only new, mismatched, or unsupported claims that do not come from the source attachment.'
      : 'Buyer requested content preservation. Treat visible attachment copy as buyer-supplied when source evidence is available; fail only newly invented or mismatched claims.',
  };
}

export function logoNoCopyReferenceFiles(contract, { limit = 3 } = {}) {
  if (contract?.workflowId !== 'logo_brand') return [];
  return semanticVisualRefereeUniqueFiles(
    (contract?.attachmentSpec?.noCopyReferenceFiles || []).map((item) => item?.path || item),
    { imageOnly: true, limit },
  );
}

export function operatorGlyphReferenceFiles(contract, { limit = 2 } = {}) {
  const files = [
    ...(Array.isArray(contract?.operatorGlyphReferenceFiles) ? contract.operatorGlyphReferenceFiles : []),
    ...(Array.isArray(contract?.attachmentSpec?.operatorGlyphReferenceFiles) ? contract.attachmentSpec.operatorGlyphReferenceFiles : []),
  ].map((item) => item?.path || item).filter(Boolean);
  return semanticVisualRefereeUniqueFiles(files, { imageOnly: true, limit });
}

export function semanticVisualRefereeReviewFiles(contract) {
  return semanticVisualRefereeUniqueFiles([
    ...posterSemanticReferenceFiles(contract),
    ...logoNoCopyReferenceFiles(contract),
    ...operatorGlyphReferenceFiles(contract),
  ]);
}

export function normalizeVisualRefereeArtifactCheckForBuyerSource(contract, item) {
  const checkItem = { id: item.id, label: item.label, source: item.source, blocking: item.blocking !== false };
  if (hasPosterContentPreservation(contract) && checkItem.id === 'no_fake_commercial_claims') {
    return {
      ...checkItem,
      label: 'No invented price, promotion, certification, contact, QR code, or unsupported product claim appears; exact promotional/discount/footer text visibly preserved from buyer source attachment is allowed.',
    };
  }
  if (!allowsBuyerSuppliedProductionInfo(contract) || checkItem.id !== 'no_fake_regulatory') return checkItem;
  return {
    ...checkItem,
    label: 'No invented barcode, QR, certification, address, phone, or regulatory claim appears; exact buyer-supplied unchanged label production information is allowed.',
  };
}

export function normalizeVisualRefereeAcceptanceForBuyerSource(contract, item) {
  if (hasPosterContentPreservation(contract)) {
    return String(item)
      .replace(/no invented commercial claims, contacts, QR codes, prices, awards, or certifications/i, 'no newly invented commercial claims, contacts, QR codes, prices, awards, or certifications; exact buyer-source promotion/footer copy is allowed')
      .replace(/No invented price, promotion, certification, contact, QR code, or unsupported product claim appears\./i, 'No newly invented price, promotion, certification, contact, QR code, or unsupported product claim appears; exact buyer-source promotion/footer copy is allowed.');
  }
  if (!allowsBuyerSuppliedProductionInfo(contract)) return item;
  return String(item)
    .replace(/No fake barcode, QR, phone, URL, awards, or regulatory claims\./i, 'No invented barcode, QR, phone, URL, awards, or regulatory claims; exact buyer-supplied unchanged label production information is allowed.')
    .replace(/No fake barcode, QR, certification, address, phone, or regulatory claim appears\./i, 'No invented barcode, QR, certification, address, phone, or regulatory claim appears; exact buyer-supplied unchanged label production information is allowed.');
}

export function semanticVisualRefereeInputForRequest(request, contract = null) {
  return {
    requestId: request.id,
    artifactIndex: request.artifactIndex ?? null,
    filename: request.filename,
    role: request.role || null,
    resultPath: request.result?.path ? path.resolve(String(request.result.path)) : null,
    acceptance: (request.acceptance || []).map((item) => normalizeVisualRefereeAcceptanceForBuyerSource(contract, item)),
    qualityChecks: (request.qualityChecks || []).map((item) => normalizeVisualRefereeArtifactCheckForBuyerSource(contract, item)),
  };
}

export function buildSemanticVisualRefereeCriteria(contract = {}) {
  const subject = posterVisibleSubject(contract);
  const mustUsePolicy = splitPosterVisibleCopyConstraints(contract, subject.mustUseText);
  const effectiveForbiddenText = filterForbiddenAgainstVisibleMustUse(subject.forbiddenText, mustUsePolicy.visible);
  const industrySpec = contract.industrySpec || {};
  const designReferenceSpec = contract.designReferenceSpec || {};
  const designReferenceRetrieval = contract.designReferenceRetrieval || {};
  const structuredQaBlockers = buildStructuredQaBlockers({
    designReferenceSpec,
    designReferenceRetrieval,
    workflowId: contract.workflowId,
  });
  return {
    version: SEMANTIC_VISUAL_REFEREE_CONTRACT_VERSION,
    workflowId: contract.workflowId,
    subject: {
      projectText: subject.projectText || null,
      brandText: subject.brandText || null,
      productText: subject.productText || null,
      deliverableText: subject.deliverableText || null,
      mustUseText: mustUsePolicy.visible,
      nonVisibleApplicationConstraints: mustUsePolicy.nonVisible,
      forbiddenText: effectiveForbiddenText,
      audienceText: subject.audienceText || null,
      industryText: subject.industryText || null,
      buyerSuppliedPackagingText: buyerSuppliedPackagingText(contract),
      posterContentPreservationPolicy: posterContentPreservationPolicy(contract),
      contactValuePolicy: buyerContactValuePolicy(contract),
    },
    industrySpec: {
      id: industrySpec.id || null,
      label: industrySpec.label || null,
      domain: industrySpec.domain || null,
      visualCues: semanticVisualRefereeArray(industrySpec.visualCues),
      applicationContexts: semanticVisualRefereeArray(industrySpec.applicationContexts),
      forbiddenCliches: semanticVisualRefereeArray(industrySpec.forbiddenCliches),
      qaFocus: semanticVisualRefereeArray(industrySpec.qaFocus),
    },
    designReferenceSpec: {
      id: designReferenceSpec.id || null,
      label: designReferenceSpec.label || null,
      sourcePolicy: designReferenceSpec.sourcePolicy || null,
      referenceKeys: semanticVisualRefereeArray(designReferenceSpec.referenceKeys),
      designGrammar: semanticVisualRefereeArray(designReferenceSpec.designGrammar),
      applicationScenes: semanticVisualRefereeArray(designReferenceSpec.applicationScenes),
      materialPreferences: semanticVisualRefereeArray(designReferenceSpec.materialPreferences),
      layoutPreferences: semanticVisualRefereeArray(designReferenceSpec.layoutPreferences),
      typographyPreferences: semanticVisualRefereeArray(designReferenceSpec.typographyPreferences),
      negativePatterns: semanticVisualRefereeArray(designReferenceSpec.negativePatterns),
      qaBlockers: semanticVisualRefereeArray(designReferenceSpec.qaBlockers),
      structuredQaBlockers,
      structuredQaBlockerSummary: summarizeStructuredQaBlockers(structuredQaBlockers),
      qaChecks: semanticVisualRefereeArray(designReferenceSpec.qaChecks),
    },
    designReferenceRetrieval: designReferenceRetrieval?.kind ? {
      status: designReferenceRetrieval.status || null,
      routingMode: designReferenceRetrieval.routingMode || null,
      selectionAuthority: designReferenceRetrieval.selectionAuthority || null,
      indexRoutingActive: designReferenceRetrieval.indexRoutingActive === true,
      indexOverrideAllowed: designReferenceRetrieval.indexOverrideAllowed === true,
      selectionReason: designReferenceRetrieval.selectionReason || null,
      selectedRefpackId: designReferenceRetrieval.selectedRefpackId || null,
      staticRefpackId: designReferenceRetrieval.staticRefpackId || null,
      topRefpackId: designReferenceRetrieval.topRefpackId || null,
      retrievalHash: designReferenceRetrieval.retrievalHash || null,
      selectedCandidate: designReferenceRetrieval.selectedCandidate ? {
        score: designReferenceRetrieval.selectedCandidate.score,
        tokenHits: designReferenceRetrieval.selectedCandidate.tokenHits,
        matchReasons: semanticVisualRefereeArray(designReferenceRetrieval.selectedCandidate.matchReasons),
      } : null,
      warnings: semanticVisualRefereeArray((designReferenceRetrieval.warnings || []).map((item) => item.code || item)),
    } : null,
    artifactChecks: (contract.qaContract?.artifactChecks || []).map((item) => normalizeVisualRefereeArtifactCheckForBuyerSource(contract, item)),
    packageChecks: (contract.qaContract?.packageChecks || []).map((item) => ({ id: item.id, label: item.label, source: item.source, blocking: item.blocking !== false })),
    safety: SEMANTIC_VISUAL_REFEREE_SAFETY,
  };
}

export function buildCompactSemanticVisualRefereeCriteria(contract = {}, request = null) {
  const subject = posterVisibleSubject(contract);
  const mustUsePolicy = splitPosterVisibleCopyConstraints(contract, subject.mustUseText);
  const effectiveForbiddenText = filterForbiddenAgainstVisibleMustUse(subject.forbiddenText, mustUsePolicy.visible);
  const industry = contract.industrySpec || {};
  const reference = contract.designReferenceSpec || {};
  const retrieval = contract.designReferenceRetrieval || {};
  const structuredQaBlockers = buildStructuredQaBlockers({
    designReferenceSpec: reference,
    designReferenceRetrieval: retrieval,
    workflowId: contract.workflowId,
    limit: 10,
  });
  return {
    subject: {
      projectText: subject.projectText || null,
      brandText: subject.brandText || null,
      productText: subject.productText || null,
      deliverableText: subject.deliverableText || null,
      mustUseText: compactSemanticVisualRefereeArray(mustUsePolicy.visible, 8),
      nonVisibleApplicationConstraints: compactSemanticVisualRefereeArray(mustUsePolicy.nonVisible, 8),
      forbiddenText: compactSemanticVisualRefereeArray(effectiveForbiddenText, 8),
      iconOnlyLogo: !!subject.iconOnlyLogo,
      buyerSuppliedPackagingText: compactSemanticVisualRefereeArray(buyerSuppliedPackagingText(contract), 8),
      posterContentPreservationPolicy: posterContentPreservationPolicy(contract),
      contactValuePolicy: buyerContactValuePolicy(contract),
    },
    industry: {
      id: industry.id || null,
      label: industry.label || null,
      visualCues: compactSemanticVisualRefereeArray(industry.visualCues, 5),
      forbiddenCliches: compactSemanticVisualRefereeArray(industry.forbiddenCliches, 5),
      qaFocus: compactSemanticVisualRefereeArray(industry.qaFocus, 5),
    },
    reference: {
      id: reference.id || null,
      label: reference.label || null,
      designGrammar: compactSemanticVisualRefereeArray(reference.designGrammar, 5),
      negativePatterns: compactSemanticVisualRefereeArray(reference.negativePatterns, 6),
      qaBlockers: compactSemanticVisualRefereeArray(reference.qaBlockers, 6),
      structuredQaBlockers: structuredQaBlockers.slice(0, 6).map((item) => ({
        id: item.id,
        category: item.category,
        severity: item.severity,
        triggerText: item.triggerText,
      })),
    },
    retrieval: retrieval?.kind ? {
      status: retrieval.status || null,
      reason: retrieval.selectionReason || null,
      selectedRefpackId: retrieval.selectedRefpackId || null,
      staticRefpackId: retrieval.staticRefpackId || null,
      topRefpackId: retrieval.topRefpackId || null,
      selectedScore: retrieval.selectedCandidate?.score ?? null,
      selectedTokenHits: retrieval.selectedCandidate?.tokenHits ?? null,
      warnings: compactSemanticVisualRefereeArray((retrieval.warnings || []).map((item) => item.code || item), 5),
    } : null,
    artifact: request ? {
      requestId: request.id,
      artifactIndex: request.artifactIndex ?? null,
      role: request.role || null,
      acceptance: compactSemanticVisualRefereeArray(request.acceptance, 8).map((item) => normalizeVisualRefereeAcceptanceForBuyerSource(contract, item)),
      qualityChecks: (request.qualityChecks || []).slice(0, 8).map((item) => normalizeVisualRefereeArtifactCheckForBuyerSource(contract, item)),
    } : null,
    packageChecks: (contract.qaContract?.packageChecks || []).slice(0, 8).map((item) => ({ id: item.id, label: item.label, blocking: item.blocking !== false })),
  };
}

export function buildSemanticVisualRefereePrompt({ manifest = null, contract = null, request = null, packageMode = false, args = {} } = {}) {
  const source = contract || manifest || {};
  const subject = posterVisibleSubject(source);
  const logoWithoutExactBrand = source.workflowId === 'logo_brand' && !subject.brandText;
  const iconOnlyLogo = source.workflowId === 'logo_brand' && subject.iconOnlyLogo;
  const noCopyLogoAttachment = source.workflowId === 'logo_brand' && (
    source.attachmentSpec?.generationUsage === 'negative_no_copy'
    || (source.attachmentSpec?.noCopyReferenceFiles || []).length > 0
    || source.attachmentSpec?.buyerAssetAttachmentPolicy?.hasNoCopyReferences
  );
  const buyerProductionInfoAllowed = allowsBuyerSuppliedProductionInfo(source);
  const buyerSizeSpecText = packagingBuyerSizeSpecText(source);
  const contactValuePolicy = buyerContactValuePolicy(source);
  const posterContentPolicy = posterContentPreservationPolicy(source);
  const posterMustUsePolicy = splitPosterVisibleCopyConstraints(source, subject.mustUseText);
  const glyphReferences = operatorGlyphReferenceFiles(source);
  if (args['compact-semantic-prompt']) {
    return [
      'You are the ZBJ production semantic visual referee. Inspect the visible pixels of this artifact.',
      'Return one-line minified JSON only, under 900 chars: {"decision":"pass|review|fail","checks":[{"id":"semantic_subject_lock","status":"pass|review|fail","notes":"<=10 words"},{"id":"semantic_brand_text_accuracy","status":"pass|review|fail","notes":"<=10 words"},{"id":"semantic_industry_fit","status":"pass|review|fail","notes":"<=10 words"},{"id":"semantic_reference_negative_patterns","status":"pass|review|fail","notes":"<=10 words"},{"id":"semantic_application_scene_fit","status":"pass|review|fail","notes":"<=10 words"},{"id":"semantic_professional_finish","status":"pass|review|fail","notes":"<=10 words"},{"id":"semantic_template_filler_absence","status":"pass|review|fail","notes":"<=10 words"}],"evidence":["<=8 words"],"riskFlags":[]}.',
      'PASS only when the visible work matches the requested subject/product/brand, looks like a finished professional deliverable, and avoids forbidden/action/reference/placeholder text. FAIL wrong subject, wrong main text, fake filler that substitutes for client-specific content, low-end hand-made layout, or forbidden content. REVIEW only for genuine ambiguity.',
      source.workflowId === 'logo_brand' ? 'Logo/VI allowance: do not fail a polished VI proposal board solely for color palettes, typography or font-weight samples, construction grids, application mockups, or multi-panel presentation structure; these can be professional evidence.' : null,
      source.workflowId === 'logo_brand' ? 'Logo/VI blocker: fail hand-made logo sheets: generic shield/leaf/drop clipart, empty placeholder cards, unrelated fake spec chips, stock brochure filler with no client-specific logo proof, weak mark construction, or boards that only arrange boxes around one rough mark.' : null,
      source.workflowId === 'logo_brand' ? 'Logo/VI blocker: fail or review if the board uses an artificial top title bar, navigation-chip row, anti-copy mask, repeated summary header, or any occluding overlay that covers or crowds the actual logo/mockup content, even if the visible brand text is correct.' : null,
      noCopyLogoAttachment ? 'No-copy logo/reference blocker: review file(s) after the generated artifact may include buyer/third-party reference logos that are not submission artifacts. Fail if the submitted mark reuses, traces, recolors, simplifies, or closely imitates the no-copy reference symbol geometry, color placement, or lockup layout. A polished VI board around the same reference mark is still fail.' : null,
      glyphReferences.length ? 'Glyph-reference rule: review file(s) after the generated artifact may include operator-created exact-glyph reference images. Use them only to distinguish rare required Chinese glyphs in the buyer brand text. Do not OCR-normalize 劵 to 券/券; the required visible word is 宝信证劵 and the final character must match the reference glyph shape.' : null,
      subject.brandText && !posterContentPolicy.enabled ? `Exact required visible brand text is: "${subject.brandText}". Do not require the buyer task title, workflow words, or design-request suffixes such as "全新LOGO设计", "LOGO设计", "品牌", or "方案" to appear as logo text. Judge exactness from the primary lockup/headline; do not fail solely because tiny secondary mockup text is too small to OCR when the primary lockup is correct.` : null,
      subject.brandText && posterContentPolicy.enabled ? `Poster source-logo rule: OCR detected brand text "${subject.brandText}", but source attachment image(s) are authoritative for the exact logo/brand lockup. Pass when the generated poster visually preserves the source lockup, including small Chinese/English glyphs that OCR may omit; fail only source-lockup omissions, rewrites, or mismatches.` : null,
      request ? 'Multi-artifact set rule: judge this artifact by its role and acceptance checks. Do not require every must-use phrase, every size, or every package/page variant to appear on every single artifact when they can be covered across the set. Primary brand/product/subject must still be correct; exact dimensions/SKU/long-box details are mandatory on flat-layout/spec artifacts and acceptable as distributed callouts on mockups.' : null,
      request && ['packaging_design', 'catalog_brochure', 'presentation_deck', 'generic_design'].includes(source.workflowId) ? 'Do not mark REVIEW merely because you cannot verify that a visible logo/mark is the buyer-provided source file; mark REVIEW/FAIL only when the visible text/mark conflicts with the required brand/product or uses obvious placeholder/fake text.' : null,
      buyerProductionInfoAllowed ? 'Packaging exception: this buyer explicitly requires label production/regulatory/trust wording and product efficacy copy. Do not fail exact buyer-supplied product names, sell points, barcode/address/phone/license/standard/date/batch/association/official-cooperation/patent-ingredient fields as fake regulatory/contact/certification/treatment content or subject drift; fail only invented extra claims, wrong copied details, or unrelated regulatory/contact/certification content.' : null,
      buyerSizeSpecText.length ? `Packaging size/spec exception: the buyer explicitly supplied these packaging capacities/specs (${buyerSizeSpecText.join(' / ')}). Do not fail exact visible size/capacity callouts such as 30g, 100ml, 30ml, or buyer-supplied SKU sizes as fake specs; fail only invented extra specs or wrong values.` : null,
      contactValuePolicy.allowMissingBlankContactValues ? `Buyer contact-field exception: the source requirement contains blank contact labels (${contactValuePolicy.blankLabels.join(', ')}). Do not require visible email/phone/contact values and do not REVIEW/FAIL solely because email/phone is absent; still FAIL invented contact details or a wrong copied contact value.` : null,
      posterContentPolicy.enabled ? `Poster source-copy exception: ${posterContentPolicy.instruction}` : null,
      source.workflowId === 'poster_design' ? `Poster visible-copy policy: layout/application constraints such as 横版, 主KV/KV, KT板, 工厂车间墙头, 20米, 2.2米, 遮挡, 海报图两边, and 排版 are NOT required visible text. Do not REVIEW/FAIL because these internal use-case/dimension words are absent from the poster. Judge them as layout constraints only; visible copy requirements are: ${posterMustUsePolicy.visible.join(' / ') || 'buyer-supported product/theme copy'}.` : null,
      source.workflowId === 'poster_design' ? 'Poster buyer-source quality points: if the buyer attachment shows simple quality-point modules/icons such as 严选原料, 标准工艺, 品质管控, 用心包装, then clean rectangular icon cards or simple line icons for those exact points are allowed. Do not treat them as fake certification/award badges unless they are medal/seal/stamp/regulatory marks or invented certification claims.' : null,
      iconOnlyLogo ? 'Icon-only logo branch: do not require a wordmark; fail forbidden text/scenery when buyer forbids it.' : null,
      logoWithoutExactBrand ? 'Logo branch without exact brand text: do not require the task title as visible text; fail task-title placeholders or uncontrolled descriptive phrases used as a logo wordmark. If the buyer explicitly asked for a name plus LOGO, original 2-4 Chinese name candidates are acceptable visible logo text when they fit the brief.' : null,
      packageMode ? 'Package mode: also judge set coherence and route diversity.' : 'Single-artifact mode.',
      source.designReferenceRetrieval?.kind ? 'Use designReferenceRetrieval as current retrieval evidence: judge against selectedRefpackId and treat retrieved qaBlockers/negativePatterns as review targets, while still applying source-policy boundaries.' : null,
      JSON.stringify({
        task: { taskId: source.taskId, title: source.title || null, workflowId: source.workflowId, outputMode: source.outputMode || null },
        criteria: buildCompactSemanticVisualRefereeCriteria(source, request),
      }),
    ].filter(Boolean).join('\n\n');
  }
  const promptPayload = {
    task: {
      taskId: source.taskId,
      orderId: source.orderId ?? null,
      title: source.title || null,
      workflowId: source.workflowId,
      outputMode: source.outputMode || null,
    },
    criteria: buildSemanticVisualRefereeCriteria(source),
    subjectTextPolicy: iconOnlyLogo ? {
      exactBrandTextProvided: false,
      iconOnlyLogo: true,
      instruction: 'Buyer explicitly requested an icon-only/cartoon logo. Do not require English text, Chinese text, a wordmark, or hospitality/tourism application scenes. Judge the artifact primarily on the requested icon subject, required motif(s), source-logo reference when provided, and forbidden content such as English text, Chinese text, scenery, or task-title placeholders. Do not fail semantic_industry_fit or semantic_application_scene_fit solely because the mark is a simple generic icon application board rather than a tourism/hotel identity suite.',
    } : logoWithoutExactBrand ? {
      exactBrandTextProvided: false,
      instruction: 'No exact buyer-provided brand text exists for this logo task. Do not fail merely because an exact brand wordmark is absent. Fail if the artifact uses the Chinese task title, workflow description, action words, or placeholder phrases as the logo wordmark. If the buyer requested name plus LOGO, an original 2-4 Chinese name candidate is acceptable; if the buyer requested English+icon without exact text, an original short English candidate wordmark is acceptable.',
    } : posterContentPolicy.enabled ? {
      exactBrandTextProvided: !!subject.brandText,
      sourceAttachmentAuthoritative: true,
      instruction: 'For poster content-preservation briefs, OCR brandText is guidance only. Judge the exact brand/logo lockup against the buyer source attachment image(s), and pass when the source lockup is visually preserved even if OCR omitted a small glyph.',
    } : {
      exactBrandTextProvided: !!subject.brandText,
      instruction: 'When exact brand/product text is provided, visible main text must preserve it exactly.',
    },
    posterVisibleCopyPolicy: source.workflowId === 'poster_design' ? {
      visibleMustUseText: posterMustUsePolicy.visible,
      nonVisibleApplicationConstraints: posterMustUsePolicy.nonVisible,
      instruction: 'Non-visible application constraints describe landscape/banner/wall/KT/dimension/use-case requirements. They should affect layout suitability only and must not be required as rendered poster text. Buyer-source quality-point icon cards are allowed when they use exact attachment copy and do not claim certification/awards.',
    } : null,
    artifacts: request
      ? [semanticVisualRefereeInputForRequest(request, source)]
      : (source.requests || []).map((item) => semanticVisualRefereeInputForRequest(item, source)),
    attachmentPolicy: noCopyLogoAttachment ? {
      generationUsage: source.attachmentSpec?.generationUsage || 'negative_no_copy',
      noCopyReferenceFiles: (source.attachmentSpec.noCopyReferenceFiles || []).map((item) => item.filename || item.path || item).slice(0, 8),
      sourceReferenceFiles: (source.attachmentSpec.sourceReferenceFiles || []).map((item) => item.filename || item.path || item).slice(0, 8),
      buyerAssetAttachmentPolicyHash: source.attachmentSpec?.buyerAssetAttachmentPolicyHash || source.attachmentSpec?.buyerAssetAttachmentPolicy?.hash || null,
      buyerAssetPackageHash: source.attachmentSpec?.buyerAssetPackageHash || source.attachmentSpec?.buyerAssetPackage?.hash || null,
    } : null,
    requiredJsonShape: {
      decision: 'pass|fail|review',
      checks: SEMANTIC_VISUAL_REFEREE_CHECK_IDS.map((id) => ({
        id,
        status: 'pass|fail|review',
        notes: id === 'semantic_professional_finish'
          ? 'professional logo/board finish; palette, type, construction, and mockup panels are acceptable when meaningful'
          : 'short visual evidence',
      })),
      evidence: ['short visual evidence, no chain-of-thought'],
      riskFlags: ['concrete blocker names if any'],
    },
  };
  return [
    'You are the ZBJ production semantic visual referee.',
    'Evaluate the provided final artifact image/PDF preview against the task contract, reference-pack criteria, and finished professional quality.',
    'Do not fail a polished VI proposal board solely for color palettes, typography/font-weight samples, construction grids, application mockups, or multi-panel presentation structure; these can show professional system thinking. Fail low-end hand-made work, generic clipart-like marks, empty placeholder cards, unrelated fake spec chips, stock brochure filler with no client-specific logo proof, or boards that only arrange boxes around one rough mark.',
    iconOnlyLogo ? 'Important: this buyer asked for an icon-only/cartoon logo. No wordmark or industry application scene is required; pass icon-only boards when the requested motif/source-logo simplification is clear and forbidden text/scenery is absent.' : null,
    logoWithoutExactBrand ? 'Important: this logo task has no exact buyer-provided brand text. Do not require the descriptive project title to appear as logo text; instead reject task-title placeholders and uncontrolled descriptive phrases.' : null,
    source.workflowId === 'logo_brand' ? 'Logo/VI blocker: fail or review artificial top title bars, navigation-chip rows, anti-copy masks, repeated summary headers, or any occluding overlay that covers or crowds the actual logo/mockup content. Do not pass a board just because such an overlay makes the OCR text easy to read.' : null,
    noCopyLogoAttachment ? 'Existing-logo attachment blocker: buyer attached an old/source logo while requesting a new logo. Fail if the visible mark copies, traces, recolors, simplifies, or closely imitates that old attachment geometry, four-part/cross composition, color placement, or lockup layout.' : null,
    request ? 'Multi-artifact set rule: evaluate this artifact against its own role and acceptance checks. Do not require every must-use phrase, every size, or every package/page variant to appear on every single artifact when the set can distribute those requirements. Primary brand/product/subject must be correct. Dimensions/SKU/box-type details are mandatory on flat-layout/spec artifacts and acceptable as distributed callouts on other mockups.' : null,
    subject.brandText && !posterContentPolicy.enabled ? `Exact required visible brand text is: "${subject.brandText}". Do not require buyer task-title or design-request suffix words such as "全新LOGO设计", "LOGO设计", "品牌", "方案" as part of the visible brand. Judge exactness from the primary lockup/headline; tiny secondary mockup text may be ignored if the primary lockup is correct.` : null,
    subject.brandText && posterContentPolicy.enabled ? `Poster source-logo rule: OCR detected brand text "${subject.brandText}", but source attachment image(s) are authoritative for the exact logo/brand lockup. Pass when the generated poster visually preserves the source lockup, including small Chinese/English glyphs that OCR may omit; fail only source-lockup omissions, rewrites, or mismatches.` : null,
    request && ['packaging_design', 'catalog_brochure', 'presentation_deck', 'generic_design'].includes(source.workflowId) ? 'Do not mark REVIEW merely because the source attachment logo cannot be verified from pixels; only review/fail when visible brand/product text or the visible mark conflicts with the task or looks like placeholder/fake text.' : null,
    buyerProductionInfoAllowed ? 'Packaging exception: this buyer explicitly requires label production/regulatory/trust wording and product efficacy copy. Do not fail exact buyer-supplied product names, sell points, barcode/address/phone/license/standard/date/batch/association/official-cooperation/patent-ingredient fields as fake regulatory/contact/certification/treatment content or subject drift; fail only invented extra claims, wrong copied details, or unrelated regulatory/contact/certification content.' : null,
    buyerSizeSpecText.length ? `Packaging size/spec exception: the buyer explicitly supplied these packaging capacities/specs (${buyerSizeSpecText.join(' / ')}). Do not fail exact visible size/capacity callouts such as 30g, 100ml, 30ml, or buyer-supplied SKU sizes as fake specs; fail only invented extra specs or wrong values.` : null,
    contactValuePolicy.allowMissingBlankContactValues ? `Buyer contact-field exception: the source requirement contains blank contact labels (${contactValuePolicy.blankLabels.join(', ')}). Do not require visible email/phone/contact values and do not REVIEW/FAIL solely because email/phone is absent; still FAIL invented contact details or a wrong copied contact value.` : null,
    posterContentPolicy.enabled ? `Poster source-copy exception: ${posterContentPolicy.instruction}` : null,
    source.workflowId === 'poster_design' ? `Poster visible-copy policy: layout/application constraints such as 横版, 主KV/KV, KT板, 工厂车间墙头, 20米, 2.2米, 遮挡, 海报图两边, and 排版 are NOT required visible text. Do not REVIEW/FAIL because these internal use-case/dimension words are absent from the poster. Judge them as layout constraints only; visible copy requirements are: ${posterMustUsePolicy.visible.join(' / ') || 'buyer-supported product/theme copy'}.` : null,
    source.workflowId === 'poster_design' ? 'Poster buyer-source quality points: if the buyer attachment shows simple quality-point modules/icons such as 严选原料, 标准工艺, 品质管控, 用心包装, then clean rectangular icon cards or simple line icons for those exact points are allowed. Do not treat them as fake certification/award badges unless they are medal/seal/stamp/regulatory marks or invented certification claims.' : null,
    'Use the reference pack only as design grammar; never reward copying third-party brands/layouts.',
    source.designReferenceRetrieval?.kind ? 'Use designReferenceRetrieval as current retrieval evidence: selectedRefpackId is the pack to judge, static/top mismatch warnings are routing risks, and retrieved qaBlockers/negativePatterns are concrete quality-review targets.' : null,
    'Return ONLY strict JSON matching requiredJsonShape. Do not include markdown.',
    packageMode ? 'This is a package-level review. Also check route diversity and set coherence across the artifacts listed.' : 'This is a single-artifact review.',
    JSON.stringify(promptPayload, null, 2),
  ].filter(Boolean).join('\n\n');
}

export function buildSemanticVisualRefereeContract({ manifest = null, contract = null, request = null, packageMode = false, args = {}, inputFiles = [] } = {}) {
  const source = contract || manifest || {};
  const criteria = buildSemanticVisualRefereeCriteria(source);
  const prompt = buildSemanticVisualRefereePrompt({ contract: source, request, packageMode, args });
  const payload = {
    version: SEMANTIC_VISUAL_REFEREE_CONTRACT_VERSION,
    taskId: source.taskId || null,
    workflowId: source.workflowId || null,
    packageMode: packageMode === true,
    requestId: request?.id || null,
    inputFiles: semanticVisualRefereeUniqueFiles(inputFiles),
    criteria,
    prompt,
    reviewFiles: semanticVisualRefereeReviewFiles(source),
    safety: SEMANTIC_VISUAL_REFEREE_SAFETY,
  };
  return {
    ...payload,
    contractHash: digest({
      version: payload.version,
      taskId: payload.taskId,
      workflowId: payload.workflowId,
      packageMode: payload.packageMode,
      requestId: payload.requestId,
      inputFiles: payload.inputFiles,
      criteria,
      prompt,
      reviewFiles: payload.reviewFiles,
    }),
  };
}

export function semanticVisualRefereeContractsSelftest() {
  const manifest = {
    taskId: 'semantic-visual-referee-selftest',
    title: '横版主KV海报优化',
    workflowId: 'poster_design',
    requirementExcerpt: '保留原图内容不变，做横版主KV海报，两边延展，20米墙头使用。',
    subject: {
      projectText: '横版主KV海报 / 桂花糕新品',
      productText: '横版主KV海报 / 桂花糕新品',
      brandText: '桂香堂',
      mustUseText: ['横版主KV海报', '桂花糕新品上市', '20米墙头'],
      forbiddenText: ['桂花糕新品', '禁止词'],
    },
    attachmentSpec: {
      referenceImages: ['/tmp/buyer-source.png', '/tmp/non-image.pdf'],
    },
    industrySpec: { id: 'food_packaged_goods', visualCues: ['fresh ingredients'] },
    designReferenceSpec: {
      id: 'refpack_food_poster_v1',
      qaBlockers: ['wrong subject placeholder', 'fake award badge'],
      negativePatterns: ['stock festival poster'],
    },
    qaContract: {
      artifactChecks: [{ id: 'no_fake_commercial_claims', label: 'No invented commercial claims.', source: 'quality_gate' }],
    },
    requests: [{
      id: 'r1',
      filename: 'poster.png',
      acceptance: ['no invented commercial claims, contacts, QR codes, prices, awards, or certifications'],
      qualityChecks: [{ id: 'no_fake_commercial_claims', label: 'No invented price, promotion, certification, contact, QR code, or unsupported product claim appears.' }],
      result: { path: '/tmp/poster.png' },
    }],
  };
  const criteria = buildSemanticVisualRefereeCriteria(manifest);
  const compact = buildCompactSemanticVisualRefereeCriteria(manifest, manifest.requests[0]);
  const prompt = buildSemanticVisualRefereePrompt({ manifest, request: manifest.requests[0], args: { 'compact-semantic-prompt': true } });
  const contract = buildSemanticVisualRefereeContract({ manifest, request: manifest.requests[0], inputFiles: ['/tmp/poster.png'] });
  const packaging = {
    workflowId: 'packaging_design',
    requirementExcerpt: '保留公司信息不变\n公司邮箱：\n规格：30g',
    subject: { mustUseText: ['产品名称：护齿牙膏', '卖点：抗牙结石'] },
    qaContract: { artifactChecks: [{ id: 'no_fake_regulatory', label: 'No fake barcode, QR, certification, address, phone, or regulatory claim appears.' }] },
  };
  const logo = {
    workflowId: 'logo_brand',
    attachmentSpec: { generationUsage: 'negative_no_copy', noCopyReferenceFiles: ['/tmp/old-logo.jpg'] },
  };
  const ok = criteria.subject.mustUseText.includes('桂花糕新品上市')
    && criteria.subject.nonVisibleApplicationConstraints.includes('20米墙头')
    && !criteria.subject.forbiddenText.includes('桂花糕新品')
    && criteria.subject.posterContentPreservationPolicy.sourceReferenceFiles.includes('buyer-source.png')
    && compact.reference.structuredQaBlockers.length >= 2
    && prompt.includes('Poster visible-copy policy')
    && prompt.includes('source-logo rule')
    && allowsBuyerSuppliedProductionInfo(packaging)
    && packagingBuyerSizeSpecText(packaging).some((item) => item.includes('30g'))
    && buyerContactValuePolicy(packaging).allowMissingBlankContactValues === true
    && logoNoCopyReferenceFiles(logo).length === 1
    && contract.contractHash.startsWith('sha256:')
    && contract.safety.callsProviderOrModel === false
    && contract.safety.grantsExecutionPermission === false;
  return { ok, criteria, compact, promptLength: prompt.length, contract, safety: SEMANTIC_VISUAL_REFEREE_SAFETY };
}
