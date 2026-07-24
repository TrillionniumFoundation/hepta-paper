#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ARCHITECTURE_ENTRYPOINT_MANIFEST,
  assertArchitectureEntrypointManifest,
} from '../src/architecture-entrypoint-manifest.mjs';
import { relativeModuleSpecifiers } from './javascript-module-specifiers.mjs';

const thisFile = fileURLToPath(import.meta.url);
const defaultWorkspaceRoot = path.resolve(path.dirname(thisFile), '..', '..');

function posix(relativePath) {
  return relativePath.replace(/\\/g, '/');
}

function sha256(content) {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function git(workspaceRoot, args, { encoding = 'utf8', input = undefined } = {}) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function isWithinWorkspace(workspaceRoot, candidate) {
  const relative = path.relative(workspaceRoot, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeEntrypoint(entry) {
  if (typeof entry !== 'string' || !entry.trim() || path.isAbsolute(entry)) return null;
  const normalized = posix(path.normalize(entry.trim()));
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) return null;
  return normalized.replace(/^\.\//, '');
}

function resolveRelativeImport({ workspaceRoot, importer, specifier }) {
  const candidate = path.resolve(path.dirname(importer), specifier);
  if (!isWithinWorkspace(workspaceRoot, candidate)) return { escaped: true, resolved: null };
  for (const resolved of [candidate, `${candidate}.mjs`, path.join(candidate, 'index.mjs')]) {
    if (!isWithinWorkspace(workspaceRoot, resolved)) return { escaped: true, resolved: null };
    try {
      if (fs.statSync(resolved).isFile()) return { escaped: false, resolved };
    } catch { /* Continue through the supported Node-style local candidates. */ }
  }
  return { escaped: false, resolved: null };
}

function inspectReachability(workspaceRoot, rawEntrypoints) {
  const workspaceReal = fs.realpathSync(workspaceRoot);
  const invalidEntrypoints = [];
  const missingEntrypoints = [];
  const escapedPaths = [];
  const unreadableModules = [];
  const unresolvedImports = [];
  const normalizedEntrypoints = [];
  for (const rawEntry of rawEntrypoints) {
    const entry = normalizeEntrypoint(rawEntry);
    if (!entry) invalidEntrypoints.push(String(rawEntry));
    else normalizedEntrypoints.push(entry);
  }

  const pending = [];
  for (const entry of normalizedEntrypoints) {
    const absolute = path.resolve(workspaceRoot, entry);
    if (!isWithinWorkspace(workspaceRoot, absolute) || !fs.existsSync(absolute)) {
      missingEntrypoints.push(entry);
      continue;
    }
    pending.push(absolute);
  }

  const reached = new Set();
  const dependencies = new Map();
  while (pending.length) {
    const absolute = pending.pop();
    if (reached.has(absolute)) continue;
    const relative = posix(path.relative(workspaceRoot, absolute));
    let real;
    try { real = fs.realpathSync(absolute); }
    catch {
      unreadableModules.push(relative);
      continue;
    }
    if (!isWithinWorkspace(workspaceReal, real)) {
      escapedPaths.push(relative);
      continue;
    }
    reached.add(absolute);
    let source;
    try { source = fs.readFileSync(absolute, 'utf8'); }
    catch {
      unreadableModules.push(relative);
      continue;
    }
    const localDependencies = new Set();
    for (const specifier of relativeModuleSpecifiers(source)) {
      const resolution = resolveRelativeImport({ workspaceRoot, importer: absolute, specifier });
      if (resolution.escaped) {
        escapedPaths.push(`${relative}->${specifier}`);
        continue;
      }
      if (!resolution.resolved) {
        unresolvedImports.push({ importer: relative, specifier });
        continue;
      }
      const dependency = posix(path.relative(workspaceRoot, resolution.resolved));
      localDependencies.add(dependency);
      if (!reached.has(resolution.resolved)) pending.push(resolution.resolved);
    }
    dependencies.set(relative, localDependencies);
  }

  return {
    entrypoints: [...new Set(normalizedEntrypoints)].sort(),
    modules: [...reached].map((absolute) => posix(path.relative(workspaceRoot, absolute))).sort(),
    dependencies,
    invalidEntrypoints: [...new Set(invalidEntrypoints)].sort(),
    missingEntrypoints: [...new Set(missingEntrypoints)].sort(),
    escapedPaths: [...new Set(escapedPaths)].sort(),
    unreadableModules: [...new Set(unreadableModules)].sort(),
    unresolvedImports: unresolvedImports
      .sort((left, right) => left.importer.localeCompare(right.importer) || left.specifier.localeCompare(right.specifier)),
  };
}

function parseIndexEntries(raw) {
  const byPath = new Map();
  let malformed = false;
  for (const row of String(raw || '').split('\0').filter(Boolean)) {
    const separator = row.indexOf('\t');
    if (separator < 0) {
      malformed = true;
      continue;
    }
    const [mode, objectId, stageText] = row.slice(0, separator).split(' ');
    const stage = Number(stageText);
    const relative = posix(row.slice(separator + 1));
    if (!/^\d{6}$/.test(mode) || !/^[0-9a-f]{40,64}$/i.test(objectId) || !Number.isInteger(stage)) {
      malformed = true;
      continue;
    }
    if (!byPath.has(relative)) byPath.set(relative, []);
    byPath.get(relative).push({ mode, objectId: objectId.toLowerCase(), stage });
  }
  return { byPath, malformed };
}

function readIndexBlobs(workspaceRoot, objectIds) {
  const requested = [...new Set(objectIds)].sort();
  if (requested.length === 0) return { ok: true, blobs: new Map() };
  const result = git(workspaceRoot, ['cat-file', '--batch'], {
    encoding: null,
    input: Buffer.from(`${requested.join('\n')}\n`, 'utf8'),
  });
  if (!result.ok || !Buffer.isBuffer(result.stdout)) return { ok: false, blobs: new Map() };
  const blobs = new Map();
  let offset = 0;
  for (const requestedId of requested) {
    const headerEnd = result.stdout.indexOf(0x0a, offset);
    if (headerEnd < 0) return { ok: false, blobs: new Map() };
    const header = result.stdout.subarray(offset, headerEnd).toString('utf8');
    const [objectId, type, sizeText] = header.split(' ');
    const size = Number(sizeText);
    if (type !== 'blob' || !Number.isSafeInteger(size) || size < 0) return { ok: false, blobs: new Map() };
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= result.stdout.length || result.stdout[contentEnd] !== 0x0a) {
      return { ok: false, blobs: new Map() };
    }
    blobs.set(requestedId, Buffer.from(result.stdout.subarray(contentStart, contentEnd)));
    if (objectId !== requestedId) return { ok: false, blobs: new Map() };
    offset = contentEnd + 1;
  }
  return { ok: true, blobs };
}

function readWorktreeIndexContent(absolute, mode) {
  try {
    const stat = fs.lstatSync(absolute);
    if (mode === '120000' && stat.isSymbolicLink()) return Buffer.from(fs.readlinkSync(absolute), 'utf8');
    if (/^100\d{3}$/.test(mode) && stat.isFile()) return fs.readFileSync(absolute);
  } catch { /* A missing or unreadable path remains an index mismatch. */ }
  return null;
}

function reportBlockers(details) {
  const blockers = [];
  if (!details.gitIndexAvailable || details.indexMalformed || !details.indexBlobsAvailable) {
    blockers.push('production_graph_git_index_unavailable');
  }
  if (details.invalidEntrypoints.length) blockers.push('production_graph_entrypoints_invalid');
  if (details.missingEntrypoints.length) blockers.push('production_graph_entrypoints_missing');
  if (details.escapedPaths.length) blockers.push('production_graph_workspace_escape_detected');
  if (details.unreadableModules.length) blockers.push('production_graph_modules_unreadable');
  if (details.unresolvedImports.length) blockers.push('production_graph_relative_imports_unresolved');
  if (details.untrackedModules.length) blockers.push('production_graph_modules_untracked');
  if (details.unmergedModules.length) blockers.push('production_graph_modules_unmerged');
  if (details.indexMismatchedModules.length) blockers.push('production_graph_modules_not_index_bound');
  if (details.expectedManifestHash && details.expectedManifestHash !== details.productionGraphManifestHash) {
    blockers.push('production_graph_manifest_hash_mismatch');
  }
  return blockers;
}

export function inspectTrackedProductionGraph({
  workspaceRoot = defaultWorkspaceRoot,
  entrypoints = assertArchitectureEntrypointManifest(ARCHITECTURE_ENTRYPOINT_MANIFEST).production,
  expectedManifestHash = null,
} = {}) {
  const absoluteWorkspace = path.resolve(workspaceRoot);
  const reachability = inspectReachability(absoluteWorkspace, entrypoints);
  const topLevel = git(absoluteWorkspace, ['rev-parse', '--show-toplevel']);
  const indexResult = git(absoluteWorkspace, ['ls-files', '--stage', '-z', '--']);
  const canonicalTopLevel = topLevel.ok ? path.resolve(String(topLevel.stdout || '').trim()) : null;
  const gitIndexAvailable = Boolean(
    topLevel.ok
    && indexResult.ok
    && canonicalTopLevel
    && fs.realpathSync(canonicalTopLevel) === fs.realpathSync(absoluteWorkspace),
  );
  const parsedIndex = gitIndexAvailable
    ? parseIndexEntries(indexResult.stdout)
    : { byPath: new Map(), malformed: true };
  const stageZeroEntries = new Map();
  const untrackedModules = [];
  const unmergedModules = [];
  for (const relative of reachability.modules) {
    const entries = parsedIndex.byPath.get(relative) || [];
    const stageZero = entries.filter((entry) => entry.stage === 0);
    if (entries.some((entry) => entry.stage !== 0) || stageZero.length > 1) unmergedModules.push(relative);
    if (stageZero.length === 0) untrackedModules.push(relative);
    else stageZeroEntries.set(relative, stageZero[0]);
  }
  const indexBlobs = readIndexBlobs(
    absoluteWorkspace,
    [...stageZeroEntries.values()].map((entry) => entry.objectId),
  );
  const indexMismatchedModules = [];
  const moduleRows = reachability.modules.map((relative) => {
    const entry = stageZeroEntries.get(relative) || null;
    const worktreeContent = entry
      ? readWorktreeIndexContent(path.join(absoluteWorkspace, relative), entry.mode)
      : (() => {
        try { return fs.readFileSync(path.join(absoluteWorkspace, relative)); }
        catch { return null; }
      })();
    const indexContent = entry ? indexBlobs.blobs.get(entry.objectId) || null : null;
    const contentSha256 = worktreeContent ? sha256(worktreeContent) : null;
    const indexContentSha256 = indexContent ? sha256(indexContent) : null;
    if (entry && (!worktreeContent || !indexContent || contentSha256 !== indexContentSha256)) {
      indexMismatchedModules.push(relative);
    }
    return {
      path: relative,
      dependencies: [...(reachability.dependencies.get(relative) || [])].sort(),
      contentSha256,
      indexMode: entry?.mode || null,
      indexObjectId: entry?.objectId || null,
      indexContentSha256,
    };
  });
  const manifest = {
    version: 1,
    kind: 'ProductionReachabilityManifest',
    entrypoints: reachability.entrypoints,
    moduleCount: moduleRows.length,
    edgeCount: moduleRows.reduce((count, row) => count + row.dependencies.length, 0),
    modules: moduleRows,
  };
  const productionGraphManifestHash = sha256(JSON.stringify(manifest));
  const details = {
    gitIndexAvailable,
    indexMalformed: parsedIndex.malformed,
    indexBlobsAvailable: indexBlobs.ok,
    invalidEntrypoints: reachability.invalidEntrypoints,
    missingEntrypoints: reachability.missingEntrypoints,
    escapedPaths: reachability.escapedPaths,
    unreadableModules: reachability.unreadableModules,
    unresolvedImports: reachability.unresolvedImports,
    untrackedModules: untrackedModules.sort(),
    unmergedModules: unmergedModules.sort(),
    indexMismatchedModules: indexMismatchedModules.sort(),
    expectedManifestHash,
    productionGraphManifestHash,
  };
  const blockers = reportBlockers(details);
  return Object.freeze({
    version: 1,
    kind: 'TrackedProductionGraphReport',
    status: blockers.length ? 'tracked_production_graph_blocked' : 'tracked_production_graph_ready',
    moduleCount: manifest.moduleCount,
    edgeCount: manifest.edgeCount,
    trackedModuleCount: manifest.moduleCount - untrackedModules.length,
    indexBoundModuleCount: manifest.moduleCount - untrackedModules.length - indexMismatchedModules.length,
    allProductionModulesTracked: untrackedModules.length === 0 && unmergedModules.length === 0,
    productionGraphManifestHash,
    expectedManifestHash,
    blockers: Object.freeze(blockers),
    invalidEntrypoints: Object.freeze(reachability.invalidEntrypoints),
    missingEntrypoints: Object.freeze(reachability.missingEntrypoints),
    escapedPaths: Object.freeze(reachability.escapedPaths),
    unreadableModules: Object.freeze(reachability.unreadableModules),
    unresolvedImports: Object.freeze(reachability.unresolvedImports),
    untrackedModules: Object.freeze(untrackedModules.sort()),
    unmergedModules: Object.freeze(unmergedModules.sort()),
    indexMismatchedModules: Object.freeze(indexMismatchedModules.sort()),
    manifest: Object.freeze(manifest),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const expectedIndex = process.argv.indexOf('--expect');
  const expectedManifestHash = expectedIndex >= 0 ? process.argv[expectedIndex + 1] : null;
  const report = inspectTrackedProductionGraph({ expectedManifestHash });
  const output = process.argv.includes('--manifest')
    ? report
    : Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'manifest'));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (report.status !== 'tracked_production_graph_ready') process.exitCode = 1;
}
