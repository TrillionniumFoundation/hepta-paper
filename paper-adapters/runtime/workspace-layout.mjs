import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEPTA_WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const MAX_SYMLINK_HOPS = 40;

function sibling(name) {
  return path.join(path.dirname(HEPTA_WORKSPACE_ROOT), name);
}

function realPath(candidate) {
  const absolute = path.isAbsolute(candidate)
    ? candidate
    : `${process.cwd()}${path.sep}${candidate}`;
  let current = path.parse(absolute).root;
  let pending = absolute.slice(current.length).split(path.sep);
  let missing = false;
  let symlinkHops = 0;
  while (pending.length) {
    const component = pending.shift();
    if (!component || component === '.') continue;
    if (component === '..') {
      if (missing) return null;
      current = path.dirname(current);
      continue;
    }
    const selected = path.join(current, component);
    if (missing) {
      current = selected;
      continue;
    }
    let selectedStat;
    try {
      selectedStat = fs.lstatSync(selected);
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      missing = true;
      current = selected;
      continue;
    }
    if (!selectedStat.isSymbolicLink()) {
      if (!selectedStat.isDirectory()) return null;
      current = selected;
      continue;
    }
    if (symlinkHops >= MAX_SYMLINK_HOPS) return null;
    symlinkHops += 1;
    let target;
    try { target = fs.readlinkSync(selected); }
    catch { return null; }
    if (path.isAbsolute(target)) current = path.parse(target).root;
    const targetRoot = path.isAbsolute(target) ? path.parse(target).root : '';
    pending = [
      ...target.slice(targetRoot.length).split(path.sep),
      ...pending,
    ];
  }
  return current;
}

function pathContains(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

export function defaultPaperAssetRoot() {
  if (process.env.HEPTA_PAPER_ASSET_ROOT) return path.resolve(process.env.HEPTA_PAPER_ASSET_ROOT);
  const standalone = sibling('hepta-paper-assets');
  if (fs.existsSync(standalone)) return standalone;
  const legacyParent = path.dirname(HEPTA_WORKSPACE_ROOT);
  return path.basename(legacyParent) === 'paper_factory'
    ? legacyParent
    : path.join(HEPTA_WORKSPACE_ROOT, 'assets');
}

export function defaultPaperRuntimeRoot() {
  return process.env.HEPTA_PAPER_RUNTIME_ROOT
    ? path.resolve(process.env.HEPTA_PAPER_RUNTIME_ROOT)
    : path.join(sibling('hepta-paper-runtime'), 'native-runtime');
}

export function defaultLegacyPaperFactoryRoot() {
  if (process.env.PAPER_FACTORY_LEGACY_ROOT) return path.resolve(process.env.PAPER_FACTORY_LEGACY_ROOT);
  const parent = path.dirname(HEPTA_WORKSPACE_ROOT);
  return path.basename(parent) === 'paper_factory' ? parent : sibling('paper_factory');
}

export function resolveWorkspaceLayout({
  assetRoot = null,
  runtimeRoot = null,
  legacyRoot = null,
} = {}) {
  const requestedPaths = {
    workspaceRoot: HEPTA_WORKSPACE_ROOT,
    assetRoot: assetRoot || defaultPaperAssetRoot(),
    runtimeRoot: runtimeRoot || defaultPaperRuntimeRoot(),
    legacyRoot: legacyRoot || defaultLegacyPaperFactoryRoot(),
  };
  const resolved = {
    version: 1,
    kind: 'HeptaPaperWorkspaceLayout',
    workspaceRoot: path.resolve(requestedPaths.workspaceRoot),
    assetRoot: path.resolve(requestedPaths.assetRoot),
    runtimeRoot: path.resolve(requestedPaths.runtimeRoot),
    legacyRoot: path.resolve(requestedPaths.legacyRoot),
  };
  const pathResolutionBlockers = [];
  const requestedRealPaths = {
    workspaceRoot: resolved.workspaceRoot,
    assetRoot: resolved.assetRoot,
    runtimeRoot: resolved.runtimeRoot,
    legacyRoot: resolved.legacyRoot,
  };
  const realPaths = Object.freeze(Object.fromEntries(Object.entries(requestedRealPaths)
    .map(([name, value]) => {
      const canonical = realPath(value);
      if (canonical === null) {
        pathResolutionBlockers.push(`workspace_layout_path_resolution_failed:${name}`);
      }
      return [name, canonical || path.resolve(value)];
    })));
  const roots = Object.entries(realPaths);
  const decouplingBlockers = [...pathResolutionBlockers];
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const [leftName, leftPath] = roots[leftIndex];
      const [rightName, rightPath] = roots[rightIndex];
      if (pathsOverlap(leftPath, rightPath)) {
        decouplingBlockers.push(`workspace_layout_paths_overlap:${leftName}:${rightName}`);
      }
    }
  }
  return Object.freeze({
    ...resolved,
    realPaths,
    physicallyDecoupled: decouplingBlockers.length === 0,
    decouplingBlockers: Object.freeze(decouplingBlockers),
    legacyCatalogRuntimeScanAllowed: false,
  });
}

export function assertWorkspaceLayoutPhysicallyDecoupled(options = {}) {
  const layout = resolveWorkspaceLayout(options);
  if (!layout.physicallyDecoupled) {
    throw new Error(`workspace_layout_not_physically_decoupled:${layout.decouplingBlockers.join(',')}`);
  }
  return layout;
}
