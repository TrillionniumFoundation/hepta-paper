import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadPinnedRuntimeImageBundle,
  parseRuntimeImageBundleLoaderArguments,
  runtimeImageBundleLoaderUsage,
} from '../bin/automation-runtime-image-bundle-loader.mjs';

const H = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';

const LAYOUT = Object.freeze([
  Object.freeze({ profile: 'python', archiveName: 'python-scientific.oci.tar' }),
  Object.freeze({ profile: 'pythonGpu', archiveName: 'python-gpu.oci.tar' }),
  Object.freeze({ profile: 'r', archiveName: 'r-scientific.oci.tar' }),
]);

function bundleFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-bundle-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profiles = LAYOUT.map((layout) => {
    const manifestBytes = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: {
        mediaType: OCI_CONFIG,
        digest: H(`${layout.profile}:config`),
        size: 41,
      },
      layers: [{
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        digest: H(`${layout.profile}:layer`),
        size: 73,
      }],
    }));
    const runtime = Object.freeze({
      image: `hepta/${layout.profile}:fixture`,
      imageDigest: H(manifestBytes),
    });
    const indexBytes = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [{
        mediaType: OCI_MANIFEST,
        digest: runtime.imageDigest,
        size: manifestBytes.length,
        annotations: { 'org.opencontainers.image.ref.name': 'fixture' },
        platform: { os: 'linux', architecture: 'amd64' },
      }],
    }));
    const archivePath = path.join(root, layout.archiveName);
    fs.writeFileSync(archivePath, `${layout.profile}:archive-fixture`);
    return Object.freeze({ ...layout, runtime, archivePath, indexBytes, manifestBytes });
  });
  return Object.freeze({ root, profiles: Object.freeze(profiles) });
}

function successfulSpawn(fixture, calls, { mismatchedProfile = null } = {}) {
  return (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    if (executable === 'tar') {
      const profile = fixture.profiles.find(
        (entry) => entry.archiveName === path.basename(args[1]),
      );
      assert.ok(profile, `unknown archive ${args[1]}`);
      return {
        status: 0,
        stdout: args[2] === 'index.json' ? profile.indexBytes : profile.manifestBytes,
        stderr: Buffer.alloc(0),
      };
    }
    if (executable === 'docker' && args[0] === 'info') {
      return { status: 0, stdout: Buffer.from('27.5.1'), stderr: Buffer.alloc(0) };
    }
    if (executable === 'docker' && args[0] === 'load') {
      return { status: 0, stdout: Buffer.from('Loaded'), stderr: Buffer.alloc(0) };
    }
    if (executable === 'docker' && args[0] === 'image' && args[1] === 'inspect') {
      const profile = fixture.profiles.find((entry) => entry.runtime.image === args[2]);
      assert.ok(profile, `unknown image ${args[2]}`);
      const digest = profile.profile === mismatchedProfile
        ? H(`${profile.profile}:mismatch`) : profile.runtime.imageDigest;
      return {
        status: 0,
        stdout: JSON.stringify([{
          Id: H(`${profile.profile}:legacy-id`),
          Descriptor: { digest, mediaType: OCI_MANIFEST },
          Os: 'linux',
          Architecture: 'amd64',
        }]),
        stderr: '',
      };
    }
    throw new Error(`unexpected process: ${executable} ${args.join(' ')}`);
  };
}

test('bundle loader CLI exposes one immutable root and no image or digest override', () => {
  assert.deepEqual(parseRuntimeImageBundleLoaderArguments([
    '--bundle-root', '/hepta/runtime-image-bundle',
  ]), {
    help: false,
    bundleRoot: '/hepta/runtime-image-bundle',
  });
  assert.throws(() => parseRuntimeImageBundleLoaderArguments([]),
    /runtime_image_bundle_loader_root_required/);
  assert.throws(() => parseRuntimeImageBundleLoaderArguments([
    '--bundle-root', 'relative/path',
  ]), /runtime_image_bundle_loader_root_absolute_required/);
  assert.throws(() => parseRuntimeImageBundleLoaderArguments([
    '--bundle-root', '/bundle', '--expected-digest', H('override'),
  ]), /unknown_cli_option/);
  const usage = runtimeImageBundleLoaderUsage();
  assert.equal(usage.requiredArchives.length, 3);
  assert.equal(usage.remoteDockerAllowed, false);
  assert.equal(usage.runtimeFallbackAllowed, false);
});

test('bundle loader prevalidates all three OCI archives before local daemon mutation', (t) => {
  const fixture = bundleFixture(t);
  const calls = [];
  const receipt = loadPinnedRuntimeImageBundle({
    bundleRoot: fixture.root,
    profiles: fixture.profiles,
    spawnSyncImpl: successfulSpawn(fixture, calls),
    environment: { PATH: process.env.PATH },
  });
  assert.equal(receipt.status, 'pinned_runtime_image_bundle_loaded');
  assert.equal(receipt.profiles.length, 3);
  assert.ok(receipt.profiles.every((entry) => entry.archivePrevalidated
    && entry.archiveStableSnapshotVerified
    && /^sha256:[0-9a-f]{64}$/.test(entry.archiveContentHash)
    && entry.manifestVerified && entry.loadAttempted));
  assert.equal(receipt.stableArchiveSnapshotsVerified, true);
  assert.equal(receipt.daemonMutationAtomic, false);
  assert.equal(receipt.partialMutationConfinedToEphemeralDaemonRequired, true);
  assert.match(receipt.pinnedRuntimeImageBundleLoadReceiptHash, /^sha256:[0-9a-f]{64}$/);
  const firstDocker = calls.findIndex((call) => call.executable === 'docker');
  assert.equal(firstDocker, 6);
  assert.deepEqual(calls[firstDocker].args.slice(0, 2), ['info', '--format']);
  assert.equal(calls.filter((call) => call.args[0] === 'load').length, 3);
  assert.equal(calls.filter((call) => call.args[0] === 'image').length, 3);
  for (const call of calls) {
    assert.equal(call.options.env.DOCKER_HOST, 'unix:///var/run/docker.sock');
    assert.equal(call.options.env.DOCKER_CONTEXT, undefined);
  }
});

