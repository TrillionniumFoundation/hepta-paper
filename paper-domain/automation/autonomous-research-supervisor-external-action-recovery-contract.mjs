import crypto from 'node:crypto';

import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const ACTION_KINDS = Object.freeze([
  'golden-release-attestor',
  'production-readiness',
  'provider-canary',
]);
const OUTCOMES = new Set(['completed', 'failed', 'in_progress', 'not_found']);
const CAPABILITY_KEYS = Object.freeze([
  'actionConfigurationIdentityHashes', 'actionKinds', 'authoritativeSignedLookupSupported',
  'autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash',
  'definitiveNotFoundSupported', 'expiresAt', 'idempotentResumeSupported',
  'issuedAt', 'kind', 'processIdentityHash', 'recoveryProcessConfigurationIdentityHash',
  'recoveryTrustIdentityHash', 'signature', 'signer',
  'stableKeyContractId', 'status', 'version',
].sort());
const RESOLUTION_KEYS = Object.freeze([
  'actionAccountingComplete', 'actionKind',
  'actionConfigurationIdentityHash',
  'autonomousResearchSupervisorExternalActionRecoveryResolutionHash',
  'completedAt', 'expiresAt', 'externalActionPerformed', 'idempotencyKey',
  'kind', 'markerHash', 'observedAt', 'outcome', 'progressHash',
  'recoveryCapabilityReceiptHash', 'recoveryConfigurationIdentityHash',
  'recoveryTrustIdentityHash', 'reservationHash', 'result', 'resultHash', 'signature', 'signer',
  'status', 'version',
].sort());
const SIGNER_KEYS = Object.freeze([
  'algorithm', 'keyId', 'keyVersion', 'organization', 'role', 'subjectId',
].sort());
const TRUSTED_SIGNER_KEYS = Object.freeze([
  ...SIGNER_KEYS, 'effectiveFrom', 'expiresAt', 'revokedAt',
].sort());

function canonicalTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalActionKinds(value) {
  return Array.isArray(value)
    && JSON.stringify(value) === JSON.stringify(ACTION_KINDS);
}

function signerValid(value) {
  return exactKeys(value, SIGNER_KEYS)
    && value.algorithm === 'Ed25519'
    && value.role === 'autonomous-research-external-action-recovery-authority'
    && [value.keyId, value.subjectId].every((item) => SAFE_ID.test(String(item || '')))
    && Number.isSafeInteger(value.keyVersion) && value.keyVersion >= 1
    && (value.organization === null || SAFE_ID.test(String(value.organization || '')));
}

function trustedSignerMatches(signer, trustedSigner, observedAt) {
  if (!signerValid(signer) || !exactKeys(trustedSigner, TRUSTED_SIGNER_KEYS)
    || !signerValid(Object.fromEntries(SIGNER_KEYS.map((key) => [key, trustedSigner[key]])))
    || signer.keyId !== trustedSigner.keyId
    || signer.keyVersion !== trustedSigner.keyVersion
    || signer.subjectId !== trustedSigner.subjectId
    || signer.organization !== trustedSigner.organization
    || signer.role !== trustedSigner.role
    || signer.algorithm !== trustedSigner.algorithm
    || !canonicalTimestamp(trustedSigner.effectiveFrom)
    || !canonicalTimestamp(trustedSigner.expiresAt)
    || trustedSigner.revokedAt !== null) return false;
  const at = Date.parse(observedAt);
  return at >= Date.parse(trustedSigner.effectiveFrom)
    && at < Date.parse(trustedSigner.expiresAt);
}

