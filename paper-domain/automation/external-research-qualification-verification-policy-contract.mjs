import { hasExactPlainObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  BOUNDED_CAPABILITY_QUALIFICATION_SCOPE,
  PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE,
} from './autonomous-research-release-binding-contract.mjs';
import {
  inspectAutonomousResearchReleaseQualificationScope,
} from './full-research-release-qualification-inspection.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export const EXTERNAL_RESEARCH_QUALIFICATION_VERIFICATION_POLICY_KIND =
  'IndependentExternalResearchQualificationVerificationPolicy';
export const EXTERNAL_RESEARCH_QUALIFICATION_PRODUCTION_POLICY_PROFILE =
  'production-full-research-release-v4';
export const EXTERNAL_RESEARCH_QUALIFICATION_BOUNDED_POLICY_PROFILE =
  'bounded-golden-capability-release-v3';
export const INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_REQUEST_VERSION = 3;
export const INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_REQUEST_KIND =
  'IndependentExternalResearchQualificationVerificationRequest';
export const INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_RESPONSE_VERSION = 2;
export const INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_RESPONSE_KIND =
  'IndependentExternalResearchQualificationVerificationResponse';

const POLICY_KEYS = Object.freeze([
  'allowBoundedGoldenCapability',
  'autonomousResearchReleaseBindingHash',
  'campaignId',
  'fullResearchQualificationEligible',
  'independentExternalResearchQualificationVerificationPolicyHash',
  'kind',
  'launchMode',
  'nativeFormalCertificateIntakeVersion',
  'paperId',
  'priorArtEvidenceReceiptHash',
  'qualificationScope',
  'recursiveReleaseClosureRequired',
  'releaseBindingVersion',
  'requireGlobalGoldenAuthority',
  'structuredPriorArtEvidenceVersion',
  'verificationProfile',
  'version',
]);

function validHash(value) {
  return SHA256.test(String(value || ''));
}

export function independentExternalResearchQualificationEnvelopeOptions({
  campaignReleaseAuthority,
  preparation,
} = {}) {
  const releaseBinding = campaignReleaseAuthority?.releaseBundle
    ?.autonomousResearchReleaseBinding || null;
  const allowBoundedGoldenCapability = preparation?.launchMode === 'golden-bootstrap'
    && releaseBinding?.version === 3
    && releaseBinding?.launchMode === 'golden-bootstrap'
    && releaseBinding?.qualificationScope
      === BOUNDED_CAPABILITY_QUALIFICATION_SCOPE
    && releaseBinding?.fullResearchQualificationEligible === false
    && releaseBinding?.genericContentCanaryVerified === true
    && validHash(releaseBinding?.globalGoldenQualificationAuthorityHash);
  return Object.freeze({ allowBoundedGoldenCapability });
}

function releaseAuthorityBound({
  authority,
  receipt,
  preparation,
  releaseBinding,
  releaseBundle,
}) {
  return authority?.status === 'current_completed_release'
    && authority?.campaignStatus === 'completed'
    && authority?.packageNodeStatus === 'completed'
    && authority?.campaignId === receipt?.campaignId
    && authority?.paperId === receipt?.paperId
    && authority?.paperId === preparation?.proposal?.paperId
    && authority?.campaignReleaseBundleHash
      === receipt?.campaignReleaseBundleHash
    && releaseBundle?.campaignReleaseBundleHash
      === receipt?.campaignReleaseBundleHash
    && releaseBundle?.autonomousResearchReleaseBindingHash
      === releaseBinding?.autonomousResearchReleaseBindingHash
    && releaseBinding?.campaignId === authority?.campaignId
    && releaseBinding?.paperId === authority?.paperId
    && releaseBinding?.campaignPlanHash === releaseBundle?.campaignPlanHash
    && releaseBinding?.proposalHash
      === preparation?.proposal?.machineProposedScientificClaimSetHash
    && releaseBinding?.policyAuthorizationHash
      === preparation?.policyAuthorization?.autonomousResearchPolicyAuthorizationHash
    && releaseBinding?.seedBindingHash
      === preparation?.seedBinding?.autonomousResearchSeedBindingHash
    && releaseBinding?.launchMode === preparation?.launchMode;
}

function structuredPriorArtBound(receipt, releaseBinding) {
  return receipt?.independentHypothesisPriorArtReviewVerified === true
    && receipt?.priorArtEvidenceReceipt?.version === 2
    && releaseBinding?.priorArtEvidenceReceipt?.version === 2
    && validHash(receipt?.independentHypothesisPriorArtReceiptHash)
    && receipt.independentHypothesisPriorArtReceiptHash
      === receipt.priorArtEvidenceReceipt.priorArtEvidenceReceiptHash
    && receipt.independentHypothesisPriorArtReceiptHash
      === releaseBinding?.priorArtEvidenceReceiptHash
    && releaseBinding.priorArtEvidenceReceiptHash
      === releaseBinding.priorArtEvidenceReceipt.priorArtEvidenceReceiptHash
    && JSON.stringify(receipt.priorArtEvidenceReceipt)
      === JSON.stringify(releaseBinding.priorArtEvidenceReceipt);
}

