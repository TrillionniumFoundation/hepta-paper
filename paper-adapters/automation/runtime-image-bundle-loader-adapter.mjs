import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { inspectDockerRuntimeImageManifest } from './docker-runtime-image-manifest-inspection.mjs';
import { inspectPinnedRuntimeImageOciArchive } from './r-runtime-bootstrap-adapter.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from './runtime-image-registry.mjs';
import { restrictedChildEnvironment } from './bounded-child-process.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const LOCAL_DOCKER_HOST = 'unix:///var/run/docker.sock';
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const REQUIRED_PROFILE_LAYOUT = Object.freeze([
  Object.freeze({ profile: 'python', archiveName: 'python-scientific.oci.tar' }),
  Object.freeze({ profile: 'pythonGpu', archiveName: 'python-gpu.oci.tar' }),
  Object.freeze({ profile: 'r', archiveName: 'r-scientific.oci.tar' }),
]);

export const PINNED_RUNTIME_IMAGE_BUNDLE_PROFILES = Object.freeze(
  REQUIRED_PROFILE_LAYOUT.map(({ profile, archiveName }) => Object.freeze({
    profile,
    archiveName,
    runtime: AUTOMATION_RUNTIME_IMAGES[profile],
  })),
);

function localDockerEnvironment(environment) {
  if (environment?.DOCKER_CONTEXT
    || (environment?.DOCKER_HOST && environment.DOCKER_HOST !== LOCAL_DOCKER_HOST)) {
    throw new Error('runtime_image_bundle_loader_remote_docker_endpoint_forbidden');
  }
  return restrictedChildEnvironment({
    source: environment,
    overrides: { DOCKER_HOST: LOCAL_DOCKER_HOST },
  });
}

function command({
  executable,
  args,
  spawnSyncImpl,
  environment,
  timeoutMs,
  maximumBytes = 64 * 1024 * 1024,
}) {
  const result = spawnSyncImpl(executable, args, {
    cwd: REPOSITORY_ROOT,
    encoding: null,
    timeout: timeoutMs,
    maxBuffer: maximumBytes,
    env: { ...environment },
  });
  if (result?.status !== 0 || result?.error || result?.signal) {
    const detail = Buffer.from(result?.stderr || result?.error?.message || result?.signal || '')
      .toString('utf8').slice(-2_000).replaceAll(/\s+/g, ' ').trim();
    throw new Error(
      `runtime_image_bundle_loader_command_failed:${executable}:${args[0]}:${detail}`,
    );
  }
  return Buffer.from(result.stdout || '');
}

function assertProfileLayout(profiles) {
  if (!Array.isArray(profiles) || profiles.length !== REQUIRED_PROFILE_LAYOUT.length) {
    throw new Error('runtime_image_bundle_loader_profile_set_invalid');
  }
  for (const required of REQUIRED_PROFILE_LAYOUT) {
    const candidate = profiles.find((entry) => entry?.profile === required.profile);
    if (!candidate || candidate.archiveName !== required.archiveName
      || !String(candidate.runtime?.image || '')
      || !SHA256.test(String(candidate.runtime?.imageDigest || ''))) {
      throw new Error(`runtime_image_bundle_loader_profile_invalid:${required.profile}`);
    }
  }
}

function archiveFilesystemIdentity(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: Number(stat.mode & 0o777n),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    linkCount: String(stat.nlink),
  });
}

function sameArchiveIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid
    && left.size === right.size && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}

