import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { assertRRuntimeSourceArchiveTransport } from '../../paper-ports/r-runtime-source-archive-transport-port.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9.]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$/;
const SNAPSHOT = 'https://packagemanager.posit.co/cran/2024-11-01';

function bytesHash(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function readLock(lockPath) {
  const bytes = fs.readFileSync(lockPath);
  let lock;
  try { lock = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('r_runtime_source_cas_lock_json_invalid'); }
  const packages = Object.entries(lock?.Packages || {}).map(([lockName, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.getPrototypeOf(entry) !== Object.prototype || lockName !== entry.Package
      || entry.Source !== 'Repository'
      || entry.Repository !== 'CRAN' || !PACKAGE.test(String(entry.Package || ''))
      || !VERSION.test(String(entry.Version || ''))) {
      throw new Error('r_runtime_source_cas_lock_entry_invalid');
    }
    const file = `${entry.Package}_${entry.Version}.tar.gz`;
    return Object.freeze({
      package: entry.Package,
      version: entry.Version,
      file,
      url: `${SNAPSHOT}/src/contrib/${file}`,
    });
  }).sort((left, right) => left.package.localeCompare(right.package));
  if (!packages.length || new Set(packages.map((entry) => entry.package)).size !== packages.length) {
    throw new Error('r_runtime_source_cas_lock_closure_invalid');
  }
  return Object.freeze({ packages: Object.freeze(packages), lockfileHash: hashBytes(bytes) });
}

function descriptionIdentity(tarPath, spawnSyncImpl = spawnSync) {
  const listing = spawnSyncImpl('tar', ['-tzf', tarPath], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (listing.status !== 0) throw new Error('r_runtime_source_cas_archive_invalid');
  const description = String(listing.stdout || '').split(/\r?\n/)
    .find((entry) => /^[^/]+\/DESCRIPTION$/.test(entry));
  if (!description) throw new Error('r_runtime_source_cas_description_missing');
  const extracted = spawnSyncImpl('tar', ['-xOzf', tarPath, description], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (extracted.status !== 0) throw new Error('r_runtime_source_cas_description_invalid');
  const text = String(extracted.stdout || '');
  return Object.freeze({
    package: text.match(/^Package:\s*([^\s]+)\s*$/m)?.[1] || null,
    version: text.match(/^Version:\s*([^\s]+)\s*$/m)?.[1] || null,
  });
}

function seededArchives(seedSourceDirectory) {
  const result = new Map();
  if (!seedSourceDirectory) return result;
  const root = fs.realpathSync(path.resolve(seedSourceDirectory));
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, name);
      const stat = fs.lstatSync(candidate);
      if (stat.isDirectory()) visit(candidate);
      else if (stat.isFile() && name.endsWith('.tar.gz')) {
        if (result.has(name)) throw new Error(`r_runtime_source_cas_seed_duplicate:${name}`);
        result.set(name, candidate);
      } else if (stat.isSymbolicLink()) throw new Error('r_runtime_source_cas_seed_symlink_invalid');
    }
  };
  visit(root);
  return result;
}

function verifyDownloadedArchive(entry, destination, spawnSyncImpl) {
  const bytes = fs.readFileSync(destination);
  if (bytes.length < 100) throw new Error('archive_too_small');
  const identity = descriptionIdentity(destination, spawnSyncImpl);
  if (identity.package !== entry.package || identity.version !== entry.version) {
    throw new Error('description_identity_mismatch');
  }
  return Object.freeze({ ...entry, bytes: bytes.length, sha256: bytesHash(bytes) });
}

async function download(entry, staging, {
  archiveTransport, repository, spawnSyncImpl, seeds,
}) {
  const seed = seeds.get(entry.file);
  if (seed) {
    repository.copySeedArchive(staging, entry.file, seed);
    return verifyDownloadedArchive(
      entry,
      repository.archivePath(staging, entry.file),
      spawnSyncImpl,
    );
  }
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await archiveTransport.fetchArchive({ url: entry.url });
      if (response.url !== entry.url || !Buffer.isBuffer(response.bytes)) {
        throw new Error('r_runtime_source_cas_transport_response_invalid');
      }
      repository.writeArchive(staging, entry.file, response.bytes);
      return verifyDownloadedArchive(
        entry,
        repository.archivePath(staging, entry.file),
        spawnSyncImpl,
      );
    } catch (error) {
      lastError = error;
      repository.removeArchive(staging, entry.file);
    }
  }
  throw new Error(`r_runtime_source_cas_download_failed:${entry.package}:${lastError?.message || 'unknown'}`);
}

