import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from './autonomous-research-agenda-production-contract.mjs';
import {
  verifyAutonomousResearchAgentProductionAuthorityBinding,
} from './autonomous-research-agent-production-authority-binding.mjs';
import {
  STRONG_PRIOR_ART_CAPABILITY_MODE,
  verifyAutonomousResearchCapabilityScopeManifest,
} from './autonomous-research-capability-scope-manifest.mjs';
import {
  verifyAutonomousResearchExternalCapabilityTrustInspection,
} from './autonomous-research-external-capability-trust-contract.mjs';
import {
  verifyDynamicFormalClaimSeed,
} from '../research/dynamic-formal-claim-seed-contract.mjs';
import {
  verifyPriorArtAuthorityVerificationBundle,
} from '../research/prior-art-authority-verification-contract.mjs';
import { verifyResearchAgendaIr } from './research-agenda-ir.mjs';
import {
  verifyAutonomousVenueProfileSelection,
} from './autonomous-venue-profile-contract.mjs';
import {
  verifyAutonomousSubmissionMetadataReceipt,
} from './autonomous-submission-metadata-contract.mjs';
import {
  verifyPriorArtClaimAlignmentReceipt,
} from '../research/prior-art-claim-alignment-contract.mjs';
import {
  verifyAutonomousResearchProductionVenueRequirement,
} from './autonomous-research-production-venue-requirement.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
export const STRONG_AUTONOMOUS_RESEARCH_PRODUCTION_PROFILE =
  'declared-capability-agent-dynamic-v1';

function unique(values) {
  return Object.freeze([...new Set((values || []).filter(Boolean))]);
}

function contentReceiptValid(receipt, {
  paperId,
  protocolFamily,
  dynamicFormalClaimSeed,
  capabilityScopeManifestHash,
} = {}) {
  const {
    autonomousResearchContentProductionReceiptHash: claimedHash,
    ...payload
  } = receipt || {};
  return receipt?.version === 5
    && receipt?.kind === 'AutonomousResearchContentProductionReceipt'
    && receipt?.status === 'autonomous_research_content_production_verified'
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchContentProductionReceipt', payload) === claimedHash
    && receipt?.paperId === paperId
    && receipt?.protocolFamily === protocolFamily
    && receipt?.withinBudget === true
    && receipt?.humanApprovalPerformed === false
    && SHA256.test(String(receipt?.producerContractHash || ''))
    && receipt?.dynamicFormalClaimsEnabled === true
    && receipt?.capabilityScopeManifestHash === capabilityScopeManifestHash
    && SHA256.test(String(receipt?.agentExecutionReceiptHash || ''))
    && receipt?.dynamicFormalClaimSeedHash
      === dynamicFormalClaimSeed?.dynamicFormalClaimSeedHash
    && dynamicFormalClaimSeed?.generatorReceiptHash
      === receipt?.agentExecutionReceiptHash;
}

function productionAgentAuthorityBindingValid(receipt, preparation) {
  const binding = receipt?.productionAuthorityBinding || null;
  const expected = preparation?.productionAuthorityBinding || null;
  return verifyAutonomousResearchAgentProductionAuthorityBinding(expected)
    && preparation?.productionAuthorityBindingHash
      === expected.autonomousResearchAgentProductionAuthorityBindingHash
    && verifyAutonomousResearchAgentProductionAuthorityBinding(binding)
    && binding.autonomousResearchAgentProductionAuthorityBindingHash
      === expected.autonomousResearchAgentProductionAuthorityBindingHash
    && JSON.stringify(binding) === JSON.stringify(expected)
    && binding.runtimePrincipalBindingHash === preparation?.runtimePrincipalBindingHash
    && binding.runtimePrincipalBindingHash
      === preparation?.runtimePrincipalBinding?.runtimePrincipalBindingHash
    && JSON.stringify(binding.runtimePrincipalBinding)
      === JSON.stringify(preparation?.runtimePrincipalBinding)
    && binding.autonomousResearchProviderConfigurationHash
      === preparation?.autonomousResearchProviderConfigurationHash
    && receipt?.producerId === binding.authorPrincipalId
    && receipt?.principalId === binding.authorPrincipalId
    && receipt?.provider === binding.authorProvider
    && receipt?.model === binding.authorModel;
}

function strongCapabilityManifestValid(manifest) {
  return verifyAutonomousResearchCapabilityScopeManifest(manifest)
    && manifest.genericDeclaredCapability === true
    && manifest.agendaMode === 'machine-generated'
    && manifest.manuscriptMode === 'agent-authored-evidence-bound-ir-v1'
    && manifest.formalClaimClasses.includes('dynamic-lean-type-v1')
    && manifest.priorArtMode === STRONG_PRIOR_ART_CAPABILITY_MODE
    && manifest.replayMode === 'external-trust-domain-v1'
    && manifest.venueMode === 'submission-enabled-v1'
    && Array.isArray(manifest.externalPrerequisites)
    && manifest.externalPrerequisites.length === 0;
}

