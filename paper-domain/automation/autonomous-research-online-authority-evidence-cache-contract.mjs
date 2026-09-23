import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CACHE_KEYS = Object.freeze([
  'version', 'kind', 'status', 'cacheRole', 'databaseScopeHash',
  'writerManifestHash', 'authorityGlobalSequence', 'authorityGlobalHash',
  'activeRefreshReceipt', 'activeRefreshReceiptHash', 'recordedAt',
  'expiresAt', 'cacheHash',
]);

export const AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_ID =
  'autonomous-research-online-authority-evidence-cache-v1';

export const AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_HASH =
  hashRecord('AutonomousResearchOnlineAuthorityEvidenceCacheContract', {
    version: 1,
    contractId: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_ID,
    keys: CACHE_KEYS,
    cacheRole: 'passive-status-only-never-mutation-authorization',
  });

function fail(code = 'autonomous_research_online_authority_evidence_cache_invalid') {
  throw new Error(code);
}

function cachePayload(document) {
  return Object.fromEntries(Object.entries(document || {}).filter(([key]) => key !== 'cacheHash'));
}

export function autonomousResearchOnlineAuthorityEvidenceCacheHash(document) {
  return hashRecord('AutonomousResearchOnlineAuthorityEvidenceCache', cachePayload(document));
}

function assertActiveRefresh(receipt) {
  if (receipt?.version !== 1
    || receipt.kind !== 'AutonomousResearchOnlineMutationActiveRefreshReceipt'
    || receipt.status !== 'autonomous_research_online_mutation_active_refresh_complete'
    || receipt.externalActionPerformed !== true
    || receipt.journalRecorded !== false
    || receipt.journalReceipt !== null
    || !Number.isSafeInteger(receipt.globalSequence)
    || receipt.globalSequence < 0
    || !SHA256.test(String(receipt.globalHash || ''))
    || !Number.isFinite(Date.parse(String(receipt.recordedAt || '')))
    || !receipt.authorityEvidence?.currentHead
    || !receipt.authorityEvidence?.activeChallenge
    || !receipt.authorityEvidence?.brokerScope) {
    fail('autonomous_research_online_authority_evidence_cache_refresh_invalid');
  }
  return receipt;
}

export function assertAutonomousResearchOnlineAuthorityEvidenceCache(document, {
  databaseScopeHash = null,
  writerManifestHash = null,
  now = null,
} = {}) {
  const refresh = assertActiveRefresh(document?.activeRefreshReceipt);
  const recordedAt = Date.parse(String(document?.recordedAt || ''));
  const expiresAt = Date.parse(String(document?.expiresAt || ''));
  const nowMs = now === null
    ? null
    : (now instanceof Date ? now.getTime() : Date.parse(String(now || '')));
  if (!hasExactObjectKeys(document, CACHE_KEYS)
    || document.version !== 1
    || document.kind !== 'AutonomousResearchOnlineAuthorityEvidenceCache'
    || document.status !== 'autonomous_research_online_authority_evidence_cache_ready'
    || document.cacheRole !== 'passive-status-only-never-mutation-authorization'
    || !SHA256.test(String(document.databaseScopeHash || ''))
    || !SHA256.test(String(document.writerManifestHash || ''))
    || !Number.isSafeInteger(document.authorityGlobalSequence)
    || document.authorityGlobalSequence < 0
    || !SHA256.test(String(document.authorityGlobalHash || ''))
    || document.authorityGlobalSequence !== refresh.globalSequence
    || document.authorityGlobalHash !== refresh.globalHash
    || document.activeRefreshReceiptHash !== hashRecord(
      'AutonomousResearchOnlineMutationActiveRefreshReceipt',
      refresh,
    )
    || !Number.isFinite(recordedAt)
    || !Number.isFinite(expiresAt)
    || recordedAt !== Date.parse(refresh.recordedAt)
    || expiresAt <= recordedAt
    || (databaseScopeHash !== null && document.databaseScopeHash !== databaseScopeHash)
    || (writerManifestHash !== null && document.writerManifestHash !== writerManifestHash)
    || (now !== null && (!Number.isFinite(nowMs) || expiresAt <= nowMs))
    || document.cacheHash !== autonomousResearchOnlineAuthorityEvidenceCacheHash(document)) {
    fail();
  }
  return document;
}

export function createAutonomousResearchOnlineAuthorityEvidenceCache({
  databaseScopeHash,
  writerManifestHash,
  activeRefreshReceipt,
  expiresAt,
} = {}) {
  const refresh = assertActiveRefresh(activeRefreshReceipt);
  const base = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineAuthorityEvidenceCache',
    status: 'autonomous_research_online_authority_evidence_cache_ready',
    cacheRole: 'passive-status-only-never-mutation-authorization',
    databaseScopeHash,
    writerManifestHash,
    authorityGlobalSequence: refresh.globalSequence,
    authorityGlobalHash: refresh.globalHash,
    activeRefreshReceipt: refresh,
    activeRefreshReceiptHash: hashRecord(
      'AutonomousResearchOnlineMutationActiveRefreshReceipt',
      refresh,
    ),
    recordedAt: refresh.recordedAt,
    expiresAt,
  });
  return assertAutonomousResearchOnlineAuthorityEvidenceCache(Object.freeze({
    ...base,
    cacheHash: autonomousResearchOnlineAuthorityEvidenceCacheHash(base),
  }));
}
