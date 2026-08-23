import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  inspectScopedPathSync,
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { ensureScopedDirectorySync } from '../runtime/scoped-file-materialization-repository.mjs';
import { fsyncDirectorySync } from '../runtime/durable-json-repository.mjs';

// Linux-only durable publication primitives for campaign release packages.

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;
const NO_CLOBBER_MOVE_EXECUTABLE = '/usr/bin/mv';
const PACKAGE_GENERATION_LOCK_EXECUTABLE = '/usr/bin/flock';
const PACKAGE_GENERATION_LOCK_DESCRIPTOR_IN_CHILD = 3;
const MAXIMUM_PACKAGE_GENERATION_LOCK_PROBE_TIMEOUT_MS = 10_000;
export const CAMPAIGN_RELEASE_PACKAGE_GENERATION_LOCK_NAME =
  '.CAMPAIGN_RELEASE_PACKAGE_GENERATION.lock';
const PREPARED_TRANSACTION_NAME = 'CAMPAIGN_RELEASE_PACKAGE_PREPARED.json';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_BUNDLE_BYTES = 32 * 1024 * 1024;

export function campaignReleasePackageTransactionError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

export function pathEntryExistsNoFollow(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function durableIdentity(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
  });
}

export function sameDurableIdentity(stat, expected) {
  return Boolean(expected)
    && String(stat?.dev) === expected.device
    && String(stat?.ino) === expected.inode
    && String(stat?.mode) === expected.mode;
}

export function sameDurableNodeIdentity(stat, expected) {
  return Boolean(expected)
    && String(stat?.dev) === expected.device
    && String(stat?.ino) === expected.inode;
}

function trustedNoClobberMoveExecutable(stat) {
  return stat.isFile() && !stat.isSymbolicLink()
    && stat.uid === 0n && stat.gid === 0n && stat.nlink === 1n
    && (stat.mode & 0o022n) === 0n;
}

