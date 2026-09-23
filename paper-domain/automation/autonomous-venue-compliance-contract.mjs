import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { verifyAutonomousVenueProfileSelection } from './autonomous-venue-profile-contract.mjs';
import {
  verifyAutonomousSubmissionMetadataReceipt,
} from './autonomous-submission-metadata-contract.mjs';
import {
  PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
  verifyAutonomousResearchReleaseBinding,
} from './autonomous-research-release-binding-contract.mjs';
import { verifyEvidenceBoundManuscriptIr } from '../research/evidence-bound-manuscript-ir.mjs';
import { verifyPriorArtEvidenceReceipt } from '../research/prior-art-evidence-contract.mjs';
import { verifyVenueRequirementIr } from './venue-requirement-ir.mjs';
import { verifyResearchAgendaIr } from './research-agenda-ir.mjs';
import {
  deriveVenueRequirementObservationsFromSourceEvidence,
  verifyAutonomousVenueSourceEvidenceBundle,
} from './autonomous-venue-source-evidence-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const SUPPORTED_METADATA = new Set([
  'abstract', 'authors', 'code_availability', 'conflict_of_interest', 'data_availability',
  'funding', 'keywords', 'title',
]);
const VENUE_REQUIREMENT_OBSERVATION_KEYS = Object.freeze([
  'anonymousReviewSatisfied', 'artifactPolicy', 'artifactPolicySatisfied',
  'artifactPresent', 'bibliographyStyle', 'citationStyle', 'disclosureRequirements',
  'documentClass', 'kind', 'pageCount', 'reviewMode',
  'metadataPresent', 'satisfiedDisclosureRequirements', 'sectionWordCounts',
  'sourceEvidenceBundleHash', 'sourceInspectionReceiptHash', 'supplementPolicy',
  'supplementPolicySatisfied', 'templateAssetHash', 'templateAssetPresent',
  'totalWordCount', 'venueRequirementIrFileHash', 'venueRequirementIrHash',
  'venueRequirementObservationHash', 'version',
]);

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function validIr(ir) {
  const { evidenceBoundManuscriptIrHash: claimedHash, ...payload } = ir || {};
  return sha(claimedHash)
    && hashRecord('EvidenceBoundManuscriptIR', payload) === claimedHash
    && ir.status === 'evidence_bound_manuscript_ir_verified'
    && Array.isArray(ir.sections) && ir.sections.length >= 3;
}

function validHashedRecord(value, type, hashKey) {
  const { [hashKey]: claimedHash, ...payload } = value || {};
  return Boolean(sha(claimedHash) && hashRecord(type, payload) === claimedHash);
}

export function buildVenueRequirementObservations({
  venueRequirementIr,
  sourceEvidenceBundle,
  releaseBinding = null,
  releaseBundle = null,
} = {}) {
  const derived = deriveVenueRequirementObservationsFromSourceEvidence({
    sourceEvidenceBundle,
    venueRequirementIr,
    releaseBinding,
    releaseBundle,
  });
  const {
    pageCount,
    documentClass,
    bibliographyStyle,
    citationStyle,
    totalWordCount,
    sectionWordCounts,
    anonymousReviewSatisfied,
    reviewMode,
    templateAssetPresent,
    supplementPolicySatisfied,
    artifactPresent,
    artifactPolicySatisfied,
    metadataPresent,
    satisfiedDisclosureRequirements,
  } = derived;
  const sections = Array.isArray(sectionWordCounts)
    ? sectionWordCounts.map((entry) => Object.freeze({
      section: String(entry?.section || ''),
      wordCount: Number(entry?.wordCount),
    })).sort((left, right) => left.section.localeCompare(right.section)) : [];
  const disclosures = Array.isArray(satisfiedDisclosureRequirements)
    ? [...satisfiedDisclosureRequirements].map(String).sort() : [];
  const presentMetadata = Array.isArray(metadataPresent)
    ? [...metadataPresent].map(String).sort() : [];
  if (venueRequirementIr?.kind !== 'VenueRequirementIR'
    || !sha(venueRequirementIr?.venueRequirementIrHash)
    || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100_000
    || !SAFE_ID.test(String(documentClass || ''))
    || !SAFE_ID.test(String(bibliographyStyle || ''))
    || !SAFE_ID.test(String(citationStyle || ''))
    || !Number.isSafeInteger(totalWordCount) || totalWordCount < 0
    || sections.some((entry) => !SAFE_ID.test(entry.section)
      || !Number.isSafeInteger(entry.wordCount) || entry.wordCount < 0)
    || new Set(sections.map((entry) => entry.section)).size !== sections.length
    || disclosures.length !== new Set(disclosures).size
    || disclosures.some((entry) => !venueRequirementIr.disclosureRequirements.includes(entry))
    || ![venueRequirementIr.reviewMode].includes(String(reviewMode || ''))
    || !sha(sourceEvidenceBundle?.autonomousVenueSourceEvidenceBundleHash)
    || !sha(sourceEvidenceBundle?.sourceInspectionReceiptHash)) {
    throw new Error('venue_requirement_observations_invalid');
  }
  const payload = {
    version: 2,
    kind: 'VenueRequirementObservations',
    venueRequirementIrHash: venueRequirementIr.venueRequirementIrHash,
    pageCount,
    documentClass,
    bibliographyStyle,
    citationStyle,
    totalWordCount,
    sectionWordCounts: Object.freeze(sections),
    anonymousReviewSatisfied: anonymousReviewSatisfied === true,
    reviewMode: venueRequirementIr.reviewMode,
    templateAssetHash: venueRequirementIr.templateAssetHash,
    templateAssetPresent: templateAssetPresent === true,
    supplementPolicy: venueRequirementIr.supplementPolicy,
    supplementPolicySatisfied: supplementPolicySatisfied === true,
    artifactPresent: artifactPresent === true,
    artifactPolicy: venueRequirementIr.artifactPolicy,
    artifactPolicySatisfied: artifactPolicySatisfied === true,
    metadataPresent: Object.freeze(presentMetadata),
    disclosureRequirements: venueRequirementIr.disclosureRequirements,
    satisfiedDisclosureRequirements: Object.freeze(disclosures),
    venueRequirementIrFileHash: sourceEvidenceBundle.venueRequirementIrFileHash,
    sourceEvidenceBundleHash:
      sourceEvidenceBundle.autonomousVenueSourceEvidenceBundleHash,
    sourceInspectionReceiptHash: sourceEvidenceBundle.sourceInspectionReceiptHash,
  };
  return Object.freeze({
    ...payload,
    venueRequirementObservationHash:
      hashRecord('VenueRequirementObservations', payload),
  });
}

