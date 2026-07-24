import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  PRODUCTION_LEAN_TOOLCHAIN,
  PRODUCTION_MATHLIB_RELEASES,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_EXECUTABLE = '/usr/bin/git';
const CRITICAL_SOURCE_PATHS = Object.freeze([
  'Mathlib.lean',
  'lakefile.lean',
  'lake-manifest.json',
  'lean-toolchain',
]);

const RELEASE_IDENTITY_KEYS = Object.freeze([
  'blockers',
  'criticalSourceFiles',
  'gitExecutableHash',
  'gitExecutableRealPath',
  'gitHeadRevision',
  'gitHeadTreeHash',
  'gitRemoteUrl',
  'kind',
  'manifestVersion',
  'mathlibManifestHash',
  'packageEntry',
  'packageSourcePath',
  'packagesDir',
  'productionMathlibReleaseIdentityHash',
  'releaseTag',
  'repositoryUrl',
  'revision',
  'sourceEvidenceHash',
  'sourceTreeHash',
  'status',
  'toolchain',
  'version',
]);

function productionPolicy(toolchain) {
  return PRODUCTION_MATHLIB_RELEASES[toolchain] || null;
}

function exactRecord(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (JSON.stringify(Object.keys(value).sort())
    !== JSON.stringify(Object.keys(expected).sort())) return false;
  return Object.entries(expected).every(([key, expectedValue]) => (
    JSON.stringify(value[key]) === JSON.stringify(expectedValue)
  ));
}

