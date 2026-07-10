import { normalizeText, uniqueStrings } from './contracts.mjs';
import { buildDesignReferenceSpec } from './design-reference-contracts.mjs';

export const DESIGN_REFERENCE_ADAPTER_VERSION = 1;

function list(value, limit = 64) {
  return uniqueStrings(Array.isArray(value) ? value : (value ? [value] : []), limit);
}

function sourceHubFromLegacy(legacy = {}, referencePackage = {}) {
  const referenceStatus = legacy.referenceSourceStatus || {};
  const sourcePolicy = referencePackage.sourcePolicy || legacy.sourcePolicy || {};
  const sourceHub = referencePackage.sourceHub || legacy.sourceHub || {};
  return {
    total: sourceHub.total ?? referenceStatus.total ?? 0,
    resolvedCount: sourceHub.resolvedCount ?? referenceStatus.resolvedCount ?? 0,
    missingCount: sourceHub.missingCount ?? referenceStatus.missingCount ?? 0,
    digestCount: sourceHub.digestCount ?? referenceStatus.digestCount ?? 0,
    digestMode: sourceHub.digestMode ?? referenceStatus.digestMode ?? sourcePolicy.sourceDigestMode ?? 'digest_only',
    sourceFlags: {
      heptaDesign: true,
      openDesignSystems: true,
      officialResearch: (legacy.referenceKeys || []).some((item) => /^official:/i.test(String(item || ''))),
      publicReferences: true,
      ...sourceHub.sourceFlags,
    },
  };
}

function sourcePolicyFromLegacy(legacy = {}, referencePackage = {}) {
  const policy = referencePackage.sourcePolicy || legacy.sourcePolicy || {};
  return {
    use: policy.use || policy.allowedUse || 'structure_and_design_grammar_only',
    digestOnly: policy.digestOnly !== false,
    rewriteRequired: policy.rewriteRequired !== false,
    mustNotCopy: list(policy.mustNotCopy || policy.mustNotCopyPatterns, 24),
    notes: policy.notes || policy.rewriteAs || null,
  };
}

function referenceSourcesFromLegacy(legacy = {}, referencePackage = {}) {
  const sources = referencePackage.referenceSources || legacy.referenceSources || [];
  return (sources || []).map((item) => ({
    key: item.key || item.sourceId || item.id || item.source || null,
    digest: item.digest || item.hash || null,
    source: item.source || item.path || item.homepageUrl || item.repoUrl || item.docsUrl || null,
    notes: item.reason || item.notes || item.allowedUse || null,
  }));
}

function referenceDigestsFromLegacy(legacy = {}, referencePackage = {}) {
  const digests = referencePackage.referenceSourceDigests || legacy.referenceSourceDigests || [];
  return (digests || []).map((item) => ({
    key: item.key || item.sourceKey || item.sourceId || item.id || item.source || null,
    digest: item.digest || item.hash || item.summary || item.text || null,
    source: item.source || item.path || null,
    notes: item.notes || item.summary || null,
  }));
}

function candidatePackIds({ legacy = {}, referencePackage = {}, retrieval = {} } = {}) {
  return uniqueStrings([
    referencePackage.selectedPackId,
    referencePackage.legacyPackId,
    legacy.id,
    retrieval.selectedRefpackId,
    retrieval.staticRefpackId,
    retrieval.topRefpackId,
    ...(referencePackage.candidatePackIds || []),
    ...(legacy.candidatePackIds || []),
    ...(retrieval.broad?.candidates || []).map((item) => item.refpackId),
    ...(retrieval.strict?.candidates || []).map((item) => item.refpackId),
  ].filter(Boolean), 24);
}

