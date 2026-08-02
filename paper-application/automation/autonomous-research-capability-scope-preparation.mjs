import {
  STRONG_PRIOR_ART_CAPABILITY_MODE,
  buildAutonomousResearchCapabilityScopeManifest,
  verifyAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function prepareAutonomousResearchCapabilityScope({
  autonomousSubmissionPortalConfigurationHash,
  declaredCapabilityScopeManifest,
  externalCapabilityTrustInspection,
  externalResearchReplayConfigurationHash,
  generated,
  priorArtReceipt,
  priorArtVerification,
  proposal,
  requireAgentAuthoredProse,
  researchAgendaProducerReceipt,
  researchPrincipalPool,
  submissionMetadataReceipt,
  venueComplianceRuntimeVerified,
  venueProfileSelection,
  venueTemplateAssetReady,
} = {}) {
  const derivedCapabilityScopeManifest = buildAutonomousResearchCapabilityScopeManifest({
    scopeId: `hepta.autonomous-research.${proposal.paperId}`,
    agendaMode: researchAgendaProducerReceipt
      ? 'machine-generated' : 'registered-profile',
    manuscriptMode: requireAgentAuthoredProse
      ? 'agent-authored-evidence-bound-ir-v1'
      : 'minimal-report-evidence-bound-ir-v1',
    formalClaimClasses: generated.dynamicFormalClaimSeed
      ? ['dynamic-lean-type-v1', 'registered-template-v1']
      : ['registered-template-v1'],
    empiricalFamilies: [proposal.protocolFamily],
    priorArtMode: priorArtVerification.ready
      ? (priorArtReceipt?.version === 2
          && priorArtReceipt?.evidenceProfile === STRONG_PRIOR_ART_CAPABILITY_MODE
        ? STRONG_PRIOR_ART_CAPABILITY_MODE : 'structured-receipt-v1')
      : 'opaque-hash-v1',
    reviewerPrincipalCount: researchPrincipalPool?.reviewerPrincipalCount || 1,
    reviewerTrustDomainCount: researchPrincipalPool?.reviewerTrustDomainCount || 1,
    replayMode: SHA256.test(String(externalResearchReplayConfigurationHash || ''))
      ? 'external-trust-domain-v1' : 'same-process-recomputation-v1',
    venueMode: venueProfileSelection?.profile.externalSubmissionEnabled
      && autonomousSubmissionPortalConfigurationHash && submissionMetadataReceipt
      && venueTemplateAssetReady
      && venueComplianceRuntimeVerified
      && venueProfileSelection.profile.bibliographyStyle === 'inline-evidence-v1'
      && venueProfileSelection.profile.citationStyle === 'evidence-inline-v1'
      ? 'submission-enabled-v1'
      : venueProfileSelection ? 'profile-selected-v1' : 'disabled',
    externalPrerequisites: Object.freeze([
      ...(!priorArtVerification.ready ? ['prior-art-service'] : []),
      ...(researchPrincipalPool ? [] : ['independent-reviewer-session-isolation']),
      ...(!SHA256.test(String(externalResearchReplayConfigurationHash || ''))
        ? ['external-replay-service'] : []),
      ...(!venueProfileSelection ? ['venue-profile-registry'] : []),
      ...(venueProfileSelection?.profile.externalSubmissionEnabled
        && !autonomousSubmissionPortalConfigurationHash
        ? ['submission-portal-service'] : []),
      ...(venueProfileSelection?.profile.externalSubmissionEnabled
        && !submissionMetadataReceipt
        ? ['submission-metadata-profile'] : []),
      ...(venueProfileSelection?.profile.externalSubmissionEnabled
        && !venueTemplateAssetReady
        ? ['venue-template-assets'] : []),
      ...(venueProfileSelection?.profile.externalSubmissionEnabled
        && !venueComplianceRuntimeVerified
        ? ['venue-compliance-runtime'] : []),
      ...(venueProfileSelection?.profile.externalSubmissionEnabled
        && (venueProfileSelection.profile.bibliographyStyle !== 'inline-evidence-v1'
          || venueProfileSelection.profile.citationStyle !== 'evidence-inline-v1')
        ? ['venue-rendering-profile'] : []),
      ...(requireAgentAuthoredProse
        ? (externalCapabilityTrustInspection?.blockers
          || ['autonomous_research_external_capability_trust_missing']) : []),
    ]),
  });
  if (declaredCapabilityScopeManifest
    && (!verifyAutonomousResearchCapabilityScopeManifest(declaredCapabilityScopeManifest)
      || !declaredCapabilityScopeManifest.empiricalFamilies.includes(proposal.protocolFamily)
      || (researchAgendaProducerReceipt
        && JSON.stringify(researchAgendaProducerReceipt.allowedProtocolFamilies)
          !== JSON.stringify(declaredCapabilityScopeManifest.empiricalFamilies))
      || declaredCapabilityScopeManifest.agendaMode !== derivedCapabilityScopeManifest.agendaMode
      || declaredCapabilityScopeManifest.manuscriptMode
        !== derivedCapabilityScopeManifest.manuscriptMode
      || JSON.stringify(declaredCapabilityScopeManifest.formalClaimClasses)
        !== JSON.stringify(derivedCapabilityScopeManifest.formalClaimClasses)
      || declaredCapabilityScopeManifest.priorArtMode
        !== derivedCapabilityScopeManifest.priorArtMode
      || declaredCapabilityScopeManifest.reviewerPrincipalCount
        > (researchPrincipalPool?.reviewerPrincipalCount || 1)
      || declaredCapabilityScopeManifest.reviewerTrustDomainCount
        > (researchPrincipalPool?.reviewerTrustDomainCount || 1)
      || (declaredCapabilityScopeManifest.replayMode === 'external-trust-domain-v1'
        && !SHA256.test(String(externalResearchReplayConfigurationHash || '')))
      || (declaredCapabilityScopeManifest.venueMode === 'submission-enabled-v1'
        && (!venueProfileSelection?.profile.externalSubmissionEnabled
          || !autonomousSubmissionPortalConfigurationHash
          || !submissionMetadataReceipt
          || !venueTemplateAssetReady
          || !venueComplianceRuntimeVerified
          || venueProfileSelection.profile.bibliographyStyle !== 'inline-evidence-v1'
          || venueProfileSelection.profile.citationStyle !== 'evidence-inline-v1')))) {
    throw new Error('autonomous_research_declared_capability_scope_invalid');
  }
  const capabilityScopeManifest = declaredCapabilityScopeManifest
    || derivedCapabilityScopeManifest;
  if (generated.dynamicFormalClaimSeed
    && generated.dynamicFormalClaimSeed.capabilityScopeManifestHash
      !== capabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash) {
    throw new Error('autonomous_research_dynamic_formal_capability_scope_mismatch');
  }
  return capabilityScopeManifest;
}
