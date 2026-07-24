import { hasExactPlainObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildIndependentExternalResearchQualificationVerificationPolicy,
  INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_REQUEST_KIND,
  INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_REQUEST_VERSION,
  INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_RESPONSE_KIND,
  INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_RESPONSE_VERSION,
  independentExternalResearchQualificationInspectionPolicyBound,
  verifyIndependentExternalResearchQualificationVerificationPolicy,
} from './external-research-qualification-verification-policy-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const REQUEST_KEYS = Object.freeze([
  'campaignReleaseAuthority', 'campaignReleaseAuthorityHash',
  'expectedBindings', 'kind', 'receipt', 'requestHash', 'verificationPolicy',
  'verificationPolicyHash', 'verifiedAt', 'verifierId', 'version',
]);
const REQUEST_PAYLOAD_KEYS = Object.freeze(
  REQUEST_KEYS.filter((key) => key !== 'requestHash'),
);
const EXPECTED_BINDING_KEYS = Object.freeze([
  'autonomousResearchReleaseBindingHash', 'genericContentCanaryVerified',
  'launchMode', 'paperId', 'policyAuthorizationHash', 'priorArtEvidenceReceiptHash',
  'proposalHash', 'qualificationScope', 'releaseBindingVersion', 'seedBindingHash',
]);
const RESPONSE_KEYS = Object.freeze([
  'inspection', 'kind', 'requestHash', 'responseHash', 'signature', 'signedAt',
  'signer', 'verificationPolicyHash', 'verifierId', 'version',
]);
const RESPONSE_PAYLOAD_KEYS = Object.freeze(
  RESPONSE_KEYS.filter((key) => !['responseHash', 'signature'].includes(key)),
);
const SIGNER_KEYS = Object.freeze([
  'algorithm', 'effectiveFrom', 'expiresAt', 'keyId', 'keyVersion', 'organization',
  'revokedAt', 'role', 'status', 'subjectId',
]);
const EVIDENCE_KEYS = Object.freeze([
  'configurationIdentityHash',
  'independentExternalResearchQualificationVerificationEvidenceHash',
  'kind', 'request', 'response', 'trustIdentityHash',
  'verifierServiceIdentityHash', 'version',
]);
const RECEIPT_INSPECTION_FIELDS = Object.freeze([
  'campaignId',
  'paperId',
  'campaignReleaseBundleHash',
  'runtimeImageReproducibilityReceiptHash',
  'runtimeImageReproducibilityRequiredProfiles',
  'runtimeImageReproducibilityDefinitionManifestHashes',
  'empiricalFamilyPluginPackageHash',
  'empiricalFamilyPluginRegistryHash',
  'empiricalFamilyPluginStartupInspectionHash',
  'activeEmpiricalProductionProfileHashes',
  'runtimeImageReproducibilityActivePluginScopeHash',
]);
const builtVerificationRequestHashes = new WeakMap();
const builtVerificationEvidenceHashes = new WeakMap();

export const INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_EVIDENCE_VERSION = 3;
export const INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_EVIDENCE_KIND =
  'IndependentExternalResearchQualificationVerificationEvidence';
const CAMPAIGN_RELEASE_AUTHORITY_COMMITMENT_KIND =
  'ExternalResearchQualificationCampaignReleaseAuthorityCommitment';

function validHash(value) {
  return SHA256.test(String(value || ''));
}

