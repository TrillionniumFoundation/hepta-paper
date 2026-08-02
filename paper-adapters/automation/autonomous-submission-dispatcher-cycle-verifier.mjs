import crypto from 'node:crypto';
import path from 'node:path';

import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  readImmutableJsonDocument,
  verifyImmutableEd25519AuthorityDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertPinnedExternalEvidenceVerificationReceipt,
} from '../authority/pinned-external-evidence-verifier.mjs';
import {
  AUTONOMOUS_SUBMISSION_DISPATCHER_CYCLE_SIGNER_ROLE,
  verifyAutonomousSubmissionDispatcherCycleReceipt,
} from '../../paper-domain/automation/autonomous-submission-dispatcher-challenge-contract.mjs';

const IDENTITY_KEYS = Object.freeze([
  'cycleMaximumLifetimeMs', 'cycleSigner', 'kind', 'principalId', 'role',
  'status', 'version',
]);
const SIGNER_KEYS = Object.freeze([
  'algorithm', 'keyId', 'role', 'trustStorePath',
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,191}$/;

function resolveRelative(candidate, source) {
  return path.isAbsolute(String(candidate || ''))
    ? path.resolve(String(candidate))
    : path.resolve(path.dirname(source), String(candidate || ''));
}

export function readAutonomousSubmissionDispatcherIdentityConfiguration({
  environment = process.env,
  configurationPath = null,
} = {}) {
  const selected = path.resolve(String(configurationPath
    || environment.HEPTA_SUBMISSION_DISPATCHER_IDENTITY_CONFIG_PATH || ''));
  const value = readImmutableJsonDocument(selected, { maximumBytes: 1024 * 1024 });
  const signer = value?.cycleSigner;
  const maximumLifetimeMs = Number(value?.cycleMaximumLifetimeMs);
  if (!hasExactObjectKeys(value, IDENTITY_KEYS)
    || value.version !== 1
    || value.kind !== 'AutonomousSubmissionDispatcherIdentityConfiguration'
    || value.role !== 'autonomous-submission-dispatcher'
    || value.status !== 'active'
    || !IDENTIFIER.test(String(value.principalId || ''))
    || !hasExactObjectKeys(signer, SIGNER_KEYS)
    || signer.algorithm !== 'ed25519'
    || signer.role !== AUTONOMOUS_SUBMISSION_DISPATCHER_CYCLE_SIGNER_ROLE
    || !IDENTIFIER.test(String(signer.keyId || ''))
    || !Number.isSafeInteger(maximumLifetimeMs)
    || maximumLifetimeMs < 60_000 || maximumLifetimeMs > 60 * 60 * 1000) {
    throw new Error('autonomous_submission_dispatcher_identity_configuration_invalid');
  }
  const trustStorePath = resolveRelative(signer.trustStorePath, selected);
  const trustStore = readImmutableJsonDocument(trustStorePath, {
    maximumBytes: 1024 * 1024,
  });
  const matching = trustStore?.version === 1
    && trustStore?.kind === 'AuthorityTrustStore'
    && Array.isArray(trustStore.keys)
    ? trustStore.keys.filter((key) => key?.keyId === signer.keyId
      && key?.algorithm === 'ed25519' && key?.status === 'active'
      && Array.isArray(key?.roles)
      && key.roles.includes(AUTONOMOUS_SUBMISSION_DISPATCHER_CYCLE_SIGNER_ROLE)
      && !key.privateKeyPem && !/PRIVATE KEY/.test(String(key.publicKeyPem || ''))) : [];
  if (matching.length !== 1) {
    throw new Error('autonomous_submission_dispatcher_cycle_trust_anchor_invalid');
  }
  let publicKey;
  try { publicKey = crypto.createPublicKey(String(matching[0].publicKeyPem || '')); }
  catch { throw new Error('autonomous_submission_dispatcher_cycle_trust_anchor_invalid'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('autonomous_submission_dispatcher_cycle_trust_anchor_invalid');
  }
  const signerIdentity = Object.freeze({
    keyId: signer.keyId,
    subjectId: String(matching[0].subjectId || signer.keyId),
    publicKeySpkiHash: hashBytes(publicKey.export({ type: 'spki', format: 'der' })),
  });
  return Object.freeze({
    configurationPath: selected,
    configuration: Object.freeze(value),
    configurationHash: hashRecord(
      'AutonomousSubmissionDispatcherIdentityConfiguration', value,
    ),
    principalId: value.principalId,
    signer: Object.freeze(signer),
    signerIdentity,
    maximumLifetimeMs,
    trustStorePath,
    trustStore: Object.freeze(trustStore),
  });
}

export function assertAutonomousSubmissionPortalCanaryAuthorityIndependentFromDispatcher({
  verificationReceipt,
  identity,
} = {}) {
  const verified = assertPinnedExternalEvidenceVerificationReceipt(verificationReceipt);
  const dispatcherSubjects = new Set([
    identity?.principalId,
    identity?.signerIdentity?.subjectId,
  ].filter(Boolean));
  const subjectCollision = verified.verifiedSubjectIds.some(
    (subjectId) => dispatcherSubjects.has(subjectId),
  );
  const spkiCollision = verified.verifiedPublicKeySpkiHashes.includes(
    identity?.signerIdentity?.publicKeySpkiHash,
  );
  if (!identity?.signerIdentity || subjectCollision || spkiCollision) {
    throw new Error(
      'autonomous_submission_portal_canary_authority_not_independent_from_dispatcher',
    );
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionPortalCanaryAuthorityIndependence',
    dispatcherPrincipalId: identity.principalId,
    dispatcherSignerSubjectId: identity.signerIdentity.subjectId,
    dispatcherSignerPublicKeySpkiHash: identity.signerIdentity.publicKeySpkiHash,
    portalCanarySignerSubjectIds: Object.freeze([...verified.verifiedSubjectIds]),
    portalCanarySignerPublicKeySpkiHashes:
      Object.freeze([...verified.verifiedPublicKeySpkiHashes]),
    independent: true,
  });
  return Object.freeze({
    ...payload,
    portalCanaryAuthorityIndependenceHash: hashRecord(
      'AutonomousSubmissionPortalCanaryAuthorityIndependence',
      payload,
    ),
  });
}

export function verifyAutonomousSubmissionDispatcherCycleEnvelope({
  envelope,
  challenge,
  identity,
  now = new Date(),
  requireReady = true,
} = {}) {
  if (!identity || envelope?.dispatcherPrincipalId !== identity.principalId
    || envelope?.dispatcherIdentityConfigurationHash !== identity.configurationHash
    || !verifyAutonomousSubmissionDispatcherCycleReceipt(envelope, {
      challenge,
      now,
      requireReady,
    })) {
    throw new Error('autonomous_submission_dispatcher_cycle_envelope_invalid');
  }
  const authority = verifyImmutableEd25519AuthorityDocument({
    document: envelope,
    trustStore: identity.trustStore,
    requiredRole: AUTONOMOUS_SUBMISSION_DISPATCHER_CYCLE_SIGNER_ROLE,
    now,
    maximumLifetimeMs: identity.maximumLifetimeMs,
  });
  if (authority.verifiedSignatures.length !== 1
    || authority.verifiedSignatures[0].keyId !== identity.signer.keyId
    || authority.verifiedSignatures[0].subjectId !== identity.signerIdentity.subjectId
    || authority.verifiedSignatures[0].publicKeySpkiHash
      !== identity.signerIdentity.publicKeySpkiHash) {
    throw new Error('autonomous_submission_dispatcher_cycle_signer_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDispatcherCycleVerification',
    status: envelope.ready
      ? 'autonomous_submission_dispatcher_cycle_verified_ready'
      : 'autonomous_submission_dispatcher_cycle_verified_blocked',
    ready: envelope.ready === true,
    challengeHash: challenge.challengeHash,
    cycleReceiptHash: envelope.cycleReceiptHash,
    dispatcherPrincipalId: identity.principalId,
    dispatcherIdentityConfigurationHash: identity.configurationHash,
    signatureVerified: true,
    verifiedSigner: authority.verifiedSignatures[0],
    signedAt: authority.signedAt,
    expiresAt: authority.expiresAt,
  });
}
