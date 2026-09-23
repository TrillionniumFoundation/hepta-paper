import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bootstrapPinnedPythonRuntimeImage,
  canonicalPythonRuntimeBuildArguments,
  parsePythonRuntimeBootstrapArguments,
  pythonRuntimeBootstrapUsage,
} from '../bin/automation-python-runtime-bootstrap.mjs';

const H = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

function temporaryArchive(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-python-bootstrap-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archivePath = path.join(root, 'image.tar');
  fs.writeFileSync(archivePath, 'fixture');
  return archivePath;
}

test('Python runtime bootstrap CLI binds one fixed profile and exposes no digest override', () => {
  assert.deepEqual(parsePythonRuntimeBootstrapArguments(['--profile', 'python', '--build']), {
    help: false,
    profile: 'python',
    mode: 'build',
    archivePath: null,
  });
  assert.equal(parsePythonRuntimeBootstrapArguments([
    '--profile', 'pythonGpu', '--archive', './image.tar',
  ]).mode, 'archive');
  assert.throws(() => parsePythonRuntimeBootstrapArguments(['--build']),
    /python_runtime_bootstrap_profile_invalid/);
  assert.throws(() => parsePythonRuntimeBootstrapArguments([
    '--profile', 'python', '--build', '--archive', './image.tar',
  ]), /python_runtime_bootstrap_exactly_one_source_required/);
  assert.throws(() => parsePythonRuntimeBootstrapArguments([
    '--profile', 'python', '--expected-digest', H('alternate'),
  ]), /unknown_cli_option/);
  assert.equal(pythonRuntimeBootstrapUsage().runtimeFallbackAllowed, false);
});

test('Python canonical builds are OCI-only, timestamp-rewritten, cacheless and pinned', () => {
  for (const [profile, image] of [
    ['python', 'hepta/python-scientific:0.14.0'],
    ['pythonGpu', 'hepta/python-gpu:0.15.0'],
  ]) {
    const args = canonicalPythonRuntimeBuildArguments({
      profile,
      archivePath: `/tmp/hepta-${profile}-bootstrap-test-output.tar`,
    });
    assert.deepEqual(args.slice(0, 2), ['buildx', 'build']);
    assert.ok(args.includes('--no-cache'));
    assert.ok(args.includes('--pull=false'));
    assert.ok(args.includes('--provenance=false'));
    assert.ok(args.includes('--sbom=false'));
    assert.ok(args.includes('SOURCE_DATE_EPOCH=1733097600'));
    assert.ok(args.some((value) => value.includes('rewrite-timestamp=true')));
    assert.ok(args.includes('linux/amd64'));
    assert.ok(args.includes(image));
    assert.equal(args.some((value) => value === '--load'), false);
  }
});

test('Python runtime bootstrap refuses a non-registered archive before docker load', (t) => {
  const archivePath = temporaryArchive(t);
  const calls = [];
  const indexBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: H('not-the-registered-python-image'),
      size: 2,
      annotations: { 'org.opencontainers.image.ref.name': '0.14.0' },
      platform: { os: 'linux', architecture: 'amd64' },
    }],
  }));
  const spawnSyncImpl = (executable, args) => {
    calls.push([executable, ...args]);
    return { status: 0, stdout: indexBytes, stderr: Buffer.alloc(0) };
  };
  assert.throws(() => bootstrapPinnedPythonRuntimeImage({
    profile: 'python',
    mode: 'archive',
    archivePath,
    spawnSyncImpl,
    environment: { PATH: process.env.PATH },
  }), /python_runtime_bootstrap_registered_manifest_not_present/);
  assert.equal(calls.some((args) => args[0] === 'docker' && args[1] === 'load'), false);
});

test('Python runtime bootstrap refuses remote Docker endpoints before process action', (t) => {
  const archivePath = temporaryArchive(t);
  let processCalls = 0;
  assert.throws(() => bootstrapPinnedPythonRuntimeImage({
    profile: 'pythonGpu',
    mode: 'archive',
    archivePath,
    spawnSyncImpl: () => { processCalls += 1; return { status: 0 }; },
    environment: { PATH: process.env.PATH, DOCKER_HOST: 'tcp://example.invalid:2376' },
  }), /python_runtime_bootstrap_remote_docker_endpoint_forbidden/);
  assert.equal(processCalls, 0);
});
