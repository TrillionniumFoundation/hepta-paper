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
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildIndependentExternalResearchQualificationVerificationPolicy,
  independentExternalResearchQualificationEnvelopeOptions,
  verifyIndependentExternalResearchQualificationVerificationPolicy,
} from '../../paper-domain/automation/external-research-qualification-verification-policy-contract.mjs';
import {
  verifyIndependentExternalResearchQualificationVerificationEvidence,
} from './external-research-qualification-verifier-attestation.mjs';

const FULL_DOMAIN_CRYPTOGRAPHIC_BLOCKERS = new Set([
  'golden_micro_campaign_qualification_receipt_hash_invalid',
  'golden_micro_campaign_qualification_signature_invalid',
  'golden_micro_campaign_release_pointer_mismatch',
  'golden_micro_campaign_release_attestation_signer_mismatch',
  'golden_micro_campaign_release_attestation_signature_invalid',
  'golden_micro_campaign_reviewer_evidence_invalid',
]);

function verifiedInspection({
  fullVerification,
  independentInspection,
  configuration,
  qualificationReceipt,
  verificationPolicy,
  independentVerificationEvidence,
}) {
  const payload = {
    ...fullVerification,
    kind: 'FullResearchQualificationInspection',
    qualificationSignatureVerified: true,
    qualificationTimeWindowVerified: true,
    releasePointerVerified: true,
    independentVerifierVerified: true,
    externalVerifierId: configuration.verifier.serviceId,
    externalVerificationRequestHash:
      independentVerificationEvidence.request.requestHash,
    configurationIdentityHash: configuration.configurationIdentityHash,
    trustIdentityHash: configuration.trustIdentityHash,
    clientServiceIdentityHash: configuration.clientServiceIdentityHash,
    verifierServiceIdentityHash: configuration.verifierServiceIdentityHash,
    proposalHash: independentInspection.proposalHash,
    policyAuthorizationHash: independentInspection.policyAuthorizationHash,
    seedBindingHash: independentInspection.seedBindingHash,
    qualificationScope: independentInspection.qualificationScope,
    genericContentCanaryVerified:
      independentInspection.genericContentCanaryVerified === true,
    verificationPolicy,
    verificationPolicyHash:
      verificationPolicy
        .independentExternalResearchQualificationVerificationPolicyHash,
    independentVerificationEvidence,
    independentVerificationEvidenceHash:
      independentVerificationEvidence
        .independentExternalResearchQualificationVerificationEvidenceHash,
    structuredPriorArtEvidenceVerified: true,
    nativeFormalCertificateIntakeV4Verified: true,
    releaseBindingVersion: verificationPolicy.releaseBindingVersion,
    launchMode: verificationPolicy.launchMode,
    recursiveReleaseClosureRequired:
      verificationPolicy.recursiveReleaseClosureRequired,
    recursiveReleaseClosureRequirementSatisfied: true,
    allowBoundedGoldenCapability:
      verificationPolicy.allowBoundedGoldenCapability,
    qualificationReceipt,
    fullDomainVerificationReady: true,
    independentHypothesisPriorArtReviewVerified:
      fullVerification.independentHypothesisPriorArtReviewVerified,
    independentHypothesisPriorArtReceiptHash:
      fullVerification.independentHypothesisPriorArtReceiptHash,
    failureCodes: Object.freeze([]),
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    fullResearchQualificationInspectionHash:
      hashRecord('FullResearchQualificationInspection', payload),
  });
}

export async function verifyExternalResearchQualificationLocally({
  receipt,
  campaignReleaseAuthority,
  preparation,
  independentVerificationEvidence,
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
  const envelopeOptions =
    independentExternalResearchQualificationEnvelopeOptions({
      campaignReleaseAuthority,
      preparation,
    });
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
    allowBoundedGoldenCapability:
      envelopeOptions.allowBoundedGoldenCapability,
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
  let verificationPolicy;
  try {
    verificationPolicy =
      buildIndependentExternalResearchQualificationVerificationPolicy({
        receipt,
        campaignReleaseAuthority,
        preparation,
      });
  } catch {
    return blockedInspection([
      'external_qualification_independent_verification_policy_invalid',
    ], envelope, configuration.verifier.serviceId, [
      FAILURE.INDEPENDENT_VERIFICATION_POLICY_INVALID,
    ], configuration);
  }
  const policyVerification =
    verifyIndependentExternalResearchQualificationVerificationPolicy(
      verificationPolicy,
      { receipt, campaignReleaseAuthority, preparation },
    );
  if (!policyVerification.valid) {
    return blockedInspection([
      'external_qualification_independent_verification_policy_invalid',
    ], envelope, configuration.verifier.serviceId, [
      FAILURE.INDEPENDENT_VERIFICATION_POLICY_INVALID,
    ], configuration);
  }
  const evidenceVerification =
    verifyIndependentExternalResearchQualificationVerificationEvidence(
      independentVerificationEvidence,
      {
        receipt,
        campaignReleaseAuthority,
        preparation,
        configuration,
        verificationTime: observedAt,
      },
    );
  if (!evidenceVerification.valid) {
    const attestationInvalid =
      evidenceVerification.structureVerified === true;
    return blockedInspection([
      'external_qualification_independent_verification_binding_invalid',
      ...evidenceVerification.blockers,
    ], envelope, configuration.verifier.serviceId, [
      attestationInvalid
        ? FAILURE.INDEPENDENT_VERIFIER_ATTESTATION_INVALID
        : FAILURE.INDEPENDENT_VERIFICATION_BINDING_INVALID,
    ], configuration);
  }
  const independentInspection = evidenceVerification.inspection;
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
    requireGlobalGoldenAuthority:
      verificationPolicy.requireGlobalGoldenAuthority,
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
  return verifiedInspection({
    fullVerification,
    independentInspection,
    configuration,
    qualificationReceipt: receipt,
    verificationPolicy,
    independentVerificationEvidence,
  });
}
