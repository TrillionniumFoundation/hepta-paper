import crypto from 'node:crypto';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import {
  campaignReleaseExecutionAttestationSigningPayloadHash,
  RESEARCH_EXECUTION_RELEASE_ATTESTOR_ROLE,
  verifyCampaignReleaseExecutionAttestationStructure,
} from '../../paper-domain/automation/campaign-release-execution-attestation-contract.mjs';

function publicKeyFingerprint(publicKeyPem) {
  try {
    const pem = String(publicKeyPem || '');
    if (Buffer.byteLength(pem, 'utf8') > 16 * 1024 || /PRIVATE KEY/.test(pem)) return null;
    return hashBytes(crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }));
  } catch { return null; }
}

function normalizedRoot(root) {
  const publicKeySpkiHash = publicKeyFingerprint(root?.publicKeyPem);
  const effectiveFrom = Date.parse(String(root?.effectiveFrom || root?.validFrom || ''));
  const expiresAt = Date.parse(String(root?.expiresAt || ''));
  const revokedAt = root?.revokedAt ? Date.parse(root.revokedAt) : Number.POSITIVE_INFINITY;
  if (!root?.keyId || !root?.subjectId || !String(root?.organization || '').trim() || root?.algorithm !== 'ed25519'
    || !root?.keyVersion
    || !publicKeySpkiHash || root?.publicKeySpkiHash !== publicKeySpkiHash
    || !Array.isArray(root?.roles) || !root.roles.includes(RESEARCH_EXECUTION_RELEASE_ATTESTOR_ROLE)
    || !Number.isFinite(effectiveFrom) || !Number.isFinite(expiresAt)
    || (root.revokedAt && !Number.isFinite(revokedAt))) return null;
  return Object.freeze({
    keyId: String(root.keyId),
    keyVersion: String(root.keyVersion),
    subjectId: String(root.subjectId),
    organization: root.organization ? String(root.organization) : null,
    publicKeyPem: String(root.publicKeyPem),
    publicKeySpkiHash,
    status: String(root.status || ''),
    revoked: root.revoked === true || root.status === 'revoked' || Boolean(root.revokedAt),
    effectiveFrom,
    expiresAt,
    revokedAt,
  });
}

export function verifyOfflineResearchExecutionReleaseAttestation({
  attestation,
  manifest,
  manifestFileHash,
  trustedReleaseRoots = null,
  verificationTime = new Date(),
} = {}) {
  const blockers = [];
  const structure = verifyCampaignReleaseExecutionAttestationStructure(attestation, {
    manifest,
    researchEvidenceCapsuleManifestHash: manifest?.researchEvidenceCapsuleManifestHash,
    researchEvidenceCapsuleManifestFileHash: manifestFileHash,
  });
  blockers.push(...structure.blockers);
  const now = verificationTime instanceof Date ? verificationTime : new Date(verificationTime);
  if (!Number.isFinite(now.getTime())) blockers.push('research_execution_release_attestation_verification_time_invalid');
  const roots = Array.isArray(trustedReleaseRoots) ? trustedReleaseRoots : [];
  if (!roots.length) blockers.push('research_execution_release_external_trust_root_required');
  const normalized = roots.map(normalizedRoot);
  if (normalized.some((root) => !root)
    || new Set(normalized.filter(Boolean).map((root) => `${root.keyId}:${root.keyVersion}`)).size
      !== normalized.filter(Boolean).length
    || new Set(normalized.filter(Boolean).map((root) => root.publicKeySpkiHash)).size
      !== normalized.filter(Boolean).length) {
    blockers.push('research_execution_release_external_trust_root_invalid');
  }
  const root = normalized.find((candidate) => candidate?.keyId === attestation?.keyId
    && candidate?.keyVersion === attestation?.keyVersion) || null;
  if (!root) blockers.push(`research_execution_release_external_trust_root_missing:${attestation?.keyId || 'unknown'}`);
  if (root && (root.subjectId !== attestation?.subjectId
    || root.organization !== (attestation?.organization || null))) {
    blockers.push('research_execution_release_external_trust_root_identity_mismatch');
  }
  if (root && !['active', 'retiring'].includes(root.status)) {
    blockers.push('research_execution_release_external_trust_root_not_active_or_retiring');
  }
  if (root && (root.revoked === true || (Number.isFinite(now.getTime()) && now.getTime() >= root.revokedAt))) {
    blockers.push('research_execution_release_external_trust_root_revoked');
  }
  if (root && Number.isFinite(now.getTime())
    && (now.getTime() < root.effectiveFrom || now.getTime() >= root.expiresAt)) {
    blockers.push('research_execution_release_external_trust_root_outside_time_window');
  }
  const signedAt = Date.parse(String(attestation?.signedAt || ''));
  if (root && Number.isFinite(signedAt)
    && (signedAt < root.effectiveFrom || signedAt >= root.expiresAt || signedAt >= root.revokedAt)) {
    blockers.push('research_execution_release_external_trust_root_invalid_at_signature_time');
  }
  if (Number.isFinite(now.getTime()) && (now.getTime() < Date.parse(String(attestation?.validFrom || ''))
    || now.getTime() >= Date.parse(String(attestation?.expiresAt || '')))) {
    blockers.push('research_execution_release_attestation_outside_time_window');
  }
  let signatureVerified = false;
  if (root && structure.valid) {
    try {
      signatureVerified = crypto.verify(
        null,
        Buffer.from(campaignReleaseExecutionAttestationSigningPayloadHash(attestation), 'utf8'),
        root.publicKeyPem,
        Buffer.from(String(attestation.signature || ''), 'base64'),
      );
    } catch { signatureVerified = false; }
  }
  if (!signatureVerified) blockers.push('research_execution_release_attestation_signature_invalid');
  const uniqueBlockers = [...new Set(blockers)];
  return Object.freeze({
    version: 1,
    kind: 'OfflineResearchExecutionReleaseAttestationVerification',
    status: uniqueBlockers.length
      ? 'offline_research_execution_release_attestation_blocked'
      : 'offline_research_execution_release_attestation_verified',
    valid: uniqueBlockers.length === 0,
    capsuleManifestExternalSignatureVerified: uniqueBlockers.length === 0 && signatureVerified,
    recordedExecutionLineageExternallyAttested: uniqueBlockers.length === 0 && signatureVerified,
    executionAuthenticityExternallyAttested: false,
    trustedReleaseRootKeyId: uniqueBlockers.length === 0 ? root?.keyId || null : null,
    trustedReleaseRootSpkiHash: uniqueBlockers.length === 0 ? root?.publicKeySpkiHash || null : null,
    verificationTime: Number.isFinite(now.getTime()) ? now.toISOString() : null,
    blockers: Object.freeze(uniqueBlockers),
  });
}