test('bundle loader rejects any invalid archive before docker info or load', (t) => {
  const fixture = bundleFixture(t);
  const calls = [];
  const broken = fixture.profiles.map((entry) => entry.profile === 'pythonGpu'
    ? Object.freeze({
      ...entry,
      indexBytes: Buffer.from(JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: [],
      })),
    }) : entry);
  const brokenFixture = Object.freeze({ ...fixture, profiles: Object.freeze(broken) });
  assert.throws(() => loadPinnedRuntimeImageBundle({
    bundleRoot: fixture.root,
    profiles: brokenFixture.profiles,
    spawnSyncImpl: successfulSpawn(brokenFixture, calls),
    environment: { PATH: process.env.PATH },
  }), /runtime_image_bundle_loader_archive_preflight_failed:pythonGpu/);
  assert.equal(calls.some((call) => call.executable === 'docker'), false);
});

test('bundle loader rejects post-load manifest drift and never reaches later profiles', (t) => {
  const fixture = bundleFixture(t);
  const calls = [];
  assert.throws(() => loadPinnedRuntimeImageBundle({
    bundleRoot: fixture.root,
    profiles: fixture.profiles,
    spawnSyncImpl: successfulSpawn(fixture, calls, { mismatchedProfile: 'pythonGpu' }),
    environment: { PATH: process.env.PATH },
  }), /runtime_image_bundle_loader_post_load_preflight_failed:pythonGpu/);
  assert.equal(calls.filter((call) => call.args[0] === 'load').length, 2);
  assert.equal(calls.some((call) => call.args.some((argument) => (
    path.basename(argument) === fixture.profiles[2].archiveName
  ))), true);
  assert.equal(calls.some((call) => call.args[0] === 'load'
    && call.args.some((argument) => (
      path.basename(argument) === fixture.profiles[2].archiveName
    ))), false);
});

test('bundle loader prevalidates and loads one stable private snapshot per archive', (t) => {
  const fixture = bundleFixture(t);
  const calls = [];
  const spawn = successfulSpawn(fixture, calls);
  const receipt = loadPinnedRuntimeImageBundle({
    bundleRoot: fixture.root,
    profiles: fixture.profiles,
    spawnSyncImpl(executable, args, options) {
      if (executable === 'tar' && args[2] === 'index.json') {
        const original = fixture.profiles.find(
          (entry) => entry.archiveName === path.basename(args[1]),
        );
        fs.writeFileSync(original.archivePath, `${original.profile}:mutated-after-snapshot`);
      }
      return spawn(executable, args, options);
    },
    environment: { PATH: process.env.PATH },
  });
  assert.equal(receipt.status, 'pinned_runtime_image_bundle_loaded');
  const archivePaths = calls
    .filter((call) => call.executable === 'tar' || call.args[0] === 'load')
    .map((call) => call.executable === 'tar' ? call.args[1] : call.args[2]);
  assert.equal(archivePaths.every((archivePath) => (
    path.dirname(archivePath) !== fixture.root
    && path.basename(path.dirname(archivePath)).startsWith(
      'hepta-runtime-image-bundle-snapshot-',
    )
  )), true);
  for (const profile of fixture.profiles) {
    const profilePaths = archivePaths.filter(
      (archivePath) => path.basename(archivePath) === profile.archiveName,
    );
    assert.ok(profilePaths.length >= 3);
    assert.equal(new Set(profilePaths).size, 1);
  }
});

test('bundle loader rejects remote Docker before filesystem or process action', () => {
  let processCalls = 0;
  assert.throws(() => loadPinnedRuntimeImageBundle({
    bundleRoot: '/not-observed-before-endpoint-policy',
    spawnSyncImpl: () => { processCalls += 1; return { status: 0 }; },
    environment: { PATH: process.env.PATH, DOCKER_HOST: 'tcp://example.invalid:2376' },
  }), /runtime_image_bundle_loader_remote_docker_endpoint_forbidden/);
  assert.equal(processCalls, 0);
});

test('bundle loader rejects symlinked OCI bundle members before process action', (t) => {
  const fixture = bundleFixture(t);
  const target = path.join(fixture.root, 'outside.oci.tar');
  fs.writeFileSync(target, 'outside');
  fs.unlinkSync(fixture.profiles[0].archivePath);
  fs.symlinkSync(target, fixture.profiles[0].archivePath);
  let processCalls = 0;
  assert.throws(() => loadPinnedRuntimeImageBundle({
    bundleRoot: fixture.root,
    profiles: fixture.profiles,
    spawnSyncImpl: () => { processCalls += 1; return { status: 0 }; },
    environment: { PATH: process.env.PATH },
  }), /runtime_image_bundle_loader_archive_regular_file_required:python/);
  assert.equal(processCalls, 0);
});
