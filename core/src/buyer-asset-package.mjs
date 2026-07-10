import { normalizeText, uniqueStrings } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const BUYER_ASSET_PACKAGE_VERSION = 1;
export const BUYER_ASSET_ATTACHMENT_POLICY_VERSION = 1;

export const BUYER_ASSET_PACKAGE_STATUS = Object.freeze({
  PASS: 'pass_buyer_asset_package',
  BLOCKED: 'blocked_buyer_asset_package',
});

export const BUYER_ASSET_ROLES = Object.freeze({
  MUST_USE_ASSET: 'must_use_asset',
  STYLE_REFERENCE: 'style_reference',
  STRUCTURE_REFERENCE: 'structure_reference',
  SOURCE_LOGO: 'source_logo',
  BUYER_CORRECTION: 'buyer_correction',
  NEGATIVE_NO_COPY: 'negative_no_copy',
  DO_NOT_COPY: 'do_not_copy',
});

export const BUYER_ASSET_ATTACHMENT_GENERATION_USAGE = Object.freeze({
  TASK_ATTACHMENT: 'task_attachment',
  BOOK_COVER_VISUAL_REFERENCES_ONLY: 'book_cover_visual_references_only',
  SOURCE_REFERENCE_WITH_NEGATIVE_NO_COPY: 'source_reference_with_negative_no_copy',
  NEGATIVE_NO_COPY: 'negative_no_copy',
  POSTER_CONTENT_PRESERVATION: 'poster_content_preservation',
});

const DEFAULT_ALLOWED_ROLES = Object.freeze(Object.values(BUYER_ASSET_ROLES));

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function textHasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(String(text || '')));
}

