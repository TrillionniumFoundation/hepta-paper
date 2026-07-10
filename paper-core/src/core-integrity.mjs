import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_BASELINE_VERSION = 1;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = path.resolve(moduleDir, '..', '..');
const DEFAULT_INCLUDED_ROOTS = Object.freeze([
  '.gitignore',
  'README.md',
  'SOURCE_FILE_SHA256SUMS.txt',
  'SOURCE_SNAPSHOT.txt',
  'docs',
  'fixtures',
  'package.json',
  'src',
]);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function stableTreeHash(files) {
  return `sha256:${sha256(JSON.stringify(files.map(({ path: file, sha256: hash, size }) => ({
    path: file,
    sha256: hash,
    size,
  }))))}`;
}

function walkFiles(root, relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];
  const stat = fs.statSync(absoluteRoot);
  if (stat.isFile()) return [relativeRoot];
  const out = [];
  const walk = (current, relativeCurrent) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'reports'].includes(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.posix.join(relativeCurrent.replace(/\\/g, '/'), entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      if (entry.isFile()) out.push(relative);
    }
  };
  walk(absoluteRoot, relativeRoot);
  return out;
}

export function collectCoreFileRows({
  coreRoot = path.join(defaultWorkspaceRoot, 'core'),
  includedRoots = DEFAULT_INCLUDED_ROOTS,
} = {}) {
  return [...new Set(includedRoots.flatMap((entry) => walkFiles(coreRoot, entry)))]
    .filter((file) => file !== 'CORE_BASELINE.json')
    .sort((left, right) => left.localeCompare(right))
    .map((file) => {
      const content = fs.readFileSync(path.join(coreRoot, file));
      return { path: file, size: content.length, sha256: sha256(content) };
    });
}

export function compareCoreFileRows(expected = [], actual = []) {
  const expectedByPath = new Map(expected.map((row) => [row.path, row]));
  const actualByPath = new Map(actual.map((row) => [row.path, row]));
  const missing = expected.filter((row) => !actualByPath.has(row.path)).map((row) => row.path);
  const extra = actual.filter((row) => !expectedByPath.has(row.path)).map((row) => row.path);
  const changed = expected
    .filter((row) => actualByPath.has(row.path) && actualByPath.get(row.path).sha256 !== row.sha256)
    .map((row) => ({
      path: row.path,
      expectedSha256: row.sha256,
      actualSha256: actualByPath.get(row.path).sha256,
    }));
  return {
    ok: missing.length === 0 && extra.length === 0 && changed.length === 0,
    missing,
    extra,
    changed,
  };
}

function parseUpstreamManifest(coreRoot) {
  const manifestPath = path.join(coreRoot, 'SOURCE_FILE_SHA256SUMS.txt');
  if (!fs.existsSync(manifestPath)) return [];
  return fs.readFileSync(manifestPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^([0-9a-f]{64})\s+(.+)$/))
    .filter(Boolean)
    .map((match) => {
      const sourcePath = match[2].replace(/\\/g, '/');
      const marker = '/design-production-core-source-20260621-213732-3f90aa27/';
      const relativePath = sourcePath.includes(marker)
        ? sourcePath.split(marker).pop()
        : sourcePath.replace(/^.*?\/(src|docs|fixtures)\//, '$1/');
      return { path: relativePath, sha256: match[1] };
    });
}

function upstreamComparison(coreRoot) {
  const expected = parseUpstreamManifest(coreRoot);
  let matched = 0;
  let changed = 0;
  let missing = 0;
  const changedPaths = [];
  for (const row of expected) {
    const file = path.join(coreRoot, row.path);
    if (!fs.existsSync(file)) {
      missing += 1;
      changedPaths.push(row.path);
      continue;
    }
    const actual = sha256(fs.readFileSync(file));
    if (actual === row.sha256) matched += 1;
    else {
      changed += 1;
      changedPaths.push(row.path);
    }
  }
  return {
    available: expected.length > 0,
    exactMatch: expected.length > 0 && changed === 0 && missing === 0,
    total: expected.length,
    matched,
    changed,
    missing,
    changedPaths,
  };
}

