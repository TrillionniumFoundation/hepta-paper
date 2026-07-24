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
const IDENTITY_ATTESTOR_ROLE = 'external_research_replay_identity_attestor';
const DISTINCT_FIELDS = Object.freeze([
  'credentialRoot', 'host', 'process', 'providerAccount', 'signerSpki', 'trustDomain',
]);
const identityAttestationBundleCodec =
  createExternalPrincipalIdentityAttestationBundleCodec({
    bundleKind: 'ExternalResearchReplayIdentityAttestationBundle',
    signerRole: IDENTITY_ATTESTOR_ROLE,
    invalidBundleError: 'external_research_replay_identity_attestation_bundle_invalid',
    requireSubjectSignerMatch: true,
  });

export function buildExternalResearchReplayIdentityAttestationBundle({
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

export function verifyExternalResearchReplayIdentityAttestationBundle(bundle) {
  return identityAttestationBundleCodec.verify(bundle);
}

function inspectBundle(bundle, now) {
  return identityAttestationBundleCodec.inspect(bundle, now);
}

function receiptSignerSpkiHashes(receiptTrustStore, receiptSignerRole, receiptSignerKeyIds) {
  const trust = inspectPinnedExternalEvidenceTrustStore(receiptTrustStore, {
    requiredRole: receiptSignerRole,
    expectedKeyIds: receiptSignerKeyIds,
  });
  return Object.freeze({
    trust,
    hashes: trust.ready
      ? trust.keys.filter((key) => receiptSignerKeyIds.includes(key.keyId))
        .map((key) => key.publicKeySpkiHash).sort()
      : [],
  });
}

export function inspectExternalResearchReplayIdentitySeparation({
  serviceId,
  serviceIdentityHash,
  receiptTrustStore,
  receiptSignerRole,
  receiptSignerKeyIds,
  remoteIdentityAttestationBundle,
  localOriginIdentityAttestationBundles,
  now,
} = {}) {
  const blockers = [];
  const remote = inspectBundle(remoteIdentityAttestationBundle, now);
  const originBundles = Array.isArray(localOriginIdentityAttestationBundles)
    ? localOriginIdentityAttestationBundles : [];
  const origins = originBundles.map((bundle) => inspectBundle(bundle, now));
  if (!remote) blockers.push('external_research_replay_remote_identity_attestation_invalid');
  if (originBundles.length < 1 || originBundles.length > 64
    || origins.some((identity) => identity === null)) {
    blockers.push('external_research_replay_local_origin_identity_set_invalid');
  }
  const originSubjectHashes = origins.map((identity) => (
    identity?.subject.externalPrincipalIdentityAttestationSubjectHash || null
  ));
  if (new Set(originSubjectHashes).size !== originSubjectHashes.length) {
    blockers.push('external_research_replay_local_origin_identity_set_duplicate');
  }
  const receiptSignerTrust = receiptSignerSpkiHashes(
    receiptTrustStore,
    receiptSignerRole,
    receiptSignerKeyIds,
  );
  const remoteSubject = remote?.subject || null;
  if (!remoteSubject
    || remoteSubject.serviceId !== serviceId
    || remoteSubject.externalPrincipalIdentityAttestationSubjectHash !== serviceIdentityHash
    || !receiptSignerTrust.hashes.includes(remoteSubject.signerPublicKeySpkiHash)) {
    blockers.push('external_research_replay_remote_identity_configuration_binding_invalid');
  }
  const separationReceipt = evaluateExternalPrincipalIdentitySeparation({
    candidate: remoteSubject,
    references: origins.map((identity) => identity?.subject),
    requiredDistinctFields: DISTINCT_FIELDS,
    now,
    requirePlatformAttestation: true,
  });
  blockers.push(...separationReceipt.blockers.map((blocker) => (
    `external_research_replay_identity_separation_invalid:${blocker}`
  )));
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const ready = uniqueBlockers.length === 0;
  const trustSetHash = ready ? hashRecord('ExternalResearchReplayIdentityTrustSet', {
    receiptTrustStoreHash: receiptSignerTrust.trust.trustStoreHash,
    remoteIdentityTrustStoreHash: remote.bundle.trustStoreHash,
    localOriginIdentityTrustStoreHashes:
      origins.map((identity) => identity.bundle.trustStoreHash).sort(),
    remoteIdentitySubjectHash:
      remoteSubject.externalPrincipalIdentityAttestationSubjectHash,
    localOriginIdentitySubjectHashes: [...originSubjectHashes].sort(),
  }) : null;
  const signatureVerificationPolicyHash = ready
    ? hashRecord('ExternalResearchReplayIdentitySeparationPolicy', {
      policy: 'pinned-platform-account-six-dimension-separation-v1',
      identitySubjectKind: IDENTITY_SUBJECT_KIND,
      identityAttestorRole: IDENTITY_ATTESTOR_ROLE,
      requiredDistinctFields: DISTINCT_FIELDS,
      platformAttestationRequired: true,
    }) : null;
  const payload = {
    version: 1,
    kind: 'ExternalResearchReplayIdentitySeparationInspection',
    status: ready
      ? 'external_research_replay_identity_separation_verified'
      : 'external_research_replay_identity_separation_blocked',
    cryptographicAuthorityReady: ready,
    identityIndependenceReady: ready,
    trustSetHash,
    signatureVerificationPolicyHash,
    remoteIdentitySubject: remoteSubject,
    remoteIdentityVerificationReceipt: remote?.verificationReceipt || null,
    localOriginIdentitySubjects: Object.freeze(origins.map((identity) => (
      identity?.subject || null
    ))),
    localOriginIdentityVerificationReceipts: Object.freeze(origins.map((identity) => (
      identity?.verificationReceipt || null
    ))),
    identitySeparationReceipt: separationReceipt,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    externalResearchReplayIdentitySeparationInspectionHash: hashRecord(
      'ExternalResearchReplayIdentitySeparationInspection', payload,
    ),
  });
}

export const EXTERNAL_RESEARCH_REPLAY_IDENTITY_ATTESTOR_ROLE = IDENTITY_ATTESTOR_ROLE;
