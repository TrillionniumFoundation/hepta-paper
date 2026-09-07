import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const validator = path.join(root, 'docs/rust/tools/strict_json_schema.py');
const entry = path.join(root, 'provider-sandbox/provider-sandbox.mjs');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function validate(schema, instance) {
  return spawnSync('python3', [validator, '--schema', path.join(root, schema),
    '--instance', path.join(root, instance)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  });
}

function gitBlobSha(bytes) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const manifestPath = 'docs/provider-sandbox/external-companion-release-source-manifest.v1.json';
const profilePath = 'docs/provider-sandbox/external-companion-target-host-profile.v1.json';
const vectorsPath = 'docs/provider-sandbox/external-companion-credential-free-vectors.v1.json';

const manifest = readJson(manifestPath);
const profile = readJson(profilePath);
const vectors = readJson(vectorsPath);

test('external companion machine kit satisfies all closed schemas', () => {
  for (const [schema, instance] of [
    ['docs/provider-sandbox/schemas/provider-external-companion-release-source-manifest-v1.schema.json', manifestPath],
    ['docs/provider-sandbox/schemas/provider-external-companion-target-host-profile-v1.schema.json', profilePath],
    ['docs/provider-sandbox/schemas/provider-external-companion-credential-free-vectors-v1.schema.json', vectorsPath],
  ]) {
    const result = validate(schema, instance);
    assert.equal(result.status, 0, `${instance}\n${result.stdout}\n${result.stderr}`);
  }
});

test('release/source manifest binds exact repository protocol blobs', () => {
  const paths = manifest.repositoryProtocolArtifacts.map((artifact) => artifact.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.deepEqual(manifest.externalSubjectRequiredFields,
    [...manifest.externalSubjectRequiredFields].sort());
  assert.deepEqual(manifest.requiredEvidenceClasses,
    [...manifest.requiredEvidenceClasses].sort());
  for (const artifact of manifest.repositoryProtocolArtifacts) {
    const bytes = fs.readFileSync(path.join(root, artifact.path));
    assert.equal(gitBlobSha(bytes), artifact.gitBlobSha, artifact.path);
  }
});

test('credential-free positive vectors execute deterministically and remain non-authorizing', (t) => {
  for (const vector of vectors.positive) {
    const directory = temporaryDirectory(t, `provider-external-positive-${vector.id}-`);
    const input = path.join(directory, 'request.json');
    const firstOutput = path.join(directory, 'response-1.json');
    const secondOutput = path.join(directory, 'response-2.json');
    fs.writeFileSync(input, `${JSON.stringify(vector.request)}\n`, { mode: 0o600, flag: 'wx' });
    const environment = {
      PATH: '/usr/bin:/bin',
      HOME: directory,
      TMPDIR: directory,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    };
    const first = spawnSync(process.execPath, [entry, input, firstOutput], {
      cwd: root, encoding: 'utf8', timeout: profile.limits.wallTimeMs,
      maxBuffer: profile.limits.stdoutBytes + profile.limits.stderrBytes,
      env: environment,
    });
    const second = spawnSync(process.execPath, [entry, input, secondOutput], {
      cwd: root, encoding: 'utf8', timeout: profile.limits.wallTimeMs,
      maxBuffer: profile.limits.stdoutBytes + profile.limits.stderrBytes,
      env: environment,
    });
    assert.equal(first.status, 0, `${vector.id}:${first.stderr}`);
    assert.equal(second.status, 0, `${vector.id}:${second.stderr}`);
    assert.deepEqual(fs.readFileSync(firstOutput), fs.readFileSync(secondOutput));
    const response = JSON.parse(fs.readFileSync(firstOutput, 'utf8'));
    const expected = vector.expectedResponse;
    assert.equal(response.kind, expected.kind);
    assert.equal(response.status, expected.status);
    assert.equal(response.companionVersion, expected.companionVersion);
    assert.equal(response.providerReceipt.sandbox, expected.providerReceiptSandbox);
    assert.equal(response.providerReceipt.credentialsObserved, expected.credentialsObserved);
    assert.equal(response.providerReceipt.networkActionPerformed, expected.networkActionPerformed);
    assert.equal(response.externalActionPerformed, expected.externalActionPerformed);
    assert.equal(response.productionEligible, expected.productionEligible);
    assert.equal(response.externalAuthorityClaimed, expected.externalAuthorityClaimed);
    assert.equal(fs.statSync(firstOutput).mode & 0o777, 0o600);
  }
});

test('credential-free hostile vectors fail before output creation', (t) => {
  for (const vector of vectors.negative) {
    const directory = temporaryDirectory(t, `provider-external-negative-${vector.id}-`);
    const input = path.join(directory, 'request.json');
    const output = path.join(directory, 'response.json');
    fs.writeFileSync(input, vector.requestText, { mode: 0o600, flag: 'wx' });
    const result = spawnSync(process.execPath, [entry, input, output], {
      cwd: root,
      encoding: 'utf8',
      timeout: profile.limits.wallTimeMs,
      maxBuffer: profile.limits.stdoutBytes + profile.limits.stderrBytes,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: directory,
        TMPDIR: directory,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      },
    });
    assert.notEqual(result.status, 0, vector.id);
    assert.match(result.stderr, new RegExp(vector.expectedError, 'u'), vector.id);
    assert.equal(fs.existsSync(output), vector.expectedOutputCreated, vector.id);
  }
});