export function verifyAutonomousResearchProductionPriorArtAuthority({
  priorArtReceipt,
  authorityBundle,
  trustConfiguration,
  externalCapabilityTrustInspection,
  researchAgendaIr = null,
  now = null,
} = {}) {
  const priorArtTrust = externalCapabilityTrustInspection?.components?.priorArt || null;
  const agendaBindingReady = researchAgendaIr === null
    || verifyResearchAgendaIr(researchAgendaIr);
  return verifyPriorArtAuthorityVerificationBundle({
    receipt: priorArtReceipt,
    authorityBundle,
    trustConfiguration,
    researchAgendaIrHash: researchAgendaIr?.researchAgendaIrHash || null,
    priorArtQueryPlan: researchAgendaIr?.priorArtQueryPlan || null,
    now,
  })
    && agendaBindingReady
    && priorArtTrust?.ready === true
    && priorArtTrust?.cryptographicAuthorityReady === true
    && priorArtTrust?.identityIndependenceReady === true
    && authorityBundle?.trustSetHash === priorArtTrust?.trustSetHash
    && authorityBundle?.signatureVerificationPolicyHash
      === priorArtTrust?.signatureVerificationPolicyHash;
}

export function inspectAutonomousResearchProductionProfileInputs({
  launchMode,
  researchAgendaProducer = null,
  hypothesisGenerator = null,
  requireAgentAuthoredProse = false,
  capabilityScopeManifest = null,
  externalCapabilityTrustInspection = null,
} = {}) {
  const required = launchMode === 'production-run';
  const blockers = [];
  if (required) {
    if (!researchAgendaProducer) {
      blockers.push('autonomous_research_production_agenda_producer_required');
    }
    if (!hypothesisGenerator) {
      blockers.push('autonomous_research_production_content_producer_required');
    }
    if (requireAgentAuthoredProse !== true) {
      blockers.push('autonomous_research_production_agent_authored_prose_required');
    }
    if (!strongCapabilityManifestValid(capabilityScopeManifest)) {
      blockers.push('autonomous_research_production_generic_capability_scope_required');
    }
    if (!verifyAutonomousResearchExternalCapabilityTrustInspection(
      externalCapabilityTrustInspection,
    ) || externalCapabilityTrustInspection?.ready !== true) {
      blockers.push('autonomous_research_production_external_capability_trust_required');
    }
  }
  const uniqueBlockers = unique(blockers);
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchProductionProfileInputInspection',
    profileId: STRONG_AUTONOMOUS_RESEARCH_PRODUCTION_PROFILE,
    required,
    ready: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'autonomous_research_production_profile_inputs_blocked'
      : required
        ? 'autonomous_research_production_profile_inputs_ready'
        : 'autonomous_research_production_profile_not_required',
    blockers: uniqueBlockers,
  });
}

