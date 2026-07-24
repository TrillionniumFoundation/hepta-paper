import {
  evaluateExternalPrincipalIdentitySeparation,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  inspectPinnedExternalEvidenceTrustStore,
} from '../authority/pinned-external-evidence-verifier.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createExternalPrincipalIdentityAttestationBundleCodec,
} from '../authority/external-principal-identity-attestation-bundle-codec.mjs';

const IDENTITY_SUBJECT_KIND = 'ExternalPrincipalIdentityAttestationSubject';
const IDENTITY_ATTESTOR_ROLE = 'external_principal_identity_attestor';
const DISTINCT_FIELDS = Object.freeze([
  'credentialRoot', 'host', 'process', 'providerAccount', 'signerSpki', 'trustDomain',
]);
const identityAttestationBundleCodec =
  createExternalPrincipalIdentityAttestationBundleCodec({
    bundleKind: 'AutonomousSubmissionPortalIdentityAttestationBundle',
    signerRole: IDENTITY_ATTESTOR_ROLE,
    invalidBundleError:
      'autonomous_submission_portal_identity_attestation_bundle_invalid',
  });

export function buildAutonomousSubmissionPortalIdentityAttestationBundle({
  subject,
  authorityEnvelope,
  trustStore,
  signerKeyIds,
  signerRole = IDENTITY_ATTESTOR_ROLE,
  maximumLifetimeMs = 15 * 60 * 1000,
} = {}) {
  return identityAttestationBundleCodec.build({
    subject,
    authorityEnvelope,
    trustStore,
    signerKeyIds,
    signerRole,
    maximumLifetimeMs,
  });
}

export function verifyAutonomousSubmissionPortalIdentityAttestationBundle(bundle) {
  return identityAttestationBundleCodec.verify(bundle);
}

function inspectBundle(bundle, now) {
  return identityAttestationBundleCodec.inspect(bundle, now);
}

export function inspectAutonomousSubmissionPortalIdentitySeparation({
  portalId,
  serviceIdentityHash,
  portalAccountIdentityHash,
  portalTrustDomainIdentityHash,
  receiptTrustStore,
  receiptSignerRole,
  receiptSignerKeyIds,
  portalIdentityAttestationBundle,
  localOriginIdentityAttestationBundles,
  now,
} = {}) {
  const blockers = [];
  const portalIdentity = inspectBundle(portalIdentityAttestationBundle, now);
  const originBundles = Array.isArray(localOriginIdentityAttestationBundles)
    ? localOriginIdentityAttestationBundles : [];
  const originIdentities = originBundles.map((bundle) => inspectBundle(bundle, now));
  if (!portalIdentity) blockers.push('autonomous_submission_portal_identity_attestation_invalid');
  if (originBundles.length < 1 || originBundles.length > 64
    || originIdentities.some((identity) => identity === null)) {
    blockers.push('autonomous_submission_local_origin_identity_set_invalid');
  }
  const originSubjectHashes = originIdentities.map((identity) => (
    identity?.subject.externalPrincipalIdentityAttestationSubjectHash || null
  ));
  if (new Set(originSubjectHashes).size !== originSubjectHashes.length) {
    blockers.push('autonomous_submission_local_origin_identity_set_duplicate');
  }
  const receiptTrust = inspectPinnedExternalEvidenceTrustStore(receiptTrustStore, {
    requiredRole: receiptSignerRole,
    expectedKeyIds: receiptSignerKeyIds,
  });
  const receiptSignerSpkiHashes = receiptTrust.ready
    ? receiptTrust.keys.filter((key) => receiptSignerKeyIds.includes(key.keyId))
      .map((key) => key.publicKeySpkiHash) : [];
  const portalSubject = portalIdentity?.subject || null;
  const allIdentities = [portalIdentity, ...originIdentities].filter(Boolean);
  if (allIdentities.some((identity) => (
    identity.verificationReceipt.verifiedPublicKeySpkiHashes
      .includes(identity.subject.signerPublicKeySpkiHash)
  ))) blockers.push('autonomous_submission_identity_self_attestation_forbidden');
  if (!portalSubject
    || portalSubject.serviceId !== portalId
    || portalSubject.externalPrincipalIdentityAttestationSubjectHash !== serviceIdentityHash
    || portalSubject.providerAccountIdentityHash !== portalAccountIdentityHash
    || portalSubject.trustDomainIdentityHash !== portalTrustDomainIdentityHash
    || !receiptSignerSpkiHashes.includes(portalSubject.signerPublicKeySpkiHash)) {
    blockers.push('autonomous_submission_portal_identity_configuration_binding_invalid');
  }
  const separationReceipt = evaluateExternalPrincipalIdentitySeparation({
    candidate: portalSubject,
    references: originIdentities.map((identity) => identity?.subject),
    requiredDistinctFields: DISTINCT_FIELDS,
    now,
    requirePlatformAttestation: true,
  });
  blockers.push(...separationReceipt.blockers.map((blocker) => (
    `autonomous_submission_portal_identity_separation_invalid:${blocker}`
  )));
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const cryptographicAuthorityReady = uniqueBlockers.length === 0;
  const trustSetHash = cryptographicAuthorityReady
    ? hashRecord('AutonomousSubmissionPortalIdentityTrustSet', {
      receiptTrustStoreHash: receiptTrust.trustStoreHash,
      portalIdentityTrustStoreHash: portalIdentity.bundle.trustStoreHash,
      localOriginIdentityTrustStoreHashes: originIdentities
        .map((identity) => identity.bundle.trustStoreHash).sort(),
      portalIdentitySubjectHash:
        portalSubject.externalPrincipalIdentityAttestationSubjectHash,
      localOriginIdentitySubjectHashes: [...originSubjectHashes].sort(),
    }) : null;
  const signatureVerificationPolicyHash = cryptographicAuthorityReady
    ? hashRecord('AutonomousSubmissionPortalIdentitySeparationPolicy', {
      policy: 'pinned-platform-account-six-dimension-separation-v1',
      identitySubjectKind: IDENTITY_SUBJECT_KIND,
      identityAttestorRole: IDENTITY_ATTESTOR_ROLE,
      requiredDistinctFields: DISTINCT_FIELDS,
      platformAttestationRequired: true,
    }) : null;
  const payload = {
    version: 1,
    kind: 'AutonomousSubmissionPortalIdentitySeparationInspection',
    status: cryptographicAuthorityReady
      ? 'autonomous_submission_portal_identity_separation_verified'
      : 'autonomous_submission_portal_identity_separation_blocked',
    cryptographicAuthorityReady,
    identityIndependenceReady: cryptographicAuthorityReady,
    trustSetHash,
    signatureVerificationPolicyHash,
    portalIdentitySubject: portalSubject,
    portalIdentityVerificationReceipt: portalIdentity?.verificationReceipt || null,
    localOriginIdentitySubjects: Object.freeze(originIdentities
      .map((identity) => identity?.subject || null)),
    localOriginIdentityVerificationReceipts: Object.freeze(originIdentities
      .map((identity) => identity?.verificationReceipt || null)),
    identitySeparationReceipt: separationReceipt,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    autonomousSubmissionPortalIdentitySeparationInspectionHash: hashRecord(
      'AutonomousSubmissionPortalIdentitySeparationInspection', payload,
    ),
  });
}
