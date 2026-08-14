import crypto from 'node:crypto';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createOperatorDatasetHarnessAuthorityReceiptVerifier } from '../automation/operator-dataset-harness-authority-receipt-verifier.mjs';
import {
  publicTrustStoreFromSnapshot,
  verifyPublicAuthorityTrustSnapshot,
} from '../../paper-domain/automation/public-authority-trust-snapshot-contract.mjs';
import {
  GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
  GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
} from '../../paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs';

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function evidencePayload(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const { offlineOperatorDatasetAuthorityEvidenceHash: _hash, ...payload } = evidence;
  return payload;
}

function referencedKeyIds(evidence) {
  return unique(['original', 'independent-replay'].flatMap((role) => (
    evidence?.executions?.[role]?.authorityReceipt?.authority?.signatures || []
  ).map((signature) => String(signature?.keyId || '')))).sort();
}

function keyStateBlockers(snapshot, verificationTime) {
  const now = verificationTime.getTime();
  const blockers = [];
  for (const key of snapshot?.keys || []) {
    const effective = key.effectiveFrom ? Date.parse(key.effectiveFrom) : Number.NEGATIVE_INFINITY;
    const expires = key.expiresAt ? Date.parse(key.expiresAt) : Number.POSITIVE_INFINITY;
    const revoked = key.revokedAt ? Date.parse(key.revokedAt) : Number.POSITIVE_INFINITY;
    if (key.status !== 'active') blockers.push(`offline_authority_key_not_active:${key.keyId}`);
    if (key.revoked === true || now >= revoked) blockers.push(`offline_authority_key_revoked:${key.keyId}`);
    if (now < effective) blockers.push(`offline_authority_key_not_yet_effective:${key.keyId}`);
    if (now >= expires) blockers.push(`offline_authority_key_expired:${key.keyId}`);
  }
  return blockers;
}

function publicKeyFingerprint(publicKeyPem) {
  try {
    const pem = String(publicKeyPem || '');
    if (Buffer.byteLength(pem, 'utf8') > 16 * 1024) return null;
    const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
    return hashBytes(der);
  } catch { return null; }
}

function normalizedTrustAnchor(key) {
  const date = (value) => {
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : 'invalid';
  };
  const publicKeySpkiHash = publicKeyFingerprint(key?.publicKeyPem);
  const roles = [...new Set(
    (Array.isArray(key?.roles) ? key.roles : []).map(String),
  )].sort();
  const gpuAuthority = roles.some((role) => [
    GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
    GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
  ].includes(role));
  const processIdentityHash = key?.processIdentityHash
    ? String(key.processIdentityHash).toLowerCase() : null;
  if (!key?.keyId || !key?.subjectId || key?.algorithm !== 'ed25519' || !publicKeySpkiHash
    || !roles.length || !key?.status
    || (processIdentityHash && !/^sha256:[0-9a-f]{64}$/.test(processIdentityHash))
    || (gpuAuthority && !processIdentityHash)) return null;
  return Object.freeze({
    keyId: String(key.keyId),
    subjectId: String(key.subjectId),
    organization: key.organization ? String(key.organization) : null,
    algorithm: 'ed25519',
    publicKeySpkiHash,
    ...(processIdentityHash ? { processIdentityHash } : {}),
    roles: Object.freeze(roles),
    status: String(key.status),
    revoked: key.revoked === true || key.status === 'revoked' || Boolean(key.revokedAt),
    effectiveFrom: date(key.effectiveFrom || key.validFrom),
    expiresAt: date(key.expiresAt),
    revokedAt: date(key.revokedAt),
  });
}