function verifyVenueRequirementObservations(observations, venueRequirementIr, context = {}) {
  if (!hasExactObjectKeys(observations, VENUE_REQUIREMENT_OBSERVATION_KEYS)
    || !validHashedRecord(
      observations,
      'VenueRequirementObservations',
      'venueRequirementObservationHash',
    )) return false;
  try {
    return JSON.stringify(buildVenueRequirementObservations({
      venueRequirementIr,
      sourceEvidenceBundle: context.sourceEvidenceBundle,
      releaseBinding: context.releaseBinding || null,
      releaseBundle: context.releaseBundle || null,
    })) === JSON.stringify(observations);
  } catch { return false; }
}

function recursiveVenueComplianceSemanticsValid(receipt, {
  releaseBundle,
  releaseBinding,
} = {}) {
  const selection = releaseBinding?.venueProfileSelection || null;
  const profile = selection?.profile || null;
  const packageOutput = releaseBundle?.packageOutput || null;
  const observations = receipt?.venueRequirementObservations || null;
  const venueRequirementIr = receipt?.venueRequirementIr || null;
  const sectionWords = new Map((observations?.sectionWordCounts || []).map((entry) => (
    [entry.section, entry.wordCount]
  )));
  const requiredDisclosures = [...(venueRequirementIr?.disclosureRequirements || [])].sort();
  return releaseBinding?.version === 4
    && releaseBundle?.venueTarget === selection?.venueId
    && receipt?.venueId === selection?.venueId
    && receipt?.venueProfileHash === selection?.venueProfileHash
    && receipt?.venueProfileSelectionHash
      === selection?.autonomousVenueProfileSelectionReceiptHash
    && receipt?.venueProfileRankingReceiptHash
      === selection?.rankingReceipt?.autonomousVenueProfileRankingReceiptHash
    && receipt?.venueSelectorConfigurationHash
      === selection?.rankingReceipt?.selectorConfigurationHash
    && receipt?.venueAuthorityConfigurationHash
      === selection?.venueAuthorityConfigurationHash
    && receipt?.submissionMetadataReceiptHash
      === releaseBinding?.submissionMetadataReceiptHash
    && receipt?.researchAgendaIrHash === releaseBinding?.researchAgendaIrHash
    && JSON.stringify(receipt?.researchAgendaIr)
      === JSON.stringify(releaseBinding?.researchAgendaIr)
    && receipt?.venueRequirementIrHash === releaseBinding?.venueRequirementIrHash
    && JSON.stringify(venueRequirementIr)
      === JSON.stringify(releaseBinding?.venueRequirementIr)
    && receipt?.immutableCampaignPackageOutputHash
      === packageOutput?.immutableCampaignPackageOutputHash
    && receipt?.packageVerificationReceiptHash
      === packageOutput?.packageVerificationReceiptHash
    && receipt?.sourceArchiveHash === packageOutput?.sourceZipHash
    && receipt?.compiledPdfHash === packageOutput?.authoritativeCompiledPdfHash
    && receipt?.independentRebuiltPdfHash === packageOutput?.independentRebuiltPdfHash
    && receipt?.pdfInfoReceiptHash
      === receipt?.sourceEvidenceBundle?.pdfInspectionReceiptHash
    && receipt?.pdfInfoToolIdentityHash
      === receipt?.sourceEvidenceBundle?.pdfInspectionReceipt?.parserPolicyHash
    && receipt?.renderedSourceHash === releaseBinding?.renderedManuscriptHash
    && receipt?.trustedAutonomousManuscriptRenderReceiptHash
      === releaseBinding?.trustedAutonomousManuscriptRenderReceiptHash
    && receipt?.evidenceBoundManuscriptIrHash
      === releaseBinding?.evidenceBoundManuscriptIrHash
    && receipt?.manuscriptIrFileHash === releaseBinding?.manuscriptIrFileHash
    && receipt?.manuscriptProductionMode === releaseBinding?.manuscriptProductionMode
    && receipt?.qualificationScope === releaseBinding?.qualificationScope
    && receipt?.agentExecutionReceiptHash === releaseBinding?.agentExecutionReceiptHash
    && receipt?.isolatedAgentMergeReceiptHash
      === releaseBinding?.isolatedAgentMergeReceiptHash
    && receipt?.agentAuthoredSourceDraftHash
      === releaseBinding?.agentAuthoredSourceDraftHash
    && receipt?.agentAuthoredSourceDraftFileHash
      === releaseBinding?.agentAuthoredSourceDraftFileHash
    && receipt?.agentWorkspacePostimageBindingHash
      === releaseBinding?.agentWorkspacePostimageBindingHash
    && receipt?.priorArtEvidenceReceiptHash === releaseBinding?.priorArtEvidenceReceiptHash
    && receipt?.seedBundleHash
      === releaseBinding?.trustedAutonomousManuscriptRenderReceipt?.seedBundleHash
    && receipt?.documentClass === profile?.documentClass
    && receipt?.bibliographyStyle === profile?.bibliographyStyle
    && receipt?.citationStyle === profile?.citationStyle
    && receipt?.pageCount === observations?.pageCount
    && receipt?.documentClass === observations?.documentClass
    && receipt?.bibliographyStyle === observations?.bibliographyStyle
    && receipt?.citationStyle === observations?.citationStyle
    && receipt?.maximumPages === profile?.maximumPages
    && Number.isSafeInteger(receipt?.pageCount) && receipt.pageCount > 0
    && (profile?.maximumPages === null || receipt.pageCount <= profile.maximumPages)
    && JSON.stringify(receipt?.requiredMetadata)
      === JSON.stringify(profile?.requiredMetadata)
    && profile?.requiredMetadata?.every((field) => (
      observations?.metadataPresent?.includes(field)
    ))
    && Number.isSafeInteger(observations?.totalWordCount)
    && observations.totalWordCount <= venueRequirementIr?.wordLimit
    && venueRequirementIr?.sectionLimits?.every((limit) => (
      sectionWords.has(limit.section) && sectionWords.get(limit.section) <= limit.maximumWords
    ))
    && (venueRequirementIr?.anonymousReview !== true
      || observations?.anonymousReviewSatisfied === true)
    && observations?.reviewMode === venueRequirementIr?.reviewMode
    && observations?.templateAssetPresent === true
    && observations?.supplementPolicySatisfied === true
    && (venueRequirementIr?.artifactRequired !== true
      || observations?.artifactPresent === true)
    && observations?.artifactPolicySatisfied === true
    && JSON.stringify(observations?.satisfiedDisclosureRequirements)
      === JSON.stringify(requiredDisclosures)
    && receipt?.machineVerified === true
    && receipt?.humanApprovalPerformed === false
    && receipt?.externalActionPerformed === false
    && receipt?.inspectedAt === releaseBundle?.createdAt
    && [
      receipt?.sourceInspectionReceiptHash,
      receipt?.pdfInfoToolIdentityHash,
      receipt?.pdfInfoReceiptHash,
    ].every(sha);
}

