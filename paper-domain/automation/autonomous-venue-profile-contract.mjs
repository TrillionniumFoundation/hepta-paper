import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousConfigurationAuthorityProof,
} from './autonomous-configuration-authority-contract.mjs';
import {
  verifyAutonomousSubmissionMetadataProfile,
} from './autonomous-submission-metadata-contract.mjs';
import {
  buildAutonomousVenueTemplateAssetBundle,
  selectAutonomousVenueTemplateAsset,
} from './autonomous-venue-template-asset-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const LATEX_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PROFILE_KEYS_V1 = Object.freeze([
  'acceptedPaperTypes', 'bibliographyStyle', 'citationStyle', 'displayName',
  'documentClass', 'externalSubmissionEnabled', 'kind', 'maximumPages',
  'profileAuthorityReceiptHash', 'protocolFamilies', 'requiredMetadata',
  'submissionPortalProfileId', 'venueId', 'venueProfileHash', 'version',
]);
const PROFILE_KEYS_V2 = Object.freeze([
  ...PROFILE_KEYS_V1,
  'minimumScopeMatchCount', 'scopeTerms',
].sort());
const PROFILE_KEYS_V3 = Object.freeze([
  ...PROFILE_KEYS_V2,
  'requirementSpecification',
].sort());
const REQUIREMENT_SPECIFICATION_KEYS = Object.freeze([
  'anonymousReview', 'artifactPolicy', 'artifactRequired',
  'disclosureRequirements', 'reviewMode', 'sectionLimits',
  'supplementPolicy', 'templateAssetHash', 'wordLimit',
]);
const STRONG_BIBLIOGRAPHY_STYLE = 'inline-evidence-v1';
const STRONG_CITATION_STYLE = 'evidence-inline-v1';
const VENUE_SELECTOR_CONFIGURATION = Object.freeze({
  version: 1,
  kind: 'AutonomousVenueSelectorConfiguration',
  algorithmId: 'scope-fit-constraints-v1',
  algorithmVersion: 1,
  scopeFitWeightMicros: 600_000,
  metadataFitWeightMicros: 200_000,
  formatFitWeightMicros: 100_000,
  submissionFitWeightMicros: 100_000,
  tieBreak: 'total-score-matched-scope-venue-id-v1',
});
export const AUTONOMOUS_VENUE_SELECTOR_CONFIGURATION_HASH = hashRecord(
  'AutonomousVenueSelectorConfiguration',
  VENUE_SELECTOR_CONFIGURATION,
);

function id(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function text(value, maximum = 1_000) {
  const candidate = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return candidate && candidate.length <= maximum ? candidate : null;
}

function ids(values, minimum = 1) {
  if (!Array.isArray(values) || values.length < minimum || values.length > 128) return null;
  const selected = values.map(id);
  if (selected.some((value) => !value) || new Set(selected).size !== selected.length) return null;
  return Object.freeze([...selected].sort());
}

function scopeTerms(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 128) return null;
  const selected = values.map((value) => text(value, 200)?.toLocaleLowerCase('en-US') || null);
  if (selected.some((value) => !value) || new Set(selected).size !== selected.length) return null;
  return Object.freeze([...selected].sort());
}

function texts(values, { maximum = 128, itemMaximum = 2_000 } = {}) {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximum) return null;
  const selected = values.map((value) => text(value, itemMaximum));
  if (selected.some((value) => !value) || new Set(selected).size !== selected.length) return null;
  return Object.freeze(selected);
}

function requirementSectionLimits(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64) return null;
  const selected = values.map((value) => Object.freeze({
    section: id(value?.section),
    maximumWords: Number(value?.maximumWords),
  }));
  if (selected.some((value) => !value.section
    || !Number.isSafeInteger(value.maximumWords) || value.maximumWords < 1)
    || new Set(selected.map((value) => value.section)).size !== selected.length) return null;
  return Object.freeze([...selected].sort((left, right) => (
    left.section.localeCompare(right.section)
  )));
}