export function validateProductionMathlibManifest({
  manifest,
  toolchain = PRODUCTION_LEAN_TOOLCHAIN,
} = {}) {
  const blockers = [];
  const policy = productionPolicy(toolchain);
  if (!policy) blockers.push('production_mathlib_release_policy_required');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    blockers.push('production_mathlib_manifest_object_required');
  }
  if (policy && manifest?.version !== policy.manifestVersion) {
    blockers.push('production_mathlib_manifest_version_mismatch');
  }
  if (policy && manifest?.packagesDir !== policy.packagesDir) {
    blockers.push('production_mathlib_manifest_packages_dir_mismatch');
  }
  const entries = Array.isArray(manifest?.packages)
    ? manifest.packages.filter((entry) => entry?.name === 'mathlib')
    : [];
  if (entries.length !== 1) {
    blockers.push('production_mathlib_manifest_entry_required');
  }
  const packageEntry = entries[0] || null;
  if (policy && packageEntry && !exactRecord(packageEntry, policy.packageEntry)) {
    const expectedKeys = Object.keys(policy.packageEntry).sort();
    const actualKeys = Object.keys(packageEntry).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      blockers.push('production_mathlib_manifest_entry_field_set_mismatch');
    }
    for (const key of expectedKeys) {
      if (JSON.stringify(packageEntry[key])
        !== JSON.stringify(policy.packageEntry[key])) {
        blockers.push(`production_mathlib_manifest_entry_field_mismatch:${key}`);
      }
    }
  }
  return Object.freeze({
    valid: blockers.length === 0,
    policy,
    packageEntry,
    packageSourcePath: policy
      ? path.posix.join(policy.packagesDir, policy.packageEntry.name)
      : null,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function executeGit(spawnSyncImpl, packageRoot, args) {
  return spawnSyncImpl(GIT_EXECUTABLE, ['-C', packageRoot, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
  });
}

function commandText(result, blocker, blockers) {
  if (result?.error || result?.status !== 0) {
    blockers.push(blocker);
    return null;
  }
  return String(result.stdout || '').trim();
}

function criticalSourceFiles(packageRoot, blockers) {
  const files = [];
  for (const relativePath of CRITICAL_SOURCE_PATHS) {
    try {
      const candidate = path.join(packageRoot, relativePath);
      const before = fs.lstatSync(candidate, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('not_regular');
      const content = fs.readFileSync(candidate);
      const after = fs.lstatSync(candidate, { bigint: true });
      if (String(before.dev) !== String(after.dev)
        || String(before.ino) !== String(after.ino)
        || String(before.size) !== String(after.size)
        || String(before.mtimeNs) !== String(after.mtimeNs)) {
        throw new Error('changed_during_read');
      }
      files.push(Object.freeze({
        path: relativePath,
        hash: hashBytes(content),
        bytes: Number(after.size),
        posixMode: Number(after.mode & 0o777n),
      }));
    } catch (error) {
      blockers.push(`production_mathlib_critical_source_invalid:${relativePath}:${String(
        error?.message || error,
      )}`);
    }
  }
  return Object.freeze(files);
}

export function inspectProductionMathlibRelease({
  manifest,
  projectRoot,
  projectScopeRoot = projectRoot,
  toolchain = PRODUCTION_LEAN_TOOLCHAIN,
  spawnSyncImpl = spawnSync,
} = {}) {
  const validation = validateProductionMathlibManifest({ manifest, toolchain });
  const blockers = [...validation.blockers];
  const policy = validation.policy;
  let packageRoot = null;
  let packageSourcePath = validation.packageSourcePath;
  let gitHeadRevision = null;
  let gitHeadTreeHash = null;
  let gitRemoteUrl = null;
  let gitExecutableRealPath = null;
  let gitExecutableHash = null;
  let mathlibManifestHash = null;
  let sources = Object.freeze([]);
  if (validation.valid) {
    try {
      const canonicalProjectRoot = fs.realpathSync.native(path.resolve(projectRoot));
      const canonicalScopeRoot = fs.realpathSync.native(path.resolve(projectScopeRoot));
      const declaredPackageRoot = path.resolve(
        canonicalProjectRoot,
        ...validation.packageSourcePath.split('/'),
      );
      packageRoot = fs.realpathSync.native(declaredPackageRoot);
      if (!isPathWithin(canonicalScopeRoot, packageRoot)
        || !isPathWithin(canonicalProjectRoot, packageRoot)) {
        blockers.push('production_mathlib_package_path_outside_project');
      }
      packageSourcePath = path.relative(canonicalScopeRoot, packageRoot).replaceAll('\\', '/');
      const gitDirectory = path.join(packageRoot, '.git');
      const gitStat = fs.lstatSync(gitDirectory);
      if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
        blockers.push('production_mathlib_git_directory_required');
      }
      if (fs.existsSync(path.join(packageRoot, '.gitmodules'))) {
        blockers.push('production_mathlib_git_submodules_forbidden');
      }
      gitExecutableRealPath = fs.realpathSync.native(GIT_EXECUTABLE);
      gitExecutableHash = hashBytes(fs.readFileSync(gitExecutableRealPath));
      gitHeadRevision = commandText(executeGit(
        spawnSyncImpl, packageRoot, ['rev-parse', '--verify', 'HEAD^{commit}'],
      ), 'production_mathlib_git_head_unverified', blockers);
      gitHeadTreeHash = commandText(executeGit(
        spawnSyncImpl, packageRoot, ['rev-parse', 'HEAD^{tree}'],
      ), 'production_mathlib_git_tree_unverified', blockers);
      gitRemoteUrl = commandText(executeGit(
        spawnSyncImpl, packageRoot, ['remote', 'get-url', 'origin'],
      ), 'production_mathlib_git_remote_unverified', blockers);
      const topLevel = commandText(executeGit(
        spawnSyncImpl, packageRoot, ['rev-parse', '--show-toplevel'],
      ), 'production_mathlib_git_top_level_unverified', blockers);
      if (topLevel && fs.realpathSync.native(topLevel) !== packageRoot) {
        blockers.push('production_mathlib_git_top_level_mismatch');
      }
      const status = executeGit(
        spawnSyncImpl, packageRoot,
        ['status', '--porcelain=v1', '--untracked-files=all'],
      );
      if (status?.error || status?.status !== 0
        || String(status.stdout || '').trim() !== '') {
        blockers.push('production_mathlib_git_worktree_not_clean');
      }
      const diff = executeGit(
        spawnSyncImpl, packageRoot, ['diff-index', '--quiet', 'HEAD', '--'],
      );
      if (diff?.error || diff?.status !== 0) {
        blockers.push('production_mathlib_git_tracked_source_changed');
      }
      if (gitHeadRevision !== policy.revision) {
        blockers.push('production_mathlib_git_revision_mismatch');
      }
      if (gitHeadTreeHash !== policy.sourceTreeHash) {
        blockers.push('production_mathlib_git_tree_mismatch');
      }
      if (gitRemoteUrl !== policy.repositoryUrl) {
        blockers.push('production_mathlib_git_remote_mismatch');
      }
      sources = criticalSourceFiles(packageRoot, blockers);
      if (sources.length === CRITICAL_SOURCE_PATHS.length) {
        const toolchainFile = fs.readFileSync(
          path.join(packageRoot, 'lean-toolchain'), 'utf8',
        ).trim();
        if (toolchainFile !== toolchain) {
          blockers.push('production_mathlib_package_toolchain_mismatch');
        }
        const packageManifest = JSON.parse(fs.readFileSync(
          path.join(packageRoot, 'lake-manifest.json'), 'utf8',
        ));
        if (packageManifest?.name !== 'mathlib'
          || packageManifest?.version !== policy.manifestVersion) {
          blockers.push('production_mathlib_package_manifest_mismatch');
        }
        mathlibManifestHash = sources.find((file) => (
          file.path === 'lake-manifest.json'
        ))?.hash || null;
      }
      const postHeadRevision = commandText(executeGit(
        spawnSyncImpl, packageRoot, ['rev-parse', '--verify', 'HEAD^{commit}'],
      ), 'production_mathlib_git_head_reinspection_failed', blockers);
      const postHeadTreeHash = commandText(executeGit(
        spawnSyncImpl, packageRoot, ['rev-parse', 'HEAD^{tree}'],
      ), 'production_mathlib_git_tree_reinspection_failed', blockers);
      const postRemoteUrl = commandText(executeGit(
        spawnSyncImpl, packageRoot, ['remote', 'get-url', 'origin'],
      ), 'production_mathlib_git_remote_reinspection_failed', blockers);
      const postStatus = executeGit(
        spawnSyncImpl, packageRoot,
        ['status', '--porcelain=v1', '--untracked-files=all'],
      );
      const postDiff = executeGit(
        spawnSyncImpl, packageRoot, ['diff-index', '--quiet', 'HEAD', '--'],
      );
      if (postHeadRevision !== gitHeadRevision
        || postHeadTreeHash !== gitHeadTreeHash
        || postRemoteUrl !== gitRemoteUrl
        || postStatus?.error || postStatus?.status !== 0
        || String(postStatus?.stdout || '').trim() !== ''
        || postDiff?.error || postDiff?.status !== 0) {
        blockers.push('production_mathlib_source_changed_during_inspection');
      }
    } catch (error) {
      blockers.push(`production_mathlib_release_inspection_failed:${String(
        error?.message || error,
      )}`);
    }
  }
  const sourceEvidence = {
    gitHeadRevision,
    gitHeadTreeHash,
    gitRemoteUrl,
    criticalSourceFiles: sources,
    mathlibManifestHash,
  };
  const payload = {
    version: 1,
    kind: 'ProductionMathlibReleaseIdentity',
    status: blockers.length
      ? 'production_mathlib_release_blocked'
      : 'production_mathlib_release_verified',
    toolchain,
    manifestVersion: policy?.manifestVersion || null,
    packagesDir: policy?.packagesDir || null,
    packageEntry: policy?.packageEntry || null,
    packageSourcePath,
    releaseTag: policy?.releaseTag || null,
    repositoryUrl: policy?.repositoryUrl || null,
    revision: policy?.revision || null,
    sourceTreeHash: policy?.sourceTreeHash || null,
    gitHeadRevision,
    gitHeadTreeHash,
    gitRemoteUrl,
    gitExecutableRealPath,
    gitExecutableHash,
    criticalSourceFiles: sources,
    mathlibManifestHash,
    sourceEvidenceHash: hashRecord('ProductionMathlibSourceEvidence', sourceEvidence),
    blockers: Object.freeze([...new Set(blockers)]),
  };
  return Object.freeze({
    ...payload,
    productionMathlibReleaseIdentityHash: hashRecord(
      'ProductionMathlibReleaseIdentity', payload,
    ),
  });
}

export function verifyProductionMathlibReleaseIdentity(identity) {
  if (!identity || JSON.stringify(Object.keys(identity).sort())
    !== JSON.stringify([...RELEASE_IDENTITY_KEYS].sort())) return false;
  const policy = productionPolicy(identity.toolchain);
  const { productionMathlibReleaseIdentityHash, ...payload } = identity;
  const sourceEvidence = {
    gitHeadRevision: identity.gitHeadRevision,
    gitHeadTreeHash: identity.gitHeadTreeHash,
    gitRemoteUrl: identity.gitRemoteUrl,
    criticalSourceFiles: identity.criticalSourceFiles,
    mathlibManifestHash: identity.mathlibManifestHash,
  };
  return Boolean(policy)
    && identity.version === 1
    && identity.kind === 'ProductionMathlibReleaseIdentity'
    && identity.status === 'production_mathlib_release_verified'
    && identity.manifestVersion === policy.manifestVersion
    && identity.packagesDir === policy.packagesDir
    && exactRecord(identity.packageEntry, policy.packageEntry)
    && identity.releaseTag === policy.releaseTag
    && identity.repositoryUrl === policy.repositoryUrl
    && identity.revision === policy.revision
    && identity.sourceTreeHash === policy.sourceTreeHash
    && identity.gitHeadRevision === policy.revision
    && identity.gitHeadTreeHash === policy.sourceTreeHash
    && identity.gitRemoteUrl === policy.repositoryUrl
    && identity.gitExecutableRealPath === fs.realpathSync.native(GIT_EXECUTABLE)
    && SHA256.test(String(identity.gitExecutableHash || ''))
    && Array.isArray(identity.criticalSourceFiles)
    && identity.criticalSourceFiles.length === CRITICAL_SOURCE_PATHS.length
    && JSON.stringify(identity.criticalSourceFiles.map((file) => file.path))
      === JSON.stringify(CRITICAL_SOURCE_PATHS)
    && identity.criticalSourceFiles.every((file) => (
      SHA256.test(String(file.hash || ''))
      && Number.isSafeInteger(file.bytes) && file.bytes >= 0
      && Number.isInteger(file.posixMode)
    ))
    && SHA256.test(String(identity.mathlibManifestHash || ''))
    && identity.sourceEvidenceHash
      === hashRecord('ProductionMathlibSourceEvidence', sourceEvidence)
    && Array.isArray(identity.blockers) && identity.blockers.length === 0
    && productionMathlibReleaseIdentityHash
      === hashRecord('ProductionMathlibReleaseIdentity', payload);
}