export function buildAutonomousVenueComplianceReceipt({
  venueProfileSelection,
  submissionMetadataReceipt,
  campaignReleaseAuthority,
  manuscriptIr,
  manuscriptIrFileHash,
  priorArtReceipt,
  seedBundle,
  agentExecutionReceipt,
  renderedSourceHash,
  sourceArchiveHash,
  compiledPdfHash,
  independentRebuiltPdfHash,
  sourceInspectionReceiptHash,
  pdfInfoToolIdentityHash,
  pdfInfoReceiptHash,
  pageCount,
  documentClass,
  bibliographyStyle = 'inline-evidence-v1',
  citationStyle = 'evidence-inline-v1',
  metadataPresent = [],
  sourceEvidenceBundle = null,
  venueRequirementObservations = null,
  inspectedAt,
} = {}) {
  const releaseBundle = campaignReleaseAuthority?.releaseBundle || null;
  const packageOutput = releaseBundle?.packageOutput || null;
  const releaseBinding = releaseBundle?.autonomousResearchReleaseBinding || null;
  const sourceTreeManifest = releaseBundle?.promotionCandidate?.sourceTreeManifest || null;
  const releaseBindingVerification = verifyAutonomousResearchReleaseBinding(releaseBinding, {
    campaignId: campaignReleaseAuthority?.campaignId,
    paperId: campaignReleaseAuthority?.paperId,
    campaignPlanHash: releaseBundle?.campaignPlanHash,
    authorityObservedAt: inspectedAt,
  });
  const recursiveClosureSource = releaseBinding?.version === 4;
  const researchAgendaIr = recursiveClosureSource
    ? releaseBinding?.researchAgendaIr || null : null;
  const venueRequirementIr = recursiveClosureSource
    ? releaseBinding?.venueRequirementIr || null : null;
  const venueRequirementIrValid = !recursiveClosureSource || (
    verifyResearchAgendaIr(researchAgendaIr, {
      agendaProductionReceipt: releaseBinding?.researchAgendaProductionReceipt,
    })
    && verifyVenueRequirementIr(venueRequirementIr, {
      researchAgendaIr,
      venueProfile: venueProfileSelection?.profile || null,
      venueProfileSelection,
      expectedVenueProfileRegistryHash: venueProfileSelection?.registryHash || null,
      expectedVenueAuthorityConfigurationHash:
        venueProfileSelection?.venueAuthorityConfigurationHash || null,
    })
    && releaseBinding?.researchAgendaIrHash === researchAgendaIr?.researchAgendaIrHash
    && releaseBinding?.venueRequirementIrHash
      === venueRequirementIr?.venueRequirementIrHash
  );
  const sourceTreeManifestValid = !recursiveClosureSource || (
    sourceTreeManifest?.status === 'scoped_source_tree_verified'
    && validHashedRecord(
      sourceTreeManifest,
      'ScopedSourceTreeManifest',
      'sourceTreeManifestHash',
    )
    && releaseBundle?.sourceTreeManifestHash === sourceTreeManifest?.sourceTreeManifestHash
  );
  const sourceEvidenceValid = !recursiveClosureSource
    || verifyAutonomousVenueSourceEvidenceBundle(sourceEvidenceBundle, {
      venueRequirementIr,
      releaseBinding,
      releaseBundle,
    });
  let canonicalVenueRequirementObservations = null;
  if (recursiveClosureSource && sourceEvidenceValid) {
    try {
      canonicalVenueRequirementObservations = buildVenueRequirementObservations({
        venueRequirementIr,
        sourceEvidenceBundle,
        releaseBinding,
        releaseBundle,
      });
    } catch { canonicalVenueRequirementObservations = null; }
  }
  const venueRequirementObservationsValid = !recursiveClosureSource || (
    canonicalVenueRequirementObservations !== null
    && (venueRequirementObservations === null
      || JSON.stringify(venueRequirementObservations)
        === JSON.stringify(canonicalVenueRequirementObservations))
  );
  const effectiveVenueRequirementObservations = recursiveClosureSource
    ? canonicalVenueRequirementObservations : null;
  const effectivePageCount = recursiveClosureSource
    ? effectiveVenueRequirementObservations?.pageCount : pageCount;
  const effectiveDocumentClass = recursiveClosureSource
    ? effectiveVenueRequirementObservations?.documentClass : documentClass;
  const effectiveBibliographyStyle = recursiveClosureSource
    ? effectiveVenueRequirementObservations?.bibliographyStyle : bibliographyStyle;
  const effectiveCitationStyle = recursiveClosureSource
    ? effectiveVenueRequirementObservations?.citationStyle : citationStyle;
  const present = Object.freeze(recursiveClosureSource
    ? [...(effectiveVenueRequirementObservations?.metadataPresent || [])]
    : [...metadataPresent].sort());
  const priorArtVerification = verifyPriorArtEvidenceReceipt(priorArtReceipt, {
    paperId: venueProfileSelection?.paperId,
  });
  const manuscriptIrVerification = verifyEvidenceBoundManuscriptIr(manuscriptIr, {
    paperId: venueProfileSelection?.paperId,
    authorityBindings: manuscriptIr?.authorityBindings,
    priorArtReceipt,
    agentExecutionReceipt,
    requireAgentAuthoredProse: true,
  });
  const { autonomousResearchSeedContractBundleHash: seedHash, ...seedPayload } = seedBundle || {};
  if (!verifyAutonomousVenueProfileSelection(venueProfileSelection, {
    authorityObservedAt: inspectedAt,
  })
    || venueProfileSelection.profile.externalSubmissionEnabled !== true
    || !verifyAutonomousSubmissionMetadataReceipt(submissionMetadataReceipt, {
      paperId: venueProfileSelection.paperId,
      protocolFamily: venueProfileSelection.protocolFamily,
      authorityObservedAt: inspectedAt,
    }) || campaignReleaseAuthority?.status !== 'current_completed_release'
    || campaignReleaseAuthority?.paperId !== venueProfileSelection.paperId
    || releaseBundle?.version !== 1 || releaseBundle?.kind !== 'CampaignReleaseBundle'
    || releaseBundle?.status !== 'campaign_release_bundle_prepared'
    || packageOutput?.version !== 1 || packageOutput?.kind !== 'ImmutableCampaignPackageOutput'
    || packageOutput?.immutable !== true
    || releaseBundle?.campaignReleaseBundleHash
      !== campaignReleaseAuthority?.campaignReleaseBundleHash
    || !validHashedRecord(
      releaseBundle,
      'CampaignReleaseBundle',
      'campaignReleaseBundleHash',
    )
    || !validHashedRecord(
      packageOutput,
      'ImmutableCampaignPackageOutput',
      'immutableCampaignPackageOutputHash',
    )
    || releaseBundle?.immutableCampaignPackageOutputHash
      !== packageOutput?.immutableCampaignPackageOutputHash
    || !validIr(manuscriptIr) || !manuscriptIrVerification.valid
    || !priorArtVerification.valid
    || !sha(seedHash)
    || hashRecord('AutonomousResearchSeedContractBundle', seedPayload) !== seedHash
    || !releaseBindingVerification.valid
    || !venueRequirementIrValid
    || !venueRequirementObservationsValid
    || !sourceTreeManifestValid
    || !sourceEvidenceValid
    || releaseBinding?.qualificationScope
      !== PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE
    || releaseBinding?.fullResearchQualificationEligible !== true
    || releaseBinding?.externalSubmissionEligible !== true
    || releaseBinding?.venueProfileSelectionHash
      !== venueProfileSelection.autonomousVenueProfileSelectionReceiptHash
    || releaseBinding?.venueProfileRankingReceiptHash
      !== venueProfileSelection.rankingReceipt?.autonomousVenueProfileRankingReceiptHash
    || releaseBinding?.venueSelectorConfigurationHash
      !== venueProfileSelection.rankingReceipt?.selectorConfigurationHash
    || releaseBinding?.venueAuthorityConfigurationHash
      !== venueProfileSelection.venueAuthorityConfigurationHash
    || releaseBinding?.submissionMetadataReceiptHash
      !== submissionMetadataReceipt.autonomousSubmissionMetadataReceiptHash
    || JSON.stringify(releaseBinding?.venueProfileSelection)
      !== JSON.stringify(venueProfileSelection)
    || JSON.stringify(releaseBinding?.submissionMetadataReceipt)
      !== JSON.stringify(submissionMetadataReceipt)
    || releaseBinding?.evidenceBoundManuscriptIrHash
      !== manuscriptIr?.evidenceBoundManuscriptIrHash
    || releaseBinding?.manuscriptIrFileHash !== manuscriptIrFileHash
    || releaseBinding?.renderedManuscriptHash !== renderedSourceHash
    || (recursiveClosureSource && (
      sourceEvidenceBundle?.sourceInspectionReceipt?.renderedSourceHash
        !== renderedSourceHash
      || sourceEvidenceBundle?.sourceInspectionReceipt?.sourceArchiveHash
        !== sourceArchiveHash
      || sourceEvidenceBundle?.sourceInspectionReceiptHash
        !== sourceInspectionReceiptHash
      || sourceEvidenceBundle?.manuscriptIrFileHash !== manuscriptIrFileHash
      || sourceEvidenceBundle?.venueRequirementIrFileHash
        !== releaseBinding?.trustedAutonomousManuscriptRenderReceipt
          ?.venueRequirementIrFileHash
      || sourceEvidenceBundle?.evidenceBoundManuscriptIrHash
        !== manuscriptIr?.evidenceBoundManuscriptIrHash
      || sourceEvidenceBundle?.pdfInspectionReceipt?.pageCount !== pageCount
      || sourceEvidenceBundle?.pdfInspectionReceipt?.compiledPdfHash !== compiledPdfHash
      || sourceEvidenceBundle?.pdfInspectionReceiptHash !== pdfInfoReceiptHash
      || sourceEvidenceBundle?.pdfInspectionReceipt?.parserPolicyHash
        !== pdfInfoToolIdentityHash
      || effectiveDocumentClass !== documentClass
      || effectiveBibliographyStyle !== bibliographyStyle
      || effectiveCitationStyle !== citationStyle
      || JSON.stringify(sourceEvidenceBundle?.manuscriptIr)
        !== JSON.stringify(manuscriptIr)
      || JSON.stringify(sourceEvidenceBundle?.submissionMetadataReceipt)
        !== JSON.stringify(submissionMetadataReceipt)
      || JSON.stringify(sourceEvidenceBundle?.sourceTreeManifest)
        !== JSON.stringify(sourceTreeManifest)
    ))
    || releaseBinding?.agentExecutionReceiptHash
      !== agentExecutionReceipt?.agentExecutionReceiptHash
    || releaseBinding?.trustedAutonomousManuscriptRenderReceipt
      ?.priorArtEvidenceReceiptHash !== priorArtReceipt?.priorArtEvidenceReceiptHash
    || releaseBinding?.trustedAutonomousManuscriptRenderReceipt?.seedBundleHash !== seedHash
    || ![
      manuscriptIrFileHash,
      renderedSourceHash,
      sourceArchiveHash,
      compiledPdfHash,
      independentRebuiltPdfHash,
      sourceInspectionReceiptHash,
      pdfInfoToolIdentityHash,
      pdfInfoReceiptHash,
    ].every((value) => sha(value))
    || !Number.isSafeInteger(effectivePageCount)
    || effectivePageCount < 1 || effectivePageCount > 100_000
    || !SAFE_ID.test(String(effectiveDocumentClass || ''))
    || !SAFE_ID.test(String(effectiveBibliographyStyle || ''))
    || !SAFE_ID.test(String(effectiveCitationStyle || ''))
    || !Array.isArray(metadataPresent)
    || metadataPresent.some((value) => !SUPPORTED_METADATA.has(value))
    || new Set(metadataPresent).size !== metadataPresent.length
    || present.some((value) => !SUPPORTED_METADATA.has(value))
    || (recursiveClosureSource
      && JSON.stringify([...metadataPresent].sort()) !== JSON.stringify(present))
    || !Number.isFinite(Date.parse(String(inspectedAt || '')))
    || new Date(inspectedAt).toISOString() !== inspectedAt) {
    throw new Error('autonomous_venue_compliance_receipt_input_invalid');
  }
  const profile = venueProfileSelection.profile;
  const blockers = [];
  if (campaignReleaseAuthority.releaseBundle.venueTarget !== venueProfileSelection.venueId) {
    blockers.push('autonomous_venue_release_target_mismatch');
  }
  if (sourceArchiveHash !== packageOutput.sourceZipHash) {
    blockers.push('autonomous_venue_source_archive_release_mismatch');
  }
  if (compiledPdfHash !== packageOutput.authoritativeCompiledPdfHash) {
    blockers.push('autonomous_venue_compiled_pdf_release_mismatch');
  }
  if (independentRebuiltPdfHash !== packageOutput.independentRebuiltPdfHash) {
    blockers.push('autonomous_venue_independent_pdf_release_mismatch');
  }
  if (manuscriptIr.paperId !== venueProfileSelection.paperId) {
    blockers.push('autonomous_venue_manuscript_paper_mismatch');
  }
  for (const required of profile.requiredMetadata) {
    if (!SUPPORTED_METADATA.has(required) || !present.includes(required)) {
      blockers.push(`autonomous_venue_required_metadata_missing:${required}`);
    }
  }
  if (effectiveDocumentClass !== profile.documentClass) {
    blockers.push('autonomous_venue_document_class_mismatch');
  }
  if (effectiveBibliographyStyle !== profile.bibliographyStyle) {
    blockers.push('autonomous_venue_bibliography_style_mismatch');
  }
  if (effectiveCitationStyle !== profile.citationStyle) {
    blockers.push('autonomous_venue_citation_style_mismatch');
  }
  if (profile.maximumPages !== null && effectivePageCount > profile.maximumPages) {
    blockers.push('autonomous_venue_page_limit_exceeded');
  }
  if (recursiveClosureSource) {
    const sectionWords = new Map(
      effectiveVenueRequirementObservations.sectionWordCounts
        .map((entry) => [entry.section, entry.wordCount]),
    );
    if (effectiveVenueRequirementObservations.totalWordCount > venueRequirementIr.wordLimit) {
      blockers.push('autonomous_venue_word_limit_exceeded');
    }
    for (const limit of venueRequirementIr.sectionLimits) {
      if (!sectionWords.has(limit.section)) {
        blockers.push(`autonomous_venue_required_section_missing:${limit.section}`);
      } else if (sectionWords.get(limit.section) > limit.maximumWords) {
        blockers.push(`autonomous_venue_section_word_limit_exceeded:${limit.section}`);
      }
    }
    if (venueRequirementIr.anonymousReview
      && effectiveVenueRequirementObservations.anonymousReviewSatisfied !== true) {
      blockers.push('autonomous_venue_anonymous_review_not_satisfied');
    }
    if (effectiveVenueRequirementObservations.reviewMode !== venueRequirementIr.reviewMode) {
      blockers.push('autonomous_venue_review_mode_mismatch');
    }
    if (effectiveVenueRequirementObservations.templateAssetPresent !== true) {
      blockers.push('autonomous_venue_template_asset_missing');
    }
    if (effectiveVenueRequirementObservations.supplementPolicySatisfied !== true) {
      blockers.push('autonomous_venue_supplement_policy_not_satisfied');
    }
    if (venueRequirementIr.artifactRequired
      && effectiveVenueRequirementObservations.artifactPresent !== true) {
      blockers.push('autonomous_venue_required_artifact_missing');
    }
    if (effectiveVenueRequirementObservations.artifactPolicySatisfied !== true) {
      blockers.push('autonomous_venue_artifact_policy_not_satisfied');
    }
    if (JSON.stringify(effectiveVenueRequirementObservations.satisfiedDisclosureRequirements)
      !== JSON.stringify([...venueRequirementIr.disclosureRequirements].sort())) {
      blockers.push('autonomous_venue_disclosure_requirements_not_satisfied');
    }
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: recursiveClosureSource ? 3 : 1,
    kind: 'AutonomousVenueComplianceReceipt',
    status: uniqueBlockers.length
      ? 'autonomous_venue_compliance_blocked'
      : 'autonomous_venue_compliance_verified',
    paperId: venueProfileSelection.paperId,
    campaignId: campaignReleaseAuthority.campaignId,
    venueId: venueProfileSelection.venueId,
    venueProfileHash: venueProfileSelection.venueProfileHash,
    venueProfileSelectionHash:
      venueProfileSelection.autonomousVenueProfileSelectionReceiptHash,
    venueProfileRankingReceiptHash:
      venueProfileSelection.rankingReceipt?.autonomousVenueProfileRankingReceiptHash || null,
    venueSelectorConfigurationHash:
      venueProfileSelection.rankingReceipt?.selectorConfigurationHash || null,
    venueAuthorityConfigurationHash:
      venueProfileSelection.venueAuthorityConfigurationHash || null,
    submissionMetadataReceiptHash:
      submissionMetadataReceipt.autonomousSubmissionMetadataReceiptHash,
    campaignReleaseBundleHash: campaignReleaseAuthority.campaignReleaseBundleHash,
    ...(recursiveClosureSource ? {
      autonomousResearchReleaseBindingHash:
        releaseBinding.autonomousResearchReleaseBindingHash,
      researchAgendaIrHash: researchAgendaIr.researchAgendaIrHash,
      researchAgendaIr,
      venueRequirementIrHash: venueRequirementIr.venueRequirementIrHash,
      venueRequirementIr,
      sourceEvidenceBundleHash:
        sourceEvidenceBundle.autonomousVenueSourceEvidenceBundleHash,
      sourceEvidenceBundle,
      venueRequirementObservationHash:
        effectiveVenueRequirementObservations.venueRequirementObservationHash,
      venueRequirementObservations: effectiveVenueRequirementObservations,
    } : {}),
    immutableCampaignPackageOutputHash:
      packageOutput.immutableCampaignPackageOutputHash,
    packageVerificationReceiptHash: packageOutput.packageVerificationReceiptHash,
    evidenceBoundManuscriptIrHash: manuscriptIr.evidenceBoundManuscriptIrHash,
    manuscriptIrFileHash: sha(manuscriptIrFileHash),
    trustedAutonomousManuscriptRenderReceiptHash:
      releaseBinding.trustedAutonomousManuscriptRenderReceiptHash,
    manuscriptProductionMode: releaseBinding.manuscriptProductionMode,
    qualificationScope: releaseBinding.qualificationScope,
    agentExecutionReceiptHash: releaseBinding.agentExecutionReceiptHash,
    isolatedAgentMergeReceiptHash: releaseBinding.isolatedAgentMergeReceiptHash,
    agentAuthoredSourceDraftHash: releaseBinding.agentAuthoredSourceDraftHash,
    agentAuthoredSourceDraftFileHash:
      releaseBinding.agentAuthoredSourceDraftFileHash,
    agentWorkspacePostimageBindingHash:
      releaseBinding.agentWorkspacePostimageBindingHash,
    priorArtEvidenceReceiptHash: priorArtReceipt.priorArtEvidenceReceiptHash,
    seedBundleHash: seedHash,
    renderedSourceHash: sha(renderedSourceHash),
    sourceArchiveHash: sha(sourceArchiveHash),
    compiledPdfHash: sha(compiledPdfHash),
    independentRebuiltPdfHash: sha(independentRebuiltPdfHash),
    sourceInspectionReceiptHash: sha(sourceInspectionReceiptHash),
    pdfInfoToolIdentityHash: sha(pdfInfoToolIdentityHash),
    pdfInfoReceiptHash: sha(pdfInfoReceiptHash),
    pageCount: effectivePageCount,
    maximumPages: profile.maximumPages,
    documentClass: effectiveDocumentClass,
    bibliographyStyle: effectiveBibliographyStyle,
    citationStyle: effectiveCitationStyle,
    metadataPresent: present,
    requiredMetadata: profile.requiredMetadata,
    machineVerified: true,
    humanApprovalPerformed: false,
    externalActionPerformed: false,
    blockers: uniqueBlockers,
    inspectedAt,
  };
  return Object.freeze({
    ...payload,
    autonomousVenueComplianceReceiptHash:
      hashRecord('AutonomousVenueComplianceReceipt', payload),
  });
}