export function openPinnedScopedDirectory(runtimeRoot, directory, code) {
  const root = path.resolve(runtimeRoot);
  const selected = path.resolve(directory);
  const inspection = inspectScopedPathSync({
    scopeRoot: root,
    candidate: selected,
    expect: 'directory',
    forbidHardlinks: false,
  });
  if (inspection.status !== 'scoped_file_identity_verified') {
    throw campaignReleasePackageTransactionError(code, {
      blockers: inspection.blockers,
    });
  }
  let descriptor;
  try {
    descriptor = fs.openSync(
      selected,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory()
      || !sameDurableIdentity(opened, {
        device: inspection.identity.device,
        inode: inspection.identity.inode,
        mode: inspection.identity.mode,
      })) {
      throw campaignReleasePackageTransactionError(code);
    }
    return Object.freeze({
      descriptor,
      identity: durableIdentity(opened),
      path: selected,
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error?.code === code) throw error;
    throw campaignReleasePackageTransactionError(code, { cause: error });
  }
}

export function assertPinnedDirectoryCurrent(opened, code) {
  let selected;
  let descriptor;
  try {
    selected = fs.lstatSync(opened.path, { bigint: true });
    descriptor = fs.fstatSync(opened.descriptor, { bigint: true });
  } catch (error) {
    throw campaignReleasePackageTransactionError(code, { cause: error });
  }
  if (!selected.isDirectory() || selected.isSymbolicLink()
    || !descriptor.isDirectory()
    || !sameDurableIdentity(selected, opened.identity)
    || !sameDurableIdentity(descriptor, opened.identity)) {
    throw campaignReleasePackageTransactionError(code);
  }
}

export function descriptorEntryPath(descriptor, name) {
  return `/proc/self/fd/${descriptor}/${name}`;
}

export function acquireCampaignReleasePackageGenerationLockHandleSync({
  runtimeRoot,
  releaseRoot,
  lockProbeTimeoutMs = MAXIMUM_PACKAGE_GENERATION_LOCK_PROBE_TIMEOUT_MS,
} = {}) {
  const root = path.resolve(runtimeRoot || '.');
  const release = path.resolve(releaseRoot || '.');
  const nodeRoot = path.dirname(release);
  if (!isPathWithin(root, nodeRoot)) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_generation_lock_invalid',
    );
  }
  const selectedProbeTimeoutMs = Number(lockProbeTimeoutMs);
  if (!Number.isSafeInteger(selectedProbeTimeoutMs) || selectedProbeTimeoutMs < 1) {
    throw campaignReleasePackageTransactionError('campaign_release_package_generation_lock_probe_timeout_invalid');
  }
  const probeTimeoutMs = Math.min(MAXIMUM_PACKAGE_GENERATION_LOCK_PROBE_TIMEOUT_MS, selectedProbeTimeoutMs);
  const executable = fs.lstatSync(PACKAGE_GENERATION_LOCK_EXECUTABLE, {
    bigint: true,
  });
  if (!executable.isFile() || executable.isSymbolicLink()
    || executable.uid !== 0n || executable.gid !== 0n
    || executable.nlink !== 1n || (executable.mode & 0o022n) !== 0n) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_generation_lock_backend_invalid',
    );
  }
  const openedParent = openPinnedScopedDirectory(
    root,
    nodeRoot,
    'campaign_release_package_generation_lock_invalid',
  );
  let descriptor;
  try {
    const candidate = descriptorEntryPath(
      openedParent.descriptor,
      CAMPAIGN_RELEASE_PACKAGE_GENERATION_LOCK_NAME,
    );
    let existed = true;
    try { fs.lstatSync(candidate); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      existed = false;
    }
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDWR | fs.constants.O_CREAT | NO_FOLLOW,
      0o600,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const selected = fs.lstatSync(candidate, { bigint: true });
    const owner = typeof process.geteuid === 'function' ? process.geteuid() : null;
    if (!opened.isFile() || !selected.isFile() || selected.isSymbolicLink()
      || !sameDurableNodeIdentity(opened, durableIdentity(selected))
      || opened.nlink !== 1n || selected.nlink !== 1n
      || (opened.mode & 0o7777n) !== 0o600n || opened.size !== 0n
      || (owner !== null && Number(opened.uid) !== owner)) {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_generation_lock_invalid',
      );
    }
    if (!existed) fs.fsyncSync(openedParent.descriptor);
    assertPinnedDirectoryCurrent(
      openedParent,
      'campaign_release_package_generation_lock_invalid',
    );
    const acquired = spawnSync(PACKAGE_GENERATION_LOCK_EXECUTABLE, [
      '--exclusive',
      '--nonblock',
      String(PACKAGE_GENERATION_LOCK_DESCRIPTOR_IN_CHILD),
    ], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe', descriptor],
      timeout: probeTimeoutMs,
      maxBuffer: 16 * 1024,
    });
    if (acquired.status === 1 && !acquired.error && !acquired.signal) {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_generation_lock_unavailable',
      );
    }
    if (acquired.error?.code === 'ETIMEDOUT') {
      throw campaignReleasePackageTransactionError('campaign_release_package_generation_lock_probe_timeout');
    }
    if (acquired.error || acquired.signal || acquired.status !== 0
      || acquired.stdout || acquired.stderr) {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_generation_lock_acquisition_failed',
      );
    }
    const assertHeld = () => {
      const held = fs.fstatSync(descriptor, { bigint: true });
      const atPath = fs.lstatSync(candidate, { bigint: true });
      assertPinnedDirectoryCurrent(
        openedParent,
        'campaign_release_package_generation_lock_identity_changed',
      );
      if (!sameDurableNodeIdentity(held, durableIdentity(opened))
        || !sameDurableNodeIdentity(atPath, durableIdentity(opened))
        || atPath.nlink !== 1n) {
        throw campaignReleasePackageTransactionError(
          'campaign_release_package_generation_lock_identity_changed',
        );
      }
    };
    assertHeld();
    return Object.freeze({
      assertHeld,
      release: () => {
        if (descriptor === undefined) return false;
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.closeSync(openedParent.descriptor);
        return true;
      },
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.closeSync(openedParent.descriptor);
    throw error;
  }
}

