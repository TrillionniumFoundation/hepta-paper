import path from 'node:path';

import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

const SAFE_PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function containerPathForScopeEntry(scopeRoot, absolutePath) {
  if (!isPathWithin(scopeRoot, absolutePath)) {
    throw new Error('sealed_formal_probe_path_outside_scope');
  }
  const relative = path.relative(scopeRoot, absolutePath)
    .split(path.sep).join('/');
  return relative ? `/work/${relative}` : '/work';
}

export function buildSealedFormalLeanProbeEnvironment({
  manifest,
  snapshotScopeRoot,
  snapshotProjectRoot,
  toolchainRoot,
} = {}) {
  const scopeRoot = path.resolve(String(snapshotScopeRoot || ''));
  const projectRoot = path.resolve(String(snapshotProjectRoot || ''));
  const resolvedToolchainRoot = path.resolve(String(toolchainRoot || ''));
  const packages = manifest?.packages;
  const packageNames = Array.isArray(packages)
    ? packages.map((entry) => String(entry?.name || '')) : [];
  if (manifest?.packagesDir !== '.lake/packages'
    || packageNames.length < 1
    || packageNames.some((name) => !SAFE_PACKAGE_NAME.test(name))
    || new Set(packageNames).size !== packageNames.length
    || !path.isAbsolute(String(snapshotScopeRoot || ''))
    || !path.isAbsolute(String(snapshotProjectRoot || ''))
    || !isPathWithin(scopeRoot, projectRoot)
    || !path.isAbsolute(String(toolchainRoot || ''))
    || [scopeRoot, projectRoot, resolvedToolchainRoot]
      .some((candidate) => /[:\r\n]/.test(candidate))) {
    throw new Error('sealed_formal_probe_environment_invalid');
  }
  const containerProjectRoot = containerPathForScopeEntry(scopeRoot, projectRoot);
  const leanSearchRoots = [
    ...[...packageNames].reverse().map((name) => (
      `${containerProjectRoot}/.lake/packages/${name}/.lake/build/lib/lean`
    )),
    `${containerProjectRoot}/.lake/build/lib/lean`,
    `${resolvedToolchainRoot}/lib/lean`,
  ];
  return Object.freeze({
    LEAN_PATH: leanSearchRoots.join(':'),
  });
}