async function mapConcurrent(values, limit, operation) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index], index);
    }
  }));
  return results;
}

function manifestPayload({ lockfileHash, packages }) {
  return Object.freeze({
    version: 1,
    kind: 'RRuntimeSourceCasManifest',
    status: 'r_runtime_source_cas_complete',
    snapshot: SNAPSHOT,
    lockfileHash,
    packageCount: packages.length,
    packages: Object.freeze(packages),
    exactLockClosure: true,
    allSourceArchivesContentHashed: true,
    offlineRestoreRequired: true,
  });
}

function expectedIndexContents(packages) {
  const sums = packages.map((entry) => (
    `${entry.sha256.slice('sha256:'.length)}  src/contrib/${entry.file}`
  )).join('\n');
  const header = 'Package\tVersion\tFile\tURL\tSHA256';
  const rows = packages.map((entry) => [
    entry.package, entry.version, entry.file, entry.url, entry.sha256,
  ].join('\t'));
  return Object.freeze({
    sums: `${sums}\n`,
    packages: `${[header, ...rows].join('\n')}\n`,
  });
}

export function verifyRRuntimeSourceCas({ contextPath } = {}) {
  try {
    const context = fs.realpathSync(path.resolve(contextPath));
    const lockPath = path.join(context, 'renv.lock');
    const cas = path.join(context, 'source-cas');
    const expected = readLock(lockPath);
    const document = JSON.parse(fs.readFileSync(path.join(cas, 'manifest.json'), 'utf8'));
    if (!sameManifest(document) || document.lockfileHash !== expected.lockfileHash
      || document.packageCount !== expected.packages.length
      || JSON.stringify(document.packages.map(({ package: name, version, file, url }) => ({
        package: name, version, file, url,
      }))) !== JSON.stringify(expected.packages)) return blocked('r_runtime_source_cas_manifest_drift');
    const expectedFiles = [
      'PACKAGES.tsv', 'SHA256SUMS', 'manifest.json',
      ...document.packages.map((entry) => `src/contrib/${entry.file}`),
    ].sort();
    const actualFiles = [];
    const visit = (directory, relative = '') => {
      for (const name of fs.readdirSync(directory).sort()) {
        const absolute = path.join(directory, name);
        const child = path.posix.join(relative, name);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error('symlink');
        if (stat.isDirectory()) visit(absolute, child);
        else if (stat.isFile()) actualFiles.push(child);
        else throw new Error('type');
      }
    };
    visit(cas);
    if (JSON.stringify(actualFiles.sort()) !== JSON.stringify(expectedFiles)) {
      return blocked('r_runtime_source_cas_file_closure_mismatch');
    }
    const indexes = expectedIndexContents(document.packages);
    if (fs.readFileSync(path.join(cas, 'SHA256SUMS'), 'utf8') !== indexes.sums
      || fs.readFileSync(path.join(cas, 'PACKAGES.tsv'), 'utf8') !== indexes.packages) {
      return blocked('r_runtime_source_cas_index_content_mismatch');
    }
    for (const entry of document.packages) {
      const candidate = path.join(cas, 'src', 'contrib', entry.file);
      const bytes = fs.readFileSync(candidate);
      if (bytes.length !== entry.bytes || bytesHash(bytes) !== entry.sha256) {
        return blocked(`r_runtime_source_cas_archive_hash_mismatch:${entry.package}`);
      }
    }
    return Object.freeze({
      ready: true,
      status: 'r_runtime_source_cas_verified',
      manifestHash: document.rRuntimeSourceCasManifestHash,
      packageCount: document.packageCount,
      lockfileHash: document.lockfileHash,
      definitionPaths: Object.freeze([
        'source-cas/PACKAGES.tsv',
        'source-cas/SHA256SUMS',
        'source-cas/manifest.json',
        ...document.packages.map((entry) => `source-cas/src/contrib/${entry.file}`),
      ]),
      blockers: Object.freeze([]),
    });
  } catch (error) {
    return blocked(`r_runtime_source_cas_unavailable:${error?.message || 'unknown'}`);
  }
}

