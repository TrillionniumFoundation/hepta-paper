import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_HASH,
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_ID,
  assertAutonomousResearchOnlineAuthorityEvidenceCache,
  createAutonomousResearchOnlineAuthorityEvidenceCache,
} from '../../paper-domain/automation/autonomous-research-online-authority-evidence-cache-contract.mjs';
import {
  assertAutonomousResearchOnlineAuthorityEvidenceCacheReaderPort,
  assertAutonomousResearchOnlineAuthorityEvidenceCacheWriterPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';
import {
  assertOpenedParentStillScoped,
  descriptorEntryPath,
  inspectDescriptorRelativeRegularFile,
  openScopedDirectoryChain,
  openVerifiedRegularFile,
  sameFileSnapshot,
  verifiedRoot,
  verifyOpenedSourceUnchanged,
  writeDescriptorFully,
} from '../runtime/scoped-file-materialization-path-io.mjs';
import {
  materializationIdentityFromStat,
} from '../runtime/scoped-file-materialization-recovery-record.mjs';
import {
  acquireTargetLock,
  assertTargetLockOwned,
  bindTargetLockTemporary,
  cleanupTargetLockOwnedTemporary,
  releaseTargetLock,
} from '../runtime/scoped-file-materialization-target-lock.mjs';

export const AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH =
  'automation-cache/online-authority-evidence-v1/current.json';

const MAXIMUM_CACHE_BYTES = 4 * 1024 * 1024;
const CACHE_PARENT = path.posix.dirname(
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH,
);
const CACHE_NAME = path.posix.basename(
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH,
);

function fail(code) { throw new Error(code); }

function cacheBytes(document) {
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8');
  if (bytes.length < 2 || bytes.length > MAXIMUM_CACHE_BYTES) {
    fail('autonomous_research_online_authority_evidence_cache_size_invalid');
  }
  return bytes;
}

function assertMonotonicCacheReplacement(existing, document) {
  if (document.cacheHash === existing.cacheHash) return;
  if (document.authorityGlobalSequence < existing.authorityGlobalSequence) {
    fail('autonomous_research_online_authority_evidence_cache_global_sequence_rollback');
  }
  if (document.authorityGlobalSequence === existing.authorityGlobalSequence
    && document.authorityGlobalHash !== existing.authorityGlobalHash) {
    fail('autonomous_research_online_authority_evidence_cache_global_hash_conflict');
  }
  if (Date.parse(document.recordedAt) <= Date.parse(existing.recordedAt)) {
    fail('autonomous_research_online_authority_evidence_cache_recorded_at_rollback');
  }
  if (Date.parse(document.expiresAt) <= Date.parse(existing.expiresAt)) {
    fail('autonomous_research_online_authority_evidence_cache_expiry_rollback');
  }
}

function readCacheDocument({
  runtimeRoot,
  databaseScopeHash,
  writerManifestHash,
  now,
} = {}) {
  const opened = openVerifiedRegularFile(
    runtimeRoot,
    AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH,
  );
  try {
    const stat = fs.fstatSync(opened.descriptor, { bigint: true });
    if (opened.mode !== 0o400 || stat.nlink !== 1n
      || stat.size < 2n || stat.size > BigInt(MAXIMUM_CACHE_BYTES)) {
      fail('autonomous_research_online_authority_evidence_cache_file_unsafe');
    }
    const bytes = fs.readFileSync(opened.descriptor);
    verifyOpenedSourceUnchanged(opened);
    let document;
    try { document = JSON.parse(bytes.toString('utf8')); }
    catch { fail('autonomous_research_online_authority_evidence_cache_json_invalid'); }
    return assertAutonomousResearchOnlineAuthorityEvidenceCache(document, {
      databaseScopeHash,
      writerManifestHash,
      now,
    });
  } finally { fs.closeSync(opened.descriptor); }
}

function writeCacheDocument({ runtimeRoot, document }) {
  const scope = verifiedRoot(runtimeRoot);
  const parent = openScopedDirectoryChain(scope, CACHE_PARENT, { create: true });
  let targetLock = null;
  let temporaryName = null;
  let descriptor = null;
  try {
    const parentStat = fs.fstatSync(parent.descriptor, { bigint: true });
    if ((parentStat.mode & 0o022n) !== 0n) {
      fail('autonomous_research_online_authority_evidence_cache_parent_unsafe');
    }
    targetLock = acquireTargetLock(
      parent,
      CACHE_NAME,
      `online-authority-evidence-cache:${document.cacheHash}:${crypto.randomUUID()}`,
    );
    temporaryName = targetLock.stageEntryName;
    const existing = inspectDescriptorRelativeRegularFile(parent.descriptor, CACHE_NAME, {
      allowedLinkCounts: [1],
    });
    if (existing.exists && (BigInt(existing.identity.mode) & 0o777n) !== 0o400n) {
      fail('autonomous_research_online_authority_evidence_cache_file_unsafe');
    }
    if (existing.exists) {
      const currentDocument = readCacheDocument({
        runtimeRoot,
        databaseScopeHash: null,
        writerManifestHash: null,
        now: null,
      });
      assertMonotonicCacheReplacement(currentDocument, document);
    }
    descriptor = fs.openSync(
      descriptorEntryPath(parent.descriptor, temporaryName),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const temporaryEntryIdentity = materializationIdentityFromStat(
      fs.fstatSync(descriptor, { bigint: true }),
    );
    bindTargetLockTemporary(
      parent,
      targetLock,
      CACHE_NAME,
      temporaryEntryIdentity,
    );
    writeDescriptorFully(descriptor, cacheBytes(document));
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o400);
    bindTargetLockTemporary(
      parent,
      targetLock,
      CACHE_NAME,
      temporaryEntryIdentity,
      materializationIdentityFromStat(fs.fstatSync(descriptor, { bigint: true })),
    );
    fs.closeSync(descriptor);
    descriptor = null;
    assertTargetLockOwned(parent, targetLock, CACHE_NAME);
    assertOpenedParentStillScoped(parent);
    const current = inspectDescriptorRelativeRegularFile(parent.descriptor, CACHE_NAME, {
      allowedLinkCounts: [1],
    });
    if (!sameFileSnapshot(existing, current)) {
      fail('autonomous_research_online_authority_evidence_cache_target_changed');
    }
    fs.renameSync(
      descriptorEntryPath(parent.descriptor, temporaryName),
      descriptorEntryPath(parent.descriptor, CACHE_NAME),
    );
    fs.fsyncSync(parent.descriptor);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (targetLock) {
      try {
        cleanupTargetLockOwnedTemporary(parent, targetLock, CACHE_NAME);
      } catch { /* preserve the primary fail-closed error */ }
    } else if (temporaryName) {
      try { fs.unlinkSync(descriptorEntryPath(parent.descriptor, temporaryName)); }
      catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
    throw error;
  } finally {
    try {
      if (targetLock) releaseTargetLock(parent, targetLock, CACHE_NAME);
    } finally {
      fs.closeSync(parent.descriptor);
    }
  }
}

export function createAutonomousResearchOnlineAuthorityEvidenceCacheWriter({
  runtimeRoot,
} = {}) {
  verifiedRoot(runtimeRoot);
  return assertAutonomousResearchOnlineAuthorityEvidenceCacheWriterPort(Object.freeze({
    cacheRelativePath: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH,
    recordActiveAuthorityEvidence({
      activeRefreshReceipt,
      databaseScopeHash,
      writerManifestHash,
      expiresAt,
    } = {}) {
      const document = createAutonomousResearchOnlineAuthorityEvidenceCache({
        databaseScopeHash,
        writerManifestHash,
        activeRefreshReceipt,
        expiresAt,
      });
      writeCacheDocument({ runtimeRoot, document });
      const verified = readCacheDocument({
        runtimeRoot,
        databaseScopeHash,
        writerManifestHash,
        now: new Date(document.recordedAt),
      });
      if (verified.cacheHash !== document.cacheHash) {
        fail('autonomous_research_online_authority_evidence_cache_readback_mismatch');
      }
      return Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineAuthorityEvidenceCacheWriteReceipt',
        status: 'autonomous_research_online_authority_evidence_cache_recorded',
        cacheRelativePath: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH,
        cacheContractHash:
          AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_HASH,
        cacheHash: document.cacheHash,
        activeRefreshReceiptHash: document.activeRefreshReceiptHash,
        recordedAt: document.recordedAt,
        expiresAt: document.expiresAt,
      });
    },
  }));
}

export function createAutonomousResearchOnlineAuthorityEvidenceCacheReader({
  runtimeRoot,
} = {}) {
  verifiedRoot(runtimeRoot);
  return assertAutonomousResearchOnlineAuthorityEvidenceCacheReaderPort(Object.freeze({
    cacheRelativePath: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH,
    readPassiveAuthorityEvidence({ databaseScopeHash, writerManifestHash, now } = {}) {
      const document = readCacheDocument({
        runtimeRoot,
        databaseScopeHash,
        writerManifestHash,
        now,
      });
      const evidence = document.activeRefreshReceipt.authorityEvidence;
      return Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineAuthorityEvidenceCacheEvidence',
        status: 'autonomous_research_online_authority_evidence_cache_loaded',
        cacheRole: document.cacheRole,
        cacheContractId: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_ID,
        cacheContractHash: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_HASH,
        cacheHash: document.cacheHash,
        activeRefreshReceiptHash: document.activeRefreshReceiptHash,
        currentHead: evidence.currentHead,
        activeChallenge: evidence.activeChallenge,
        brokerScope: evidence.brokerScope,
        externalActionPerformed: false,
      });
    },
  }));
}