export function verifyAutonomousVenueComplianceReceipt(receipt, expected = {}) {
  const {
    campaignReleaseAuthority = null,
    ...fieldExpected
  } = expected;
  const releaseBundle = campaignReleaseAuthority?.releaseBundle || null;
  const releaseBinding = releaseBundle?.autonomousResearchReleaseBinding || null;
  const releaseBindingValid = verifyAutonomousResearchReleaseBinding(releaseBinding, {
    campaignId: campaignReleaseAuthority?.campaignId,
    paperId: campaignReleaseAuthority?.paperId,
    campaignPlanHash: releaseBundle?.campaignPlanHash,
    authorityObservedAt: receipt?.inspectedAt,
  }).valid;
  const { autonomousVenueComplianceReceiptHash: claimedHash, ...payload } = receipt || {};
  const recursiveVenueRequirementValid = receipt?.version !== 3 || (
    releaseBindingValid
    && verifyResearchAgendaIr(receipt?.researchAgendaIr)
    && receipt?.researchAgendaIrHash
      === receipt?.researchAgendaIr?.researchAgendaIrHash
    && verifyVenueRequirementIr(receipt?.venueRequirementIr, {
      researchAgendaIr: receipt.researchAgendaIr,
      venueProfileSelection:
        receipt?.venueRequirementIr?.sourceVenueProfileSelection || null,
      expectedVenueProfileRegistryHash:
        receipt?.venueRequirementIr?.sourceVenueRegistryHash || null,
      expectedVenueAuthorityConfigurationHash:
        receipt?.venueRequirementIr?.venueRequirementAuthorityReceiptHash || null,
    })
    && receipt?.venueRequirementIrHash
      === receipt?.venueRequirementIr?.venueRequirementIrHash
    && receipt?.paperId === receipt?.researchAgendaIr?.paperId
    && receipt?.venueId === receipt?.venueRequirementIr?.venueId
    && receipt?.venueProfileSelectionHash
      === receipt?.venueRequirementIr?.sourceVenueProfileSelectionReceiptHash
    && verifyAutonomousVenueSourceEvidenceBundle(receipt?.sourceEvidenceBundle, {
      venueRequirementIr: receipt?.venueRequirementIr,
      releaseBinding,
      releaseBundle,
    })
    && receipt?.sourceEvidenceBundleHash
      === receipt?.sourceEvidenceBundle?.autonomousVenueSourceEvidenceBundleHash
    && verifyVenueRequirementObservations(
      receipt?.venueRequirementObservations,
      receipt?.venueRequirementIr,
      {
        sourceEvidenceBundle: receipt?.sourceEvidenceBundle,
        releaseBinding,
        releaseBundle,
      },
    )
    && receipt?.venueRequirementObservationHash
      === receipt?.venueRequirementObservations?.venueRequirementObservationHash
    && receipt?.venueRequirementObservations?.sourceEvidenceBundleHash
      === receipt?.sourceEvidenceBundleHash
    && receipt?.sourceInspectionReceiptHash
      === receipt?.sourceEvidenceBundle?.sourceInspectionReceiptHash
    && receipt?.renderedSourceHash
      === receipt?.sourceEvidenceBundle?.sourceInspectionReceipt?.renderedSourceHash
    && receipt?.sourceArchiveHash
      === receipt?.sourceEvidenceBundle?.sourceInspectionReceipt?.sourceArchiveHash
    && receipt?.campaignReleaseBundleHash
      === receipt?.sourceEvidenceBundle?.sourceInspectionReceipt?.campaignReleaseBundleHash
    && receipt?.submissionMetadataReceiptHash
      === receipt?.sourceEvidenceBundle?.submissionMetadataReceiptHash
    && receipt?.evidenceBoundManuscriptIrHash
      === receipt?.sourceEvidenceBundle?.evidenceBoundManuscriptIrHash
    && receipt?.manuscriptIrFileHash
      === receipt?.sourceEvidenceBundle?.manuscriptIrFileHash
    && receipt?.venueRequirementObservations?.venueRequirementIrFileHash
      === receipt?.sourceEvidenceBundle?.venueRequirementIrFileHash
    && receipt?.immutableCampaignPackageOutputHash
      === receipt?.sourceEvidenceBundle?.releaseArtifactEvidence
        ?.immutableCampaignPackageOutputHash
    && receipt?.packageVerificationReceiptHash
      === receipt?.sourceEvidenceBundle?.releaseArtifactEvidence
        ?.packageVerificationReceiptHash
    && JSON.stringify(receipt?.metadataPresent)
      === JSON.stringify(receipt?.venueRequirementObservations?.metadataPresent)
    && campaignReleaseAuthority?.status === 'current_completed_release'
      && campaignReleaseAuthority?.campaignReleaseBundleHash
        === receipt?.campaignReleaseBundleHash
      && releaseBundle?.campaignReleaseBundleHash === receipt?.campaignReleaseBundleHash
    && releaseBinding?.autonomousResearchReleaseBindingHash
        === receipt?.autonomousResearchReleaseBindingHash
    && recursiveVenueComplianceSemanticsValid(receipt, {
      releaseBundle,
      releaseBinding,
    })
  );
  return Boolean([1, 3].includes(receipt?.version)
    && sha(claimedHash)
    && hashRecord('AutonomousVenueComplianceReceipt', payload) === claimedHash
    && receipt.status === 'autonomous_venue_compliance_verified'
    && receipt.blockers?.length === 0
    && recursiveVenueRequirementValid
    && Object.entries(fieldExpected).every(([field, value]) => (
      value === undefined || value === null || receipt[field] === value
    )));
}