function externalTrustAnchorBlockers({ trustSnapshot, keyIds, trustedAuthorityRoots }) {
  if (!keyIds.length) return [];
  if (!Array.isArray(trustedAuthorityRoots) || trustedAuthorityRoots.length < 1) {
    return ['offline_authority_external_trust_anchor_required'];
  }
  const blockers = [];
  const pins = new Map();
  for (const root of trustedAuthorityRoots) {
    const normalized = normalizedTrustAnchor(root);
    const keyId = String(normalized?.keyId || '');
    if (!normalized || pins.has(keyId)) {
      blockers.push('offline_authority_external_trust_anchor_invalid');
      continue;
    }
    pins.set(keyId, hashRecord('OfflineAuthorityExternalTrustAnchor', normalized));
  }
  const snapshotKeys = new Map((trustSnapshot?.keys || []).map((key) => [String(key?.keyId || ''), key]));
  for (const keyId of keyIds) {
    const snapshotKey = snapshotKeys.get(keyId);
    const pinnedAnchorHash = pins.get(keyId);
    const snapshotAnchor = normalizedTrustAnchor(snapshotKey);
    const snapshotAnchorHash = snapshotAnchor
      ? hashRecord('OfflineAuthorityExternalTrustAnchor', snapshotAnchor)
      : null;
    if (!pinnedAnchorHash) blockers.push(`offline_authority_external_trust_anchor_missing:${keyId}`);
    else if (!snapshotAnchorHash || snapshotAnchorHash !== pinnedAnchorHash) {
      blockers.push(`offline_authority_external_trust_anchor_mismatch:${keyId}`);
    }
  }
  return blockers;
}

export function verifyOfflinePublicAuthorityTrustAnchors({
  trustSnapshot,
  keyIds = [],
  trustedAuthorityRoots = null,
  verificationTime = new Date(),
} = {}) {
  const selectedKeyIds = unique(keyIds.map(String).filter(Boolean)).sort();
  const now = verificationTime instanceof Date
    ? verificationTime : new Date(verificationTime);
  const internalBlockers = [];
  const snapshotVerification = verifyPublicAuthorityTrustSnapshot(
    trustSnapshot,
  );
  internalBlockers.push(...snapshotVerification.blockers.map((blocker) => (
    `offline_authority:${blocker}`
  )));
  if (!selectedKeyIds.length) {
    internalBlockers.push('offline_authority_referenced_key_missing');
  }
  const declared = new Set(
    (trustSnapshot?.referencedKeyIds || []).map(String),
  );
  if (selectedKeyIds.some((keyId) => !declared.has(keyId))) {
    internalBlockers.push('offline_authority_referenced_key_not_in_snapshot');
  }
  if (!Number.isFinite(now.getTime())) {
    internalBlockers.push('offline_authority_verification_time_invalid');
  } else {
    const capturedAt = Date.parse(String(trustSnapshot?.capturedAt || ''));
    if (Number.isFinite(capturedAt) && now.getTime() < capturedAt) {
      internalBlockers.push('offline_authority_verification_precedes_trust_snapshot');
    }
    internalBlockers.push(...keyStateBlockers(trustSnapshot, now));
  }
  const anchorBlockers = externalTrustAnchorBlockers({
    trustSnapshot,
    keyIds: selectedKeyIds,
    trustedAuthorityRoots,
  });
  const blockers = unique([...internalBlockers, ...anchorBlockers]);
  return Object.freeze({
    valid: blockers.length === 0,
    packageInternalTrustSnapshotVerified: internalBlockers.length === 0,
    externalTrustAnchorVerified:
      selectedKeyIds.length > 0 && anchorBlockers.length === 0,
    externallyAnchoredKeyIds: Object.freeze(
      anchorBlockers.length ? [] : selectedKeyIds,
    ),
    blockers: Object.freeze(blockers),
  });
}

export function buildOfflineOperatorDatasetAuthorityEvidence({ originalRunReceipt, replayRunReceipt } = {}) {
  const execution = (run) => {
    const authorityReceipt = run?.harnessExecutionReceipt?.operatorDatasetHarnessAuthority || null;
    const datasetAuthorization = (run?.datasetAuthorizations || [])
      .find((dataset) => dataset?.name === authorityReceipt?.datasetName) || null;
    return Object.freeze({
      authorityReceipt,
      datasetAuthorization,
      benchmarkSelector: run?.benchmarkSelector || null,
      experimentRunReceiptHash: run?.experimentRunReceiptHash || null,
    });
  };
  const payload = {
    version: 2,
    kind: 'OfflineOperatorDatasetAuthorityEvidence',
    assurance: 'package-internal-signature-consistency-plus-external-root-required-v2',
    executions: Object.freeze({
      original: execution(originalRunReceipt),
      'independent-replay': execution(replayRunReceipt),
    }),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    offlineOperatorDatasetAuthorityEvidenceHash: hashRecord('OfflineOperatorDatasetAuthorityEvidence', payload),
  });
}