export function withCampaignReleasePackageGenerationLockSync(
  scope,
  operation,
) {
  if (typeof operation !== 'function') {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_generation_lock_operation_required',
    );
  }
  const handle = acquireCampaignReleasePackageGenerationLockHandleSync(scope);
  try {
    handle.assertHeld();
    const value = operation(Object.freeze({ assertHeld: handle.assertHeld }));
    if (value && typeof value.then === 'function') {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_generation_lock_async_operation_forbidden',
      );
    }
    handle.assertHeld();
    return value;
  } finally {
    handle.release();
  }
}

function entryStatNoFollow(directory, name) {
  try {
    return fs.lstatSync(descriptorEntryPath(directory.descriptor, name), {
      bigint: true,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function moveEntryNoClobberSync({
  runtimeRoot,
  sourceParent,
  sourceName,
  targetParent,
  targetName,
  expectedSourceIdentity,
  sourceKind,
  collisionCode,
  invalidCode,
}) {
  if (path.basename(sourceName) !== sourceName
    || path.basename(targetName) !== targetName
    || sourceName === '.' || sourceName === '..'
    || targetName === '.' || targetName === '..') {
    throw campaignReleasePackageTransactionError(invalidCode);
  }
  let sourceDirectory;
  let targetDirectory;
  let executableDescriptor;
  try {
    sourceDirectory = openPinnedScopedDirectory(
      runtimeRoot,
      sourceParent,
      invalidCode,
    );
    targetDirectory = openPinnedScopedDirectory(
      runtimeRoot,
      targetParent,
      invalidCode,
    );
    const sourceBefore = entryStatNoFollow(sourceDirectory, sourceName);
    if (!sourceBefore || sourceBefore.isSymbolicLink()
      || (sourceKind === 'directory' && !sourceBefore.isDirectory())
      || (sourceKind === 'file' && (!sourceBefore.isFile()
        || Number(sourceBefore.nlink) !== 1))
      || !sameDurableIdentity(sourceBefore, expectedSourceIdentity)) {
      throw campaignReleasePackageTransactionError(invalidCode);
    }
    const selectedExecutable = fs.lstatSync(
      NO_CLOBBER_MOVE_EXECUTABLE,
      { bigint: true },
    );
    if (!trustedNoClobberMoveExecutable(selectedExecutable)) {
      throw campaignReleasePackageTransactionError(invalidCode);
    }
    executableDescriptor = fs.openSync(
      NO_CLOBBER_MOVE_EXECUTABLE,
      fs.constants.O_RDONLY | NO_FOLLOW,
    );
    const openedExecutable = fs.fstatSync(executableDescriptor, {
      bigint: true,
    });
    if (!trustedNoClobberMoveExecutable(openedExecutable)
      || !sameDurableIdentity(
        openedExecutable,
        durableIdentity(selectedExecutable),
      )) {
      throw campaignReleasePackageTransactionError(invalidCode);
    }
    const result = spawnSync(NO_CLOBBER_MOVE_EXECUTABLE, [
      '-n', '--no-copy', '-T', '--',
      `/proc/self/fd/3/${sourceName}`,
      `/proc/self/fd/4/${targetName}`,
    ], {
      encoding: 'utf8',
      env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      stdio: [
        'ignore', 'pipe', 'pipe',
        sourceDirectory.descriptor,
        targetDirectory.descriptor,
      ],
      timeout: 10_000,
      windowsHide: true,
    });
    assertPinnedDirectoryCurrent(sourceDirectory, invalidCode);
    assertPinnedDirectoryCurrent(targetDirectory, invalidCode);
    const selectedExecutableAfter = fs.lstatSync(
      NO_CLOBBER_MOVE_EXECUTABLE,
      { bigint: true },
    );
    const openedExecutableAfter = fs.fstatSync(executableDescriptor, {
      bigint: true,
    });
    if (!trustedNoClobberMoveExecutable(selectedExecutableAfter)
      || !trustedNoClobberMoveExecutable(openedExecutableAfter)
      || !sameDurableIdentity(
        selectedExecutableAfter,
        durableIdentity(selectedExecutable),
      )
      || !sameDurableIdentity(
        openedExecutableAfter,
        durableIdentity(selectedExecutable),
      )) {
      throw campaignReleasePackageTransactionError(invalidCode);
    }
    fs.fsyncSync(sourceDirectory.descriptor);
    fs.fsyncSync(targetDirectory.descriptor);
    const sourceAfter = entryStatNoFollow(sourceDirectory, sourceName);
    const targetAfter = entryStatNoFollow(targetDirectory, targetName);
    if (!sourceAfter && targetAfter
      && sameDurableIdentity(targetAfter, expectedSourceIdentity)) {
      return Object.freeze({ published: true, moveResult: result });
    }
    if (sourceAfter && sameDurableIdentity(sourceAfter, expectedSourceIdentity)
      && targetAfter
      && !sameDurableIdentity(targetAfter, expectedSourceIdentity)) {
      return Object.freeze({
        published: false,
        collision: true,
        moveResult: result,
      });
    }
    if (sourceAfter && sameDurableIdentity(sourceAfter, expectedSourceIdentity)
      && !targetAfter) {
      throw campaignReleasePackageTransactionError(invalidCode, {
        moveResult: result,
      });
    }
    throw campaignReleasePackageTransactionError(
      targetAfter ? collisionCode : invalidCode,
      { moveResult: result },
    );
  } finally {
    if (executableDescriptor !== undefined) fs.closeSync(executableDescriptor);
    if (sourceDirectory?.descriptor !== undefined) {
      fs.closeSync(sourceDirectory.descriptor);
    }
    if (targetDirectory?.descriptor !== undefined) {
      fs.closeSync(targetDirectory.descriptor);
    }
  }
}

function preparedTransactionPath(releaseRoot) {
  return path.join(path.resolve(releaseRoot), PREPARED_TRANSACTION_NAME);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertPreparedTransactionRecord(record, { runtimeRoot, releaseRoot }) {
  const root = path.resolve(runtimeRoot || '.');
  const release = path.resolve(releaseRoot || '.');
  const {
    campaignReleasePackagePreparedTransactionHash: claimedHash,
    ...payload
  } = record || {};
  const publishedPackageDir = path.resolve(record?.packageDir || '.');
  const preparedPackageDir = path.resolve(record?.preparedPackageDir || '.');
  if (record?.version !== 1
    || record?.kind !== 'CampaignReleasePackagePreparedTransaction'
    || record?.status !== 'campaign_release_package_prepared'
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('CampaignReleasePackagePreparedTransaction', payload)
      !== claimedHash
    || !SHA256.test(String(record?.bundleContentHash || ''))
    || hashBytes(jsonBytes(record?.bundle)) !== record.bundleContentHash
    || jsonBytes(record?.bundle).length > MAXIMUM_BUNDLE_BYTES
    || !SHA256.test(String(record?.campaignReleaseBundleHash || ''))
    || record.campaignReleaseBundleHash
      !== record?.bundle?.campaignReleaseBundleHash
    || path.resolve(record?.bundle?.packageOutput?.releaseRoot || '.') !== release
    || path.resolve(record?.bundle?.packageOutput?.packageDir || '.')
      !== publishedPackageDir
    || !isPathWithin(root, release)
    || !isPathWithin(root, publishedPackageDir)
    || !isPathWithin(path.dirname(publishedPackageDir), preparedPackageDir)
    || path.dirname(path.dirname(preparedPackageDir))
      !== path.dirname(publishedPackageDir)
    || path.basename(preparedPackageDir) !== path.basename(publishedPackageDir)
    || !record?.preparedPackageIdentity?.device
    || !record?.preparedPackageIdentity?.inode
    || !record?.preparedPackageIdentity?.mode) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_prepared_transaction_invalid',
    );
  }
  return Object.freeze({
    record: Object.freeze(record),
    path: preparedTransactionPath(release),
    preparedPackageDir,
    publishedPackageDir,
  });
}

export function readCampaignReleasePackagePreparedTransactionSync({
  runtimeRoot,
  releaseRoot,
} = {}) {
  const candidate = preparedTransactionPath(releaseRoot);
  if (!pathEntryExistsNoFollow(candidate)) return null;
  const read = readScopedFileSync({
    scopeRoot: path.resolve(runtimeRoot),
    candidate,
    maximumBytes: 64 * 1024 * 1024,
  });
  if (read.status !== 'scoped_file_read_verified') {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_prepared_transaction_invalid',
      { blockers: read.blockers },
    );
  }
  let record;
  try {
    record = JSON.parse(read.content.toString('utf8'));
  } catch (cause) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_prepared_transaction_invalid',
      { cause },
    );
  }
  return Object.freeze({
    ...assertPreparedTransactionRecord(record, { runtimeRoot, releaseRoot }),
    contentHash: read.hash,
    bytes: read.bytes,
  });
}

