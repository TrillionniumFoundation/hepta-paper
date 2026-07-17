import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEPTA_WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function sibling(name) {
  return path.join(path.dirname(HEPTA_WORKSPACE_ROOT), name);
}

function realPath(candidate) {
  const absolute = path.resolve(candidate);
  let existing = absolute;
  const missingSegments = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
  try { return path.join(fs.realpathSync(existing), ...missingSegments); }
  catch { return absolute; }
}

function pathsOverlap(left, right) {
  return left === right
    || left.startsWith(`${right}${path.sep}`)
    || right.startsWith(`${left}${path.sep}`);
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
  const resolved = {
    version: 1,
    kind: 'HeptaPaperWorkspaceLayout',
    workspaceRoot: HEPTA_WORKSPACE_ROOT,
    assetRoot: path.resolve(assetRoot || defaultPaperAssetRoot()),
    runtimeRoot: path.resolve(runtimeRoot || defaultPaperRuntimeRoot()),
    legacyRoot: path.resolve(legacyRoot || defaultLegacyPaperFactoryRoot()),
  };
  const realPaths = Object.freeze({
    workspaceRoot: realPath(resolved.workspaceRoot),
    assetRoot: realPath(resolved.assetRoot),
    runtimeRoot: realPath(resolved.runtimeRoot),
    legacyRoot: realPath(resolved.legacyRoot),
  });
  const roots = Object.entries(realPaths);
  const decouplingBlockers = [];
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