export function inspectAutonomousResearchProductionProfilePreparation(preparation) {
  const required = preparation?.launchMode === 'production-run';
  const blockers = [];
  if (required) {
    const proposal = preparation?.proposal || null;
    const manifest = preparation?.capabilityScopeManifest || null;
    const agendaReceipt = preparation?.researchAgendaProducerReceipt || null;
    const dynamicFormalClaimSeed = preparation?.dynamicFormalClaimSeed || null;
    const contentReceipt = preparation?.researchContentProducerReceipt || null;
    const externalCapabilityTrustInspection =
      preparation?.externalCapabilityTrustInspection || null;
    const priorArtReceipt = preparation?.priorArtReceipt || null;
    const priorArtAuthorityVerificationBundle =
      preparation?.priorArtAuthorityVerificationBundle || null;
    const priorArtAuthorityTrustConfiguration =
      preparation?.priorArtAuthorityTrustConfiguration || null;
    const priorArtClaimAlignmentReceipt =
      preparation?.priorArtClaimAlignmentReceipt || null;
    const venueProfileSelection = preparation?.venueProfileSelection || null;
    const submissionMetadataReceipt = preparation?.submissionMetadataReceipt || null;
    const authorityObservedAt = preparation?.observedAt || preparation?.createdAt || null;
    const agendaVerification = verifyAutonomousResearchAgendaProductionReceipt(agendaReceipt);
    const dynamicVerification = verifyDynamicFormalClaimSeed(dynamicFormalClaimSeed, {
      claimKey: `${proposal?.paperId || ''}:formal-support:1`,
      generatorReceiptHash: contentReceipt?.agentExecutionReceiptHash,
    });
    const agendaAuthorityBindingReady = agendaReceipt?.version === 3
      && SHA256.test(String(agendaReceipt?.producerContractHash || ''))
      && productionAgentAuthorityBindingValid(agendaReceipt, preparation);
    const contentAuthorityBindingReady = contentReceipt?.version === 5
      && SHA256.test(String(contentReceipt?.producerContractHash || ''))
      && contentReceipt?.dynamicFormalClaimsEnabled === true
      && contentReceipt?.capabilityScopeManifestHash
        === manifest?.autonomousResearchCapabilityScopeManifestHash
      && productionAgentAuthorityBindingValid(contentReceipt, preparation);
    if (!agendaAuthorityBindingReady || !contentAuthorityBindingReady
      || agendaReceipt?.productionAuthorityBinding
        ?.autonomousResearchAgentProductionAuthorityBindingHash
        !== contentReceipt?.productionAuthorityBinding
          ?.autonomousResearchAgentProductionAuthorityBindingHash) {
      blockers.push('autonomous_research_production_agent_authority_binding_required');
    }
    if (!strongCapabilityManifestValid(manifest)) {
      blockers.push('autonomous_research_production_generic_capability_scope_required');
    }
    if (!verifyAutonomousResearchExternalCapabilityTrustInspection(
      externalCapabilityTrustInspection,
    ) || externalCapabilityTrustInspection?.ready !== true) {
      blockers.push('autonomous_research_production_external_capability_trust_required');
    }
    if (!verifyAutonomousResearchProductionPriorArtAuthority({
      priorArtReceipt,
      authorityBundle: priorArtAuthorityVerificationBundle,
      trustConfiguration: priorArtAuthorityTrustConfiguration,
      externalCapabilityTrustInspection,
      researchAgendaIr: preparation?.researchAgendaIr || null,
    })) {
      blockers.push('autonomous_research_production_prior_art_authority_required');
    }
    if (!verifyPriorArtClaimAlignmentReceipt(priorArtClaimAlignmentReceipt, {
      researchAgendaIr: preparation?.researchAgendaIr || null,
      priorArtEvidenceReceipt: priorArtReceipt,
      agendaSelectionReceiptHash:
        proposal?.agendaSelectionReceipt?.autonomousResearchAgendaSelectionReceiptHash,
    })) {
      blockers.push('autonomous_research_production_prior_art_claim_alignment_required');
    }
    const venueRanking = venueProfileSelection?.rankingReceipt || null;
    if (venueProfileSelection?.version !== 2
      || venueProfileSelection?.requireExternalSubmission !== true
      || !verifyAutonomousVenueProfileSelection(venueProfileSelection, {
        authorityObservedAt,
      })
      || !Number.isSafeInteger(venueRanking?.eligibleCandidateCount)
      || venueRanking.eligibleCandidateCount < 1
      || venueRanking?.candidateEvaluations?.find((candidate) => (
        candidate.venueId === venueProfileSelection.venueId
      ))?.rank !== 1
      || submissionMetadataReceipt?.version !== 2
      || !verifyAutonomousSubmissionMetadataReceipt(submissionMetadataReceipt, {
        paperId: proposal?.paperId,
        protocolFamily: proposal?.protocolFamily,
        authorityObservedAt,
      })
      || venueProfileSelection.submissionMetadataProfileHash
        !== submissionMetadataReceipt.profileHash
      || venueRanking?.submissionMetadataAuthorityConfigurationHash
        !== submissionMetadataReceipt.submissionMetadataAuthorityConfigurationHash
      || venueRanking?.submissionMetadataAuthorityTrustSetHash
        !== submissionMetadataReceipt.submissionMetadataAuthorityTrustSetHash
      || venueRanking?.submissionMetadataAuthoritySignatureVerificationPolicyHash
        !== submissionMetadataReceipt
          .submissionMetadataAuthoritySignatureVerificationPolicyHash) {
      blockers.push('autonomous_research_production_signed_venue_ranking_required');
    }
    if (!verifyAutonomousResearchProductionVenueRequirement(preparation, {
      authorityObservedAt,
    })) {
      blockers.push('autonomous_research_production_venue_requirement_asset_required');
    }
    if (!agendaVerification.valid
      || agendaReceipt?.paperId !== proposal?.paperId
      || agendaReceipt?.selectedObjective !== proposal?.objective
      || agendaReceipt?.selectedProtocolFamily !== proposal?.protocolFamily
      || !manifest?.empiricalFamilies?.includes(proposal?.protocolFamily)
      || JSON.stringify(agendaReceipt?.allowedProtocolFamilies || [])
        !== JSON.stringify(manifest?.empiricalFamilies || [])) {
      blockers.push('autonomous_research_production_machine_agenda_required');
    }
    if (proposal?.version !== 2
      || proposal?.formalSupportMode !== 'dynamic-lean-type-v1'
      || proposal?.formalSupportRegistryHash !== null
      || proposal?.formalSupportTemplateId !== null
      || proposal?.formalSupportTemplateHash !== null
      || !dynamicVerification.valid
      || proposal?.dynamicFormalClaimSeed?.dynamicFormalClaimSeedHash
        !== dynamicFormalClaimSeed?.dynamicFormalClaimSeedHash
      || proposal?.researchContentProducerReceipt
        ?.autonomousResearchContentProductionReceiptHash
          !== contentReceipt?.autonomousResearchContentProductionReceiptHash
      || dynamicFormalClaimSeed?.capabilityScopeManifestHash
        !== manifest?.autonomousResearchCapabilityScopeManifestHash
      || !contentReceiptValid(contentReceipt, {
        paperId: proposal?.paperId,
        protocolFamily: proposal?.protocolFamily,
        dynamicFormalClaimSeed,
        capabilityScopeManifestHash:
          manifest?.autonomousResearchCapabilityScopeManifestHash,
      })) {
      blockers.push('autonomous_research_production_dynamic_content_lineage_required');
    }
  }
  const uniqueBlockers = unique(blockers);
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchProductionProfilePreparationInspection',
    profileId: STRONG_AUTONOMOUS_RESEARCH_PRODUCTION_PROFILE,
    required,
    ready: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'autonomous_research_production_profile_preparation_blocked'
      : required
        ? 'autonomous_research_production_profile_preparation_ready'
        : 'autonomous_research_production_profile_not_required',
    capabilityScopeManifestHash:
      preparation?.capabilityScopeManifest
        ?.autonomousResearchCapabilityScopeManifestHash || null,
    researchAgendaProductionReceiptHash:
      preparation?.researchAgendaProducerReceipt
        ?.autonomousResearchAgendaProductionReceiptHash || null,
    researchContentProductionReceiptHash:
      preparation?.researchContentProducerReceipt
        ?.autonomousResearchContentProductionReceiptHash || null,
    agentProductionAuthorityBindingHash:
      preparation?.researchContentProducerReceipt?.productionAuthorityBinding
        ?.autonomousResearchAgentProductionAuthorityBindingHash || null,
    dynamicFormalClaimSeedHash:
      preparation?.dynamicFormalClaimSeed?.dynamicFormalClaimSeedHash || null,
    externalCapabilityTrustInspectionHash:
      preparation?.externalCapabilityTrustInspection
        ?.autonomousResearchExternalCapabilityTrustInspectionHash || null,
    priorArtEvidenceReceiptHash:
      preparation?.priorArtReceipt?.priorArtEvidenceReceiptHash || null,
    priorArtAuthorityVerificationBundleHash:
      preparation?.priorArtAuthorityVerificationBundle
        ?.priorArtRetrievalAuthorityVerificationBundleHash || null,
    priorArtAuthorityTrustConfigurationHash:
      preparation?.priorArtAuthorityTrustConfiguration
        ?.priorArtAuthorityTrustConfigurationHash || null,
    priorArtClaimAlignmentReceiptHash:
      preparation?.priorArtClaimAlignmentReceipt
        ?.priorArtClaimAlignmentReceiptHash || null,
    venueProfileRankingReceiptHash:
      preparation?.venueProfileSelection?.rankingReceipt
        ?.autonomousVenueProfileRankingReceiptHash || null,
    venueAuthorityConfigurationHash:
      preparation?.venueProfileSelection?.venueAuthorityConfigurationHash || null,
    venueRequirementIrHash:
      preparation?.venueRequirementIr?.venueRequirementIrHash || null,
    venueTemplateAssetHash:
      preparation?.venueTemplateAsset?.templateAssetHash || null,
    venueTemplateAssetBundleHash:
      preparation?.venueTemplateAssetBundleHash || null,
    submissionMetadataAuthorityConfigurationHash:
      preparation?.submissionMetadataReceipt
        ?.submissionMetadataAuthorityConfigurationHash || null,
    blockers: uniqueBlockers,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchProductionProfilePreparationInspectionHash: hashRecord(
      'AutonomousResearchProductionProfilePreparationInspection',
      payload,
    ),
  });
}

export function assertAutonomousResearchProductionProfilePreparation(preparation) {
  const inspection = inspectAutonomousResearchProductionProfilePreparation(preparation);
  if (!inspection.ready) {
    throw new Error(
      `autonomous_research_production_profile_blocked:${inspection.blockers.join(',')}`,
    );
  }
  return inspection;
}
