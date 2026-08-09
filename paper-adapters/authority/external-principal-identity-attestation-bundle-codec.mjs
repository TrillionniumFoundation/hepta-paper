import {
  verifyExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  inspectPinnedExternalEvidenceTrustStore,
  verifyPinnedExternalEvidenceEnvelope,
} from './pinned-external-evidence-verifier.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const IDENTITY_SUBJECT_KIND = 'ExternalPrincipalIdentityAttestationSubject';
const BUNDLE_KEYS = Object.freeze([
  'authorityEnvelope', 'bundleHash', 'kind', 'maximumLifetimeMs', 'signerKeyIds',
  'signerRole', 'subject', 'trustStore', 'trustStoreHash', 'version',
]);

export function canonicalExternalPrincipalKeyIds(values) {
  const selected = [...new Set((Array.isArray(values) ? values : []).map(String))].sort();
  return selected.length >= 1 && selected.length <= 4
    && selected.every((value) => SAFE_ID.test(value)) ? Object.freeze(selected) : null;
}

export function createExternalPrincipalIdentityAttestationBundleCodec({
  bundleKind,
  signerRole: expectedSignerRole,
  invalidBundleError,
  requireSubjectSignerMatch = false,
} = {}) {
  function build({
    subject,
    authorityEnvelope,
    trustStore,
    signerKeyIds,
    signerRole = expectedSignerRole,
    maximumLifetimeMs = 15 * 60 * 1000,
  } = {}) {
    const expectedKeyIds = canonicalExternalPrincipalKeyIds(signerKeyIds);
    const trust = inspectPinnedExternalEvidenceTrustStore(trustStore, {
      requiredRole: signerRole,
      expectedKeyIds,
    });
    let canonicalEnvelope = null;
    try { canonicalEnvelope = buildPinnedExternalEvidenceEnvelope(authorityEnvelope); }
    catch { /* rejected below */ }
    if (!verifyExternalPrincipalIdentityAttestationSubject(subject)
      || !expectedKeyIds || signerRole !== expectedSignerRole || !trust.ready
      || !Number.isSafeInteger(Number(maximumLifetimeMs))
      || Number(maximumLifetimeMs) < 1_000
      || Number(maximumLifetimeMs) > 24 * 60 * 60 * 1000
      || !canonicalEnvelope
      || JSON.stringify(canonicalEnvelope) !== JSON.stringify(authorityEnvelope)
      || canonicalEnvelope.subjectKind !== IDENTITY_SUBJECT_KIND
      || canonicalEnvelope.subjectHash
        !== subject.externalPrincipalIdentityAttestationSubjectHash) {
      throw new Error(invalidBundleError);
    }
    const payload = {
      version: 1,
      kind: bundleKind,
      subject,
      authorityEnvelope: canonicalEnvelope,
      trustStore: trust.canonicalTrustStore,
      trustStoreHash: trust.trustStoreHash,
      signerKeyIds: expectedKeyIds,
      signerRole: expectedSignerRole,
      maximumLifetimeMs: Number(maximumLifetimeMs),
    };
    return Object.freeze({
      ...payload,
      bundleHash: hashRecord(bundleKind, payload),
    });
  }

  function verify(bundle) {
    if (!hasExactObjectKeys(bundle, BUNDLE_KEYS)) return false;
    try { return JSON.stringify(build(bundle)) === JSON.stringify(bundle); }
    catch { return false; }
  }

  function inspect(bundle, now) {
    if (!verify(bundle)
      || !verifyExternalPrincipalIdentityAttestationSubject(bundle.subject, {
        now,
        maximumLifetimeMs: bundle.maximumLifetimeMs,
        requirePlatformAttestation: true,
      })) return null;
    const verificationReceipt = verifyPinnedExternalEvidenceEnvelope({
      envelope: bundle.authorityEnvelope,
      subjectKind: IDENTITY_SUBJECT_KIND,
      subjectHash: bundle.subject.externalPrincipalIdentityAttestationSubjectHash,
      trustStore: bundle.trustStore,
      requiredRole: bundle.signerRole,
      expectedKeyIds: bundle.signerKeyIds,
      now,
      maximumLifetimeMs: bundle.maximumLifetimeMs,
    });
    if (verificationReceipt.cryptographicAuthorityReady !== true
      || (requireSubjectSignerMatch
        && (verificationReceipt.verifiedPublicKeySpkiHashes.length !== 1
          || verificationReceipt.verifiedPublicKeySpkiHashes[0]
            !== bundle.subject.signerPublicKeySpkiHash))) return null;
    return Object.freeze({ bundle, subject: bundle.subject, verificationReceipt });
  }

  return Object.freeze({ build, verify, inspect });
}
