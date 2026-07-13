import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultLegacyPaperFactoryRoot } from '../paper-adapters/runtime/workspace-layout.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(workspaceRoot, 'migration', 'fixtures', 'legacy-matrix-reference-v1.json');

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function walk(directory, basename, rows = []) {
  if (!fs.existsSync(directory)) return rows;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, basename, rows);
    else if (entry.isFile() && entry.name === basename) rows.push(absolute);
  }
  return rows;
}

export function resolveImmutableLegacyMatrixArchive({ manifest = null } = {}) {
  const resolvedManifest = manifest || JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const explicit = process.env.HEPTA_LEGACY_REFERENCE_ARCHIVE
    ? path.resolve(process.env.HEPTA_LEGACY_REFERENCE_ARCHIVE)
    : null;
  const referenceRoot = path.join(path.dirname(defaultLegacyPaperFactoryRoot()), 'hepta-paper-legacy-reference');
  const candidates = [
    ...(explicit ? [explicit] : []),
    ...walk(referenceRoot, resolvedManifest.archiveBasename),
  ];
  const archivePath = [...new Set(candidates)].find((candidate) => (
    fs.existsSync(candidate) && sha256File(candidate) === resolvedManifest.archiveSha256
  ));
  if (!archivePath) throw new Error(`Immutable legacy matrix archive ${resolvedManifest.archiveSha256} not found`);
  return archivePath;
}

export function prepareImmutableLegacyMatrixReference() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const matrixPath = path.join(workspaceRoot, manifest.matrixPath);
  if (sha256File(matrixPath) !== manifest.matrixSha256) throw new Error('Legacy matrix reference hash mismatch');
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  const sourcePaths = [...new Set((matrix.entries || []).map((entry) => String(entry?.source?.path || '')).filter(Boolean))].sort();
  if (sourcePaths.length !== Number(manifest.sourceFileCount)) throw new Error('Legacy matrix source file count mismatch');
  const archivePath = resolveImmutableLegacyMatrixArchive({ manifest });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-legacy-matrix-reference-'));
  const extract = spawnSync('tar', ['-xzf', archivePath, '-C', root, '--', ...sourcePaths], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (extract.status !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(extract.stderr || 'immutable_legacy_matrix_extract_failed');
  }
  const extracted = sourcePaths.filter((relative) => fs.existsSync(path.join(root, relative)));
  if (extracted.length !== sourcePaths.length) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error('Immutable legacy matrix archive is missing source files');
  }
  let cleaned = false;
  const cleanup = () => {
    if (cleaned || !fs.existsSync(root)) return;
    cleaned = true;
    fs.rmSync(root, { recursive: true, force: true });
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
    sourcePaths,
    cleanup,
  });
}

export function immutableLegacyMatrixReferenceStatus() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const archivePath = resolveImmutableLegacyMatrixArchive({ manifest });
  return Object.freeze({
    version: 1,
    kind: 'ImmutableLegacyMatrixReferenceStatus',
    status: 'immutable_legacy_matrix_reference_ready',
    manifestPath,
    archivePath,
    archiveSha256: sha256File(archivePath),
    matrixPath: path.join(workspaceRoot, manifest.matrixPath),
    matrixSha256: manifest.matrixSha256,
    sourceFileCount: manifest.sourceFileCount,
    liveLegacyRootRequired: false,
  });
}
