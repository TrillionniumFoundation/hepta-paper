import fs from 'node:fs';
import path from 'node:path';

import {
  REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
  RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE,
} from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const SHA256 = /^sha256:[0-9a-f]{64}$/i;
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
export const MAXIMUM_AGE_MS = 24 * 60 * 60 * 1000;

const MAXIMUM_RECEIPT_BYTES = 16 * 1024 * 1024;

export function receiptHashValid(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || !SHA256.test(String(receipt.fullResearchQualificationReceiptHash || ''))
    || !SHA256.test(String(receipt.runtimeImageReproducibilityReceiptHash || ''))
    || JSON.stringify(receipt.runtimeImageReproducibilityRequiredProfiles)
      !== JSON.stringify(REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES)
    || JSON.stringify(Object.keys(
      receipt.runtimeImageReproducibilityDefinitionManifestHashes || {},
    )) !== JSON.stringify(REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES)
    || Object.values(receipt.runtimeImageReproducibilityDefinitionManifestHashes || {})
      .some((value) => !SHA256.test(String(value || '')))
    || receipt.empiricalFamilyPluginPackageHash
      !== RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.empiricalFamilyPluginPackageHash
    || receipt.empiricalFamilyPluginRegistryHash
      !== RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.empiricalFamilyPluginRegistryHash
    || receipt.empiricalFamilyPluginStartupInspectionHash
      !== RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginStartupInspectionHash
    || JSON.stringify(receipt.activeEmpiricalProductionProfileHashes)
      !== JSON.stringify(RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .activeProductionProfileHashes)
    || receipt.runtimeImageReproducibilityActivePluginScopeHash
      !== RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .runtimeImageReproducibilityActivePluginScopeHash) return false;
  const { fullResearchQualificationReceiptHash, ...payload } = receipt;
  return hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', payload)
    === fullResearchQualificationReceiptHash;
}

function canonicalTimestamp(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds : null;
}

export function receiptTimeWindowValid(receipt, now) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const issuedAt = canonicalTimestamp(receipt?.issuedAt);
  const expiresAt = canonicalTimestamp(receipt?.expiresAt);
  return Number.isFinite(nowMs) && issuedAt !== null && expiresAt !== null
    && expiresAt > issuedAt && expiresAt - issuedAt <= MAXIMUM_AGE_MS
    && nowMs >= issuedAt && nowMs < expiresAt;
}

export function receiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}

export function safeFile(
  candidate,
  { minimumBytes = 1, maximumBytes = MAXIMUM_RECEIPT_BYTES } = {},
) {
  const requested = path.resolve(candidate);
  const stat = fs.lstatSync(requested);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid
    || (stat.mode & 0o022) !== 0 || stat.size < minimumBytes || stat.size > maximumBytes
    || fs.realpathSync(requested) !== requested) {
    throw new Error('full_research_qualification_pointer_file_invalid');
  }
  return requested;
}

function parseReceiptBytes(bytes) {
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('full_research_qualification_pointer_json_invalid'); }
  if (!receiptHashValid(receipt)) {
    throw new Error('full_research_qualification_pointer_receipt_hash_invalid');
  }
  return Object.freeze(receipt);
}

export function safeReadMirror(candidate) {
  const bytes = fs.readFileSync(safeFile(candidate));
  return Object.freeze({ receipt: parseReceiptBytes(bytes), bytes });
}

export function ensureDatabaseFile(candidate) {
  fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(candidate), 0o700);
  try {
    const descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    safeFile(candidate, { minimumBytes: 0, maximumBytes: 256 * 1024 * 1024 });
  }
}