function canonicalTimestamp(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

function exactPayload(value, keys) {
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

export function externalResearchQualificationCampaignReleaseAuthorityHash(
  campaignReleaseAuthority,
) {
  return hashRecord(
    CAMPAIGN_RELEASE_AUTHORITY_COMMITMENT_KIND,
    campaignReleaseAuthority,
  );
}

function requestHashPayload(value) {
  return Object.freeze({
    version: value?.version,
    kind: value?.kind,
    verifierId: value?.verifierId,
    verifiedAt: value?.verifiedAt,
    receipt: value?.receipt,
    campaignReleaseAuthorityHash: value?.campaignReleaseAuthorityHash,
    verificationPolicy: value?.verificationPolicy,
    verificationPolicyHash: value?.verificationPolicyHash,
    expectedBindings: value?.expectedBindings,
  });
}

export function independentExternalResearchQualificationRequestHash(value) {
  return hashRecord(
    INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_REQUEST_KIND,
    requestHashPayload(value),
  );
}

function evidenceHashPayload(value) {
  return Object.freeze({
    version: value?.version,
    kind: value?.kind,
    requestHash: value?.request?.requestHash,
    responseHash: value?.response?.responseHash,
    configurationIdentityHash: value?.configurationIdentityHash,
    trustIdentityHash: value?.trustIdentityHash,
    verifierServiceIdentityHash: value?.verifierServiceIdentityHash,
  });
}

export function independentExternalResearchQualificationEvidenceHash(value) {
  return hashRecord(
    INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_EVIDENCE_KIND,
    evidenceHashPayload(value),
  );
}

function sameValue(left, right) {
  if (left === right) return true;
  try {
    return hashRecord(
      'IndependentExternalResearchQualificationExactBindingValue',
      left,
    ) === hashRecord(
      'IndependentExternalResearchQualificationExactBindingValue',
      right,
    );
  } catch {
    return false;
  }
}

export function externalResearchQualificationPreparationBindingFromReleaseAuthority(
  campaignReleaseAuthority,
) {
  const releaseBinding = campaignReleaseAuthority?.releaseBundle
    ?.autonomousResearchReleaseBinding || null;
  return Object.freeze({
    launchMode: releaseBinding?.launchMode || null,
    proposal: Object.freeze({
      paperId: releaseBinding?.paperId || null,
      machineProposedScientificClaimSetHash:
        releaseBinding?.proposalHash || null,
    }),
    policyAuthorization: Object.freeze({
      autonomousResearchPolicyAuthorizationHash:
        releaseBinding?.policyAuthorizationHash || null,
    }),
    seedBinding: Object.freeze({
      autonomousResearchSeedBindingHash:
        releaseBinding?.seedBindingHash || null,
    }),
  });
}

function expectedBindings({ campaignReleaseAuthority, preparation } = {}) {
  const releaseBinding = campaignReleaseAuthority?.releaseBundle
    ?.autonomousResearchReleaseBinding || null;
  return Object.freeze({
    paperId: preparation?.proposal?.paperId || null,
    proposalHash:
      preparation?.proposal?.machineProposedScientificClaimSetHash || null,
    policyAuthorizationHash:
      preparation?.policyAuthorization
        ?.autonomousResearchPolicyAuthorizationHash || null,
    seedBindingHash:
      preparation?.seedBinding?.autonomousResearchSeedBindingHash || null,
    qualificationScope: releaseBinding?.qualificationScope || null,
    genericContentCanaryVerified:
      releaseBinding?.genericContentCanaryVerified === true,
    autonomousResearchReleaseBindingHash:
      releaseBinding?.autonomousResearchReleaseBindingHash || null,
    releaseBindingVersion: releaseBinding?.version || null,
    launchMode: releaseBinding?.launchMode || null,
    priorArtEvidenceReceiptHash:
      releaseBinding?.priorArtEvidenceReceiptHash || null,
  });
}

export function buildIndependentExternalResearchQualificationVerificationRequest({
  receipt,
  campaignReleaseAuthority,
  preparation,
  verifierId,
  verifiedAt,
} = {}) {
  if (!SAFE_ID.test(String(verifierId || ''))
    || canonicalTimestamp(verifiedAt) === null) {
    throw new Error(
      'independent_external_research_qualification_verification_request_invalid',
    );
  }
  const verificationPolicy =
    buildIndependentExternalResearchQualificationVerificationPolicy({
      receipt,
      campaignReleaseAuthority,
      preparation,
    });
  const campaignReleaseAuthorityHash =
    externalResearchQualificationCampaignReleaseAuthorityHash(
      campaignReleaseAuthority,
    );
  const payload = {
    version: INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_REQUEST_VERSION,
    kind: INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_REQUEST_KIND,
    verifierId,
    verifiedAt,
    receipt,
    campaignReleaseAuthority,
    campaignReleaseAuthorityHash,
    verificationPolicy,
    verificationPolicyHash:
      verificationPolicy
        .independentExternalResearchQualificationVerificationPolicyHash,
    expectedBindings: expectedBindings({
      campaignReleaseAuthority,
      preparation,
    }),
  };
  const requestHash =
    independentExternalResearchQualificationRequestHash(payload);
  const request = deepFreezeJsonValue({
    ...payload,
    requestHash,
  });
  builtVerificationRequestHashes.set(request, requestHash);
  return request;
}

export function verifyIndependentExternalResearchQualificationVerificationRequest(
  request,
  {
    receipt,
    campaignReleaseAuthority,
    preparation,
    verifierId,
  } = {},
) {
  const blockers = [];
  if (!hasExactPlainObjectKeys(request, REQUEST_KEYS)
    || !hasExactPlainObjectKeys(request?.expectedBindings, EXPECTED_BINDING_KEYS)
    || request?.version
      !== INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_REQUEST_VERSION
    || request?.kind !== INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_REQUEST_KIND
    || request?.verifierId !== verifierId
    || !validHash(request?.requestHash)
    || !validHash(request?.campaignReleaseAuthorityHash)
    || canonicalTimestamp(request?.verifiedAt) === null
    || !hasExactPlainObjectKeys(
      exactPayload(request || {}, REQUEST_PAYLOAD_KEYS),
      REQUEST_PAYLOAD_KEYS,
    )
    || externalResearchQualificationCampaignReleaseAuthorityHash(
      request?.campaignReleaseAuthority,
    ) !== request?.campaignReleaseAuthorityHash
    || (builtVerificationRequestHashes.get(request)
      || independentExternalResearchQualificationRequestHash(request))
      !== request?.requestHash) {
    blockers.push(
      'independent_external_research_qualification_verification_request_invalid',
    );
  }
  const currentExpectedBindings = expectedBindings({
    campaignReleaseAuthority,
    preparation,
  });
  const policyVerification =
    verifyIndependentExternalResearchQualificationVerificationPolicy(
      request?.verificationPolicy,
      { receipt, campaignReleaseAuthority, preparation },
    );
  if (!policyVerification.valid
    || request?.verificationPolicyHash
      !== request?.verificationPolicy
        ?.independentExternalResearchQualificationVerificationPolicyHash) {
    blockers.push(
      'independent_external_research_qualification_verification_request_policy_invalid',
    );
  }
  if (!sameValue(request?.receipt, receipt)
    || !sameValue(
      request?.campaignReleaseAuthority,
      campaignReleaseAuthority,
    )
    || request?.campaignReleaseAuthorityHash
      !== externalResearchQualificationCampaignReleaseAuthorityHash(
        campaignReleaseAuthority,
      )
    || !sameValue(request?.expectedBindings, currentExpectedBindings)) {
    blockers.push(
      'independent_external_research_qualification_verification_request_current_binding_invalid',
    );
  }
  return Object.freeze({
    valid: blockers.length === 0,
    request: blockers.length ? null : request,
    verificationPolicy: blockers.length ? null : request.verificationPolicy,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function independentExternalResearchQualificationResponseSigningPayloadHash(
  response,
) {
  return hashRecord(
    'IndependentExternalResearchQualificationVerificationResponseSigningPayload',
    exactPayload(response || {}, RESPONSE_PAYLOAD_KEYS),
  );
}

function inspectionBoundToRequest(inspection, request) {
  const receipt = request?.receipt || null;
  const bindings = request?.expectedBindings || null;
  const policy = request?.verificationPolicy || null;
  return inspection?.version === 1
    && inspection?.kind === 'FullResearchQualificationInspection'
    && inspection?.status === 'full_research_qualification_verified'
    && inspection?.ready === true
    && inspection?.receiptAccepted === true
    && Array.isArray(inspection?.blockers)
    && inspection.blockers.length === 0
    && RECEIPT_INSPECTION_FIELDS.every((field) => (
      sameValue(inspection?.[field], receipt?.[field])
    ))
    && inspection?.qualificationReceiptHash
      === receipt?.fullResearchQualificationReceiptHash
    && inspection?.proposalHash === bindings?.proposalHash
    && inspection?.policyAuthorizationHash === bindings?.policyAuthorizationHash
    && inspection?.seedBindingHash === bindings?.seedBindingHash
    && inspection?.qualificationScope === bindings?.qualificationScope
    && inspection?.genericContentCanaryVerified
      === bindings?.genericContentCanaryVerified
    && inspection?.independentHypothesisPriorArtReviewVerified === true
    && inspection?.independentHypothesisPriorArtReceiptHash
      === receipt?.independentHypothesisPriorArtReceiptHash
    && independentExternalResearchQualificationInspectionPolicyBound(
      inspection,
      policy,
    );
}

export function verifyIndependentExternalResearchQualificationVerificationResponseStructure(
  response,
  { request } = {},
) {
  const blockers = [];
  const payload = exactPayload(response || {}, RESPONSE_PAYLOAD_KEYS);
  if (!hasExactPlainObjectKeys(response, RESPONSE_KEYS)
    || !hasExactPlainObjectKeys(response?.signer, SIGNER_KEYS)
    || response?.version
      !== INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_RESPONSE_VERSION
    || response?.kind !== INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_RESPONSE_KIND
    || response?.verifierId !== request?.verifierId
    || response?.requestHash !== request?.requestHash
    || response?.verificationPolicyHash !== request?.verificationPolicyHash
    || canonicalTimestamp(response?.signedAt) === null
    || canonicalTimestamp(response?.signer?.effectiveFrom) === null
    || canonicalTimestamp(response?.signer?.expiresAt) === null
    || (response?.signer?.revokedAt !== null
      && canonicalTimestamp(response.signer.revokedAt) === null)
    || !validHash(response?.responseHash)
    || typeof response?.signature !== 'string'
    || response.signature.length < 1
    || hashRecord(
      INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_RESPONSE_KIND,
      payload,
    ) !== response?.responseHash) {
    blockers.push(
      'independent_external_research_qualification_verification_response_invalid',
    );
  }
  if (!inspectionBoundToRequest(response?.inspection, request)) {
    blockers.push(
      'independent_external_research_qualification_verification_response_binding_invalid',
    );
  }
  return Object.freeze({
    valid: blockers.length === 0,
    response: blockers.length ? null : response,
    inspection: blockers.length ? null : response.inspection,
    signingPayloadHash:
      independentExternalResearchQualificationResponseSigningPayloadHash(response),
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function buildIndependentExternalResearchQualificationVerificationEvidence({
  request,
  response,
  configurationIdentityHash,
  trustIdentityHash,
  verifierServiceIdentityHash,
} = {}) {
  if (![configurationIdentityHash, trustIdentityHash, verifierServiceIdentityHash]
    .every(validHash)
    || !verifyIndependentExternalResearchQualificationVerificationResponseStructure(
      response,
      { request },
    ).valid) {
    throw new Error(
      'independent_external_research_qualification_verification_evidence_invalid',
    );
  }
  const payload = {
    version: INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_EVIDENCE_VERSION,
    kind: INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_EVIDENCE_KIND,
    request,
    response,
    configurationIdentityHash,
    trustIdentityHash,
    verifierServiceIdentityHash,
  };
  const evidenceHash =
    independentExternalResearchQualificationEvidenceHash(payload);
  const evidence = deepFreezeJsonValue({
    ...payload,
    independentExternalResearchQualificationVerificationEvidenceHash: evidenceHash,
  });
  builtVerificationEvidenceHashes.set(evidence, evidenceHash);
  return evidence;
}

export function verifyIndependentExternalResearchQualificationVerificationEvidenceStructure(
  evidence,
  {
    receipt,
    campaignReleaseAuthority,
    preparation,
    verifierId,
    configurationIdentityHash,
    trustIdentityHash,
    verifierServiceIdentityHash,
  } = {},
) {
  const blockers = [];
  const requestVerification =
    verifyIndependentExternalResearchQualificationVerificationRequest(
      evidence?.request,
      { receipt, campaignReleaseAuthority, preparation, verifierId },
    );
  const responseVerification =
    verifyIndependentExternalResearchQualificationVerificationResponseStructure(
      evidence?.response,
      { request: evidence?.request },
    );
  if (!hasExactPlainObjectKeys(evidence, EVIDENCE_KEYS)
    || evidence?.version
      !== INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_EVIDENCE_VERSION
    || evidence?.kind !== INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_EVIDENCE_KIND
    || evidence?.configurationIdentityHash !== configurationIdentityHash
    || evidence?.trustIdentityHash !== trustIdentityHash
    || evidence?.verifierServiceIdentityHash !== verifierServiceIdentityHash
    || !validHash(
      evidence
        ?.independentExternalResearchQualificationVerificationEvidenceHash,
    )
    || (builtVerificationEvidenceHashes.get(evidence)
      || independentExternalResearchQualificationEvidenceHash(evidence))
      !== evidence
      ?.independentExternalResearchQualificationVerificationEvidenceHash) {
    blockers.push(
      'independent_external_research_qualification_verification_evidence_invalid',
    );
  }
  blockers.push(
    ...requestVerification.blockers,
    ...responseVerification.blockers,
  );
  return Object.freeze({
    valid: blockers.length === 0,
    evidence: blockers.length ? null : evidence,
    request: blockers.length ? null : evidence.request,
    response: blockers.length ? null : evidence.response,
    inspection: blockers.length ? null : evidence.response.inspection,
    verificationPolicy:
      blockers.length ? null : evidence.request.verificationPolicy,
    signingPayloadHash: responseVerification.signingPayloadHash,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