function inspectBundleRoot(bundleRoot, profiles) {
  if (!path.isAbsolute(String(bundleRoot || ''))) {
    throw new Error('runtime_image_bundle_loader_root_absolute_required');
  }
  const resolvedRoot = path.resolve(String(bundleRoot));
  const rootStat = fs.lstatSync(resolvedRoot, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()
    || fs.realpathSync(resolvedRoot) !== resolvedRoot) {
    throw new Error('runtime_image_bundle_loader_root_real_directory_required');
  }
  const archives = profiles.map((entry) => {
    const archivePath = path.join(resolvedRoot, entry.archiveName);
    const archiveStat = fs.lstatSync(archivePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (!archiveStat?.isFile() || archiveStat.isSymbolicLink()
      || archiveStat.nlink !== 1n || archiveStat.size <= 0n
      || archiveStat.size > BigInt(Number.MAX_SAFE_INTEGER)
      || fs.realpathSync(archivePath) !== archivePath) {
      throw new Error(
        `runtime_image_bundle_loader_archive_regular_file_required:${entry.profile}`,
      );
    }
    return Object.freeze({
      ...entry,
      archivePath,
      archiveBytes: Number(archiveStat.size),
      sourceFilesystemIdentity: archiveFilesystemIdentity(archiveStat),
    });
  });
  return Object.freeze({ bundleRoot: resolvedRoot, archives: Object.freeze(archives) });
}

function copyArchiveToStableSnapshot(entry, snapshotRoot) {
  const snapshotPath = path.join(snapshotRoot, entry.archiveName);
  let sourceDescriptor = null;
  let snapshotDescriptor = null;
  try {
    sourceDescriptor = fs.openSync(
      entry.archivePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const sourceBefore = fs.fstatSync(sourceDescriptor, { bigint: true });
    if (!sourceBefore.isFile() || sourceBefore.nlink !== 1n
      || !sameArchiveIdentity(sourceBefore, fs.lstatSync(entry.archivePath, { bigint: true }))) {
      throw new Error(`runtime_image_bundle_loader_archive_snapshot_source_invalid:${entry.profile}`);
    }
    snapshotDescriptor = fs.openSync(
      snapshotPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let copiedBytes = 0;
    while (true) {
      const bytesRead = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(
          snapshotDescriptor,
          buffer,
          written,
          bytesRead - written,
        );
      }
      copiedBytes += bytesRead;
    }
    fs.fsyncSync(snapshotDescriptor);
    const sourceAfter = fs.fstatSync(sourceDescriptor, { bigint: true });
    const currentPathStat = fs.lstatSync(entry.archivePath, { bigint: true });
    if (!sameArchiveIdentity(sourceBefore, sourceAfter)
      || !sameArchiveIdentity(sourceAfter, currentPathStat)
      || fs.realpathSync(entry.archivePath) !== entry.archivePath
      || copiedBytes !== entry.archiveBytes) {
      throw new Error(`runtime_image_bundle_loader_archive_changed_during_snapshot:${entry.profile}`);
    }
    return Object.freeze({
      ...entry,
      sourceArchivePath: entry.archivePath,
      archivePath: snapshotPath,
      archiveContentHash: `sha256:${digest.digest('hex')}`,
      snapshotFilesystemIdentity: archiveFilesystemIdentity(
        fs.fstatSync(snapshotDescriptor, { bigint: true }),
      ),
    });
  } finally {
    if (snapshotDescriptor !== null) fs.closeSync(snapshotDescriptor);
    if (sourceDescriptor !== null) fs.closeSync(sourceDescriptor);
  }
}

function snapshotBundleArchives(bundle) {
  const snapshotRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hepta-runtime-image-bundle-snapshot-'),
  );
  fs.chmodSync(snapshotRoot, 0o700);
  try {
    const archives = bundle.archives.map(
      (entry) => copyArchiveToStableSnapshot(entry, snapshotRoot),
    );
    return Object.freeze({ snapshotRoot, archives: Object.freeze(archives) });
  } catch (error) {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

function prevalidateArchive({ entry, spawnSyncImpl, environment }) {
  try {
    return inspectPinnedRuntimeImageOciArchive({
      archivePath: entry.archivePath,
      runtime: entry.runtime,
      spawnSyncImpl,
      environment,
    });
  } catch (error) {
    throw new Error(
      `runtime_image_bundle_loader_archive_preflight_failed:${entry.profile}:${String(error?.message || error)}`,
    );
  }
}

export function loadPinnedRuntimeImageBundle({
  bundleRoot,
  profiles = PINNED_RUNTIME_IMAGE_BUNDLE_PROFILES,
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  const childEnvironment = localDockerEnvironment(environment);
  assertProfileLayout(profiles);
  const bundle = inspectBundleRoot(bundleRoot, profiles);
  const snapshots = snapshotBundleArchives(bundle);
  try {
    const archiveInspections = snapshots.archives.map((entry) => Object.freeze({
      entry,
      inspection: prevalidateArchive({ entry, spawnSyncImpl, environment }),
    }));

    command({
      executable: 'docker',
      args: ['info', '--format', '{{.ServerVersion}}'],
      spawnSyncImpl,
      environment: childEnvironment,
      timeoutMs: 30_000,
      maximumBytes: 1024 * 1024,
    });

    const loadedProfiles = archiveInspections.map(({ entry, inspection }) => {
      command({
        executable: 'docker',
        args: ['load', '--input', entry.archivePath],
        spawnSyncImpl,
        environment: childEnvironment,
        timeoutMs: 10 * 60 * 1_000,
      });
      const manifestInspection = inspectDockerRuntimeImageManifest({
        image: entry.runtime.image,
        expectedManifestDigest: entry.runtime.imageDigest,
        spawnSyncImpl,
        environment,
        timeoutMs: 30_000,
      });
      if (!manifestInspection.ready) {
        throw new Error(
          `runtime_image_bundle_loader_post_load_preflight_failed:${entry.profile}:${manifestInspection.blockers.join(',')}`,
        );
      }
      return Object.freeze({
        profile: entry.profile,
        archiveName: entry.archiveName,
        archiveBytes: entry.archiveBytes,
        archiveContentHash: entry.archiveContentHash,
        image: entry.runtime.image,
        expectedManifestDigest: entry.runtime.imageDigest,
        observedManifestDigest: manifestInspection.observedManifestDigest,
        descriptorMediaType: manifestInspection.descriptorMediaType,
        platform: manifestInspection.observedPlatform,
        archiveStableSnapshotVerified: true,
        archivePrevalidated: inspection.readyToLoad === true,
        loadAttempted: true,
        manifestVerified: true,
      });
    });

    const payload = Object.freeze({
      version: 1,
      kind: 'PinnedRuntimeImageBundleLoadReceipt',
      status: 'pinned_runtime_image_bundle_loaded',
      bundleRoot: bundle.bundleRoot,
      profiles: Object.freeze(loadedProfiles),
      requiredProfileCount: REQUIRED_PROFILE_LAYOUT.length,
      localDockerSocket: LOCAL_DOCKER_HOST,
      stableArchiveSnapshotsVerified: true,
      localDaemonMutationPerformed: true,
      daemonMutationAtomic: false,
      partialMutationConfinedToEphemeralDaemonRequired: true,
      remoteDockerAllowed: false,
      runtimeFallbackAllowed: false,
      blockers: Object.freeze([]),
    });
    return Object.freeze({
      ...payload,
      pinnedRuntimeImageBundleLoadReceiptHash:
        hashRecord('PinnedRuntimeImageBundleLoadReceipt', payload),
    });
  } finally {
    fs.rmSync(snapshots.snapshotRoot, { recursive: true, force: true });
  }
}

export function runtimeImageBundleLoaderUsage() {
  return Object.freeze({
    version: 1,
    kind: 'PinnedRuntimeImageBundleLoaderUsage',
    usage: 'automation:runtime-image-bundle-load -- --bundle-root ABSOLUTE_PATH',
    behavior: 'Copies all three fixed OCI archives into stable private snapshots, prevalidates and loads those same snapshots only into unix:///var/run/docker.sock, then verifies each registered OCI manifest digest and linux/amd64 platform.',
    requiredArchives: Object.freeze(REQUIRED_PROFILE_LAYOUT.map((entry) => Object.freeze({
      ...entry,
      image: AUTOMATION_RUNTIME_IMAGES[entry.profile].image,
      manifestDigest: AUTOMATION_RUNTIME_IMAGES[entry.profile].imageDigest,
    }))),
    remoteDockerAllowed: false,
    runtimeFallbackAllowed: false,
  });
}

export function blockedRuntimeImageBundleLoadReceipt(error) {
  return Object.freeze({
    version: 1,
    kind: 'PinnedRuntimeImageBundleLoadReceipt',
    status: 'pinned_runtime_image_bundle_load_blocked',
    requiredProfiles: Object.freeze(REQUIRED_PROFILE_LAYOUT.map(({ profile }) => profile)),
    localDockerSocket: LOCAL_DOCKER_HOST,
    remoteDockerAllowed: false,
    runtimeFallbackAllowed: false,
    blockers: Object.freeze([
      String(error?.message || 'runtime_image_bundle_loader_failed').slice(0, 2_000),
    ]),
  });
}
