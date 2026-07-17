import {
  verifyFullResearchQualificationReceipt,
  verifyFullResearchQualificationReceiptEnvelope,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import {
  EXTERNAL_QUALIFICATION_FAILURE_CODES as FAILURE,
} from '../../paper-domain/automation/external-research-qualification-failure-policy.mjs';
import {
  verifyExternalQualificationReleaseSignerAuthority,
} from './external-qualification-release-signer-authority.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const FULL_DOMAIN_CRYPTOGRAPHIC_BLOCKERS = new Set([
  'golden_micro_campaign_qualification_receipt_hash_invalid',
  'golden_micro_campaign_qualification_signature_invalid',
  'golden_micro_campaign_release_pointer_mismatch',
  'golden_micro_campaign_release_attestation_signer_mismatch',
  'golden_micro_campaign_release_attestation_signature_invalid',
]);

function independentInspectionBound({
  independentInspection,
  envelope,
  receipt,
  preparation,
  configuration,
}) {
  return independentInspection?.kind === 'FullResearchQualificationInspection'
    && independentInspection?.status === 'full_research_qualification_verified'
    && independentInspection?.ready === true
    && independentInspection?.receiptAccepted === true
    && independentInspection?.independentVerifierVerified === true
    && independentInspection?.externalVerifierId === configuration.verifier.serviceId
    && SHA256.test(String(independentInspection?.externalVerificationRequestHash || ''))
    && independentInspection?.configurationIdentityHash
      === configuration.configurationIdentityHash
    && independentInspection?.trustIdentityHash === configuration.trustIdentityHash
    && independentInspection?.clientServiceIdentityHash
      === configuration.clientServiceIdentityHash
    && independentInspection?.verifierServiceIdentityHash
      === configuration.verifierServiceIdentityHash
    && independentInspection?.campaignId === envelope.campaignId
    && independentInspection?.paperId === envelope.paperId
    && independentInspection?.campaignReleaseBundleHash === envelope.campaignReleaseBundleHash
    && independentInspection?.qualificationReceiptHash === envelope.qualificationReceiptHash
    && independentInspection?.runtimeImageReproducibilityReceiptHash
      === envelope.runtimeImageReproducibilityReceiptHash
    && JSON.stringify(independentInspection?.runtimeImageReproducibilityRequiredProfiles)
      === JSON.stringify(envelope.runtimeImageReproducibilityRequiredProfiles)
    && JSON.stringify(independentInspection?.runtimeImageReproducibilityDefinitionManifestHashes)
      === JSON.stringify(envelope.runtimeImageReproducibilityDefinitionManifestHashes)
    && independentInspection?.proposalHash
      === preparation?.proposal?.machineProposedScientificClaimSetHash
    && independentInspection?.policyAuthorizationHash
      === preparation?.policyAuthorization?.autonomousResearchPolicyAuthorizationHash
    && independentInspection?.seedBindingHash
      === preparation?.seedBinding?.autonomousResearchSeedBindingHash
    && independentInspection?.independentHypothesisPriorArtReviewVerified === true
    && independentInspection?.independentHypothesisPriorArtReceiptHash
      === receipt?.independentHypothesisPriorArtReceiptHash;
}

function verifiedInspection({ fullVerification, independentInspection, configuration }) {
  return Object.freeze({
    ...fullVerification,
    kind: 'FullResearchQualificationInspection',
    qualificationSignatureVerified: true,
    qualificationTimeWindowVerified: true,
    releasePointerVerified: true,
    independentVerifierVerified: true,
    externalVerifierId: configuration.verifier.serviceId,
    externalVerificationRequestHash: independentInspection.externalVerificationRequestHash,
    configurationIdentityHash: configuration.configurationIdentityHash,
    trustIdentityHash: configuration.trustIdentityHash,
    clientServiceIdentityHash: configuration.clientServiceIdentityHash,
    verifierServiceIdentityHash: configuration.verifierServiceIdentityHash,
    proposalHash: independentInspection.proposalHash,
    policyAuthorizationHash: independentInspection.policyAuthorizationHash,
    seedBindingHash: independentInspection.seedBindingHash,
    fullDomainVerificationReady: true,
    independentHypothesisPriorArtReviewVerified:
      fullVerification.independentHypothesisPriorArtReviewVerified,
    independentHypothesisPriorArtReceiptHash:
      fullVerification.independentHypothesisPriorArtReceiptHash,
    failureCodes: Object.freeze([]),
    blockers: Object.freeze([]),
  });
}

