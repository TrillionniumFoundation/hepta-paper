import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bootstrapPinnedRRuntimeImage,
  canonicalRRuntimeBuildArguments,
  inspectPinnedRRuntimeOciArchive,
  parseRRuntimeBootstrapArguments,
  rRuntimeBootstrapUsage,
} from '../bin/automation-r-runtime-bootstrap.mjs';

const H = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

function temporaryArchive(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-r-bootstrap-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archivePath = path.join(root, 'image.tar');
  fs.writeFileSync(archivePath, 'fixture');
  return archivePath;
}

test('R runtime bootstrap CLI requires one pinned source and exposes no digest override', () => {
  assert.deepEqual(parseRRuntimeBootstrapArguments(['--build']), {
    help: false,
    mode: 'build',
    archivePath: null,
  });
  assert.equal(parseRRuntimeBootstrapArguments(['--archive', './image.tar']).mode, 'archive');
  assert.throws(() => parseRRuntimeBootstrapArguments([]),
    /r_runtime_bootstrap_exactly_one_source_required/);
  assert.throws(() => parseRRuntimeBootstrapArguments(['--build', '--archive', './image.tar']),
    /r_runtime_bootstrap_exactly_one_source_required/);
  assert.throws(() => parseRRuntimeBootstrapArguments(['--expected-digest', H('alternate')]),
    /unknown_cli_option/);
  assert.equal(rRuntimeBootstrapUsage().runtimeFallbackAllowed, false);
});

test('R runtime canonical build is OCI-only, timestamp-rewritten, cacheless and pinned', () => {
  const archivePath = '/tmp/hepta-r-bootstrap-test-output.tar';
  const args = canonicalRRuntimeBuildArguments({ archivePath });
  assert.deepEqual(args.slice(0, 2), ['buildx', 'build']);
  assert.ok(args.includes('--no-cache'));
  assert.ok(args.includes('--pull=false'));
  assert.ok(args.includes('--provenance=false'));
  assert.ok(args.includes('--sbom=false'));
  assert.ok(args.includes('SOURCE_DATE_EPOCH=1733097600'));
  assert.ok(args.includes(`type=oci,dest=${archivePath},rewrite-timestamp=true`));
  assert.ok(args.includes('linux/amd64'));
  assert.ok(args.includes('hepta/r-scientific:0.14.0'));
  assert.equal(args.some((value) => value === '--load'), false);
});

test('R runtime OCI archive inspection binds raw manifest bytes, platform and fixed tag', (t) => {
  const archivePath = temporaryArchive(t);
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: H('config'),
      size: 42,
    },
    layers: [{
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      digest: H('layer'),
      size: 73,
    }],
  }));
  const runtime = Object.freeze({
    image: 'hepta/r-scientific:test',
    imageDigest: H(manifestBytes),
  });
  const indexBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: runtime.imageDigest,
      size: manifestBytes.length,
      annotations: { 'org.opencontainers.image.ref.name': 'test' },
      platform: { os: 'linux', architecture: 'amd64' },
    }],
  }));
  const spawnSyncImpl = (_executable, args) => ({
    status: 0,
    stdout: args[2] === 'index.json' ? indexBytes : manifestBytes,
    stderr: Buffer.alloc(0),
  });
  const inspection = inspectPinnedRRuntimeOciArchive({
    archivePath,
    runtime,
    spawnSyncImpl,
    environment: { PATH: process.env.PATH },
  });
  assert.equal(inspection.readyToLoad, true);
  assert.equal(inspection.observedManifestDigest, runtime.imageDigest);
  assert.equal(inspection.descriptorMediaType,
    'application/vnd.oci.image.manifest.v1+json');
  assert.equal(inspection.platform, 'linux/amd64');
});

test('R runtime bootstrap refuses a non-registered archive before docker load', (t) => {
  const archivePath = temporaryArchive(t);
  const calls = [];
  const indexBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: H('not-the-registered-r-image'),
      size: 2,
      annotations: { 'org.opencontainers.image.ref.name': '0.14.0' },
      platform: { os: 'linux', architecture: 'amd64' },
    }],
  }));
  const spawnSyncImpl = (executable, args) => {
    calls.push([executable, ...args]);
    return { status: 0, stdout: indexBytes, stderr: Buffer.alloc(0) };
  };
  assert.throws(() => bootstrapPinnedRRuntimeImage({
    mode: 'archive',
    archivePath,
    spawnSyncImpl,
    environment: { PATH: process.env.PATH },
  }), /r_runtime_bootstrap_registered_manifest_not_present/);
  assert.equal(calls.some((args) => args[0] === 'docker' && args[1] === 'load'), false);
});

test('R runtime bootstrap refuses remote Docker endpoints before any process action', (t) => {
  const archivePath = temporaryArchive(t);
  let processCalls = 0;
  assert.throws(() => bootstrapPinnedRRuntimeImage({
    mode: 'archive',
    archivePath,
    spawnSyncImpl: () => { processCalls += 1; return { status: 0 }; },
    environment: { PATH: process.env.PATH, DOCKER_HOST: 'tcp://example.invalid:2376' },
  }), /r_runtime_bootstrap_remote_docker_endpoint_forbidden/);
  assert.equal(processCalls, 0);
});