function sameManifest(document) {
  if (!exactKeys(document, [
    'allSourceArchivesContentHashed', 'exactLockClosure', 'kind', 'lockfileHash',
    'offlineRestoreRequired', 'packageCount', 'packages', 'rRuntimeSourceCasManifestHash',
    'snapshot', 'status', 'version',
  ]) || document.version !== 1 || document.kind !== 'RRuntimeSourceCasManifest'
    || document.status !== 'r_runtime_source_cas_complete' || document.snapshot !== SNAPSHOT
    || !SHA256.test(String(document.lockfileHash || '')) || !Array.isArray(document.packages)
    || document.packageCount !== document.packages.length
    || document.packages.some((entry) => !exactKeys(entry, [
      'bytes', 'file', 'package', 'sha256', 'url', 'version',
    ]) || !PACKAGE.test(String(entry.package || '')) || !VERSION.test(String(entry.version || ''))
      || entry.file !== `${entry.package}_${entry.version}.tar.gz`
      || entry.url !== `${SNAPSHOT}/src/contrib/${entry.file}`
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 100
      || !SHA256.test(String(entry.sha256 || '')))
    || JSON.stringify(document.packages.map((entry) => entry.package))
      !== JSON.stringify(document.packages.map((entry) => entry.package)
        .sort((left, right) => left.localeCompare(right)))
    || new Set(document.packages.map((entry) => entry.package)).size
      !== document.packages.length) return false;
  const { rRuntimeSourceCasManifestHash, ...payload } = document;
  return SHA256.test(String(rRuntimeSourceCasManifestHash || ''))
    && hashRecord('RRuntimeSourceCasManifest', payload) === rRuntimeSourceCasManifestHash;
}

function blocked(blocker) {
  return Object.freeze({
    ready: false,
    status: 'r_runtime_source_cas_blocked',
    manifestHash: null,
    packageCount: 0,
    lockfileHash: null,
    definitionPaths: Object.freeze([]),
    blockers: Object.freeze([blocker]),
  });
}

export async function acquireRRuntimeSourceCas({
  contextPath,
  archiveTransport,
  repository,
  spawnSyncImpl = spawnSync,
  concurrency = 6,
  seedSourceDirectory = null,
} = {}) {
  assertRRuntimeSourceArchiveTransport(archiveTransport);
  if (!repository || repository.kind !== 'RRuntimeSourceCasRepository') {
    throw new Error('RRuntimeSourceCasRepository is required');
  }
  if (!Number.isSafeInteger(Number(concurrency))
    || Number(concurrency) < 1 || Number(concurrency) > 16) {
    throw new Error('r_runtime_source_cas_concurrency_invalid');
  }
  const context = fs.realpathSync(path.resolve(contextPath));
  const current = verifyRRuntimeSourceCas({ contextPath: context });
  if (current.ready) return Object.freeze({ ...current, acquired: false });
  if (repository.destinationExists()) throw new Error('r_runtime_source_cas_existing_invalid');
  const expected = readLock(path.join(context, 'renv.lock'));
  const seeds = seededArchives(seedSourceDirectory);
  const staging = repository.begin();
  let wasPublished = false;
  try {
    const packages = await mapConcurrent(expected.packages, Number(concurrency),
      (entry) => download(entry, staging, {
        archiveTransport, repository, spawnSyncImpl, seeds,
      }));
    repository.writeIndexes(staging, packages);
    const payload = manifestPayload({ lockfileHash: expected.lockfileHash, packages });
    const manifest = Object.freeze({
      ...payload,
      rRuntimeSourceCasManifestHash: hashRecord('RRuntimeSourceCasManifest', payload),
    });
    repository.writeManifest(staging, manifest);
    repository.publish(staging);
    wasPublished = true;
    const verified = verifyRRuntimeSourceCas({ contextPath: context });
    if (!verified.ready) throw new Error(`r_runtime_source_cas_post_publish_invalid:${verified.blockers.join(',')}`);
    repository.settlePublished(staging);
    return Object.freeze({ ...verified, acquired: true });
  } catch (error) {
    if (wasPublished) repository.rollbackPublished(staging);
    else repository.discard(staging);
    throw error;
  }
}
