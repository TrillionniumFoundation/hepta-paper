import {
  canonicalProductLineId,
  canonicalProductLineIdOrNull,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const DESIGN_REFERENCE_CONTRACT_VERSION = 1;

export const DESIGN_REFERENCE_STATUS = Object.freeze({
  PASS: 'pass_design_reference_spec',
  BLOCKED: 'blocked_design_reference_spec',
});

export const DEFAULT_SOURCE_POLICY = Object.freeze({
  use: 'structure_and_design_grammar_only',
  digestOnly: true,
  rewriteRequired: true,
  mustNotCopy: [
    'third-party marks',
    'exact logos',
    'exact layouts',
    'proprietary fonts',
    'official trade dress',
    'demo dashboards',
    'sample data',
  ],
});

function normalizeSourcePolicy(policy = {}) {
  return {
    use: normalizeText(policy.use || DEFAULT_SOURCE_POLICY.use),
    digestOnly: policy.digestOnly !== false,
    rewriteRequired: policy.rewriteRequired !== false,
    mustNotCopy: uniqueStrings(policy.mustNotCopy || DEFAULT_SOURCE_POLICY.mustNotCopy, 24),
    notes: normalizeText(policy.notes || '') || null,
  };
}

function normalizeSourceHub(sourceHub = {}) {
  return {
    total: Number.isFinite(Number(sourceHub.total)) ? Number(sourceHub.total) : 0,
    resolvedCount: Number.isFinite(Number(sourceHub.resolvedCount)) ? Number(sourceHub.resolvedCount) : 0,
    missingCount: Number.isFinite(Number(sourceHub.missingCount)) ? Number(sourceHub.missingCount) : 0,
    digestCount: Number.isFinite(Number(sourceHub.digestCount)) ? Number(sourceHub.digestCount) : 0,
    digestMode: normalizeText(sourceHub.digestMode || 'digest_only'),
    sourceFlags: {
      heptaDesign: Boolean(sourceHub.sourceFlags?.heptaDesign || sourceHub.heptaDesign),
      openDesignSystems: Boolean(sourceHub.sourceFlags?.openDesignSystems || sourceHub.openDesignSystems),
      officialResearch: Boolean(sourceHub.sourceFlags?.officialResearch || sourceHub.officialResearch),
      publicReferences: Boolean(sourceHub.sourceFlags?.publicReferences || sourceHub.publicReferences),
    },
  };
}

function normalizeDigestEntries(values = []) {
  return (values || []).map((item) => {
    if (typeof item === 'string') {
      return {
        key: normalizeText(item),
        digest: null,
        source: null,
      };
    }
    return {
      key: normalizeText(item?.key || item?.id || item?.name || item?.kind || ''),
      digest: normalizeText(item?.digest || item?.hash || '') || null,
      source: normalizeText(item?.source || item?.path || item?.url || item?.ref || '') || null,
      notes: normalizeText(item?.notes || item?.kind || '') || null,
    };
  }).filter((item) => item.key || item.digest || item.source);
}

function normalizeReferencePackage({
  selectedPackId = null,
  legacyPackId = null,
  industryId = null,
  workflowId = null,
  selectionReason = null,
  candidatePackIds = [],
  sourceHub = {},
  referenceKeys = [],
  referenceSources = [],
  referenceSourceDigests = [],
  sourcePolicy = {},
  designGrammar = [],
  layoutPatterns = [],
  surfacePatterns = [],
  applicationScenes = [],
  materialPreferences = [],
  typographyPreferences = [],
  avoidPatterns = [],
  negativePatterns = [],
  qaChecks = [],
  qaBlockers = [],
  referenceImages = {},
} = {}) {
  return {
    selectedPackId: normalizeText(selectedPackId || legacyPackId || '') || null,
    legacyPackId: normalizeText(legacyPackId || selectedPackId || '') || null,
    industryId: normalizeText(industryId || '') || null,
    workflowId: canonicalProductLineIdOrNull(workflowId),
    selectionReason: normalizeText(selectionReason || '') || null,
    candidatePackIds: uniqueStrings(candidatePackIds, 24),
    sourceHub: normalizeSourceHub(sourceHub),
    referenceKeys: uniqueStrings(referenceKeys, 64),
    referenceSources: normalizeDigestEntries(referenceSources),
    referenceSourceDigests: normalizeDigestEntries(referenceSourceDigests),
    sourcePolicy: normalizeSourcePolicy(sourcePolicy),
    designGrammar: uniqueStrings(designGrammar, 64),
    layoutPatterns: uniqueStrings(layoutPatterns, 64),
    surfacePatterns: uniqueStrings(surfacePatterns, 64),
    applicationScenes: uniqueStrings(applicationScenes, 64),
    materialPreferences: uniqueStrings(materialPreferences, 64),
    typographyPreferences: uniqueStrings(typographyPreferences, 64),
    avoidPatterns: uniqueStrings(avoidPatterns, 64),
    negativePatterns: uniqueStrings(negativePatterns, 64),
    qaChecks: uniqueStrings(qaChecks, 64),
    qaBlockers: uniqueStrings(qaBlockers, 64),
    referenceImages: {
      policy: normalizeText(referenceImages.policy || 'separate_asset_channel'),
      count: Number.isFinite(Number(referenceImages.count)) ? Number(referenceImages.count) : 0,
      notes: normalizeText(referenceImages.notes || '') || null,
    },
  };
}

function blockersForReferencePackage(referencePackage) {
  const blockers = [];
  if (!referencePackage.selectedPackId) blockers.push('reference_package_id_required');
  if (!referencePackage.workflowId) blockers.push('reference_package_workflow_id_required');
  if (!referencePackage.sourcePolicy?.digestOnly) blockers.push('reference_package_digest_only_policy_required');
  if (!referencePackage.sourcePolicy?.rewriteRequired) blockers.push('reference_package_rewrite_policy_required');
  if (!referencePackage.qaChecks.length && !referencePackage.qaBlockers.length) blockers.push('reference_package_qa_rules_required');
  return blockers;
}

export function buildDesignReferenceSpec({
  taskKey = null,
  channelId = null,
  productLineId = null,
  workflowId = null,
  referencePackage = {},
  createdAt = null,
  evidenceRefs = [],
} = {}) {
  const normalizedPackage = normalizeReferencePackage({
    workflowId,
    ...referencePackage,
  });
  const blockers = blockersForReferencePackage(normalizedPackage);
  const spec = {
    version: DESIGN_REFERENCE_CONTRACT_VERSION,
    kind: 'DesignReferenceSpec',
    status: blockers.length ? DESIGN_REFERENCE_STATUS.BLOCKED : DESIGN_REFERENCE_STATUS.PASS,
    ok: blockers.length === 0,
    taskKey: normalizeText(taskKey || '') || null,
    channelId: normalizeText(channelId || '') || null,
    productLineId: canonicalProductLineIdOrNull(productLineId),
    workflowId: canonicalProductLineIdOrNull(workflowId || normalizedPackage.workflowId),
    referencePackage: normalizedPackage,
    blockers,
    evidenceRefs: normalizeDigestEntries(evidenceRefs),
    safety: {
      designGrammarOnly: true,
      copiesThirdPartyAssets: false,
      requiresRewrite: true,
      imageRefsSeparateFromSourceDigests: true,
      executesExternalAction: false,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const referencePackageHash = digest({
    kind: spec.kind,
    taskKey: spec.taskKey,
    channelId: spec.channelId,
    productLineId: spec.productLineId,
    workflowId: spec.workflowId,
    referencePackage: spec.referencePackage,
    blockers: spec.blockers,
    safety: spec.safety,
  });
  return {
    ...spec,
    referencePackageHash,
    designReferenceSpecHash: referencePackageHash,
    hash: referencePackageHash,
  };
}

export function summarizeDesignReferenceSpecs(specs = []) {
  const byStatus = {};
  const byWorkflow = {};
  for (const spec of specs || []) {
    byStatus[spec.status || 'unknown'] = (byStatus[spec.status || 'unknown'] || 0) + 1;
    const workflowId = canonicalProductLineIdOrNull(spec.workflowId) || 'unknown';
    byWorkflow[workflowId] = (byWorkflow[workflowId] || 0) + 1;
  }
  return {
    version: DESIGN_REFERENCE_CONTRACT_VERSION,
    count: specs.length,
    byStatus,
    byWorkflow,
    blocked: specs.filter((spec) => spec.blockers?.length).length,
    executesExternalAction: false,
  };
}
