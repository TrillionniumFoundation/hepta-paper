import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { persistCampaignReleaseBundleSync, readCampaignReleaseBundleSync } from './campaign-release-repository.mjs';
import { ensureScopedDirectorySync } from '../runtime/scoped-file-materialization-repository.mjs';
import { fsyncDirectorySync } from '../runtime/durable-json-repository.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;

function safeSegment(value) {
  const raw = String(value || 'missing');
  const label = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100) || 'missing';
  const suffix = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${label}-${suffix}`;
}

function attemptRoot(runtimeRoot, category, campaign, packageNode) {
  if (!packageNode?.attemptId) throw new Error('campaign_release_package_attempt_id_required');
  return path.join(
    path.resolve(runtimeRoot),
    category,
    safeSegment(campaign?.campaignId),
    safeSegment(packageNode?.nodeId),
    safeSegment(packageNode.attemptId),
  );
}

export function campaignReleaseRootFor(runtimeRoot, campaign, packageNode) {
  return attemptRoot(runtimeRoot, 'campaign-releases', campaign, packageNode);
}

export function campaignReleasePackageRootFor(runtimeRoot, campaign, packageNode) {
  if (!packageNode?.attemptId) throw new Error('campaign_release_package_attempt_id_required');
  const label = String(campaign?.campaignId || 'campaign')
    .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 72) || 'campaign';
  const identity = JSON.stringify({
    campaignId: campaign?.campaignId,
    nodeId: packageNode?.nodeId,
    attemptId: packageNode.attemptId,
  });
  const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
  return path.join(path.resolve(runtimeRoot), 'packages', `${label}-${suffix}`);
}

export function campaignReleaseRebuildRootFor(runtimeRoot, campaign, packageNode) {
  return attemptRoot(runtimeRoot, 'campaign-release-rebuilds', campaign, packageNode);
}

export function initializeCampaignReleaseRootSync(runtimeRoot, releaseRoot) {
  return ensureScopedDirectorySync({
    scopeRoot: runtimeRoot,
    relative: path.relative(runtimeRoot, releaseRoot).replace(/\\/g, '/'),
  });
}

export function initializeCampaignReleasePackageScopeSync(runtimeRoot) {
  return ensureScopedDirectorySync({
    scopeRoot: runtimeRoot,
    relative: 'packages',
  });
}

function packageRelativePath(root, candidate) {
  return path.relative(root, candidate).replace(/\\/g, '/');
}

function expectedPackageTree(packageOutput, packageRoot) {
  const files = new Set();
  const directories = new Set();
  for (const file of packageOutput?.files || []) {
    const candidate = path.resolve(file?.path || '.');
    if (candidate === packageRoot || !isPathWithin(packageRoot, candidate)) continue;
    const relative = packageRelativePath(packageRoot, candidate);
    files.add(relative);
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }
  return { files, directories };
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function actualPackageTree(packageRoot, {
  sealDirectories = false,
  requireSealedDirectories = false,
  requireImmutableFiles = false,
} = {}) {
  const files = new Set();
  const directories = new Set();
  const rootIdentity = fs.lstatSync(packageRoot, { bigint: true });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()
    || fs.realpathSync(packageRoot) !== packageRoot) {
    throw new Error('campaign_release_package_output_root_unsafe');
  }
  const visit = (candidate, relative, initial) => {
    if (initial.isSymbolicLink() || (!initial.isDirectory() && !initial.isFile())) {
      throw new Error(`campaign_release_package_output_entry_unsafe:${relative || '.'}`);
    }
    let descriptor;
    try {
      descriptor = fs.openSync(
        candidate,
        fs.constants.O_RDONLY | (initial.isDirectory() ? DIRECTORY_ONLY : 0) | NO_FOLLOW,
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!sameFileIdentity(initial, opened)
        || initial.isDirectory() !== opened.isDirectory()
        || initial.isFile() !== opened.isFile()) {
        throw new Error(`campaign_release_package_output_entry_identity_changed:${relative || '.'}`);
      }
      if (opened.isDirectory()) {
        if (relative) directories.add(relative);
        const pinnedDirectory = `/proc/self/fd/${descriptor}`;
        for (const rawName of fs.readdirSync(pinnedDirectory, { encoding: 'buffer' })
          .sort((left, right) => Buffer.compare(left, right))) {
          const name = rawName.toString('utf8');
          if (!Buffer.from(name, 'utf8').equals(rawName)
            || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
            throw new Error('campaign_release_package_output_entry_name_invalid');
          }
          const child = path.join(pinnedDirectory, name);
          const childRelative = relative ? `${relative}/${name}` : name;
          visit(child, childRelative, fs.lstatSync(child, { bigint: true }));
        }
        if (sealDirectories) {
          fs.fchmodSync(descriptor, Number(opened.mode & 0o555n) | 0o500);
          fs.fsyncSync(descriptor);
        }
      } else if (opened.nlink === 1n
        && (!requireImmutableFiles || (Number(opened.mode) & 0o222) === 0)) {
        files.add(relative);
      } else {
        throw new Error(`campaign_release_package_output_entry_unsafe:${relative}`);
      }
      const completed = fs.fstatSync(descriptor, { bigint: true });
      const pathCompleted = fs.lstatSync(candidate, { bigint: true });
      if (!sameFileIdentity(opened, completed)
        || !sameFileIdentity(completed, pathCompleted)
        || ((sealDirectories || requireSealedDirectories)
          && completed.isDirectory()
          && (Number(completed.mode) & 0o222) !== 0)
        || (requireImmutableFiles && completed.isFile()
          && (Number(completed.mode) & 0o222) !== 0)) {
        throw new Error(`campaign_release_package_output_entry_changed:${relative || '.'}`);
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };
  visit(packageRoot, '', rootIdentity);
  const completedRoot = fs.lstatSync(packageRoot, { bigint: true });
  if (!sameFileIdentity(rootIdentity, completedRoot)) {
    throw new Error('campaign_release_package_output_root_identity_changed');
  }
  return { files, directories };
}

function assertPackageOutputRecordValid(packageOutput) {
  const {
    immutableCampaignPackageOutputHash: claimedHash,
    ...payload
  } = packageOutput || {};
  const files = Array.isArray(packageOutput?.files) ? packageOutput.files : [];
  const resolvedPaths = files.map((file) => path.resolve(file?.path || '.'));
  if (packageOutput?.version !== 1
    || packageOutput?.kind !== 'ImmutableCampaignPackageOutput'
    || packageOutput?.immutable !== true
    || !/^sha256:[0-9a-f]{64}$/.test(String(claimedHash || ''))
    || hashRecord('ImmutableCampaignPackageOutput', payload) !== claimedHash
    || files.length < 1 || files.length !== Number(packageOutput?.fileCount)
    || new Set(resolvedPaths).size !== files.length) {
    throw new Error('campaign_release_package_output_record_invalid');
  }
}

function assertReadOnlyDeclaredFileSync(candidate) {
  let descriptor;
  try {
    const before = fs.lstatSync(candidate, { bigint: true });
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(candidate, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n
      || (Number(opened.mode) & 0o222) !== 0
      || !sameFileIdentity(before, opened)
      || !sameFileIdentity(opened, after)) {
      throw new Error('campaign_release_package_output_file_not_immutable');
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertExactPackageTreeSync(packageOutput, packageRoot) {
  const expected = expectedPackageTree(packageOutput, packageRoot);
  const actual = actualPackageTree(packageRoot);
  const sameSet = (left, right) => left.size === right.size
    && [...left].every((item) => right.has(item));
  if (!sameSet(expected.files, actual.files)
    || !sameSet(expected.directories, actual.directories)) {
    throw new Error('campaign_release_package_output_exact_tree_invalid');
  }
}

export function assertImmutableCampaignPackageFilesSync(packageOutput, runtimeRoot) {
  const releaseRoot = path.resolve(packageOutput?.releaseRoot || '.');
  const packageRoot = path.resolve(packageOutput?.packageDir || '.');
  if (!isPathWithin(runtimeRoot, releaseRoot)) throw new Error('campaign_release_package_output_runtime_escape');
  if (!isPathWithin(runtimeRoot, packageRoot)) throw new Error('campaign_release_package_output_runtime_escape');
  for (const file of packageOutput?.files || []) {
    const candidate = path.resolve(file.path || '.');
    const inReleaseRoot = candidate !== releaseRoot && isPathWithin(releaseRoot, candidate);
    const inPackageRoot = candidate !== packageRoot && isPathWithin(packageRoot, candidate);
    if (!inReleaseRoot && !inPackageRoot) {
      throw new Error(`campaign_release_package_output_file_escape:${file.role || 'unknown'}`);
    }
    const read = readScopedFileSync({
      scopeRoot: inPackageRoot ? packageRoot : releaseRoot,
      candidate,
    });
    if (read.status !== 'scoped_file_read_verified' || read.hash !== file.hash
      || Number(read.bytes) !== Number(file.bytes)) {
      throw new Error(`campaign_release_package_output_file_invalid:${file.role || 'unknown'}`);
    }
  }
  assertExactPackageTreeSync(packageOutput, packageRoot);
}

export function sealImmutableCampaignPackageDirectoriesSync(packageOutput, runtimeRoot) {
  const packageRoot = path.resolve(packageOutput?.packageDir || '.');
  assertImmutableCampaignPackageFilesSync(packageOutput, runtimeRoot);
  actualPackageTree(packageRoot, { sealDirectories: true });
  assertImmutableCampaignPackageFilesSync(packageOutput, runtimeRoot);
}

export function assertSealedImmutableCampaignPackageFilesSync(
  packageOutput,
  runtimeRoot,
) {
  assertPackageOutputRecordValid(packageOutput);
  assertImmutableCampaignPackageFilesSync(packageOutput, runtimeRoot);
  const packageRoot = path.resolve(packageOutput.packageDir);
  actualPackageTree(packageRoot, {
    requireSealedDirectories: true,
    requireImmutableFiles: true,
  });
  for (const file of packageOutput.files) {
    assertReadOnlyDeclaredFileSync(path.resolve(file.path));
  }
}

export function readCampaignReleaseMaterializationSync({ runtimeRoot, releaseRoot }) {
  return readCampaignReleaseBundleSync({ runtimeRoot, releaseRoot });
}

export function persistCampaignReleaseMaterializationSync({ runtimeRoot, releaseRoot, bundle }) {
  sealImmutableCampaignPackageDirectoriesSync(bundle?.packageOutput, runtimeRoot);
  return persistCampaignReleaseBundleSync({ runtimeRoot, releaseRoot, bundle });
}

export function fsyncCampaignReleasePackageDirectorySync(packageDir) {
  fsyncDirectorySync(packageDir);
}
