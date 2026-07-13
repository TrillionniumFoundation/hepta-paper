import { verifyAuthoritySignatures, verifyAuthorityTimeWindow } from '../../paper-adapters/authority/authority-signatures.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildProviderCapabilitySubject({ attestation, executorDescriptor } = {}) {
  const subject = {
    version: 1,
    kind: 'SubmissionProviderCapabilitySubject',
    provider: attestation?.provider || null,
    accountId: attestation?.accountId || null,
    portalRoute: attestation?.portalRoute || null,
    permittedAction: attestation?.permittedAction || null,
    executorId: executorDescriptor?.executorId || null,
    executorDescriptorHash: executorDescriptor?.submissionExecutorDescriptorHash || null,
    capabilitiesHash: executorDescriptor?.capabilitiesHash || null,
  };
  return Object.freeze({ ...subject, submissionProviderCapabilitySubjectHash: hashRecord('SubmissionProviderCapabilitySubject', subject) });
}

export function verifyProviderCapabilityAttestation({ attestation, executorDescriptor, trustStore, now = new Date() } = {}) {
  const blockers = [];
  const subject = buildProviderCapabilitySubject({ attestation, executorDescriptor });
  if (attestation?.version !== 1 || attestation?.kind !== 'SignedSubmissionProviderCapabilityAttestation') blockers.push('provider_capability_attestation_schema_invalid');
  if (attestation?.capabilitySubjectHash !== subject.submissionProviderCapabilitySubjectHash) blockers.push('provider_capability_subject_mismatch');
  if (attestation?.permittedAction !== 'submit_manuscript') blockers.push('provider_capability_action_invalid');
  if (!attestation?.portalRoute) blockers.push('provider_capability_portal_route_missing');
  if (executorDescriptor?.provider !== attestation?.provider || executorDescriptor?.accountId !== attestation?.accountId) blockers.push('provider_capability_executor_scope_mismatch');
  const capabilities = typeof executorDescriptor?.capabilities === 'function'
    ? executorDescriptor.capabilities()
    : executorDescriptor?.capabilities;
  if (capabilities?.externalActions !== true) blockers.push('provider_capability_external_action_not_declared');
  const signatures = verifyAuthoritySignatures({ document: attestation, trustStore, requiredRoles: ['provider_capability_operator'], minSignatures: 1 });
  blockers.push(...signatures.blockers);
  const timeWindow = verifyAuthorityTimeWindow({ signedAt: attestation?.signedAt, validFrom: attestation?.validFrom, expiresAt: attestation?.expiresAt, now, maximumLifetimeMs: 24 * 60 * 60 * 1000 });
  blockers.push(...timeWindow.blockers);
  const payload = {
    version: 1,
    kind: 'ProviderCapabilityVerificationReceipt',
    status: blockers.length ? 'provider_capability_verification_blocked' : 'provider_capability_verified',
    provider: attestation?.provider || null,
    accountId: attestation?.accountId || null,
    portalRoute: attestation?.portalRoute || null,
    executorDescriptorHash: executorDescriptor?.submissionExecutorDescriptorHash || null,
    capabilitiesHash: executorDescriptor?.capabilitiesHash || null,
    attestationHash: hashRecord('SignedSubmissionProviderCapabilityAttestation', attestation || {}),
    verifiedSubjectIds: signatures.verifiedSubjectIds,
    cryptographicSignaturesVerified: signatures.cryptographicSignaturesVerified,
    validFrom: timeWindow.validFrom,
    expiresAt: timeWindow.expiresAt,
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, providerCapabilityVerificationReceiptHash: hashRecord('ProviderCapabilityVerificationReceipt', payload) });
}
