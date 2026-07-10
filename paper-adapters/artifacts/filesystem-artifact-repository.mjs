import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertArtifactRepository, assertArtifactTarget } from '../../paper-ports/artifact-repository-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function digestPart(value) {
  return String(value).replace(/^sha256:/, '');
}

async function writeImmutable(candidate, bytes) {
  await fsp.mkdir(path.dirname(candidate), { recursive: true });
  try {
    await fsp.writeFile(candidate, bytes, { flag: 'wx', mode: 0o444 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await fsp.readFile(candidate);
    if (sha256(existing) !== sha256(bytes)) throw new Error(`Immutable artifact collision: ${candidate}`);
    return false;
  }
}

async function atomicMaterialize(candidate, objectPath) {
  await fsp.mkdir(path.dirname(candidate), { recursive: true });
  const temporary = `${candidate}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    await fsp.copyFile(objectPath, temporary);
    await fsp.rename(temporary, candidate);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function walkFiles(root) {
  const output = [];
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(candidate));
    else if (entry.isFile()) output.push(candidate);
  }
  return output;
}

export function createFilesystemArtifactRepository({
  scopeRoot,
  casRoot = null,
  repositoryId = 'filesystem-cas-artifacts',
  receiptLedger,
  clock,
  retentionPolicy = {},
} = {}) {
  if (!receiptLedger || typeof receiptLedger.record !== 'function') throw new Error('ArtifactRepository requires a persistent receipt ledger');
  if (!clock || typeof clock.nowIso !== 'function') throw new Error('ArtifactRepository requires an injected clock');
  const declaredRoot = path.resolve(scopeRoot || '.');
  const declaredCasRoot = path.resolve(casRoot || path.join(declaredRoot, '.hepta-artifact-cas'));
  const objectsRoot = path.join(declaredCasRoot, 'objects', 'sha256');
  const manifestsRoot = path.join(declaredCasRoot, 'manifests');
  const policy = Object.freeze({
    immutableManifests: true,
    unreferencedObjectMinimumAgeMs: Math.max(0, Number(retentionPolicy.unreferencedObjectMinimumAgeMs ?? 86400000)),
  });

  const write = async ({ target, payload, role, contentType, atomic = true }) => {
    if (!role) throw new Error('Artifact write role is required');
    if (!atomic) throw new Error('ArtifactRepository only permits atomic materialization');
    const { candidate } = assertArtifactTarget({ scopeRoot: declaredRoot, target });
    const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const contentHash = sha256(bytes);
    const digest = digestPart(contentHash);
    const objectPath = path.join(objectsRoot, digest.slice(0, 2), digest.slice(2));
    const objectCreated = await writeImmutable(objectPath, bytes);
    await atomicMaterialize(candidate, objectPath);
    const manifestPayload = {
      version: 1,
      kind: 'ImmutableArtifactManifest',
      repositoryId,
      role,
      contentType,
      logicalPath: path.relative(declaredRoot, candidate).replace(/\\/g, '/'),
      contentHash,
      bytes: bytes.length,
      objectPath: path.relative(declaredCasRoot, objectPath).replace(/\\/g, '/'),
      createdAt: clock.nowIso(),
    };
    const manifestHash = hashRecord('ImmutableArtifactManifest', manifestPayload);
    const manifestPath = path.join(manifestsRoot, `${digestPart(manifestHash)}.json`);
    await writeImmutable(manifestPath, Buffer.from(`${JSON.stringify({ ...manifestPayload, manifestHash }, null, 2)}\n`));
    const receiptPayload = Object.freeze({
      version: 2,
      kind: 'ArtifactWriteReceipt',
      repositoryId,
      role,
      contentType,
      path: manifestPayload.logicalPath,
      bytes: bytes.length,
      hash: contentHash,
      contentAddress: contentHash,
      manifestHash,
      manifestPath: path.relative(declaredCasRoot, manifestPath).replace(/\\/g, '/'),
      objectCreated,
      immutableObject: true,
      atomic: true,
      scopeRoot: declaredRoot,
      casRoot: declaredCasRoot,
      createdAt: manifestPayload.createdAt,
      externalActionPerformed: false,
    });
    const writeReceiptHash = hashRecord('ArtifactWriteReceipt', receiptPayload);
    const ledgerReceipt = receiptLedger.record({ ...receiptPayload, writeReceiptHash }, { stream: 'artifact-writes' });
    return Object.freeze({ ...receiptPayload, writeReceiptHash, ledgerReceiptId: ledgerReceipt.receiptId });
  };

  return assertArtifactRepository({
    version: 2,
    kind: 'FilesystemContentAddressedArtifactRepository',
    repositoryId,
    scopeRoot: declaredRoot,
    casRoot: declaredCasRoot,
    retentionPolicy: policy,
    writeText(target, value, options = {}) {
      return write({ target, payload: value, contentType: 'text/plain', ...options });
    },
    writeJson(target, value, options = {}) {
      return write({ target, payload: `${JSON.stringify(value, null, 2)}\n`, contentType: 'application/json', ...options });
    },
    async readManifest(manifestHash) {
      const candidate = path.join(manifestsRoot, `${digestPart(manifestHash)}.json`);
      return JSON.parse(await fsp.readFile(candidate, 'utf8'));
    },
    async garbageCollect({ dryRun = true, minimumAgeMs = policy.unreferencedObjectMinimumAgeMs } = {}) {
      const manifestFiles = await walkFiles(manifestsRoot);
      const referenced = new Set();
      for (const file of manifestFiles) {
        try { referenced.add((JSON.parse(await fsp.readFile(file, 'utf8'))).contentHash); } catch { /* invalid manifests are retained for audit */ }
      }
      const now = Date.now();
      const candidates = [];
      for (const objectPath of await walkFiles(objectsRoot)) {
        const relative = path.relative(objectsRoot, objectPath).replace(/\\/g, '');
        const contentHash = `sha256:${relative}`;
        const stat = await fsp.stat(objectPath);
        if (!referenced.has(contentHash) && now - stat.mtimeMs >= Math.max(0, Number(minimumAgeMs))) candidates.push(objectPath);
      }
      if (!dryRun) await Promise.all(candidates.map((candidate) => fsp.rm(candidate, { force: true })));
      const receipt = {
        version: 1,
        kind: 'ArtifactGarbageCollectionReceipt',
        status: dryRun ? 'artifact_gc_dry_run_recorded' : 'artifact_gc_completed',
        repositoryId,
        scannedObjectCount: (await walkFiles(objectsRoot)).length,
        referencedObjectCount: referenced.size,
        candidateCount: candidates.length,
        removedCount: dryRun ? 0 : candidates.length,
        createdAt: clock.nowIso(),
      };
      const receiptHash = hashRecord('ArtifactGarbageCollectionReceipt', receipt);
      const ledger = receiptLedger.record({ ...receipt, receiptHash }, { stream: 'artifact-retention' });
      return { ...receipt, receiptHash, ledgerReceiptId: ledger.receiptId };
    },
  });
}