function venueRequirementSpecification(value) {
  if (!hasExactObjectKeys(value, REQUIREMENT_SPECIFICATION_KEYS)) return null;
  const payload = {
    anonymousReview: value.anonymousReview === true,
    reviewMode: id(value.reviewMode),
    wordLimit: Number(value.wordLimit),
    sectionLimits: requirementSectionLimits(value.sectionLimits),
    templateAssetHash: String(value.templateAssetHash || '').toLowerCase(),
    supplementPolicy: text(value.supplementPolicy, 2_000),
    artifactRequired: value.artifactRequired === true,
    artifactPolicy: text(value.artifactPolicy, 2_000),
    disclosureRequirements: texts(value.disclosureRequirements),
  };
  return payload.reviewMode
    && Number.isSafeInteger(payload.wordLimit) && payload.wordLimit > 0
    && payload.sectionLimits && SHA256.test(payload.templateAssetHash)
    && payload.supplementPolicy && payload.artifactPolicy
    && payload.disclosureRequirements
    ? Object.freeze(payload) : null;
}

function canonicalInstant(value) {
  const candidate = String(value || '');
  const milliseconds = Date.parse(candidate);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === candidate
    ? candidate : null;
}

function normalizedResearchSurface(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function metadataAvailabilityFromProfile(profile) {
  if (!verifyAutonomousSubmissionMetadataProfile(profile)) return null;
  return Object.freeze([
    'title', 'abstract',
    ...(profile.authors.length ? ['authors'] : []),
    ...(profile.defaultKeywords.length ? ['keywords'] : []),
    ...(profile.conflictOfInterestStatement ? ['conflict_of_interest'] : []),
    ...(profile.fundingStatement ? ['funding'] : []),
    ...(profile.dataAvailabilityStatement ? ['data_availability'] : []),
    ...(profile.codeAvailabilityStatement ? ['code_availability'] : []),
  ].sort());
}

export function buildAutonomousVenueProfile({
  venueId,
  displayName,
  acceptedPaperTypes = ['research_article'],
  protocolFamilies,
  documentClass = 'article',
  bibliographyStyle = 'plain',
  citationStyle = 'numeric',
  maximumPages = null,
  requiredMetadata = ['title', 'abstract', 'keywords', 'authors'],
  submissionPortalProfileId = null,
  externalSubmissionEnabled = false,
  profileAuthorityReceiptHash,
  scopeTerms: selectedScopeTerms = null,
  minimumScopeMatchCount = 1,
  requirementSpecification = null,
} = {}) {
  const profileVersion = requirementSpecification === null
    ? selectedScopeTerms === null ? 1 : 2
    : 3;
  const selectedRequirementSpecification = profileVersion === 3
    ? venueRequirementSpecification(requirementSpecification) : null;
  const payload = {
    version: profileVersion,
    kind: 'AutonomousVenueProfile',
    venueId: id(venueId),
    displayName: text(displayName),
    acceptedPaperTypes: ids(acceptedPaperTypes),
    protocolFamilies: ids(protocolFamilies),
    documentClass: LATEX_ID.test(String(documentClass || '')) ? String(documentClass) : null,
    bibliographyStyle: LATEX_ID.test(String(bibliographyStyle || ''))
      ? String(bibliographyStyle) : null,
    citationStyle: id(citationStyle),
    maximumPages: maximumPages === null ? null : Number(maximumPages),
    requiredMetadata: ids(requiredMetadata),
    submissionPortalProfileId: submissionPortalProfileId === null
      ? null : id(submissionPortalProfileId),
    externalSubmissionEnabled: externalSubmissionEnabled === true,
    profileAuthorityReceiptHash: String(profileAuthorityReceiptHash || '').toLowerCase(),
    ...(profileVersion >= 2 ? {
      scopeTerms: scopeTerms(selectedScopeTerms),
      minimumScopeMatchCount: Number(minimumScopeMatchCount),
    } : {}),
    ...(profileVersion === 3 ? {
      requirementSpecification: selectedRequirementSpecification,
    } : {}),
  };
  if (Object.values(payload).some((value) => value === undefined)
    || !payload.venueId || !payload.displayName || !payload.acceptedPaperTypes
    || !payload.protocolFamilies || !payload.documentClass || !payload.bibliographyStyle
    || !payload.citationStyle || !payload.requiredMetadata
    || !SHA256.test(payload.profileAuthorityReceiptHash)
    || (payload.maximumPages !== null
      && (!Number.isSafeInteger(payload.maximumPages) || payload.maximumPages < 1
        || payload.maximumPages > 1_000))
    || (profileVersion >= 2 && (!payload.scopeTerms
      || !Number.isSafeInteger(payload.minimumScopeMatchCount)
      || payload.minimumScopeMatchCount < 1
      || payload.minimumScopeMatchCount > payload.scopeTerms.length))
    || (profileVersion === 3 && !payload.requirementSpecification)
    || (payload.externalSubmissionEnabled && !payload.submissionPortalProfileId)) {
    throw new Error('autonomous_venue_profile_invalid');
  }
  return Object.freeze({
    ...payload,
    venueProfileHash: hashRecord('AutonomousVenueProfile', payload),
  });
}

export function verifyAutonomousVenueProfile(profile) {
  if (!hasExactObjectKeys(
    profile,
    profile?.version === 3
      ? PROFILE_KEYS_V3 : profile?.version === 2 ? PROFILE_KEYS_V2 : PROFILE_KEYS_V1,
  )) return false;
  try { return JSON.stringify(buildAutonomousVenueProfile(profile)) === JSON.stringify(profile); }
  catch { return false; }
}

export function buildAutonomousVenueProfileRegistry({ registryId, profiles } = {}) {
  const selectedRegistryId = id(registryId);
  if (!selectedRegistryId || !Array.isArray(profiles) || !profiles.length
    || profiles.length > 128 || profiles.some((profile) => !verifyAutonomousVenueProfile(profile))) {
    throw new Error('autonomous_venue_profile_registry_invalid');
  }
  const selected = Object.freeze([...profiles].sort((left, right) => (
    left.venueId.localeCompare(right.venueId)
  )));
  if (new Set(selected.map((profile) => profile.venueId)).size !== selected.length) {
    throw new Error('autonomous_venue_profile_registry_duplicate');
  }
  const versions = new Set(selected.map((profile) => profile.version));
  if (versions.size !== 1) throw new Error('autonomous_venue_profile_registry_mixed_versions');
  const payload = {
    version: selected[0].version,
    kind: 'AutonomousVenueProfileRegistry',
    status: 'autonomous_venue_profile_registry_ready',
    registryId: selectedRegistryId,
    profiles: selected,
    profileCount: selected.length,
  };
  return Object.freeze({
    ...payload,
    autonomousVenueProfileRegistryHash:
      hashRecord('AutonomousVenueProfileRegistry', payload),
  });
}

function buildRankingReceipt({
  registry,
  paperId,
  protocolFamily,
  paperType,
  objective,
  submissionMetadataProfileHash,
  submissionMetadataAuthorityProof,
  registryAuthorityProof,
  venueTemplateAssetBundle,
  availableMetadata: metadata,
  requireExternalSubmission,
} = {}) {
  const surface = ` ${normalizedResearchSurface(
    `${objective} ${protocolFamily.replace(/_/g, ' ')}`,
  )} `;
  const evaluations = registry.profiles.map((profile) => {
    const matchedScopeTerms = profile.scopeTerms.filter((term) => (
      surface.includes(` ${normalizedResearchSurface(term)} `)
    ));
    const missingMetadata = profile.requiredMetadata.filter((field) => !metadata.includes(field));
    const blockers = [];
    if (!profile.protocolFamilies.includes(protocolFamily)) {
      blockers.push('protocol-family-not-covered');
    }
    if (!profile.acceptedPaperTypes.includes(paperType)) blockers.push('paper-type-not-covered');
    if (matchedScopeTerms.length < profile.minimumScopeMatchCount) {
      blockers.push('minimum-scope-fit-not-met');
    }
    if (missingMetadata.length) blockers.push('required-metadata-not-available');
    if (profile.bibliographyStyle !== STRONG_BIBLIOGRAPHY_STYLE
      || profile.citationStyle !== STRONG_CITATION_STYLE) {
      blockers.push('rendering-profile-not-supported');
    }
    if (requireExternalSubmission && (!profile.externalSubmissionEnabled
      || !profile.submissionPortalProfileId)) {
      blockers.push('external-submission-not-supported');
    }
    const scopeFitScoreMicros = Math.floor(
      VENUE_SELECTOR_CONFIGURATION.scopeFitWeightMicros
        * matchedScopeTerms.length / profile.scopeTerms.length,
    );
    const metadataFitScoreMicros = Math.floor(
      VENUE_SELECTOR_CONFIGURATION.metadataFitWeightMicros
        * (profile.requiredMetadata.length - missingMetadata.length)
        / profile.requiredMetadata.length,
    );
    const formatFitScoreMicros = profile.bibliographyStyle === STRONG_BIBLIOGRAPHY_STYLE
      && profile.citationStyle === STRONG_CITATION_STYLE
      ? VENUE_SELECTOR_CONFIGURATION.formatFitWeightMicros : 0;
    const submissionFitScoreMicros = profile.externalSubmissionEnabled
      && profile.submissionPortalProfileId
      ? VENUE_SELECTOR_CONFIGURATION.submissionFitWeightMicros : 0;
    return {
      venueId: profile.venueId,
      venueProfileHash: profile.venueProfileHash,
      eligible: blockers.length === 0,
      blockers: Object.freeze(blockers),
      matchedScopeTerms: Object.freeze(matchedScopeTerms),
      missingMetadata: Object.freeze(missingMetadata),
      scopeFitScoreMicros,
      metadataFitScoreMicros,
      formatFitScoreMicros,
      submissionFitScoreMicros,
      totalScoreMicros: scopeFitScoreMicros + metadataFitScoreMicros
        + formatFitScoreMicros + submissionFitScoreMicros,
      deferredConstraints: Object.freeze(profile.maximumPages === null
        ? [] : ['maximum-pages-post-render-compliance']),
    };
  });
  const ranked = evaluations.filter((candidate) => candidate.eligible).sort((left, right) => (
    right.totalScoreMicros - left.totalScoreMicros
      || right.matchedScopeTerms.length - left.matchedScopeTerms.length
      || left.venueId.localeCompare(right.venueId)
  ));
  if (!ranked.length) throw new Error('autonomous_venue_profile_not_covered');
  const rankByVenue = new Map(ranked.map((candidate, index) => [candidate.venueId, index + 1]));
  const candidateEvaluations = Object.freeze(evaluations.map((candidate) => Object.freeze({
    ...candidate,
    rank: rankByVenue.get(candidate.venueId) || null,
  })).sort((left, right) => left.venueId.localeCompare(right.venueId)));
  const payload = {
    version: 1,
    kind: 'AutonomousVenueProfileRankingReceipt',
    algorithmId: VENUE_SELECTOR_CONFIGURATION.algorithmId,
    algorithmVersion: VENUE_SELECTOR_CONFIGURATION.algorithmVersion,
    selectorConfigurationHash: AUTONOMOUS_VENUE_SELECTOR_CONFIGURATION_HASH,
    registryHash: registry.autonomousVenueProfileRegistryHash,
    ...(venueTemplateAssetBundle ? {
      venueTemplateAssetBundleHash:
        venueTemplateAssetBundle.autonomousVenueTemplateAssetBundleHash,
    } : {}),
    paperId,
    protocolFamily,
    paperType,
    objectiveHash: hashRecord('AutonomousVenueSelectionObjective', { objective }),
    normalizedResearchSurfaceHash: hashRecord(
      'AutonomousVenueNormalizedResearchSurface', { surface },
    ),
    submissionMetadataProfileHash,
    venueAuthorityConfigurationHash: registryAuthorityProof.configurationHash,
    venueAuthorityTrustSetHash: registryAuthorityProof.trustSetHash,
    venueAuthoritySignatureVerificationPolicyHash:
      registryAuthorityProof.signatureVerificationPolicyHash,
    submissionMetadataAuthorityConfigurationHash:
      submissionMetadataAuthorityProof.configurationHash,
    submissionMetadataAuthorityTrustSetHash: submissionMetadataAuthorityProof.trustSetHash,
    submissionMetadataAuthoritySignatureVerificationPolicyHash:
      submissionMetadataAuthorityProof.signatureVerificationPolicyHash,
    availableMetadata: metadata,
    requireExternalSubmission,
    candidateEvaluations,
    selectedVenueId: ranked[0].venueId,
    selectedVenueProfileHash: ranked[0].venueProfileHash,
    eligibleCandidateCount: ranked.length,
    evaluatedCandidateCount: evaluations.length,
    machineRanked: true,
    humanApprovalPerformed: false,
  };
  return Object.freeze({
    ...payload,
    autonomousVenueProfileRankingReceiptHash: hashRecord(
      'AutonomousVenueProfileRankingReceipt', payload,
    ),
  });
}

export function verifyAutonomousVenueProfileRegistry(registry) {
  try {
    return JSON.stringify(buildAutonomousVenueProfileRegistry(registry))
      === JSON.stringify(registry);
  } catch { return false; }
}

export function selectAutonomousVenueProfile({
  registry,
  paperId,
  protocolFamily,
  paperType = 'research_article',
  selectedAt = null,
  objective = null,
  submissionMetadataProfile = null,
  registryAuthorityProof = null,
  submissionMetadataAuthorityProof = null,
  venueTemplateAssetBundle = null,
  requireExternalSubmission = false,
  authorityObservedAt = null,
} = {}) {
  if (!verifyAutonomousVenueProfileRegistry(registry) || !id(paperId)
    || !id(protocolFamily) || !id(paperType)) {
    throw new Error('autonomous_venue_profile_selection_input_invalid');
  }
  const candidates = registry.profiles.filter((profile) => (
    profile.protocolFamilies.includes(protocolFamily)
      && profile.acceptedPaperTypes.includes(paperType)
  ));
  if (!candidates.length) throw new Error('autonomous_venue_profile_not_covered');
  if (registry.version >= 2) {
    let selectedTemplateAssetBundle = null;
    if (registry.version === 3) {
      try {
        selectedTemplateAssetBundle = buildAutonomousVenueTemplateAssetBundle({
          registry,
          assets: venueTemplateAssetBundle?.assets,
        });
      } catch {
        throw new Error('autonomous_venue_profile_template_asset_bundle_invalid');
      }
    }
    const selectedInstant = canonicalInstant(selectedAt);
    const metadata = metadataAvailabilityFromProfile(submissionMetadataProfile);
    const metadataProfileHash = submissionMetadataProfile?.profileHash || null;
    const authorityInstant = canonicalInstant(authorityObservedAt);
    if (!selectedInstant || !text(objective, 8_000)
      || !authorityInstant || !SHA256.test(String(metadataProfileHash || '')) || !metadata
      || !verifyAutonomousConfigurationAuthorityProof(registryAuthorityProof, {
        subjectKind: selectedTemplateAssetBundle
          ? 'AutonomousVenueTemplateAssetBundle' : 'AutonomousVenueProfileRegistry',
        subjectHash: selectedTemplateAssetBundle
          ? selectedTemplateAssetBundle.autonomousVenueTemplateAssetBundleHash
          : registry.autonomousVenueProfileRegistryHash,
        requiredRole: 'venue_profile_authority',
        observedAt: authorityInstant,
      }) || !verifyAutonomousConfigurationAuthorityProof(
        submissionMetadataAuthorityProof,
        {
          subjectKind: 'AutonomousSubmissionMetadataProfile',
          subjectHash: metadataProfileHash,
          requiredRole: 'submission_metadata_authority',
          observedAt: authorityInstant,
        },
      )) {
      throw new Error('autonomous_venue_profile_strong_selection_authority_invalid');
    }
    const rankingReceipt = buildRankingReceipt({
      registry,
      paperId,
      protocolFamily,
      paperType,
      objective: text(objective, 8_000),
      submissionMetadataProfileHash: metadataProfileHash,
      submissionMetadataAuthorityProof,
      registryAuthorityProof,
      venueTemplateAssetBundle: selectedTemplateAssetBundle,
      availableMetadata: metadata,
      requireExternalSubmission: requireExternalSubmission === true,
    });
    const profile = registry.profiles.find((candidate) => (
      candidate.venueId === rankingReceipt.selectedVenueId
    ));
    const venueTemplateAsset = selectedTemplateAssetBundle
      ? selectAutonomousVenueTemplateAsset(selectedTemplateAssetBundle, {
        registry,
        venueId: profile.venueId,
      }) : null;
    const payload = {
      version: 2,
      kind: 'AutonomousVenueProfileSelectionReceipt',
      status: 'autonomous_venue_profile_selected',
      paperId,
      protocolFamily,
      paperType,
      objective: text(objective, 8_000),
      registry,
      registryHash: registry.autonomousVenueProfileRegistryHash,
      ...(selectedTemplateAssetBundle ? {
        venueTemplateAssetBundle: selectedTemplateAssetBundle,
        venueTemplateAssetBundleHash:
          selectedTemplateAssetBundle.autonomousVenueTemplateAssetBundleHash,
        venueTemplateAsset,
      } : {}),
      registryAuthorityProof,
      venueAuthorityConfigurationHash: registryAuthorityProof.configurationHash,
      submissionMetadataProfileHash: metadataProfileHash,
      submissionMetadataProfile,
      submissionMetadataAuthorityProof,
      availableMetadata: metadata,
      requireExternalSubmission: requireExternalSubmission === true,
      rankingReceipt,
      profile,
      venueId: profile.venueId,
      venueProfileHash: profile.venueProfileHash,
      machineSelected: true,
      humanApprovalPerformed: false,
      selectedAt: selectedInstant,
    };
    return Object.freeze({
      ...payload,
      autonomousVenueProfileSelectionReceiptHash:
        hashRecord('AutonomousVenueProfileSelectionReceipt', payload),
    });
  }
  const selectorHash = hashRecord('AutonomousVenueProfileSelector', {
    registryHash: registry.autonomousVenueProfileRegistryHash,
    paperId,
    protocolFamily,
    paperType,
  });
  const profile = candidates[Number.parseInt(selectorHash.slice(-8), 16) % candidates.length];
  const payload = {
    version: 1,
    kind: 'AutonomousVenueProfileSelectionReceipt',
    status: 'autonomous_venue_profile_selected',
    paperId,
    protocolFamily,
    paperType,
    registryHash: registry.autonomousVenueProfileRegistryHash,
    profile,
    venueId: profile.venueId,
    venueProfileHash: profile.venueProfileHash,
    machineSelected: true,
    humanApprovalPerformed: false,
    selectedAt,
  };
  return Object.freeze({
    ...payload,
    autonomousVenueProfileSelectionReceiptHash:
      hashRecord('AutonomousVenueProfileSelectionReceipt', payload),
  });
}

export function verifyAutonomousVenueProfileSelection(selection, {
  registry = null,
  authorityObservedAt = null,
  expectedVenueAuthorityConfigurationHash = null,
  expectedSubmissionMetadataAuthorityConfigurationHash = null,
} = {}) {
  if (selection?.version === 2) {
    try {
      return JSON.stringify(selectAutonomousVenueProfile({
        registry: selection.registry,
        paperId: selection.paperId,
        protocolFamily: selection.protocolFamily,
        paperType: selection.paperType,
        selectedAt: selection.selectedAt,
        objective: selection.objective,
        submissionMetadataProfile: selection.submissionMetadataProfile,
        registryAuthorityProof: selection.registryAuthorityProof,
        submissionMetadataAuthorityProof: selection.submissionMetadataAuthorityProof,
        venueTemplateAssetBundle: selection.venueTemplateAssetBundle || null,
        requireExternalSubmission: selection.requireExternalSubmission,
        authorityObservedAt,
      })) === JSON.stringify(selection)
        && (!registry || registry.autonomousVenueProfileRegistryHash
          === selection.registryHash)
        && (expectedVenueAuthorityConfigurationHash === null
          || expectedVenueAuthorityConfigurationHash
            === selection.venueAuthorityConfigurationHash)
        && (expectedSubmissionMetadataAuthorityConfigurationHash === null
          || expectedSubmissionMetadataAuthorityConfigurationHash
            === selection.submissionMetadataAuthorityProof?.configurationHash);
    } catch { return false; }
  }
  if (!selection || !verifyAutonomousVenueProfile(selection.profile)
    || selection.kind !== 'AutonomousVenueProfileSelectionReceipt'
    || selection.status !== 'autonomous_venue_profile_selected'
    || selection.machineSelected !== true || selection.humanApprovalPerformed !== false
    || selection.venueId !== selection.profile.venueId
    || selection.venueProfileHash !== selection.profile.venueProfileHash) return false;
  const { autonomousVenueProfileSelectionReceiptHash: claimedHash, ...payload } = selection;
  if (hashRecord('AutonomousVenueProfileSelectionReceipt', payload) !== claimedHash) return false;
  if (!registry) return true;
  try {
    return JSON.stringify(selectAutonomousVenueProfile({
      registry,
      paperId: selection.paperId,
      protocolFamily: selection.protocolFamily,
      paperType: selection.paperType,
      selectedAt: selection.selectedAt,
    })) === JSON.stringify(selection);
  } catch { return false; }
}