export function ensureSchema(database) {
  // DELETE journaling keeps status/read() side-effect free. Opening a read-only
  // WAL database can materialize `-shm`/`-wal` sidecars even without a query mutation.
  database.exec('PRAGMA journal_mode=DELETE;');
  database.exec('PRAGMA synchronous=FULL;');
  database.exec(`CREATE TABLE IF NOT EXISTS full_research_qualification_pointer_authority (
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
    receipt_json TEXT NOT NULL,
    receipt_content_hash TEXT NOT NULL,
    receipt_hash TEXT NOT NULL,
    runtime_receipt_hash TEXT NOT NULL,
    qualification_state_hash TEXT NOT NULL,
    qualification_state_generation INTEGER NOT NULL CHECK(qualification_state_generation>=1),
    publisher_scope TEXT NOT NULL,
    publisher_owner_id TEXT NOT NULL,
    publisher_lease_generation INTEGER NOT NULL CHECK(publisher_lease_generation>=1),
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    publication_generation INTEGER NOT NULL CHECK(publication_generation>=1),
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS full_research_qualification_pointer_lease (
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
    lease_owner TEXT,
    lease_token TEXT,
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation>=0),
    lease_expires_at TEXT,
    recovered_lease_count INTEGER NOT NULL DEFAULT 0 CHECK(recovered_lease_count>=0),
    updated_at TEXT NOT NULL
  ) STRICT;`);
  database.prepare(`INSERT OR IGNORE INTO full_research_qualification_pointer_lease(
    singleton_id,lease_generation,recovered_lease_count,updated_at
  ) VALUES(1,0,0,?)`).run(new Date(0).toISOString());
}

function authorityRow(database) {
  return database.prepare(
    'SELECT * FROM full_research_qualification_pointer_authority WHERE singleton_id=1',
  ).get() || null;
}

export function validatedAuthority(database) {
  const row = authorityRow(database);
  if (!row) return null;
  const bytes = Buffer.from(String(row.receipt_json));
  const receipt = parseReceiptBytes(bytes);
  if (hashBytes(bytes) !== row.receipt_content_hash
    || receipt.fullResearchQualificationReceiptHash !== row.receipt_hash
    || receipt.runtimeImageReproducibilityReceiptHash !== row.runtime_receipt_hash
    || receipt.issuedAt !== row.issued_at || receipt.expiresAt !== row.expires_at
    || !SHA256.test(String(row.qualification_state_hash || ''))
    || !Number.isSafeInteger(Number(row.qualification_state_generation))
    || Number(row.qualification_state_generation) < 1
    || !SAFE_ID.test(String(row.publisher_scope || ''))
    || !SAFE_ID.test(String(row.publisher_owner_id || ''))
    || !Number.isSafeInteger(Number(row.publisher_lease_generation))
    || Number(row.publisher_lease_generation) < 1
    || !Number.isSafeInteger(Number(row.publication_generation))
    || Number(row.publication_generation) < 1) {
    throw new Error('full_research_qualification_pointer_authority_state_invalid');
  }
  return Object.freeze({ row, bytes, receipt });
}

export function leaseIdentity(value = {}) {
  if (!SAFE_ID.test(String(value.ownerId || ''))
    || !SAFE_ID.test(String(value.leaseToken || ''))
    || !Number.isSafeInteger(Number(value.leaseGeneration))
    || Number(value.leaseGeneration) < 1) {
    throw new Error('full_research_qualification_pointer_lease_identity_invalid');
  }
  return Object.freeze({
    ownerId: String(value.ownerId),
    leaseToken: String(value.leaseToken),
    leaseGeneration: Number(value.leaseGeneration),
  });
}

export function fencedLease(row, rawLease, nowMs) {
  const lease = leaseIdentity(rawLease);
  if (!row || row.lease_owner !== lease.ownerId || row.lease_token !== lease.leaseToken
    || Number(row.lease_generation) !== lease.leaseGeneration
    || Date.parse(row.lease_expires_at || '') <= nowMs) {
    throw new Error('full_research_qualification_pointer_lease_lost');
  }
  return lease;
}

export function monotonicSuccessor(current, receipt, qualificationStateGeneration) {
  if (!current) return true;
  if (receipt.fullResearchQualificationReceiptHash === current.receipt_hash) {
    return Number(qualificationStateGeneration)
      === Number(current.qualification_state_generation);
  }
  const currentIssuedAt = Date.parse(current.issued_at);
  const currentExpiresAt = Date.parse(current.expires_at);
  const nextIssuedAt = Date.parse(receipt.issuedAt);
  const nextExpiresAt = Date.parse(receipt.expiresAt);
  return Number.isFinite(currentIssuedAt) && Number.isFinite(currentExpiresAt)
    && Number.isFinite(nextIssuedAt) && Number.isFinite(nextExpiresAt)
    && nextIssuedAt > currentIssuedAt && nextExpiresAt > currentExpiresAt
    && Number(qualificationStateGeneration) > Number(current.qualification_state_generation);
}
