import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultLegacyPaperFactoryRoot } from '../paper-adapters/runtime/workspace-layout.mjs';
import { bindIdentityBoundTemporaryDirectory } from '../paper-composition/bootstrap/immutable-release-workspace-composition.mjs';
import { captureLegacyMatrixArchive, extractLegacyMatrixSources, legacyBytesHash, readStableLegacyFile } from './legacy-matrix-archive-io.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(workspaceRoot, 'migration', 'fixtures', 'legacy-matrix-reference-v1.json');

function walk(directory, basename, budget = { remaining: 4096 }, depth = 0) {
  if (depth > 16 || --budget.remaining < 0) throw new Error('legacy_matrix_discovery_limit');
  let selected;
  try { selected = fs.lstatSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!selected.isDirectory() || selected.isSymbolicLink()) throw new Error('legacy_matrix_discovery_root_unsafe');
  const rows = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (--budget.remaining < 0) throw new Error('legacy_matrix_discovery_limit');
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...walk(absolute, basename, budget, depth + 1));
    else if (entry.isFile() && entry.name === basename) rows.push(absolute);
  }
  return rows;
}

function captureSelectedArchive(manifest, environment = process.env) {
  if (!manifest || typeof manifest.archiveBasename !== 'string'
    || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(manifest.archiveBasename)
    || typeof manifest.archiveSha256 !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(manifest.archiveSha256)) {
    throw new Error('legacy_matrix_archive_manifest_invalid');
  }
  if (environment.HEPTA_LEGACY_REFERENCE_ARCHIVE) {
    // An explicit input is an assertion. Never silently substitute a discovered archive.
    return captureLegacyMatrixArchive(path.resolve(environment.HEPTA_LEGACY_REFERENCE_ARCHIVE), manifest.archiveSha256);
  }
  const legacyRoot = environment.PAPER_FACTORY_LEGACY_ROOT
    ? path.resolve(environment.PAPER_FACTORY_LEGACY_ROOT) : defaultLegacyPaperFactoryRoot();
  const referenceRoot = path.join(path.dirname(legacyRoot), 'hepta-paper-legacy-reference');
  for (const candidate of walk(referenceRoot, manifest.archiveBasename)) {
    try { return captureLegacyMatrixArchive(candidate, manifest.archiveSha256); }
    catch (error) { if (error.code !== 'legacy_matrix_archive_hash_mismatch') throw error; }
  }
  throw new Error(`Immutable legacy matrix archive ${manifest.archiveSha256} not found`);
}

export function resolveImmutableLegacyMatrixArchive({ manifest = null, environment = process.env } = {}) {
  const resolvedManifest = manifest || JSON.parse(readStableLegacyFile(manifestPath, 1024 * 1024));
  return captureSelectedArchive(resolvedManifest, environment).archivePath;
}

export function prepareImmutableLegacyMatrixReference() {
  const manifest = JSON.parse(readStableLegacyFile(manifestPath, 1024 * 1024));
  const matrixPath = path.join(workspaceRoot, manifest.matrixPath);
  const matrixBytes = readStableLegacyFile(matrixPath, 4 * 1024 * 1024);
  if (legacyBytesHash(matrixBytes) !== manifest.matrixSha256) throw new Error('Legacy matrix reference hash mismatch');
  const matrix = JSON.parse(matrixBytes);
  const sources = (matrix.entries || []).map((entry) => ({
    path: entry?.source?.path,
    sha256: `sha256:${String(entry?.source?.sha256 || '').replace(/^sha256:/u, '')}`,
  }));
  const sourcePaths = sources.map((source) => source.path);
  if (!Number.isSafeInteger(manifest.sourceFileCount) || sources.length !== manifest.sourceFileCount
    || new Set(sourcePaths).size !== sources.length) throw new Error('Legacy matrix source file count mismatch');
  const archive = captureSelectedArchive(manifest);
  const archivePath = archive.archivePath;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-legacy-matrix-reference-'));
  const ownedRoot = bindIdentityBoundTemporaryDirectory(root);
  try { extractLegacyMatrixSources(archive, sources, root); }
  catch (error) { ownedRoot.cleanup(); throw error; }
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    ownedRoot.cleanup();
    cleaned = true;
  };
  return Object.freeze({
    version: 1,
    kind: 'PreparedImmutableLegacyMatrixReference',
    root,
    archivePath,
    archiveSha256: manifest.archiveSha256,
    matrixPath,
    matrixSha256: manifest.matrixSha256,
    sourceFileCount: sourcePaths.length,
    sourcePaths: Object.freeze(sourcePaths),
    cleanup,
  });
}

export function immutableLegacyMatrixReferenceStatus() {
  const manifest = JSON.parse(readStableLegacyFile(manifestPath, 1024 * 1024));
  const archive = captureSelectedArchive(manifest);
  const archivePath = archive.archivePath;
  return Object.freeze({
    version: 1,
    kind: 'ImmutableLegacyMatrixReferenceStatus',
    status: 'immutable_legacy_matrix_reference_ready',
    manifestPath,
    archivePath,
    archiveSha256: archive.archiveSha256,
    matrixPath: path.join(workspaceRoot, manifest.matrixPath),
    matrixSha256: manifest.matrixSha256,
    sourceFileCount: manifest.sourceFileCount,
    liveLegacyRootRequired: false,
  });
}