function publicKey(value) {
  if (typeof value !== 'string' || !value || /PRIVATE KEY/.test(value)) return null;
  try {
    const key = crypto.createPublicKey(value);
    return key.type === 'public' && key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch { return null; }
}

function signatureValid(payloadHash, signature, key) {
  if (!SHA256.test(String(payloadHash || '')) || typeof signature !== 'string' || !signature) {
    return false;
  }
  try {
    return crypto.verify(null, Buffer.from(payloadHash, 'utf8'), key,
      Buffer.from(signature, 'base64'));
  } catch { return false; }
}

function resultSnapshotValid(value) {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try { return Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024; }
  catch { return false; }
}

export function autonomousResearchSupervisorExternalActionStableKey({
  campaignId,
  actionKind,
  dispatchCount,
  providerCanaryCount = 0,
  providerConfigurationHash,
  actionConfigurationIdentityHash = providerConfigurationHash,
  attemptScopeHash,
  action = null,
  launchMode = null,
} = {}) {
  if (!SAFE_ID.test(String(campaignId || '')) || !ACTION_KINDS.includes(actionKind)
    || !Number.isSafeInteger(dispatchCount) || dispatchCount < 1
    || !Number.isSafeInteger(providerCanaryCount) || providerCanaryCount < 0
    || !SHA256.test(String(actionConfigurationIdentityHash || ''))
    || !SHA256.test(String(attemptScopeHash || ''))
    || (action !== null && !SAFE_ID.test(String(action || '')))
    || (launchMode !== null && !SAFE_ID.test(String(launchMode || '')))) {
    throw new Error('autonomous_research_supervisor_external_action_stable_key_invalid');
  }
  return hashRecord('AutonomousResearchSupervisorExternalActionStableKey', {
    campaignId,
    actionKind,
    dispatchCount,
    providerCanaryCount,
    actionConfigurationIdentityHash,
    attemptScopeHash,
    action,
    launchMode,
  });
}

export function verifyAutonomousResearchSupervisorExternalActionRecoveryCapability(
  receipt,
  {
    trustedSigner,
    publicKeyPem,
    processIdentityHash,
    recoveryProcessConfigurationIdentityHash,
    recoveryTrustIdentityHash,
    now = null,
  } = {},
) {
  if (!exactKeys(receipt, CAPABILITY_KEYS) || receipt.version !== 1
    || receipt.kind !== 'AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceipt'
    || receipt.status !== 'autonomous_research_supervisor_external_action_recovery_qualified'
    || !canonicalActionKinds(receipt.actionKinds)
    || receipt.authoritativeSignedLookupSupported !== true
    || receipt.definitiveNotFoundSupported !== true
    || receipt.idempotentResumeSupported !== true
    || receipt.stableKeyContractId
      !== 'autonomous-research-supervisor-external-action-stable-key-v1'
    || !SHA256.test(String(receipt.processIdentityHash || ''))
    || receipt.processIdentityHash !== processIdentityHash
    || !SHA256.test(String(receipt.recoveryProcessConfigurationIdentityHash || ''))
    || receipt.recoveryProcessConfigurationIdentityHash
      !== recoveryProcessConfigurationIdentityHash
    || !SHA256.test(String(receipt.recoveryTrustIdentityHash || ''))
    || receipt.recoveryTrustIdentityHash !== recoveryTrustIdentityHash
    || !receipt.actionConfigurationIdentityHashes
    || JSON.stringify(Object.keys(receipt.actionConfigurationIdentityHashes).sort())
      !== JSON.stringify(ACTION_KINDS)
    || Object.values(receipt.actionConfigurationIdentityHashes)
      .some((value) => !SHA256.test(String(value || '')))
    || !canonicalTimestamp(receipt.issuedAt) || !canonicalTimestamp(receipt.expiresAt)
    || Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt)
    || !canonicalTimestamp(now instanceof Date ? now.toISOString() : String(now))
    || Date.parse(receipt.issuedAt) > new Date(now).getTime()
    || new Date(now).getTime() >= Date.parse(receipt.expiresAt)
    || !trustedSignerMatches(receipt.signer, trustedSigner, receipt.issuedAt)) return false;
  const key = publicKey(publicKeyPem);
  if (!key) return false;
  const {
    autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash: claimedHash,
    signature,
    ...payload
  } = receipt;
  const payloadHash = hashRecord(
    'AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptPayload',
    payload,
  );
  return claimedHash === hashRecord(
    'AutonomousResearchSupervisorExternalActionRecoveryCapabilityReceipt',
    { ...payload, signature },
  ) && signatureValid(payloadHash, signature, key);
}