function referencePackageFromLegacy({ legacySpec = {}, retrieval = {}, workflowId = null } = {}) {
  const legacy = legacySpec || {};
  const referencePackage = legacy.referencePackage || {};
  return {
    selectedPackId: referencePackage.selectedPackId || referencePackage.id || legacy.id || retrieval.selectedRefpackId || null,
    legacyPackId: referencePackage.legacyPackId || legacy.id || retrieval.selectedRefpackId || null,
    industryId: referencePackage.industryId || legacy.industryId || retrieval.selectedIndustryId || null,
    workflowId: referencePackage.workflowId || legacy.workflowId || workflowId || retrieval.workflowId || null,
    selectionReason: referencePackage.selectionReason || legacy.selectionReason || retrieval.selectionReason || null,
    candidatePackIds: candidatePackIds({ legacy, referencePackage, retrieval }),
    sourceHub: sourceHubFromLegacy(legacy, referencePackage),
    referenceKeys: list(referencePackage.referenceKeys || legacy.referenceKeys, 64),
    referenceSources: referenceSourcesFromLegacy(legacy, referencePackage),
    referenceSourceDigests: referenceDigestsFromLegacy(legacy, referencePackage),
    sourcePolicy: sourcePolicyFromLegacy(legacy, referencePackage),
    designGrammar: list(referencePackage.designGrammar || legacy.designGrammar, 64),
    layoutPatterns: list(referencePackage.layoutPatterns || legacy.layoutPatterns || legacy.layoutPreferences, 64),
    surfacePatterns: list(referencePackage.surfacePatterns || legacy.surfacePatterns, 64),
    applicationScenes: list(referencePackage.applicationScenes || legacy.applicationScenes, 64),
    materialPreferences: list(referencePackage.materialPreferences || legacy.materialPreferences, 64),
    typographyPreferences: list(referencePackage.typographyPreferences || legacy.typographyPreferences, 64),
    avoidPatterns: list(referencePackage.avoidPatterns || legacy.avoidPatterns, 64),
    negativePatterns: list(referencePackage.negativePatterns || legacy.negativePatterns, 64),
    qaChecks: list(referencePackage.qaChecks || legacy.qaChecks, 64),
    qaBlockers: list(referencePackage.qaBlockers || legacy.qaBlockers, 64),
    referenceImages: {
      policy: normalizeText(referencePackage.referenceImages?.policy || legacy.referenceImages?.policy || 'separate_asset_channel'),
      count: referencePackage.referenceImages?.count ?? legacy.referenceImages?.count ?? 0,
      notes: referencePackage.referenceImages?.notes || legacy.referenceImages?.notes || null,
    },
  };
}

export function convertLegacyDesignReferenceSpecToCore({
  taskKey = null,
  channelId = null,
  productLineId = null,
  workflowId = null,
  legacySpec = {},
  retrieval = {},
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const spec = buildDesignReferenceSpec({
    taskKey,
    channelId,
    productLineId,
    workflowId: workflowId || legacySpec?.workflowId || retrieval?.workflowId || null,
    referencePackage: referencePackageFromLegacy({ legacySpec, retrieval, workflowId }),
    evidenceRefs,
    createdAt,
  });
  return {
    ...spec,
    adapter: {
      version: DESIGN_REFERENCE_ADAPTER_VERSION,
      source: 'legacy_design_reference_spec',
      legacySpecId: legacySpec?.id || null,
      retrievalHash: retrieval?.retrievalHash || null,
      selectionReason: retrieval?.selectionReason || legacySpec?.selectionReason || null,
      executesExternalAction: false,
    },
  };
}

export function summarizeLegacyDesignReferenceConversions(specs = []) {
  const byChannel = {};
  const byStatus = {};
  for (const spec of specs || []) {
    byChannel[spec.channelId || 'unknown'] = (byChannel[spec.channelId || 'unknown'] || 0) + 1;
    byStatus[spec.status || 'unknown'] = (byStatus[spec.status || 'unknown'] || 0) + 1;
  }
  return {
    version: DESIGN_REFERENCE_ADAPTER_VERSION,
    count: specs.length,
    blocked: specs.filter((spec) => spec.blockers?.length).length,
    byChannel,
    byStatus,
    safety: {
      executesExternalAction: false,
      callsProvider: false,
      opensBrowser: false,
    },
  };
}