test('target-host profile is credential-free, network-denied and non-authorizing', () => {
  assert.equal(profile.environment.inheritAmbient, false);
  assert.deepEqual(profile.environment.allowedNames,
    [...profile.environment.allowedNames].sort());
  assert.deepEqual(profile.environment.forbiddenNamePatterns,
    [...profile.environment.forbiddenNamePatterns].sort());
  assert.equal(profile.network.mode, 'deny_all');
  assert.deepEqual(profile.network.permittedDestinations, []);
  assert.equal(profile.credentials.credentialFree, true);
  assert.equal(profile.credentials.secretMounts, false);
  for (const value of Object.values(profile.authority)) assert.equal(value, false);
  for (const value of Object.values(manifest.authority)) assert.equal(value, false);
  for (const value of Object.values(vectors.authority)) assert.equal(value, false);
});

test('external operational runner retains authoritative sibling and quarantine boundary', () => {
  const source = fs.readFileSync(path.join(root,
    'paper-core/operational/provider-sandbox-external.operational.mjs'), 'utf8');
  assert.match(source, /hepta-paper-provider-sandbox\/provider-sandbox\.mjs/u);
  assert.match(source, /runProviderSandboxQuarantineProbe/u);
  assert.match(source, /evidenceClass: 'external_companion_operational'/u);
  assert.match(source, /productionAuthorized: false/u);
  assert.doesNotMatch(source, /provider-sandbox\/provider-sandbox\.mjs', import\.meta\.url/u);
});

test('idempotency and rollback documents retain ambiguity, fencing and external acceptance', () => {
  const idempotency = fs.readFileSync(path.join(root,
    'docs/provider-sandbox/IDEMPOTENCY_AND_RECONCILIATION.md'), 'utf8');
  const rollback = fs.readFileSync(path.join(root,
    'docs/provider-sandbox/REVOCATION_AND_ROLLBACK.md'), 'utf8');
  for (const token of [
    'provider_idempotency_conflict',
    'provider_dispatch_ambiguous',
    'provider_recovery_required',
    'monotonically increasing fencing token',
    'authoritative remote lookup',
  ]) assert.ok(idempotency.includes(token), token);
  for (const token of [
    'Increment the durable provider fencing generation',
    'quarantine',
    'independent reviewer signatures',
    'prove the revoked generation cannot re-enter',
    'Do not',
  ]) assert.ok(rollback.includes(token), token);
});