function sourceGitHead(coreRoot) {
  const sourceSnapshot = path.join(coreRoot, 'SOURCE_SNAPSHOT.txt');
  if (!fs.existsSync(sourceSnapshot)) return null;
  return fs.readFileSync(sourceSnapshot, 'utf8').match(/^git_head:\s*(\S+)/m)?.[1] || null;
}

export function buildCoreBaseline({
  workspaceRoot = defaultWorkspaceRoot,
  createdAt = new Date().toISOString(),
  acceptedFromGitCommit = null,
} = {}) {
  const coreRoot = path.join(workspaceRoot, 'core');
  const files = collectCoreFileRows({ coreRoot });
  const upstream = upstreamComparison(coreRoot);
  return {
    version: CORE_BASELINE_VERSION,
    kind: 'HeptaPaperCoreAcceptedBaseline',
    createdAt,
    acceptedFromGitCommit,
    trustBasis: 'independent_git_history_plus_content_hash_manifest',
    provenance: {
      upstreamGitHead: sourceGitHead(coreRoot),
      upstreamSnapshotExactMatchAtAcceptance: upstream.exactMatch,
      upstreamMatchedFilesAtAcceptance: upstream.matched,
      upstreamChangedFilesAtAcceptance: upstream.changed,
      upstreamMissingFilesAtAcceptance: upstream.missing,
      note: 'This is an explicitly accepted vendored-core baseline; it does not claim byte identity with the historical upstream snapshot.',
    },
    includedRoots: [...DEFAULT_INCLUDED_ROOTS],
    fileCount: files.length,
    treeHash: stableTreeHash(files),
    files,
  };
}

export function writeCoreBaseline({
  workspaceRoot = defaultWorkspaceRoot,
  acceptedFromGitCommit = null,
} = {}) {
  const baseline = buildCoreBaseline({ workspaceRoot, acceptedFromGitCommit });
  const manifestPath = path.join(workspaceRoot, 'core', 'CORE_BASELINE.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(baseline, null, 2)}\n`);
  return { baseline, manifestPath };
}

export function buildCoreIntegrityReport({ workspaceRoot = defaultWorkspaceRoot } = {}) {
  const coreRoot = path.join(workspaceRoot, 'core');
  const manifestPath = path.join(coreRoot, 'CORE_BASELINE.json');
  const upstream = upstreamComparison(coreRoot);
  if (!fs.existsSync(manifestPath)) {
    return {
      version: 1,
      kind: 'HeptaPaperCoreIntegrityReport',
      status: 'blocked_core_baseline_missing',
      ok: false,
      coreSnapshotModified: true,
      manifestPath,
      acceptedBaseline: null,
      current: null,
      drift: { ok: false, missing: [], extra: [], changed: [] },
      upstream,
    };
  }
  const acceptedBaseline = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const currentFiles = collectCoreFileRows({
    coreRoot,
    includedRoots: acceptedBaseline.includedRoots || DEFAULT_INCLUDED_ROOTS,
  });
  const drift = compareCoreFileRows(acceptedBaseline.files || [], currentFiles);
  const currentTreeHash = stableTreeHash(currentFiles);
  const ok = drift.ok && currentTreeHash === acceptedBaseline.treeHash;
  return {
    version: 1,
    kind: 'HeptaPaperCoreIntegrityReport',
    status: ok ? 'pass_accepted_core_baseline' : 'blocked_core_baseline_drift',
    ok,
    coreSnapshotModified: !ok,
    manifestPath,
    acceptedBaseline: {
      createdAt: acceptedBaseline.createdAt || null,
      acceptedFromGitCommit: acceptedBaseline.acceptedFromGitCommit || null,
      treeHash: acceptedBaseline.treeHash || null,
      fileCount: acceptedBaseline.fileCount || 0,
      trustBasis: acceptedBaseline.trustBasis || null,
    },
    current: { treeHash: currentTreeHash, fileCount: currentFiles.length },
    drift,
    upstream,
  };
}