export function verifyOfflineOperatorDatasetAuthorityEvidence({
  evidence,
  trustSnapshot,
  trustedAuthorityRoots = null,
  verificationTime = new Date(),
} = {}) {
  const internalBlockers = [];
  const now = verificationTime instanceof Date ? verificationTime : new Date(verificationTime);
  if (!Number.isFinite(now.getTime())) internalBlockers.push('offline_authority_verification_time_invalid');
  const payload = evidencePayload(evidence);
  if (evidence?.version !== 2 || evidence?.kind !== 'OfflineOperatorDatasetAuthorityEvidence'
    || evidence?.assurance !== 'package-internal-signature-consistency-plus-external-root-required-v2'
    || evidence?.externalActionPerformed !== false
    || !payload || hashRecord('OfflineOperatorDatasetAuthorityEvidence', payload)
      !== evidence?.offlineOperatorDatasetAuthorityEvidenceHash) {
    internalBlockers.push('offline_operator_dataset_authority_evidence_invalid');
  }
  const keyIds = referencedKeyIds(evidence);
  const snapshotVerification = verifyPublicAuthorityTrustSnapshot(trustSnapshot, {
    requiredKeyIds: keyIds,
    allowAdditionalReferencedKeys: true,
  });
  internalBlockers.push(...snapshotVerification.blockers.map((blocker) => `offline_authority:${blocker}`));
  if (!keyIds.length) internalBlockers.push('offline_authority_referenced_key_missing');
  if (Number.isFinite(now.getTime()) && Number.isFinite(Date.parse(String(trustSnapshot?.capturedAt || '')))
    && now.getTime() < Date.parse(trustSnapshot.capturedAt)) internalBlockers.push('offline_authority_verification_precedes_trust_snapshot');
  if (Number.isFinite(now.getTime())) internalBlockers.push(...keyStateBlockers(trustSnapshot, now));
  const anchorBlockers = externalTrustAnchorBlockers({ trustSnapshot, keyIds, trustedAuthorityRoots });
  const trustStore = publicTrustStoreFromSnapshot(trustSnapshot);
  const verifyReceipt = createOperatorDatasetHarnessAuthorityReceiptVerifier({
    trustStoreProvider: () => trustStore,
    clock: Object.freeze({ now: () => now }),
  });
  const results = {};
  for (const role of ['original', 'independent-replay']) {
    const execution = evidence?.executions?.[role];
    const result = verifyReceipt(execution?.authorityReceipt, {
      dataset: execution?.datasetAuthorization,
      selector: execution?.benchmarkSelector,
    });
    results[role] = result;
    if (!result.verified) internalBlockers.push(...result.blockers.map((blocker) => `offline_authority:${role}:${blocker}`));
    if (execution?.experimentRunReceiptHash === null || !execution?.experimentRunReceiptHash) {
      internalBlockers.push(`offline_authority:${role}:experiment_run_binding_missing`);
    }
  }
  const original = evidence?.executions?.original;
  const replay = evidence?.executions?.['independent-replay'];
  if (original?.experimentRunReceiptHash === replay?.experimentRunReceiptHash
    || original?.authorityReceipt?.operatorDatasetAuthorityDocumentHash
      !== replay?.authorityReceipt?.operatorDatasetAuthorityDocumentHash
    || original?.authorityReceipt?.analysisProtocolHash !== replay?.authorityReceipt?.analysisProtocolHash
    || original?.benchmarkSelector?.campaignBenchmarkSelectorHash
      !== replay?.benchmarkSelector?.campaignBenchmarkSelectorHash) {
    internalBlockers.push('offline_authority_original_replay_binding_invalid');
  }
  const blockers = unique([...internalBlockers, ...anchorBlockers]);
  return Object.freeze({
    version: 2,
    kind: 'OfflineOperatorDatasetAuthorityEvidenceVerification',
    status: blockers.length ? 'offline_operator_dataset_authority_blocked' : 'offline_operator_dataset_authority_verified',
    valid: blockers.length === 0,
    verificationTime: Number.isFinite(now.getTime()) ? now.toISOString() : null,
    trustSnapshotHash: trustSnapshot?.publicAuthorityTrustSnapshotHash || null,
    evidenceHash: evidence?.offlineOperatorDatasetAuthorityEvidenceHash || null,
    packageInternalCryptographicConsistencyVerified: internalBlockers.length === 0,
    externalTrustAnchorVerified: keyIds.length > 0 && anchorBlockers.length === 0,
    externallyAnchoredKeyIds: Object.freeze(anchorBlockers.length ? [] : keyIds),
    executionResults: Object.freeze(results),
    blockers: Object.freeze(blockers),
  });
}
