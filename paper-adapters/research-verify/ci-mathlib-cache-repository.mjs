import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  PRODUCTION_LEAN_TOOLCHAIN,
  PRODUCTION_MATHLIB_RELEASES,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { resolvePinnedLakeExecutable } from './pinned-lake-executable-resolver.mjs';
import {
  inspectProductionMathlibRelease,
} from './production-mathlib-release-provenance.mjs';

const policy = PRODUCTION_MATHLIB_RELEASES[PRODUCTION_LEAN_TOOLCHAIN];
const lakefile = [
  'import Lake',
  '',
  'open Lake DSL',
  '',
  'package HeptaCiMathlib where',
  '',
  `require "leanprover-community" / "mathlib" @ git "${policy.releaseTag}"`,
  '',
].join('\n');
const probeSource = 'import Mathlib\nexample : True := by trivial\n';

export const CI_MATHLIB_CACHE_USAGE = Object.freeze({
  version: 1,
  kind: 'CiMathlibCacheUsage',
  usage: 'prepare-ci-mathlib-cache [--root PATH] [--prepare]',
  sourceAuthority: 'official_pinned_mathlib_commit_and_tree',
  productionAuthorityGranted: false,
});

function cachePaths({ workspaceRoot, root }) {
  const cacheRoot = path.join(workspaceRoot, '.ci-cache');
  const selectedRoot = path.resolve(root || path.join(cacheRoot, 'mathlib-project'));
  const relative = path.relative(cacheRoot, selectedRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('ci_mathlib_cache_root_outside_workspace_cache');
  }
  return Object.freeze({ cacheRoot, root: selectedRoot });
}

function projectFilesCurrent(root) {
  const expected = new Map([
    ['lakefile.lean', lakefile],
    ['lean-toolchain', `${PRODUCTION_LEAN_TOOLCHAIN}\n`],
    ['HeptaCiMathlib.lean', probeSource],
  ]);
  return [...expected].every(([relative, content]) => {
    const candidate = path.join(root, relative);
    try {
      const stat = fs.lstatSync(candidate);
      return stat.isFile() && !stat.isSymbolicLink()
        && fs.readFileSync(candidate, 'utf8') === content;
    } catch {
      return false;
    }
  });
}

function lakeRunner({ root, environment }) {
  return (args) => {
    const pinned = resolvePinnedLakeExecutable({ environment });
    if (pinned.status !== 'formal_pinned_lake_resolved') {
      throw new Error(`ci_mathlib_cache_lake_unavailable:${pinned.blockers.join(',')}`);
    }
    const result = spawnSync(pinned.executable, args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 30 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...environment,
        ELAN_TOOLCHAIN: PRODUCTION_LEAN_TOOLCHAIN,
      },
    });
    if (result.error || result.status !== 0) {
      throw new Error(`ci_mathlib_cache_lake_command_failed:${args.join('_')}:${String(
        result.stderr || result.stdout || result.error?.message || '',
      ).slice(-2000)}`);
    }
    return result;
  };
}

function inspectCache({ root, runLake }) {
  const blockers = [];
  let releaseIdentity = null;
  let probeExitCode = null;
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('ci_mathlib_cache_root_invalid');
    }
    if (!projectFilesCurrent(root)) blockers.push('ci_mathlib_cache_project_files_drifted');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'lake-manifest.json'), 'utf8'));
    releaseIdentity = inspectProductionMathlibRelease({
      manifest,
      projectRoot: root,
      projectScopeRoot: root,
    });
    if (releaseIdentity.status !== 'production_mathlib_release_verified') {
      blockers.push(...releaseIdentity.blockers);
    }
    if (!blockers.length) {
      const probe = runLake(['env', 'lean', 'HeptaCiMathlib.lean']);
      probeExitCode = probe.status;
    }
  } catch (error) {
    blockers.push(String(error?.message || error));
  }
  const payload = {
    version: 1,
    kind: 'CiMathlibCacheReceipt',
    status: blockers.length
      ? 'ci_mathlib_cache_blocked'
      : 'ci_mathlib_cache_verified',
    root,
    toolchain: PRODUCTION_LEAN_TOOLCHAIN,
    releaseTag: policy.releaseTag,
    revision: policy.revision,
    sourceTreeHash: policy.sourceTreeHash,
    projectDefinitionHash: hashBytes(Buffer.from(lakefile, 'utf8')),
    probeSourceHash: hashBytes(Buffer.from(probeSource, 'utf8')),
    probeExitCode,
    productionAuthorityGranted: false,
    releaseIdentity,
    blockers: Object.freeze([...new Set(blockers)]),
  };
  return Object.freeze({
    ...payload,
    ciMathlibCacheReceiptHash: hashRecord('CiMathlibCacheReceipt', payload),
  });
}

export function prepareCiMathlibCacheAdapter({
  workspaceRoot,
  root = null,
  prepare = false,
  environment = process.env,
} = {}) {
  const paths = cachePaths({ workspaceRoot, root });
  const runLake = lakeRunner({ root: paths.root, environment });
  let receipt = inspectCache({ root: paths.root, runLake });
  if (prepare && receipt.status !== 'ci_mathlib_cache_verified') {
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(path.join(paths.root, 'lakefile.lean'), lakefile);
    fs.writeFileSync(
      path.join(paths.root, 'lean-toolchain'),
      `${PRODUCTION_LEAN_TOOLCHAIN}\n`,
    );
    fs.writeFileSync(path.join(paths.root, 'HeptaCiMathlib.lean'), probeSource);
    runLake(['update']);
    runLake(['exe', 'cache', 'get']);
    receipt = inspectCache({ root: paths.root, runLake });
  }
  return receipt;
}
