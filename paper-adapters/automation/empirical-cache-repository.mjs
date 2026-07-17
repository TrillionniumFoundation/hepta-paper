import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertEmpiricalCachePort } from '../../paper-ports/empirical-cache-port.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { inspectScopedPathSync, inspectScopedWriteTargetSync, readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { verifyEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
import { buildEnvironmentBoundEmpiricalCacheKey, verifyEmpiricalCacheReproducibilityDecision } from '../../paper-domain/automation/empirical-cache-reproducibility-policy.mjs';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function cacheKeyDirectory(cacheRoot, cacheKey) {
  const normalized = String(cacheKey || '').toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error('empirical_cache_key_invalid');
  const directory = path.join(cacheRoot, normalized.slice('sha256:'.length));
  if (!isPathWithin(cacheRoot, directory) || directory === cacheRoot) throw new Error('empirical_cache_key_escape');
  return directory;
}

function normalizedArtifact(artifact) {
  const relative = String(artifact?.path || '');
  const posix = relative.replaceAll('\\', '/');
  const normalized = path.posix.normalize(posix);
  if (!relative || posix !== relative || normalized !== relative || path.posix.isAbsolute(relative)
    || relative === '..' || relative.startsWith('../') || relative.includes('/../') || relative.includes('\0')) {
    throw new Error('empirical_cache_artifact_path_invalid');
  }
  const sha256 = String(artifact?.sha256 || '').toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new Error('empirical_cache_artifact_hash_invalid');
  return Object.freeze({ ...artifact, path: relative, sha256 });
}

function scopedArtifact(root, relative, { write = false } = {}) {
  const candidate = path.resolve(root, ...relative.split('/'));
  if (!isPathWithin(root, candidate) || candidate === path.resolve(root)) throw new Error('empirical_cache_artifact_path_escape');
  if (write) {
    const inspection = inspectScopedWriteTargetSync({ scopeRoot: root, candidate });
    if (inspection.status !== 'scoped_write_target_verified') throw new Error(`empirical_cache_write_target_unsafe:${inspection.blockers.join(',')}`);
  }
  return candidate;
}

function writeScopedBytes(root, relative, bytes) {
  const destination = scopedArtifact(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  scopedArtifact(root, relative, { write: true });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(descriptor, bytes); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, destination);
  const identity = inspectScopedPathSync({ scopeRoot: root, candidate: destination, expect: 'file', forbidHardlinks: true });
  if (identity.status !== 'scoped_file_identity_verified') throw new Error(`empirical_cache_materialized_artifact_unsafe:${identity.blockers.join(',')}`);
}