function derivePolicyPayload({
  receipt,
  campaignReleaseAuthority,
  preparation,
} = {}) {
  const authority = campaignReleaseAuthority;
  const releaseBundle = authority?.releaseBundle || null;
  const releaseBinding = releaseBundle?.autonomousResearchReleaseBinding || null;
  const scope = inspectAutonomousResearchReleaseQualificationScope({
    authority,
    receipt,
    allowBoundedGoldenCapability: true,
  });
  if (!scope.valid
    || !releaseAuthorityBound({
      authority,
      receipt,
      preparation,
      releaseBinding,
      releaseBundle,
    })
    || !structuredPriorArtBound(receipt, releaseBinding)
    || !validHash(releaseBinding?.autonomousResearchReleaseBindingHash)) {
    return null;
  }
  const production = scope.productionScope === true
    && releaseBinding.version === 4
    && releaseBinding.launchMode === 'production-run'
    && releaseBinding.qualificationScope
      === PRODUCTION_AGENT_AUTHORED_QUALIFICATION_SCOPE
    && releaseBinding.fullResearchQualificationEligible === true
    && validHash(releaseBinding.researchReportHash)
    && releaseBinding.researchReportHash === releaseBundle?.researchReportHash
    && releaseBinding.researchReportHash
      === releaseBundle?.researchReport?.researchReportHash;
  const bounded = scope.boundedGoldenScope === true
    && releaseBinding.version === 3
    && releaseBinding.launchMode === 'golden-bootstrap'
    && releaseBinding.qualificationScope
      === BOUNDED_CAPABILITY_QUALIFICATION_SCOPE
    && releaseBinding.fullResearchQualificationEligible === false
    && validHash(releaseBinding.globalGoldenQualificationAuthorityHash)
    && (releaseBinding.proposal ?? null) === null
    && (releaseBinding.researchAgendaIr ?? null) === null
    && (releaseBinding.researchAgendaIrHash ?? null) === null
    && (releaseBinding.researchReportHash ?? null) === null;
  if (production === bounded) return null;
  return Object.freeze({
    version: 1,
    kind: EXTERNAL_RESEARCH_QUALIFICATION_VERIFICATION_POLICY_KIND,
    verificationProfile: production
      ? EXTERNAL_RESEARCH_QUALIFICATION_PRODUCTION_POLICY_PROFILE
      : EXTERNAL_RESEARCH_QUALIFICATION_BOUNDED_POLICY_PROFILE,
    campaignId: authority.campaignId,
    paperId: authority.paperId,
    autonomousResearchReleaseBindingHash:
      releaseBinding.autonomousResearchReleaseBindingHash,
    releaseBindingVersion: releaseBinding.version,
    launchMode: releaseBinding.launchMode,
    qualificationScope: releaseBinding.qualificationScope,
    fullResearchQualificationEligible:
      releaseBinding.fullResearchQualificationEligible,
    priorArtEvidenceReceiptHash: releaseBinding.priorArtEvidenceReceiptHash,
    structuredPriorArtEvidenceVersion: 2,
    nativeFormalCertificateIntakeVersion: 3,
    recursiveReleaseClosureRequired: production,
    allowBoundedGoldenCapability: bounded,
    requireGlobalGoldenAuthority: bounded,
  });
}

export function buildIndependentExternalResearchQualificationVerificationPolicy(input = {}) {
  const payload = derivePolicyPayload(input);
  if (!payload) {
    throw new Error(
      'independent_external_research_qualification_verification_policy_invalid',
    );
  }
  return Object.freeze({
    ...payload,
    independentExternalResearchQualificationVerificationPolicyHash: hashRecord(
      EXTERNAL_RESEARCH_QUALIFICATION_VERIFICATION_POLICY_KIND,
      payload,
    ),
  });
}

export function verifyIndependentExternalResearchQualificationVerificationPolicy(
  policy,
  input = {},
) {
  const {
    independentExternalResearchQualificationVerificationPolicyHash: claimedHash,
    ...payload
  } = policy || {};
  const expectedPayload = derivePolicyPayload(input);
  const blockers = [];
  if (!hasExactPlainObjectKeys(policy, POLICY_KEYS)
    || !expectedPayload
    || !validHash(claimedHash)
    || hashRecord(
      EXTERNAL_RESEARCH_QUALIFICATION_VERIFICATION_POLICY_KIND,
      payload,
    ) !== claimedHash
    || hashRecord(
      EXTERNAL_RESEARCH_QUALIFICATION_VERIFICATION_POLICY_KIND,
      expectedPayload,
    ) !== claimedHash) {
    blockers.push(
      'independent_external_research_qualification_verification_policy_invalid',
    );
  }
  return Object.freeze({
    valid: blockers.length === 0,
    policy: blockers.length ? null : policy,
    blockers: Object.freeze(blockers),
  });
}

export function independentExternalResearchQualificationInspectionPolicyBound(
  inspection,
  policy,
) {
  const policyHash = policy
    ?.independentExternalResearchQualificationVerificationPolicyHash;
  return validHash(policyHash)
    && inspection?.verificationPolicyHash === policyHash
    && inspection?.structuredPriorArtEvidenceVerified === true
    && inspection?.nativeFormalCertificateIntakeV3Verified === true
    && inspection?.releaseBindingVersion === policy.releaseBindingVersion
    && inspection?.launchMode === policy.launchMode
    && inspection?.qualificationScope === policy.qualificationScope
    && inspection?.recursiveReleaseClosureRequired
      === policy.recursiveReleaseClosureRequired
    && inspection?.recursiveReleaseClosureRequirementSatisfied === true
    && inspection?.allowBoundedGoldenCapability
      === policy.allowBoundedGoldenCapability;
}