export async function verifyExternalResearchQualificationLocally({
  receipt,
  campaignReleaseAuthority,
  preparation,
  independentInspection,
  observedAt,
  configuration,
  fullVerificationContextProvider,
  freshlyIssuedReceipts,
  now,
  blockedInspection,
  envelopeFailureCodes,
  verifyDetachedSignature,
  verifyReleaseAttestation,
  onSynchronousProgress = null,
} = {}) {
  const envelope = verifyFullResearchQualificationReceiptEnvelope(receipt, {
    now: observedAt,
    campaignReleaseAuthority,
    expectedPaperId: preparation?.proposal?.paperId || null,
    expectedProposalHash: preparation?.proposal?.machineProposedScientificClaimSetHash || null,
    expectedPolicyAuthorizationHash:
      preparation?.policyAuthorization?.autonomousResearchPolicyAuthorizationHash || null,
    expectedSeedBindingHash:
      preparation?.seedBinding?.autonomousResearchSeedBindingHash || null,
    verifyQualificationSignature: (input) => verifyDetachedSignature(
      input, configuration, observedAt,
    ),
  });
  if (!envelope.ready) {
    return blockedInspection(
      envelope.blockers,
      envelope,
      configuration.verifier.serviceId,
      envelopeFailureCodes(envelope.blockers),
      configuration,
    );
  }
  if (!independentInspectionBound({
    independentInspection, envelope, receipt, preparation, configuration,
  })) {
    return blockedInspection([
      'external_qualification_independent_verification_binding_invalid',
    ], envelope, configuration.verifier.serviceId, [
      FAILURE.INDEPENDENT_VERIFICATION_BINDING_INVALID,
    ], configuration);
  }
  let fullVerificationContext;
  try {
    fullVerificationContext = typeof fullVerificationContextProvider === 'function'
      ? await fullVerificationContextProvider({
        receipt,
        campaignReleaseAuthority,
        preparation,
        observedAt,
        onSynchronousProgress,
      }) : null;
  } catch (error) {
    if (error?.message === 'autonomous_research_qualification_progress_fence_lost') {
      throw error;
    }
    fullVerificationContext = null;
  }
  if (!fullVerificationContext) {
    return blockedInspection([
      'external_qualification_full_verification_context_required',
    ], envelope, configuration.verifier.serviceId, [
      typeof fullVerificationContextProvider === 'function'
        ? FAILURE.FULL_VERIFICATION_CONTEXT_UNAVAILABLE
        : FAILURE.FULL_VERIFICATION_CONTEXT_CONFIGURATION_MISSING,
    ], configuration);
  }
  const fullVerificationObservedAt = now();
  const currentReleaseInspection = fullVerificationContext.releaseAttestorInspection;
  const releaseAttestation = campaignReleaseAuthority?.releaseBundle
    ?.researchExecutionReleaseAttestation || null;
  if (!verifyExternalQualificationReleaseSignerAuthority({
    inspection: currentReleaseInspection,
    configuration,
    signer: receipt?.signer,
    signedAt: receipt?.issuedAt,
    freshlyIssued: freshlyIssuedReceipts.has(receipt),
  }) || !verifyExternalQualificationReleaseSignerAuthority({
    inspection: currentReleaseInspection,
    configuration,
    signer: releaseAttestation,
    signedAt: releaseAttestation?.signedAt,
  })) {
    return blockedInspection([
      'external_qualification_current_release_signer_authority_invalid',
    ], envelope, configuration.verifier.serviceId, [
      FAILURE.FULL_DOMAIN_CRYPTOGRAPHIC_INTEGRITY_INVALID,
    ], configuration);
  }
  const fullVerification = verifyFullResearchQualificationReceipt(receipt, {
    ...fullVerificationContext,
    now: fullVerificationObservedAt,
    releaseAttestorInspection: currentReleaseInspection,
    resolveCampaignReleaseAuthority: ({ campaignId }) => (
      campaignId === campaignReleaseAuthority?.campaignId ? campaignReleaseAuthority : null
    ),
    verifyReleaseAttestation: (input) => verifyReleaseAttestation(
      input, configuration, fullVerificationObservedAt,
    ),
    verifyQualificationSignature: (input) => verifyDetachedSignature(
      input, configuration, fullVerificationObservedAt,
    ),
  });
  if (!fullVerification.ready) {
    const cryptographicIntegrityInvalid = fullVerification.blockers
      .some((blocker) => FULL_DOMAIN_CRYPTOGRAPHIC_BLOCKERS.has(blocker));
    return blockedInspection([
      'external_qualification_full_domain_verification_failed',
      ...fullVerification.blockers,
    ], envelope, configuration.verifier.serviceId, [
      cryptographicIntegrityInvalid
        ? FAILURE.FULL_DOMAIN_CRYPTOGRAPHIC_INTEGRITY_INVALID
        : FAILURE.FULL_DOMAIN_NOT_READY,
    ], configuration);
  }
  return verifiedInspection({ fullVerification, independentInspection, configuration });
}