function writePreparedTransactionSync({ runtimeRoot, releaseRoot, record }) {
  const release = path.resolve(releaseRoot);
  const bytes = jsonBytes(record);
  const expectedHash = hashBytes(bytes);
  const temporaryName = `.${PREPARED_TRANSACTION_NAME}.tmp-${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
  const temporary = path.join(release, temporaryName);
  let descriptor;
  let temporaryIdentity;
  try {
    const openedRelease = openPinnedScopedDirectory(
      runtimeRoot,
      release,
      'campaign_release_package_prepared_transaction_invalid',
    );
    try {
      descriptor = fs.openSync(
        descriptorEntryPath(openedRelease.descriptor, temporaryName),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | NO_FOLLOW,
        0o444,
      );
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n) {
        throw campaignReleasePackageTransactionError(
          'campaign_release_package_prepared_transaction_invalid',
        );
      }
      temporaryIdentity = durableIdentity(opened);
      assertPinnedDirectoryCurrent(
        openedRelease,
        'campaign_release_package_prepared_transaction_invalid',
      );
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.closeSync(openedRelease.descriptor);
      descriptor = undefined;
    }
    const moved = moveEntryNoClobberSync({
      runtimeRoot,
      sourceParent: release,
      sourceName: temporaryName,
      targetParent: release,
      targetName: PREPARED_TRANSACTION_NAME,
      expectedSourceIdentity: temporaryIdentity,
      sourceKind: 'file',
      collisionCode: 'campaign_release_package_prepared_transaction_collision',
      invalidCode: 'campaign_release_package_prepared_transaction_invalid',
    });
    if (moved.collision) {
      const existing = readCampaignReleasePackagePreparedTransactionSync({
        runtimeRoot,
        releaseRoot,
      });
      if (existing?.contentHash !== expectedHash) {
        throw campaignReleasePackageTransactionError(
          'campaign_release_package_prepared_transaction_collision',
        );
      }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (pathEntryExistsNoFollow(temporary)) {
      const remaining = fs.lstatSync(temporary, { bigint: true });
      if (!sameDurableIdentity(remaining, temporaryIdentity)) {
        throw campaignReleasePackageTransactionError(
          'campaign_release_package_prepared_transaction_invalid',
        );
      }
      fs.unlinkSync(temporary);
      fsyncDirectorySync(release);
    }
  }
  const prepared = readCampaignReleasePackagePreparedTransactionSync({
    runtimeRoot,
    releaseRoot,
  });
  if (!prepared || prepared.contentHash !== expectedHash) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_prepared_transaction_invalid',
    );
  }
  return prepared;
}

export function prepareCampaignReleasePackageDirectorySync({
  runtimeRoot,
  releaseRoot,
  packageDir,
} = {}) {
  const root = path.resolve(runtimeRoot || '.');
  const release = path.resolve(releaseRoot || '.');
  const publishedPackageDir = path.resolve(packageDir || '.');
  if (!isPathWithin(root, release)
    || !isPathWithin(root, publishedPackageDir)
    || path.resolve(root) === release
    || path.resolve(root) === publishedPackageDir
    || pathEntryExistsNoFollow(preparedTransactionPath(release))) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_preparation_scope_invalid',
    );
  }
  if (pathEntryExistsNoFollow(publishedPackageDir)) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_publication_collision',
    );
  }
  const publishedParent = path.dirname(publishedPackageDir);
  if (!isPathWithin(root, publishedParent)
    || !pathEntryExistsNoFollow(publishedParent)) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_preparation_scope_invalid',
    );
  }
  const publishedParentStat = fs.lstatSync(publishedParent, { bigint: true });
  if (!publishedParentStat.isDirectory() || publishedParentStat.isSymbolicLink()) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_preparation_scope_invalid',
    );
  }
  const preparedParent = path.join(
    publishedParent,
    `.package-prepared-${process.pid}-${crypto.randomBytes(12).toString('hex')}`,
  );
  ensureScopedDirectorySync({
    scopeRoot: root,
    relative: path.relative(root, preparedParent).replace(/\\/g, '/'),
  });
  const preparedParentStat = fs.lstatSync(preparedParent, { bigint: true });
  if (!preparedParentStat.isDirectory() || preparedParentStat.isSymbolicLink()
    || preparedParentStat.dev !== publishedParentStat.dev) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_preparation_cross_device',
    );
  }
  return Object.freeze({
    packageDir: publishedPackageDir,
    preparedPackageDir: path.join(
      preparedParent,
      path.basename(publishedPackageDir),
    ),
    preparedParent,
  });
}

export function writeCampaignReleasePackagePreparedTransactionSync({
  runtimeRoot,
  releaseRoot,
  bundle,
  preparedPackageDir,
} = {}) {
  if (jsonBytes(bundle).length > MAXIMUM_BUNDLE_BYTES) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_prepared_transaction_invalid',
    );
  }
  const packageIdentity = fs.lstatSync(preparedPackageDir, { bigint: true });
  if (!packageIdentity.isDirectory() || packageIdentity.isSymbolicLink()) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_prepared_transaction_invalid',
    );
  }
  const payload = {
    version: 1,
    kind: 'CampaignReleasePackagePreparedTransaction',
    status: 'campaign_release_package_prepared',
    campaignReleaseBundleHash: bundle.campaignReleaseBundleHash,
    bundleContentHash: hashBytes(jsonBytes(bundle)),
    packageDir: path.resolve(bundle.packageOutput.packageDir),
    preparedPackageDir: path.resolve(preparedPackageDir),
    preparedPackageIdentity: durableIdentity(packageIdentity),
    bundle,
  };
  const record = Object.freeze({
    ...payload,
    campaignReleasePackagePreparedTransactionHash: hashRecord(
      'CampaignReleasePackagePreparedTransaction',
      payload,
    ),
  });
  assertPreparedTransactionRecord(record, { runtimeRoot, releaseRoot });
  return writePreparedTransactionSync({ runtimeRoot, releaseRoot, record });
}

export function publishCampaignReleasePreparedPackageSync({
  runtimeRoot,
  prepared,
} = {}) {
  const preparedStat = pathEntryExistsNoFollow(prepared.preparedPackageDir)
    ? fs.lstatSync(prepared.preparedPackageDir, { bigint: true }) : null;
  const publishedStat = pathEntryExistsNoFollow(prepared.publishedPackageDir)
    ? fs.lstatSync(prepared.publishedPackageDir, { bigint: true }) : null;
  if (preparedStat && publishedStat) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_publication_collision',
    );
  }
  if (preparedStat) {
    if (!sameDurableNodeIdentity(
      preparedStat,
      prepared.record.preparedPackageIdentity,
    )) {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_prepared_transaction_invalid',
      );
    }
    const moved = moveEntryNoClobberSync({
      runtimeRoot,
      sourceParent: path.dirname(prepared.preparedPackageDir),
      sourceName: path.basename(prepared.preparedPackageDir),
      targetParent: path.dirname(prepared.publishedPackageDir),
      targetName: path.basename(prepared.publishedPackageDir),
      expectedSourceIdentity: durableIdentity(preparedStat),
      sourceKind: 'directory',
      collisionCode: 'campaign_release_package_publication_collision',
      invalidCode: 'campaign_release_package_publication_invalid',
    });
    if (moved.collision) {
      throw campaignReleasePackageTransactionError(
        'campaign_release_package_publication_collision',
      );
    }
    return Object.freeze({ status: 'campaign_release_package_published' });
  }
  if (!publishedStat || !sameDurableNodeIdentity(
    publishedStat,
    prepared.record.preparedPackageIdentity,
  )) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_prepared_transaction_invalid',
    );
  }
  return Object.freeze({ status: 'campaign_release_package_already_published' });
}
