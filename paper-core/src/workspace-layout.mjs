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
    : path.join(HEPTA_WORKSPACE_ROOT, 'runtime');
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
  return Object.freeze({
    ...resolved,
    physicallyDecoupled: (
      !resolved.workspaceRoot.startsWith(resolved.legacyRoot + path.sep)
      && !resolved.assetRoot.startsWith(resolved.legacyRoot + path.sep)
      && !resolved.runtimeRoot.startsWith(resolved.legacyRoot + path.sep)
    ),
    legacyCatalogRuntimeScanAllowed: false,
  });
}