export function createFilesystemEmpiricalCacheRepository({ root } = {}) {
  if (!root) throw new Error('empirical cache root is required');
  const cacheRoot = path.resolve(root);
  return assertEmpiricalCachePort({
    version: 1,
    kind: 'FilesystemEmpiricalCacheRepository',
    get(cacheKey, { outputDirectory } = {}) {
      let cacheDirectory;
      try { cacheDirectory = cacheKeyDirectory(cacheRoot, cacheKey); } catch { return null; }
      const manifestPath = path.join(cacheDirectory, 'manifest.json');
      if (!outputDirectory || !fs.existsSync(manifestPath)) return null;
      try {
        const manifestRead = readScopedFileSync({ scopeRoot: cacheDirectory, candidate: manifestPath, maximumBytes: 4 * 1024 * 1024 });
        if (manifestRead.status !== 'scoped_file_read_verified') return null;
        const manifest = JSON.parse(manifestRead.content.toString('utf8'));
        if (manifest.version !== 3 || manifest.cacheKey !== cacheKey
          || !verifyEmpiricalEnvironmentBom(manifest.environmentBom).valid
          || !verifyEmpiricalCacheReproducibilityDecision(manifest.cacheReproducibilityDecision, manifest.environmentBom)
          || manifest.cacheReproducibilityDecision.cacheAllowed !== true
          || buildEnvironmentBoundEmpiricalCacheKey(manifest.baseCacheDescriptor, manifest.cacheReproducibilityDecision) !== cacheKey) return null;
        const artifacts = (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).map(normalizedArtifact);
        if (!artifacts.length) return null;
        const verified = artifacts.map((artifact) => {
          const source = scopedArtifact(path.join(cacheDirectory, 'artifacts'), artifact.path);
          const read = readScopedFileSync({ scopeRoot: path.join(cacheDirectory, 'artifacts'), candidate: source });
          if (read.status !== 'scoped_file_read_verified' || read.hash !== artifact.sha256) throw new Error('empirical_cache_artifact_invalid');
          return { artifact, bytes: read.content };
        });
        fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
        const outputIdentity = inspectScopedPathSync({ scopeRoot: outputDirectory, candidate: outputDirectory, expect: 'directory', forbidHardlinks: false });
        if (outputIdentity.status !== 'scoped_file_identity_verified') return null;
        for (const item of verified) writeScopedBytes(outputDirectory, item.artifact.path, item.bytes);
        return Object.freeze({ ...manifest, artifacts });
      } catch { return null; }
    },
    put(cacheKey, { outputDirectory, artifacts = [], runnerReceiptHash = null, environmentBom = null, cacheReproducibilityDecision = null, baseCacheDescriptor = null } = {}) {
      if (!outputDirectory || !artifacts.length) return Object.freeze({ stored: false, reason: 'cache_artifacts_required' });
      if (!verifyEmpiricalEnvironmentBom(environmentBom).valid
        || !verifyEmpiricalCacheReproducibilityDecision(cacheReproducibilityDecision, environmentBom)
        || cacheReproducibilityDecision.cacheAllowed !== true
        || buildEnvironmentBoundEmpiricalCacheKey(baseCacheDescriptor, cacheReproducibilityDecision) !== cacheKey) {
        return Object.freeze({ stored: false, reason: 'cache_environment_identity_invalid' });
      }
      let cacheDirectory;
      let normalizedArtifacts;
      try {
        cacheDirectory = cacheKeyDirectory(cacheRoot, cacheKey);
        normalizedArtifacts = artifacts.map(normalizedArtifact);
      } catch (error) {
        return Object.freeze({ stored: false, reason: error.message || 'cache_manifest_invalid' });
      }
      fs.mkdirSync(path.dirname(cacheDirectory), { recursive: true });
      const temporary = `${cacheDirectory}.tmp-${process.pid}-${crypto.randomUUID()}`;
      fs.mkdirSync(path.join(temporary, 'artifacts'), { recursive: true });
      for (const artifact of normalizedArtifacts) {
        const source = scopedArtifact(outputDirectory, artifact.path);
        const read = readScopedFileSync({ scopeRoot: outputDirectory, candidate: source });
        if (read.status !== 'scoped_file_read_verified' || read.hash !== artifact.sha256) {
          fs.rmSync(temporary, { recursive: true, force: true });
          return Object.freeze({ stored: false, reason: 'cache_artifact_source_invalid' });
        }
        writeScopedBytes(path.join(temporary, 'artifacts'), artifact.path, read.content);
      }
      writeScopedBytes(temporary, 'manifest.json', Buffer.from(`${JSON.stringify({ version: 3, cacheKey, artifacts: normalizedArtifacts, runnerReceiptHash, environmentBom, cacheReproducibilityDecision, baseCacheDescriptor }, null, 2)}\n`));
      if (fs.existsSync(cacheDirectory)) fs.rmSync(cacheDirectory, { recursive: true, force: true });
      try {
        fs.renameSync(temporary, cacheDirectory);
        return Object.freeze({ stored: true, cacheKey });
      } catch {
        fs.rmSync(temporary, { recursive: true, force: true });
        return Object.freeze({ stored: false, reason: 'cache_publish_race' });
      }
    },
  });
}
