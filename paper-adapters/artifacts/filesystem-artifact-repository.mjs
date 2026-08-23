import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertArtifactRepository, assertArtifactTarget } from '../../paper-ports/artifact-repository-port.mjs';
import { bindArtifactRepositoryFactoryPackageDeletionWriterScope }
  from '../../paper-ports/execution-service-ports.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectScopedWriteTargetSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { createRuntimeRetentionPackageDeletionWriterScope }
  from '../automation/runtime-retention-package-deletion-writer-boundary.mjs';

const WRITER_CONTEXT_KEYS = new Set(['packageDeletionWriterSelector']);
const WRITER_SELECTOR_KEYS = new Set([
  'packageLifecycleReceiptHash',
  'packagePath',
  'packageContentHash',
  'deletionIntentHash',
  'operationId',
]);

function digestPart(value) {
  return String(value).replace(/^sha256:/, '');
}

function packagePathForTarget(runtimeRoot, candidate) {
  if (!runtimeRoot) return null;
  const packagesRoot = path.join(runtimeRoot, 'packages');
  const relative = path.relative(packagesRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  const transactionStaging = parts.length >= 3
    && /^\.package-(?:prepared|aborted)-[^/\\]+$/.test(parts[0]);
  const packageName = transactionStaging ? parts[1] : parts[0];
  return packageName ? path.join(packagesRoot, packageName) : null;
}

function exactPlainData(value, allowedKeys, errorCode) {
  let prototype;
  let keys;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new Error(errorCode, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || prototype !== Object.prototype
    || keys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
    throw new Error(errorCode);
  }
  const entries = [];
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(errorCode);
    }
    entries.push([key, descriptor.value]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function writerSelectorFromContext(writerContext) {
  const context = exactPlainData(
    writerContext,
    WRITER_CONTEXT_KEYS,
    'artifact_repository_factory_writer_context_invalid',
  );
  const selector = context.packageDeletionWriterSelector;
  if (selector == null) return null;
  return exactPlainData(
    selector,
    WRITER_SELECTOR_KEYS,
    'artifact_repository_factory_writer_context_invalid',
  );
}

function writerSelectorForTarget({
  candidate,
  defaultSelector,
  runtimeRoot,
  suppliedSelector,
}) {
  const packagePath = packagePathForTarget(runtimeRoot, candidate);
  if (!packagePath) return suppliedSelector || defaultSelector();
  if (suppliedSelector && Object.hasOwn(suppliedSelector, 'packagePath')
    && suppliedSelector.packagePath !== packagePath) {
    throw new Error('artifact_repository_writer_selector_target_mismatch');
  }
  return Object.freeze({
    ...(suppliedSelector || defaultSelector()),
    packagePath,
  });
}

async function writeImmutable(candidate, bytes) {
  await fsp.mkdir(path.dirname(candidate), { recursive: true });
  try {
    await fsp.writeFile(candidate, bytes, { flag: 'wx', mode: 0o444 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await fsp.readFile(candidate);
    if (hashBytes(existing) !== hashBytes(bytes)) throw new Error(`Immutable artifact collision: ${candidate}`);
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

export function createPackageDeletionWriterScopedFilesystemArtifactRepositoryFactory({
  casRoot,
  receiptLedger,
  clock,
  runtimeRoot,
  packageDeletionWriterBoundary,
  packageDeletionWriterOperationId,
} = {}) {
  const factory = (scopeRoot, writerContext = {}) => {
    const packageDeletionWriterSelector = writerSelectorFromContext(writerContext);
    return createFilesystemArtifactRepository({
      scopeRoot,
      casRoot,
      receiptLedger,
      clock,
      runtimeRoot,
      packageDeletionWriterBoundary,
      packageDeletionWriterSelector,
      packageDeletionWriterOperationId,
    });
  };
  if (!packageDeletionWriterBoundary && !packageDeletionWriterOperationId) {
    return factory;
  }
  return bindArtifactRepositoryFactoryPackageDeletionWriterScope(
    factory,
    createRuntimeRetentionPackageDeletionWriterScope({
      writerBoundary: packageDeletionWriterBoundary,
      operationId: packageDeletionWriterOperationId,
    }),
  );
}

export function createFilesystemArtifactRepository({
  scopeRoot,
  casRoot = null,
  repositoryId = 'filesystem-cas-artifacts',
  receiptLedger,
  clock,
  retentionPolicy = {},
  runtimeRoot = null,
  packageDeletionWriterBoundary = null,
  packageDeletionWriterSelector = null,
  packageDeletionWriterOperationId = null,
} = {}) {
  if (!receiptLedger || typeof receiptLedger.record !== 'function') throw new Error('ArtifactRepository requires a persistent receipt ledger');
  if (!clock || typeof clock.nowIso !== 'function' || typeof clock.now !== 'function') {
    throw new Error('ArtifactRepository requires an injected ClockPort');
  }
  const declaredRoot = path.resolve(scopeRoot || '.');
  const declaredCasRoot = path.resolve(casRoot || path.join(declaredRoot, '.hepta-artifact-cas'));
  const declaredRuntimeRoot = runtimeRoot ? path.resolve(runtimeRoot) : null;
  const declaredWriterSelector = packageDeletionWriterSelector == null
    ? null
    : exactPlainData(
      packageDeletionWriterSelector,
      WRITER_SELECTOR_KEYS,
      'artifact_repository_writer_selector_invalid',
    );
  if (packageDeletionWriterBoundary
    && typeof packageDeletionWriterBoundary.runAsync !== 'function') {
    throw new Error('ArtifactRepository package deletion writer boundary is invalid');
  }
  const objectsRoot = path.join(declaredCasRoot, 'objects', 'sha256');
  const manifestsRoot = path.join(declaredCasRoot, 'manifests');
  const policy = Object.freeze({
    immutableManifests: true,
    unreferencedObjectMinimumAgeMs: Math.max(0, Number(retentionPolicy.unreferencedObjectMinimumAgeMs ?? 86400000)),
  });

  const guarded = (selector, operation) => packageDeletionWriterBoundary
    ? packageDeletionWriterBoundary.runAsync(selector, operation)
    : operation();
  const defaultSelector = (candidate, operation) => {
    const packagePath = packagePathForTarget(declaredRuntimeRoot, candidate);
    const operationId = packageDeletionWriterOperationId
      || `artifact:${operation}:${digestPart(hashRecord('ArtifactWriterScope', {
        repositoryId, scopeRoot: declaredRoot, casRoot: declaredCasRoot,
      }))}`;
    return Object.freeze(packagePath ? { packagePath, operationId } : { operationId });
  };
  const write = async ({ target, payload, role, contentType, atomic = true }) => {
    if (!role) throw new Error('Artifact write role is required');
    if (!atomic) throw new Error('ArtifactRepository only permits atomic materialization');
    const { candidate } = assertArtifactTarget({ scopeRoot: declaredRoot, target });
    return guarded(
      writerSelectorForTarget({
        candidate,
        defaultSelector: () => defaultSelector(candidate, 'write'),
        runtimeRoot: declaredRuntimeRoot,
        suppliedSelector: declaredWriterSelector,
      }),
      async () => {
        const beforeTarget = inspectScopedWriteTargetSync({ scopeRoot: declaredRoot, candidate });
        if (beforeTarget.status !== 'scoped_write_target_verified') {
          throw new Error(`Artifact target is unsafe: ${beforeTarget.blockers.join(',')}`);
        }
        const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
        const contentHash = hashBytes(bytes);
        const digest = digestPart(contentHash);
        const objectPath = path.join(objectsRoot, digest.slice(0, 2), digest.slice(2));
        const objectCreated = await writeImmutable(objectPath, bytes);
        await atomicMaterialize(candidate, objectPath);
        const afterTarget = inspectScopedWriteTargetSync({ scopeRoot: declaredRoot, candidate });
        if (afterTarget.status !== 'scoped_write_target_verified') {
          throw new Error(`Artifact target became unsafe: ${afterTarget.blockers.join(',')}`);
        }
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
          scopedWriteTargetIdentityHash: afterTarget.scopedWriteTargetIdentityHash,
          createdAt: manifestPayload.createdAt,
          externalActionPerformed: false,
        });
        const writeReceiptHash = hashRecord('ArtifactWriteReceipt', receiptPayload);
        const ledgerReceipt = receiptLedger.record({ ...receiptPayload, writeReceiptHash }, { stream: 'artifact-writes' });
        return Object.freeze({ ...receiptPayload, writeReceiptHash, ledgerReceiptId: ledgerReceipt.receiptId });
      },
    );
  };

  return assertArtifactRepository({
    version: 2,
    kind: 'FilesystemContentAddressedArtifactRepository',
    repositoryId,
    scopeRoot: declaredRoot,
    casRoot: declaredCasRoot,
    retentionPolicy: policy,
    writeBytes(target, value, options = {}) {
      if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error('ArtifactRepository.writeBytes requires bytes');
      return write({ target, payload: Buffer.from(value), contentType: 'application/octet-stream', ...options });
    },
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
      const collect = async () => {
        const manifestFiles = await walkFiles(manifestsRoot);
        const referenced = new Set();
        for (const file of manifestFiles) {
          try { referenced.add((JSON.parse(await fsp.readFile(file, 'utf8'))).contentHash); } catch { /* invalid manifests are retained for audit */ }
        }
        const now = clock.now().getTime();
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
      };
      return dryRun ? collect() : guarded(
        declaredWriterSelector || defaultSelector(declaredCasRoot, 'gc'),
        collect,
      );
    },
  });
}