export function verifyAutonomousResearchSupervisorExternalActionRecoveryResolution(
  resolution,
  {
    trustedSigner,
    publicKeyPem,
    actionKind,
    idempotencyKey,
    markerHash,
    reservationHash,
    progressHash = null,
    actionConfigurationIdentityHash,
    recoveryConfigurationIdentityHash,
    recoveryTrustIdentityHash,
    recoveryCapabilityReceiptHash,
    now = null,
  } = {},
) {
  if (!exactKeys(resolution, RESOLUTION_KEYS) || resolution.version !== 1
    || resolution.kind !== 'AutonomousResearchSupervisorExternalActionRecoveryResolution'
    || resolution.status !== 'autonomous_research_supervisor_external_action_recovery_resolved'
    || resolution.actionKind !== actionKind || !ACTION_KINDS.includes(actionKind)
    || resolution.idempotencyKey !== idempotencyKey
    || resolution.markerHash !== markerHash
    || resolution.reservationHash !== reservationHash
    || resolution.progressHash !== progressHash
    || resolution.actionConfigurationIdentityHash !== actionConfigurationIdentityHash
    || resolution.recoveryConfigurationIdentityHash !== recoveryConfigurationIdentityHash
    || resolution.recoveryTrustIdentityHash !== recoveryTrustIdentityHash
    || resolution.recoveryCapabilityReceiptHash !== recoveryCapabilityReceiptHash
    || [actionConfigurationIdentityHash, recoveryConfigurationIdentityHash,
      recoveryTrustIdentityHash, recoveryCapabilityReceiptHash]
      .some((value) => !SHA256.test(String(value || '')))
    || !OUTCOMES.has(resolution.outcome)
    || !resultSnapshotValid(resolution.result)
    || resolution.resultHash !== (resolution.result === null ? null : hashRecord(
      'AutonomousResearchSupervisorExternalActionRecoveryResult',
      { actionKind, idempotencyKey, result: resolution.result },
    ))
    || typeof resolution.actionAccountingComplete !== 'boolean'
    || typeof resolution.externalActionPerformed !== 'boolean'
    || !canonicalTimestamp(resolution.observedAt)
    || !canonicalTimestamp(resolution.expiresAt)
    || (resolution.completedAt !== null && !canonicalTimestamp(resolution.completedAt))
    || Date.parse(resolution.expiresAt) <= Date.parse(resolution.observedAt)
    || Date.parse(resolution.observedAt) > new Date(now).getTime()
    || (resolution.completedAt !== null
      && Date.parse(resolution.completedAt) > Date.parse(resolution.observedAt))
    || new Date(now).getTime() >= Date.parse(resolution.expiresAt)
    || !trustedSignerMatches(resolution.signer, trustedSigner, resolution.observedAt)) return false;
  if (['completed', 'failed'].includes(resolution.outcome)) {
    if (!canonicalTimestamp(resolution.completedAt)
      || resolution.actionAccountingComplete !== true || resolution.result === null) return false;
  } else if (resolution.completedAt !== null
    || resolution.actionAccountingComplete !== false
    || resolution.externalActionPerformed !== (resolution.outcome === 'in_progress')) return false;
  const key = publicKey(publicKeyPem);
  if (!key) return false;
  const {
    autonomousResearchSupervisorExternalActionRecoveryResolutionHash: claimedHash,
    signature,
    ...payload
  } = resolution;
  const payloadHash = hashRecord(
    'AutonomousResearchSupervisorExternalActionRecoveryResolutionPayload',
    payload,
  );
  return claimedHash === hashRecord(
    'AutonomousResearchSupervisorExternalActionRecoveryResolution',
    { ...payload, signature },
  ) && signatureValid(payloadHash, signature, key);
}

export const AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_RECOVERY_ACTION_KINDS =
  ACTION_KINDS;