function attachmentBasename(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function attachmentLabel(item) {
  if (typeof item === 'string') return item;
  return [
    item?.filename,
    item?.displayName,
    item?.path,
    item?.localPath,
    item?.url,
  ].filter(Boolean).join('\n');
}

function normalizeAttachmentRef(item = {}) {
  if (typeof item === 'string') {
    return {
      path: normalizeText(item),
      filename: attachmentBasename(item),
      sha256: null,
      hash: null,
      size: null,
      originKind: null,
      mimeType: null,
    };
  }
  const path = normalizeText(item.path || item.file || item.sourcePath || item.localPath || '');
  const url = normalizeText(item.url || '');
  const filename = normalizeText(item.filename || item.displayName || attachmentBasename(path || url));
  const sha256 = normalizeText(item.sha256 || item.hash || '') || null;
  const size = Number(item.size || 0);
  return {
    ...item,
    path: path || null,
    url: url || null,
    filename: filename || null,
    sha256,
    hash: sha256,
    size: Number.isFinite(size) && size > 0 ? size : null,
    originKind: normalizeText(item.originKind || item.kind || '') || null,
    mimeType: normalizeText(item.mimeType || item.contentType || item.type || '') || null,
  };
}

function compactAttachmentRef(item = {}) {
  const ref = normalizeAttachmentRef(item);
  return {
    path: ref.path,
    url: ref.url,
    filename: ref.filename,
    sha256: ref.sha256,
    size: ref.size,
    originKind: ref.originKind,
    mimeType: ref.mimeType,
  };
}

function uniqueAttachmentRefs(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of asArray(values).map(normalizeAttachmentRef)) {
    const key = value.path || value.url || `${value.filename || ''}:${value.sha256 || ''}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function attachmentPaths(values = []) {
  return uniqueStrings(asArray(values).map((item) => {
    if (typeof item === 'string') return item;
    return item?.path || item?.file || item?.sourcePath || item?.localPath || item?.url || '';
  }), 100);
}

function imageLikeAttachmentRef(item = {}) {
  const ref = normalizeAttachmentRef(item);
  const label = `${ref.path || ''}\n${ref.filename || ''}\n${ref.mimeType || ''}\n${ref.originKind || ''}`.toLowerCase();
  return /\.(jpg|jpeg|png|webp|bmp|gif|tif|tiff)(?:$|[?\s])/i.test(label) || label.includes('image/') || label.includes('image');
}

function composeAttachmentContextText({
  title = '',
  requirementText = '',
  subject = {},
  text = '',
} = {}) {
  return [
    text,
    title,
    requirementText,
    subject?.projectText,
    subject?.brandText,
    subject?.productText,
    subject?.deliverableText,
    ...(Array.isArray(subject?.mustUseText) ? subject.mustUseText : []),
    ...(Array.isArray(subject?.forbiddenText) ? subject.forbiddenText : []),
  ].filter(Boolean).join('\n');
}

export function isBookCoverAttachmentContext(text) {
  return /(?:图书|书籍|书封|封面|封四|书脊|勒口|full[-\s]?jacket|book\s*cover)/i.test(String(text || ''))
    && /(?:封四|书脊|勒口|出版社|作者简介|内容简介|开本|中国社会科学出版社)/.test(String(text || ''));
}

export function isBuyerLogoSourceAttachmentReference(item) {
  const label = attachmentLabel(item);
  return /(?:底稿|原稿|源稿|草图|初稿|线稿|手稿|图样|样稿|原有|已有|现有|当前|旧|老|draft|source|sketch).{0,16}(?:LOGO|logo|标志|标识|图形|图案)?|(?:LOGO|logo|标志|标识|图形|图案).{0,16}(?:底稿|原稿|源稿|草图|初稿|线稿|手稿|图样|样稿|原有|已有|现有|当前|旧|老|draft|source|sketch)/i.test(label);
}

export function isThirdPartyLogoNoCopyAttachmentReference(item) {
  const label = attachmentLabel(item);
  const looksThirdParty = /(?:北航|BEIHANG|北京航空航天大学|BUAA|校徽|大学徽章|高校徽章|参考校徽|reference\s*logo)/i.test(label);
  return looksThirdParty && !isBuyerLogoSourceAttachmentReference(item);
}

export function splitBuyerLogoSourceAndNoCopyReferences(referenceFiles = []) {
  const refs = uniqueAttachmentRefs(referenceFiles);
  if (refs.length < 2) return { sourceReferenceFiles: refs, noCopyReferenceFiles: [], splitApplied: false };
  const noCopyReferenceFiles = [];
  const sourceReferenceFiles = [];
  for (const item of refs) {
    if (isBuyerLogoSourceAttachmentReference(item)) sourceReferenceFiles.push(item);
    else if (isThirdPartyLogoNoCopyAttachmentReference(item)) noCopyReferenceFiles.push(item);
    else sourceReferenceFiles.push(item);
  }
  return {
    sourceReferenceFiles,
    noCopyReferenceFiles,
    splitApplied: noCopyReferenceFiles.length > 0 && sourceReferenceFiles.length > 0,
  };
}

function logoAttachmentNames(spec = {}) {
  return [
    ...asArray(spec.attachments).map((item) => item?.filename || item?.localPath || item?.path || ''),
    ...asArray(spec.referenceFiles).map((item) => item?.filename || item?.path || ''),
    ...asArray(spec.semanticReferenceFiles).map((item) => item?.filename || item?.path || ''),
  ].join('\n');
}

function logoNewRequestPolicy({ spec = {}, text = '' } = {}) {
  const hasLogoAttachment = /(?:logo|LOGO|标志|商标|标识|VI|vi|品牌)/i.test(logoAttachmentNames(spec));
  const asksForNewLogo = textHasAny(text, [
    /全新.{0,12}(?:LOGO|logo|标志|标识|企业LOGO)/i,
    /设计一款全新的?企业?LOGO/i,
    /核心.{0,16}全新/i,
    /重新设计.{0,12}(?:LOGO|logo|标志|标识)/i,
  ]);
  const explicitlyUsesExisting = textHasAny(text, [
    /(?:基于|参考|沿用|保留|延续|继承|升级|优化|改造|改版).{0,18}(?:原|旧|老|现有|已有|附件|当前).{0,12}(?:LOGO|logo|标志|标识)/i,
    /(?:原|旧|老|现有|已有|附件|当前).{0,12}(?:LOGO|logo|标志|标识).{0,18}(?:基于|参考|沿用|保留|延续|继承|升级|优化|改造|改版)/i,
    /(?:隐形|隐藏).{0,12}体现.{0,12}(?:logo|LOGO|标志|标识)/i,
    /(?:卡通版本|卡通化|卡通图|只要卡通图|icon-only|icon only)/i,
  ]);
  return { hasLogoAttachment, asksForNewLogo, explicitlyUsesExisting };
}

export function posterContentPreservationAttachmentPolicy({ workflowId = null, attachmentSpec = {}, text = '' } = {}) {
  const referenceFiles = attachmentPaths([
    ...asArray(attachmentSpec.semanticReferenceImages),
    ...asArray(attachmentSpec.referenceImages),
    ...asArray(attachmentSpec.semanticReferenceFiles),
    ...asArray(attachmentSpec.referenceFiles),
  ]);
  const enabled = workflowId === 'poster_design'
    && referenceFiles.length > 0
    && /不改变内容|内容不变|保留(?:原有|现有)?.{0,8}(?:内容|文案|文字|信息)|原(?:图|稿|设计|海报).{0,8}(?:内容|文案|文字|信息)|优化图文排版|延展海报|电商详情页/i.test(text);
  return {
    enabled,
    referenceFiles,
    referenceCount: enabled ? referenceFiles.length : 0,
    instruction: enabled
      ? 'Visible copy and logo lockup present in buyer source attachments are buyer-supplied preservation evidence; fail only new, mismatched, or unsupported claims.'
      : null,
  };
}

function hashAttachmentPolicyPayload(payload) {
  return digest({
    version: BUYER_ASSET_ATTACHMENT_POLICY_VERSION,
    ...payload,
  });
}

function buyerAssetFromAttachmentRef(ref, {
  index = 0,
  role = BUYER_ASSET_ROLES.STYLE_REFERENCE,
  providerInputRequired = false,
  copyPolicy = null,
  notes = null,
} = {}) {
  const normalized = normalizeAttachmentRef(ref);
  return {
    id: normalizeText(`${role}_${index + 1}`),
    role,
    path: normalized.path,
    url: normalized.url,
    hash: normalized.sha256,
    mimeType: normalized.mimeType,
    providerInputRequired,
    copyPolicy: copyPolicy || (role === BUYER_ASSET_ROLES.NEGATIVE_NO_COPY ? 'do_not_copy' : 'use_as_constrained_reference'),
    notes,
  };
}

function normalizeEvidenceRefs(values = []) {
  return (values || []).map((item) => {
    if (typeof item === 'string') return { kind: 'path', ref: item };
    return {
      kind: item?.kind || 'path',
      ref: normalizeText(item?.ref || item?.path || item?.url || item?.id || ''),
      hash: normalizeText(item?.hash || item?.sha256 || '') || null,
      notes: normalizeText(item?.notes || '') || null,
    };
  }).filter((item) => item.ref);
}

function normalizeDimensions(dimensions = {}) {
  const width = Number(dimensions.width || dimensions.w || 0);
  const height = Number(dimensions.height || dimensions.h || 0);
  return {
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null,
  };
}

function normalizeAsset(asset = {}, index = 0) {
  const role = normalizeText(asset.role || asset.kind || BUYER_ASSET_ROLES.STYLE_REFERENCE);
  const copyPolicy = normalizeText(asset.copyPolicy || asset.policy || (
    [BUYER_ASSET_ROLES.NEGATIVE_NO_COPY, BUYER_ASSET_ROLES.DO_NOT_COPY].includes(role)
      ? 'do_not_copy'
      : 'use_as_constrained_reference'
  ));
  return {
    id: normalizeText(asset.id || `buyer_asset_${index + 1}`),
    role,
    source: normalizeText(asset.source || asset.origin || 'buyer_supplied') || 'buyer_supplied',
    path: normalizeText(asset.path || asset.filePath || '') || null,
    url: normalizeText(asset.url || '') || null,
    hash: normalizeText(asset.hash || asset.sha256 || '') || null,
    mimeType: normalizeText(asset.mimeType || asset.type || '') || null,
    dimensions: normalizeDimensions(asset.dimensions || asset),
    providerInputRequired: Boolean(asset.providerInputRequired),
    copyPolicy,
    mustPreserveText: uniqueStrings(asset.mustPreserveText || [], 24),
    forbiddenText: uniqueStrings(asset.forbiddenText || [], 24),
    notes: normalizeText(asset.notes || '') || null,
  };
}

function blockersForPackage({ assets, textOnlyAllowed }) {
  const blockers = [];
  if (!assets.length && !textOnlyAllowed) blockers.push('buyer_assets_or_text_only_exception_required');
  for (const asset of assets) {
    if (!DEFAULT_ALLOWED_ROLES.includes(asset.role)) blockers.push(`buyer_asset_unknown_role:${asset.id}`);
    if (!asset.path && !asset.url) blockers.push(`buyer_asset_source_required:${asset.id}`);
    if (!asset.hash) blockers.push(`buyer_asset_hash_required:${asset.id}`);
    if (asset.role === BUYER_ASSET_ROLES.DO_NOT_COPY && asset.providerInputRequired) {
      blockers.push(`do_not_copy_asset_cannot_be_provider_input:${asset.id}`);
    }
  }
  return blockers;
}

export function buildBuyerAssetPackage({
  taskKey = null,
  channelId = null,
  mode = null,
  assets = [],
  textOnlyAllowed = false,
  textOnlyReason = null,
  createdAt = null,
  evidenceRefs = [],
} = {}) {
  const normalizedAssets = (assets || []).map(normalizeAsset);
  const blockers = blockersForPackage({ assets: normalizedAssets, textOnlyAllowed });
  const pack = {
    version: BUYER_ASSET_PACKAGE_VERSION,
    kind: 'BuyerAssetPackage',
    status: blockers.length ? BUYER_ASSET_PACKAGE_STATUS.BLOCKED : BUYER_ASSET_PACKAGE_STATUS.PASS,
    ok: blockers.length === 0,
    taskKey: normalizeText(taskKey || '') || null,
    channelId: normalizeText(channelId || '') || null,
    mode: normalizeText(mode || (normalizedAssets.length ? 'buyer_asset_package' : 'text_only_buyer_asset_package')),
    textOnlyAllowed: Boolean(textOnlyAllowed),
    textOnlyReason: normalizeText(textOnlyReason || '') || null,
    assets: normalizedAssets,
    providerInputAssets: normalizedAssets.filter((asset) => asset.providerInputRequired).map((asset) => ({
      id: asset.id,
      role: asset.role,
      path: asset.path,
      url: asset.url,
      hash: asset.hash,
      copyPolicy: asset.copyPolicy,
    })),
    blockers,
    evidenceRefs: normalizeEvidenceRefs(evidenceRefs),
    safety: {
      buyerAssetsSeparateFromDesignReferencePackage: true,
      doNotCopyIsHardConstraint: true,
      hashesRequiredForAssets: true,
      executesExternalAction: false,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const buyerAssetPackageHash = digest({
    kind: pack.kind,
    taskKey: pack.taskKey,
    channelId: pack.channelId,
    mode: pack.mode,
    textOnlyAllowed: pack.textOnlyAllowed,
    textOnlyReason: pack.textOnlyReason,
    assets: pack.assets,
    blockers: pack.blockers,
    safety: pack.safety,
  });
  return {
    ...pack,
    buyerAssetPackageHash,
    hash: buyerAssetPackageHash,
  };
}

export function summarizeBuyerAssetPackages(packages = []) {
  const byStatus = {};
  const byMode = {};
  let assetCount = 0;
  for (const pack of packages || []) {
    byStatus[pack.status || 'unknown'] = (byStatus[pack.status || 'unknown'] || 0) + 1;
    byMode[pack.mode || 'unknown'] = (byMode[pack.mode || 'unknown'] || 0) + 1;
    assetCount += pack.assets?.length || 0;
  }
  return {
    version: BUYER_ASSET_PACKAGE_VERSION,
    count: packages.length,
    assetCount,
    byStatus,
    byMode,
    blocked: packages.filter((pack) => pack.blockers?.length).length,
    executesExternalAction: false,
  };
}

export function buildBuyerAssetAttachmentPolicy({
  taskKey = null,
  channelId = null,
  workflowId = null,
  attachmentSpec = {},
  title = '',
  requirementText = '',
  subject = {},
  text = '',
  createdAt = null,
} = {}) {
  const contextText = composeAttachmentContextText({ title, requirementText, subject, text });
  const sourceReferenceFiles = uniqueAttachmentRefs(attachmentSpec.sourceReferenceFiles || []);
  const noCopyReferenceFiles = uniqueAttachmentRefs(attachmentSpec.noCopyReferenceFiles || []);
  const providerReferenceFiles = uniqueAttachmentRefs(attachmentSpec.referenceFiles || []);
  const semanticReferenceFiles = uniqueAttachmentRefs(attachmentSpec.semanticReferenceFiles || []);
  const posterContentPolicy = posterContentPreservationAttachmentPolicy({
    workflowId,
    attachmentSpec,
    text: contextText,
  });
  const generationUsage = normalizeText(attachmentSpec.generationUsage || (
    posterContentPolicy.enabled
      ? BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.POSTER_CONTENT_PRESERVATION
      : (attachmentSpec.required ? BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.TASK_ATTACHMENT : '')
  )) || null;
  const sourceAssets = (sourceReferenceFiles.length ? sourceReferenceFiles : (
    generationUsage === BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.TASK_ATTACHMENT
      || generationUsage === BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.BOOK_COVER_VISUAL_REFERENCES_ONLY
      || posterContentPolicy.enabled
      ? providerReferenceFiles
      : []
  )).map((item, index) => buyerAssetFromAttachmentRef(item, {
    index,
    role: generationUsage === BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.BOOK_COVER_VISUAL_REFERENCES_ONLY
      ? BUYER_ASSET_ROLES.STRUCTURE_REFERENCE
      : (generationUsage === BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.SOURCE_REFERENCE_WITH_NEGATIVE_NO_COPY
        ? BUYER_ASSET_ROLES.SOURCE_LOGO
        : BUYER_ASSET_ROLES.MUST_USE_ASSET),
    providerInputRequired: true,
    copyPolicy: posterContentPolicy.enabled
      ? 'preserve_buyer_source_visible_copy_and_logo_lockup'
      : (generationUsage === BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.BOOK_COVER_VISUAL_REFERENCES_ONLY
        ? 'use_visual_structure_reference_only'
        : 'use_buyer_source_as_required_input'),
    notes: posterContentPolicy.enabled ? 'buyer source copy/lockup preservation evidence' : null,
  }));
  const noCopyAssets = noCopyReferenceFiles.map((item, index) => buyerAssetFromAttachmentRef(item, {
    index: sourceAssets.length + index,
    role: BUYER_ASSET_ROLES.NEGATIVE_NO_COPY,
    providerInputRequired: false,
    copyPolicy: 'do_not_copy',
    notes: 'negative reference only; never send as provider input',
  }));
  const assets = [...sourceAssets, ...noCopyAssets].filter((asset) => asset.path || asset.url);
  if (!assets.length && !attachmentSpec.required && !providerReferenceFiles.length && !semanticReferenceFiles.length && !noCopyReferenceFiles.length) return null;
  const buyerAssetPackage = buildBuyerAssetPackage({
    taskKey,
    channelId,
    mode: 'buyer_asset_attachment_policy',
    assets,
    textOnlyAllowed: assets.length === 0,
    textOnlyReason: assets.length === 0 ? 'attachment_policy_without_file_asset' : null,
    createdAt,
    evidenceRefs: [
      ...(attachmentSpec.hash ? [{ kind: 'attachmentSpecHash', ref: attachmentSpec.hash }] : []),
      ...(attachmentSpec.originalHash ? [{ kind: 'attachmentSpecOriginalHash', ref: attachmentSpec.originalHash }] : []),
    ],
  });
  const policyHash = hashAttachmentPolicyPayload({
    taskKey: normalizeText(taskKey || '') || null,
    channelId: normalizeText(channelId || '') || null,
    workflowId: normalizeText(workflowId || '') || null,
    generationUsage,
    generationUsageReason: normalizeText(attachmentSpec.generationUsageReason || '') || null,
    sourceReferenceFiles: sourceReferenceFiles.map(compactAttachmentRef),
    noCopyReferenceFiles: noCopyReferenceFiles.map(compactAttachmentRef),
    providerReferenceFiles: providerReferenceFiles.map(compactAttachmentRef),
    posterContentPolicy,
    buyerAssetPackageHash: buyerAssetPackage.buyerAssetPackageHash,
  });
  return {
    version: BUYER_ASSET_ATTACHMENT_POLICY_VERSION,
    kind: 'BuyerAssetAttachmentPolicy',
    ok: buyerAssetPackage.ok,
    taskKey: normalizeText(taskKey || '') || null,
    channelId: normalizeText(channelId || '') || null,
    workflowId: normalizeText(workflowId || '') || null,
    generationUsage,
    generationUsageReason: normalizeText(attachmentSpec.generationUsageReason || '') || null,
    sourceReferenceCount: sourceReferenceFiles.length,
    sourceReferenceImages: attachmentPaths(sourceReferenceFiles),
    sourceReferenceFiles: sourceReferenceFiles.map(compactAttachmentRef),
    noCopyReferenceCount: noCopyReferenceFiles.length,
    noCopyReferenceImages: attachmentPaths(noCopyReferenceFiles),
    noCopyReferenceFiles: noCopyReferenceFiles.map(compactAttachmentRef),
    providerReferenceCount: providerReferenceFiles.length,
    providerReferenceImages: attachmentPaths(providerReferenceFiles),
    providerReferenceFiles: providerReferenceFiles.map(compactAttachmentRef),
    posterContentPreservationPolicy: posterContentPolicy,
    hasSourceReferences: sourceReferenceFiles.length > 0 || providerReferenceFiles.length > 0,
    hasNoCopyReferences: noCopyReferenceFiles.length > 0,
    buyerAssetPackageHash: buyerAssetPackage.buyerAssetPackageHash,
    buyerAssetPackage,
    buyerAssetAttachmentPolicyHash: policyHash,
    hash: policyHash,
    safety: {
      noCopyReferencesNeverProviderInput: true,
      sourceReferencesMayBeProviderInput: true,
      buyerAssetsSeparateFromDesignReferencePackage: true,
      executesExternalAction: false,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
}

function adaptBookCoverAttachmentSpec(spec = {}) {
  const referenceFiles = uniqueAttachmentRefs(spec.referenceFiles || []).filter(imageLikeAttachmentRef);
  if (!referenceFiles.length || referenceFiles.length === asArray(spec.referenceFiles).length) return spec;
  return {
    ...spec,
    originalHash: spec.hash || null,
    hash: hashAttachmentPolicyPayload({
      originalHash: spec.hash || null,
      generationUsage: BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.BOOK_COVER_VISUAL_REFERENCES_ONLY,
      referenceFiles: referenceFiles.map(compactAttachmentRef),
      semanticReferenceFiles: uniqueAttachmentRefs(spec.semanticReferenceFiles || []).map(compactAttachmentRef),
      documentTextSnippets: asArray(spec.documentTextSnippets).map((item) => ({
        attachmentIndex: item.attachmentIndex,
        filename: item.filename,
        charCount: item.charCount,
        textHash: digest(String(item.text || '')),
      })),
    }),
    generationUsage: BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.BOOK_COVER_VISUAL_REFERENCES_ONLY,
    generationUsageReason: 'book cover prompts carry document text; provider image edit only needs binding visual artifacts',
    referenceCount: referenceFiles.length,
    referenceImages: attachmentPaths(referenceFiles),
    referenceFiles,
    blockers: referenceFiles.length ? [] : (spec.blockers || []),
  };
}

function adaptLogoSourceAndNoCopySpec(spec = {}) {
  const split = splitBuyerLogoSourceAndNoCopyReferences(spec.referenceFiles || []);
  if (!split.splitApplied) return spec;
  const sourcePaths = new Set(attachmentPaths(split.sourceReferenceFiles));
  return {
    ...spec,
    originalHash: spec.hash || null,
    hash: hashAttachmentPolicyPayload({
      originalHash: spec.hash || null,
      generationUsage: BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.SOURCE_REFERENCE_WITH_NEGATIVE_NO_COPY,
      sourceReferenceFiles: split.sourceReferenceFiles.map(compactAttachmentRef),
      noCopyReferenceFiles: split.noCopyReferenceFiles.map(compactAttachmentRef),
    }),
    generationUsage: BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.SOURCE_REFERENCE_WITH_NEGATIVE_NO_COPY,
    generationUsageReason: 'logo_source_attachment_with_third_party_no_copy_reference',
    sourceReferenceCount: split.sourceReferenceFiles.length,
    sourceReferenceImages: attachmentPaths(split.sourceReferenceFiles),
    sourceReferenceFiles: split.sourceReferenceFiles,
    noCopyReferenceCount: split.noCopyReferenceFiles.length,
    noCopyReferenceImages: attachmentPaths(split.noCopyReferenceFiles),
    noCopyReferenceFiles: split.noCopyReferenceFiles,
    referenceCount: split.sourceReferenceFiles.length,
    referenceImages: asArray(spec.referenceImages).filter((file) => sourcePaths.has(String(file || ''))),
    referenceFiles: split.sourceReferenceFiles,
    semanticReferenceCount: uniqueAttachmentRefs(spec.semanticReferenceFiles || []).filter((item) => sourcePaths.has(item.path)).length,
    semanticReferenceImages: asArray(spec.semanticReferenceImages).filter((file) => sourcePaths.has(String(file || ''))),
    semanticReferenceFiles: uniqueAttachmentRefs(spec.semanticReferenceFiles || []).filter((item) => sourcePaths.has(item.path)),
  };
}

function adaptLogoNewNoCopySpec(spec = {}, text = '') {
  const policy = logoNewRequestPolicy({ spec, text });
  const splitSourceSpec = adaptLogoSourceAndNoCopySpec(spec);
  if (!policy.hasLogoAttachment || !policy.asksForNewLogo || policy.explicitlyUsesExisting) return splitSourceSpec;
  const noCopyReferenceFiles = uniqueAttachmentRefs([
    ...(splitSourceSpec.referenceFiles || []),
    ...(splitSourceSpec.semanticReferenceFiles || []),
    ...(splitSourceSpec.noCopyReferenceFiles || []),
  ]);
  return {
    ...splitSourceSpec,
    originalHash: splitSourceSpec.hash || null,
    hash: hashAttachmentPolicyPayload({
      originalHash: splitSourceSpec.hash || null,
      generationUsage: BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.NEGATIVE_NO_COPY,
      referenceFiles: noCopyReferenceFiles.map(compactAttachmentRef),
    }),
    required: false,
    generationUsage: BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.NEGATIVE_NO_COPY,
    generationUsageReason: 'logo_brand_new_request_with_logo_attachment',
    noCopyReferenceCount: noCopyReferenceFiles.length,
    noCopyReferenceImages: attachmentPaths(noCopyReferenceFiles),
    noCopyReferenceFiles,
    referenceCount: 0,
    referenceImages: [],
    referenceFiles: [],
    blockers: [],
  };
}

export function adaptBuyerAssetAttachmentSpecForGeneration({
  attachmentSpec = null,
  workflowId = null,
  taskKey = null,
  channelId = null,
  title = '',
  requirementText = '',
  subject = {},
  text = '',
  createdAt = null,
} = {}) {
  if (!attachmentSpec) return attachmentSpec;
  const contextText = composeAttachmentContextText({ title, requirementText, subject, text });
  let spec = attachmentSpec;
  if (spec.required && workflowId === 'catalog_brochure' && isBookCoverAttachmentContext(contextText)) {
    spec = adaptBookCoverAttachmentSpec(spec);
  }
  if (workflowId === 'logo_brand') {
    spec = adaptLogoNewNoCopySpec(spec, contextText);
  }
  const policy = buildBuyerAssetAttachmentPolicy({
    taskKey,
    channelId,
    workflowId,
    attachmentSpec: spec,
    title,
    requirementText,
    subject,
    text: contextText,
    createdAt,
  });
  if (!policy) return spec;
  const { buyerAssetPackage, ...policyWithoutPackage } = policy;
  return {
    ...spec,
    buyerAssetAttachmentPolicy: policyWithoutPackage,
    buyerAssetPackage,
    buyerAssetPackageHash: buyerAssetPackage.buyerAssetPackageHash,
    buyerAssetAttachmentPolicyHash: policy.buyerAssetAttachmentPolicyHash,
  };
}

export function buyerAssetAttachmentContractsSelftest() {
  const sourceLogo = {
    path: 'attachments/source-logo.png',
    filename: '旧LOGO底稿.png',
    sha256: 'sha256:source',
    size: 123,
    originKind: 'image',
  };
  const schoolLogo = {
    path: 'attachments/beihang-reference.png',
    filename: '北航参考校徽.png',
    sha256: 'sha256:no-copy',
    size: 456,
    originKind: 'image',
  };
  const splitSpec = adaptBuyerAssetAttachmentSpecForGeneration({
    workflowId: 'logo_brand',
    channelId: 'zbj',
    title: '基于原有LOGO升级企业标识',
    attachmentSpec: {
      required: true,
      hash: 'sha256:raw',
      referenceImages: [sourceLogo.path, schoolLogo.path],
      referenceFiles: [sourceLogo, schoolLogo],
      semanticReferenceImages: [sourceLogo.path, schoolLogo.path],
      semanticReferenceFiles: [sourceLogo, schoolLogo],
      blockers: [],
    },
  });
  const splitPolicy = splitSpec.buyerAssetAttachmentPolicy;
  const noCopyAsset = splitSpec.buyerAssetPackage.assets.find((item) => item.role === BUYER_ASSET_ROLES.NEGATIVE_NO_COPY);
  if (splitSpec.generationUsage !== BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.SOURCE_REFERENCE_WITH_NEGATIVE_NO_COPY) throw new Error('source/no-copy split generation usage mismatch');
  if (splitSpec.referenceFiles.length !== 1 || splitSpec.noCopyReferenceFiles.length !== 1) throw new Error('source/no-copy split counts mismatch');
  if (!splitPolicy.hasNoCopyReferences || noCopyAsset?.providerInputRequired !== false) throw new Error('no-copy references must remain out of provider input');

  const negativeSpec = adaptBuyerAssetAttachmentSpecForGeneration({
    workflowId: 'logo_brand',
    title: '设计一款全新的企业LOGO',
    attachmentSpec: {
      required: true,
      hash: 'sha256:old',
      referenceImages: [sourceLogo.path],
      referenceFiles: [sourceLogo],
      semanticReferenceImages: [sourceLogo.path],
      semanticReferenceFiles: [sourceLogo],
      blockers: ['attachment_reference_pass_required'],
    },
  });
  if (negativeSpec.required !== false || negativeSpec.referenceFiles.length !== 0) throw new Error('new-logo attachment should become negative no-copy only');
  if (negativeSpec.generationUsage !== BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.NEGATIVE_NO_COPY) throw new Error('new-logo no-copy usage mismatch');

  const bookSpec = adaptBuyerAssetAttachmentSpecForGeneration({
    workflowId: 'catalog_brochure',
    title: '图书封面封四书脊勒口设计 中国社会科学出版社',
    attachmentSpec: {
      required: true,
      hash: 'sha256:book',
      referenceImages: ['cover.png', 'brief.pdf'],
      referenceFiles: [
        { path: 'cover.png', filename: 'cover.png', sha256: 'sha256:cover', originKind: 'image' },
        { path: 'brief.pdf', filename: 'brief.pdf', sha256: 'sha256:brief', originKind: 'pdf' },
      ],
      semanticReferenceFiles: [],
      documentTextSnippets: [{ filename: 'brief.pdf', text: '作者简介', charCount: 4 }],
      blockers: ['attachment_reference_pass_required'],
    },
  });
  if (bookSpec.referenceFiles.length !== 1 || bookSpec.generationUsage !== BUYER_ASSET_ATTACHMENT_GENERATION_USAGE.BOOK_COVER_VISUAL_REFERENCES_ONLY) throw new Error('book-cover visual reference adaptation mismatch');

  const posterPolicy = buildBuyerAssetAttachmentPolicy({
    workflowId: 'poster_design',
    requirementText: '基于附件原海报优化图文排版，不改变内容',
    attachmentSpec: {
      required: true,
      hash: 'sha256:poster',
      referenceImages: ['poster.png'],
      referenceFiles: [{ path: 'poster.png', filename: 'poster.png', sha256: 'sha256:poster-source', originKind: 'image' }],
    },
  });
  if (!posterPolicy.posterContentPreservationPolicy.enabled) throw new Error('poster source-copy preservation policy should be enabled');
  return {
    ok: true,
    version: BUYER_ASSET_ATTACHMENT_POLICY_VERSION,
    splitHash: splitSpec.buyerAssetAttachmentPolicyHash,
    negativeHash: negativeSpec.buyerAssetAttachmentPolicyHash,
    bookHash: bookSpec.buyerAssetAttachmentPolicyHash,
    posterHash: posterPolicy.buyerAssetAttachmentPolicyHash,
  };
}
