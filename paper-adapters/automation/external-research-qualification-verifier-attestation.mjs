import crypto from 'node:crypto';
import {
  independentExternalResearchQualificationResponseSigningPayloadHash,
  verifyIndependentExternalResearchQualificationVerificationEvidenceStructure,
} from '../../paper-domain/automation/external-research-qualification-verification-evidence-contract.mjs';

export const INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_MAXIMUM_CLOCK_SKEW_MS =
  5 * 60 * 1000;

function canonicalTimestamp(value) {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : Date.parse(String(value || ''));
  return Number.isFinite(milliseconds)
    && (value instanceof Date || new Date(milliseconds).toISOString() === value)
    ? milliseconds
    : null;
}

function sameSigner(left, right) {
  return left?.keyId === right?.keyId
    && left?.keyVersion === right?.keyVersion
    && left?.subjectId === right?.subjectId
    && (left?.organization || null) === (right?.organization || null)
    && left?.role === right?.role
    && left?.algorithm === right?.algorithm
    && left?.status === right?.status
    && left?.effectiveFrom === right?.effectiveFrom
    && left?.expiresAt === right?.expiresAt
    && left?.revokedAt === right?.revokedAt;
}

function verifierAttestorTimeWindowValid({
  request,
  response,
  configuration,
  verificationTime,
}) {
  const attestor = configuration?.verifierAttestor || null;
  const requestAt = canonicalTimestamp(request?.verifiedAt);
  const signedAt = canonicalTimestamp(response?.signedAt);
  const verifiedAt = canonicalTimestamp(verificationTime);
  const effectiveFrom = canonicalTimestamp(attestor?.effectiveFrom);
  const expiresAt = canonicalTimestamp(attestor?.expiresAt);
  if ([requestAt, signedAt, verifiedAt, effectiveFrom, expiresAt]
    .some((value) => value === null)
    || attestor?.status !== 'active'
    || attestor?.revokedAt !== null
    || expiresAt <= effectiveFrom) {
    return false;
  }
  const inValidityWindow = (instant) => (
    instant >= effectiveFrom && instant < expiresAt
  );
  return [requestAt, signedAt, verifiedAt].every(inValidityWindow)
    && Math.abs(signedAt - requestAt)
      <= INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_MAXIMUM_CLOCK_SKEW_MS
    && requestAt - verifiedAt
      <= INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_MAXIMUM_CLOCK_SKEW_MS
    && signedAt - verifiedAt
      <= INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_MAXIMUM_CLOCK_SKEW_MS;
}

export function verifyIndependentExternalResearchQualificationVerificationEvidence(
  evidence,
  {
    receipt,
    campaignReleaseAuthority,
    preparation,
    configuration,
    verificationTime,
  } = {},
) {
  const structure =
    verifyIndependentExternalResearchQualificationVerificationEvidenceStructure(
      evidence,
      {
        receipt,
        campaignReleaseAuthority,
        preparation,
        verifierId: configuration?.verifier?.serviceId,
        configurationIdentityHash: configuration?.configurationIdentityHash,
        trustIdentityHash: configuration?.trustIdentityHash,
        verifierServiceIdentityHash:
          configuration?.verifierServiceIdentityHash,
      },
    );
  const response = evidence?.response || null;
  const signer = response?.signer || null;
  const configuredAttestor = configuration?.verifierAttestor || null;
  const attestorIdentityVerified = sameSigner(signer, configuredAttestor)
    && configuredAttestor?.status === 'active'
    && configuredAttestor?.revokedAt === null
    && signer?.algorithm === 'ed25519';
  const timeWindowVerified = verifierAttestorTimeWindowValid({
    request: evidence?.request,
    response,
    configuration,
    verificationTime,
  });
  let signatureVerified = false;
  if (structure.valid && attestorIdentityVerified && timeWindowVerified
    && configuration?.verifierPublicKey) {
    try {
      signatureVerified = crypto.verify(
        null,
        Buffer.from(
          independentExternalResearchQualificationResponseSigningPayloadHash(
            response,
          ),
          'utf8',
        ),
        configuration.verifierPublicKey,
        Buffer.from(String(response?.signature || ''), 'base64'),
      );
    } catch {
      signatureVerified = false;
    }
  }
  const blockers = [
    ...structure.blockers,
    ...(!attestorIdentityVerified
      ? ['independent_external_research_qualification_verifier_attestor_invalid']
      : []),
    ...(!timeWindowVerified
      ? ['independent_external_research_qualification_verifier_time_window_invalid']
      : []),
    ...(!signatureVerified
      ? ['independent_external_research_qualification_verifier_signature_invalid']
      : []),
  ];
  return Object.freeze({
    valid: blockers.length === 0,
    structureVerified: structure.valid,
    requestVerified: structure.valid,
    responseStructureVerified: structure.valid,
    signatureVerified,
    timeWindowVerified,
    policyBound: structure.valid,
    inspectionBound: structure.valid,
    request: structure.request,
    verificationPolicy: structure.verificationPolicy,
    inspection: structure.inspection,
    evidenceHash: structure.valid
      ? evidence
        .independentExternalResearchQualificationVerificationEvidenceHash
      : null,
    responseHash: structure.valid ? response.responseHash : null,
    signedAt: structure.valid ? response.signedAt : null,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
