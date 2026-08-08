import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { releaseIntegrityEvidence } from '../bin/release-integrity-evidence.mjs';
import * as releaseIntegrityKeyManagement from '../bin/release-integrity-key-management.mjs';
import * as releaseIntegritySigning from '../bin/release-integrity-signing.mjs';
import {
  inspectLocalReleaseIntegrityKey as inspectLocalReleaseIntegrityKeyPrimitive,
  loadExistingLocalReleaseIntegritySigningKey,
  provisionLocalReleaseIntegrityKey as provisionLocalReleaseIntegrityKeyPrimitive,
} from '../bin/release-integrity-key-management.mjs';

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(WORKSPACE_ROOT, 'paper-core/bin/release-integrity-key.mjs');
const NON_ISOLATED_TEST_ENVIRONMENT = Object.freeze({
  HEPTA_PAPER_RUNTIME_ISOLATED: '0',
});

function inspectLocalReleaseIntegrityKey(options = {}) {
  return inspectLocalReleaseIntegrityKeyPrimitive({
    ...options,
    environment: options.environment || NON_ISOLATED_TEST_ENVIRONMENT,
  });
}

function provisionLocalReleaseIntegrityKey(options = {}) {
  return provisionLocalReleaseIntegrityKeyPrimitive({
    ...options,
    environment: options.environment || NON_ISOLATED_TEST_ENVIRONMENT,
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-integrity-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  return { root, runtimeRoot };
}

function keyPaths(runtimeRoot) {
  const keyRoot = path.join(runtimeRoot, 'release-signing');
  return {
    keyRoot,
    privatePath: path.join(keyRoot, 'release-integrity-ed25519-private.pem'),
    publicPath: path.join(keyRoot, 'release-integrity-ed25519-public.pem'),
  };
}

test('key-management compatibility facade preserves its exact public surface', () => {
  assert.deepEqual(Object.keys(releaseIntegrityKeyManagement), [
    'LOCAL_RELEASE_INTEGRITY_AUTHORITY_LIMIT',
    'inspectLocalReleaseIntegrityKey',
    'loadExistingLocalReleaseIntegritySigningKey',
    'provisionLocalReleaseIntegrityKey',
  ]);
});

test('narrow release signing API exposes only existing-key payload signing', (t) => {
  assert.deepEqual(Object.keys(releaseIntegritySigning), ['signReleasePayload']);
  const selected = fixture(t);
  provisionLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
    execute: true,
  });
  const payload = { version: 1, kind: 'NarrowReleaseSigningApiFixture' };
  const signature = releaseIntegritySigning.signReleasePayload(
    payload,
    selected.runtimeRoot,
    { environment: NON_ISOLATED_TEST_ENVIRONMENT },
  );
  assert.equal(signature.kind, 'ReleaseIntegritySignature');
  assert.equal(releaseIntegrityEvidence.verifyReleaseIntegritySignature(payload, signature), true);
});

function sha256File(candidate) {
  return crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
}

function cli(runtimeRoot, argv, environment = {}) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot,
      HEPTA_PAPER_RUNTIME_ISOLATED: '0',
      ...environment,
    },
  });
}

function writePair(runtimeRoot, { mismatch = false } = {}) {
  const paths = keyPaths(runtimeRoot);
  const privatePair = crypto.generateKeyPairSync('ed25519');
  const publicPair = mismatch ? crypto.generateKeyPairSync('ed25519') : privatePair;
  fs.mkdirSync(paths.keyRoot, { mode: 0o700 });
  fs.writeFileSync(
    paths.privatePath,
    privatePair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    paths.publicPath,
    publicPair.publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o444 },
  );
  return paths;
}

test('status is read-only and absent keys remain absent', (t) => {
  const selected = fixture(t);
  const result = inspectLocalReleaseIntegrityKey({ runtimeRoot: selected.runtimeRoot });
  assert.equal(result.ready, false);
  assert.equal(result.status, 'local_release_integrity_key_not_provisioned');
  assert.equal(result.privateKeyRead, false);
  assert.equal(result.fullProductionAuthorityClaimed, false);
  assert.equal(fs.existsSync(keyPaths(selected.runtimeRoot).keyRoot), false);

  const child = cli(selected.runtimeRoot, ['--action', 'status']);
  assert.equal(child.status, 2, child.stderr);
  assert.equal(JSON.parse(child.stdout).ready, false);
  assert.equal(fs.existsSync(keyPaths(selected.runtimeRoot).keyRoot), false);
});

test('explicit provision publishes one validated pair with exact modes and is idempotent', (t) => {
  const selected = fixture(t);
  const first = cli(selected.runtimeRoot, ['--action', 'provision', '--execute']);
  assert.equal(first.status, 0, first.stderr);
  const firstReport = JSON.parse(first.stdout);
  assert.equal(firstReport.created, true);
  assert.equal(firstReport.ready, true);
  assert.equal(firstReport.hostResidentExportableKey, true);
  assert.equal(firstReport.externalKmsOrHsmClaimed, false);
  assert.equal(Object.hasOwn(firstReport, 'privateKeyPath'), false);
  assert.equal(Object.hasOwn(firstReport, 'identities'), false);

  const paths = keyPaths(selected.runtimeRoot);
  assert.equal(fs.statSync(paths.keyRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.privatePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.publicPath).mode & 0o777, 0o444);
  const before = {
    root: fs.statSync(paths.keyRoot),
    private: fs.statSync(paths.privatePath),
    public: fs.statSync(paths.publicPath),
    privateHash: sha256File(paths.privatePath),
    publicHash: sha256File(paths.publicPath),
  };
  const challenge = Buffer.from('release integrity key test');
  assert.equal(crypto.verify(
    null,
    challenge,
    crypto.createPublicKey(fs.readFileSync(paths.publicPath)),
    crypto.sign(null, challenge, crypto.createPrivateKey(fs.readFileSync(paths.privatePath))),
  ), true);

  assert.equal(Object.hasOwn(releaseIntegrityEvidence, 'provisionReleaseSigningKey'), false);
  assert.throws(() => provisionLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
  }), /release_integrity_key_provision_execute_required/);
  const primitiveReplay = provisionLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
    execute: true,
  });
  assert.equal(primitiveReplay.created, false);
  assert.equal(primitiveReplay.publicKeyFingerprint, firstReport.publicKeyFingerprint);

  const second = cli(selected.runtimeRoot, ['--action', 'provision', '--execute']);
  assert.equal(second.status, 0, second.stderr);
  const secondReport = JSON.parse(second.stdout);
  assert.equal(secondReport.created, false);
  assert.equal(secondReport.publicKeyFingerprint, firstReport.publicKeyFingerprint);
  for (const [name, candidate] of [
    ['root', paths.keyRoot], ['private', paths.privatePath], ['public', paths.publicPath],
  ]) {
    const after = fs.statSync(candidate);
    assert.equal(after.dev, before[name].dev);
    assert.equal(after.ino, before[name].ino);
    assert.equal(after.mtimeMs, before[name].mtimeMs);
  }
  assert.equal(sha256File(paths.privatePath), before.privateHash);
  assert.equal(sha256File(paths.publicPath), before.publicHash);
  assert.deepEqual(
    fs.readdirSync(selected.runtimeRoot).sort(),
    ['release-signing'],
  );
});

test('provision confirmation, unknown options, and isolated runtime fail before mutation', (t) => {
  const selected = fixture(t);
  for (const [argv, blocker] of [
    [['--action', 'provision'], 'release_integrity_key_provision_execute_required'],
    [['--action', 'status', '--execute'], 'release_integrity_key_status_execute_forbidden'],
    [['--unknown'], 'unknown_cli_option'],
  ]) {
    const child = cli(selected.runtimeRoot, argv);
    assert.equal(child.status, 1);
    assert.match(child.stderr, new RegExp(blocker));
  }
  assert.equal(fs.existsSync(keyPaths(selected.runtimeRoot).keyRoot), false);

  const isolatedRoot = path.join(selected.root, 'isolated-does-not-exist');
  for (const action of ['status', 'provision']) {
    const child = cli(
      isolatedRoot,
      action === 'status' ? ['--action', action] : ['--action', action, '--execute'],
      { HEPTA_PAPER_RUNTIME_ISOLATED: '1' },
    );
    assert.equal(child.status, 1);
    assert.match(child.stderr, /release_integrity_key_access_forbidden_in_isolated_runtime/);
    assert.equal(fs.existsSync(isolatedRoot), false);
  }
});

test('partial, mismatched, unexpected, and symlink key roots are never repaired or rotated', (t) => {
  for (const scenario of ['partial', 'mismatch', 'unexpected', 'symlink']) {
    const selected = fixture(t);
    const paths = keyPaths(selected.runtimeRoot);
    if (scenario === 'partial') {
      const pair = crypto.generateKeyPairSync('ed25519');
      fs.mkdirSync(paths.keyRoot, { mode: 0o700 });
      fs.writeFileSync(
        paths.privatePath,
        pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        { mode: 0o600 },
      );
    } else if (scenario === 'symlink') {
      const target = path.join(selected.root, 'redirected');
      fs.mkdirSync(target, { mode: 0o700 });
      fs.symlinkSync(target, paths.keyRoot);
    } else {
      writePair(selected.runtimeRoot, { mismatch: scenario === 'mismatch' });
      if (scenario === 'unexpected') fs.writeFileSync(path.join(paths.keyRoot, 'extra'), 'x');
    }
    const before = fs.readdirSync(selected.runtimeRoot).map((name) => ({
      name,
      link: fs.lstatSync(path.join(selected.runtimeRoot, name)).isSymbolicLink(),
    }));
    const child = cli(selected.runtimeRoot, ['--action', 'provision', '--execute']);
    assert.equal(child.status, 1, `${scenario}: ${child.stderr}`);
    assert.deepEqual(fs.readdirSync(selected.runtimeRoot).map((name) => ({
      name,
      link: fs.lstatSync(path.join(selected.runtimeRoot, name)).isSymbolicLink(),
    })), before);
    assert.equal(fs.existsSync(path.join(selected.runtimeRoot, '.release-integrity-key-provision.lock')), false);
  }
});

test('injected staged write failure rolls back without exposing a final half-pair', (t) => {
  const selected = fixture(t);
  const injected = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (candidate, flags, ...rest) => {
          if (path.basename(String(candidate)) === 'release-integrity-ed25519-public.pem'
            && (flags & fs.constants.O_CREAT) !== 0) {
            const error = new Error('injected_public_key_write_failure');
            error.code = 'EIO';
            throw error;
          }
          return target.openSync(candidate, flags, ...rest);
        };
      }
      return target[property];
    },
  });
  assert.throws(
    () => provisionLocalReleaseIntegrityKey({
      runtimeRoot: selected.runtimeRoot,
      execute: true,
      fileSystem: injected,
    }),
    /injected_public_key_write_failure/,
  );
  assert.deepEqual(fs.readdirSync(selected.runtimeRoot), []);
});

test('runtime-root replacement before key publication fails closed and cleans sibling staging', (t) => {
  const selected = fixture(t);
  const heldRoot = path.join(selected.root, 'runtime-held');
  assert.throws(() => provisionLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
    execute: true,
    beforePublish() {
      fs.renameSync(selected.runtimeRoot, heldRoot);
      fs.mkdirSync(selected.runtimeRoot, { mode: 0o700 });
    },
  }), /release_integrity_directory_chain_changed/);
  assert.equal(fs.existsSync(keyPaths(heldRoot).keyRoot), false);
  assert.equal(fs.existsSync(keyPaths(selected.runtimeRoot).keyRoot), false);
  assert.deepEqual(
    fs.readdirSync(selected.root).filter((name) => name.includes('release-signing-staging')),
    [],
  );
  assert.deepEqual(
    fs.readdirSync(selected.root).filter((name) => name.includes('key-provision.lock')),
    [],
  );
});

test('concurrent empty key root is never overwritten by provisioning', (t) => {
  const selected = fixture(t);
  const paths = keyPaths(selected.runtimeRoot);
  let concurrentIdentity;
  assert.throws(() => provisionLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
    execute: true,
    beforePublish() {
      fs.mkdirSync(paths.keyRoot, { mode: 0o700 });
      const stat = fs.lstatSync(paths.keyRoot);
      concurrentIdentity = { dev: stat.dev, ino: stat.ino };
    },
  }), /release_integrity_key_pair_shape_invalid/);
  const preserved = fs.lstatSync(paths.keyRoot);
  assert.deepEqual(
    { dev: preserved.dev, ino: preserved.ino },
    concurrentIdentity,
  );
  assert.deepEqual(fs.readdirSync(paths.keyRoot), []);
  assert.deepEqual(
    fs.readdirSync(selected.root).filter((name) => name.includes('release-signing-staging')),
    [],
  );
  assert.deepEqual(
    fs.readdirSync(selected.root).filter((name) => name.includes('key-provision.lock')),
    [],
  );
});

test('concurrent final-file insertion is preserved and never becomes signing authority', (t) => {
  const selected = fixture(t);
  const paths = keyPaths(selected.runtimeRoot);
  const concurrent = Buffer.from('concurrent public bytes\n');
  let injected = false;
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'linkSync') {
        return (source, destination) => {
          if (!injected && destination === paths.publicPath) {
            injected = true;
            target.writeFileSync(destination, concurrent, { mode: 0o444, flag: 'wx' });
          }
          return target.linkSync(source, destination);
        };
      }
      return target[property];
    },
  });
  assert.throws(() => provisionLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
    execute: true,
    fileSystem: racingFs,
  }), /release_integrity_key_provision_rollback_incomplete:EEXIST/);
  assert.deepEqual(fs.readFileSync(paths.publicPath), concurrent);
  assert.equal(fs.existsSync(paths.privatePath), false);
  assert.deepEqual(
    fs.readdirSync(selected.root).filter((name) => name.includes('release-signing-staging')),
    [],
  );
  assert.deepEqual(
    fs.readdirSync(selected.root).filter((name) => name.includes('key-provision.lock')),
    [],
  );
});

test('key-root replacement during reads is rejected and temporary private bytes are zeroed', (t) => {
  const selected = fixture(t);
  const paths = writePair(selected.runtimeRoot);
  const replacementParent = path.join(selected.root, 'replacement-runtime');
  fs.mkdirSync(replacementParent, { mode: 0o700 });
  const replacement = writePair(replacementParent);
  const heldRoot = path.join(selected.runtimeRoot, 'release-signing-held');
  const observed = [];
  let injected = false;
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'readdirSync') {
        return (candidate, ...args) => {
          const result = target.readdirSync(candidate, ...args);
          if (!injected && candidate === paths.keyRoot) {
            injected = true;
            target.renameSync(paths.keyRoot, heldRoot);
            target.renameSync(replacement.keyRoot, paths.keyRoot);
          }
          return result;
        };
      }
      if (property === 'readFileSync') {
        return (...args) => {
          const bytes = target.readFileSync(...args);
          if (Buffer.isBuffer(bytes) && bytes.includes(Buffer.from('PRIVATE KEY'))) {
            observed.push(bytes);
          }
          return bytes;
        };
      }
      return target[property];
    },
  });
  const status = inspectLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
    fileSystem: racingFs,
  });
  assert.equal(status.ready, false);
  assert.match(status.blockers.join(','), /release_integrity_directory_chain_changed/);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].every((value) => value === 0), true);
});

test('private bytes are zeroed when descriptor validation fails after the read', (t) => {
  const selected = fixture(t);
  writePair(selected.runtimeRoot);
  const observed = [];
  let privateRead = false;
  let injected = false;
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'readFileSync') {
        return (...args) => {
          const bytes = target.readFileSync(...args);
          if (Buffer.isBuffer(bytes) && bytes.includes(Buffer.from('PRIVATE KEY'))) {
            observed.push(bytes);
            privateRead = true;
          }
          return bytes;
        };
      }
      if (property === 'fstatSync') {
        return (...args) => {
          const stat = target.fstatSync(...args);
          if (!privateRead || injected) return stat;
          injected = true;
          return new Proxy(stat, {
            get(selectedStat, field) {
              if (field === 'mtimeMs') return Number(selectedStat.mtimeMs) + 1;
              const value = Reflect.get(selectedStat, field, selectedStat);
              return typeof value === 'function' ? value.bind(selectedStat) : value;
            },
          });
        };
      }
      return target[property];
    },
  });
  const status = inspectLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
    fileSystem: racingFs,
  });
  assert.equal(status.ready, false);
  assert.match(status.blockers.join(','), /release_integrity_key_file_changed_during_read/);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].every((value) => value === 0), true);
});

test('key file path replacement after descriptor read is rejected and preserves both files', (t) => {
  const selected = fixture(t);
  const paths = writePair(selected.runtimeRoot);
  const replacementPair = crypto.generateKeyPairSync('ed25519');
  const replacementPath = path.join(selected.root, 'replacement-private.pem');
  const heldPath = path.join(selected.root, 'held-private.pem');
  fs.writeFileSync(
    replacementPath,
    replacementPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  const observed = [];
  let privateRead = false;
  let injected = false;
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'readFileSync') {
        return (...args) => {
          const bytes = target.readFileSync(...args);
          if (Buffer.isBuffer(bytes) && bytes.includes(Buffer.from('PRIVATE KEY'))) {
            observed.push(bytes);
            privateRead = true;
          }
          return bytes;
        };
      }
      if (property === 'lstatSync') {
        return (candidate, ...args) => {
          if (candidate === paths.privatePath && privateRead && !injected) {
            injected = true;
            target.renameSync(paths.privatePath, heldPath);
            target.renameSync(replacementPath, paths.privatePath);
          }
          return target.lstatSync(candidate, ...args);
        };
      }
      return target[property];
    },
  });
  const status = inspectLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
    fileSystem: racingFs,
  });
  assert.equal(status.ready, false);
  assert.match(status.blockers.join(','), /release_integrity_key_file_changed_during_read/);
  assert.equal(fs.existsSync(heldPath), true);
  assert.equal(fs.existsSync(paths.privatePath), true);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].every((value) => value === 0), true);
});

test('staging mode hardening never chmods a directory substituted before open', (t) => {
  const selected = fixture(t);
  const concurrentRoot = path.join(selected.root, 'concurrent-staging-root');
  fs.mkdirSync(concurrentRoot, { mode: 0o755 });
  fs.chmodSync(concurrentRoot, 0o755);
  let substitutedPath = null;
  let heldPath = null;
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'openSync') {
        return (candidate, flags, ...args) => {
          if (!substitutedPath
            && String(candidate).includes('.release-signing-staging-')
            && (flags & fs.constants.O_DIRECTORY) !== 0) {
            substitutedPath = candidate;
            heldPath = `${candidate}.held`;
            target.renameSync(candidate, heldPath);
            target.renameSync(concurrentRoot, candidate);
          }
          return target.openSync(candidate, flags, ...args);
        };
      }
      return target[property];
    },
  });
  assert.throws(() => provisionLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
    execute: true,
    fileSystem: racingFs,
  }), /release_integrity_key_staging_root_unsafe/);
  assert.equal(fs.lstatSync(substitutedPath).mode & 0o7777, 0o755);
  assert.equal(fs.lstatSync(heldPath).mode & 0o7777, 0o700);
});

test('empty key-root cleanup quarantines but never deletes a substituted directory', (t) => {
  const selected = fixture(t);
  const paths = keyPaths(selected.runtimeRoot);
  const concurrentRoot = path.join(selected.root, 'concurrent-key-root');
  const marker = path.join(concurrentRoot, 'concurrent-marker');
  const heldRoot = path.join(selected.root, 'owned-key-root-held');
  fs.mkdirSync(concurrentRoot, { mode: 0o700 });
  fs.writeFileSync(marker, 'preserve me\n', { mode: 0o600 });
  let injected = false;
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'linkSync') {
        return (source, destination) => {
          if (destination === paths.publicPath) throw new Error('injected_publish_failure');
          return target.linkSync(source, destination);
        };
      }
      if (property === 'renameSync') {
        return (source, destination) => {
          if (!injected && source === paths.keyRoot) {
            injected = true;
            target.renameSync(paths.keyRoot, heldRoot);
            target.renameSync(concurrentRoot, paths.keyRoot);
          }
          return target.renameSync(source, destination);
        };
      }
      return target[property];
    },
  });
  assert.throws(() => provisionLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
    execute: true,
    fileSystem: racingFs,
  }), /release_integrity_key_provision_rollback_incomplete:injected_publish_failure/);
  assert.equal(fs.existsSync(heldRoot), true);
  const quarantines = fs.readdirSync(selected.runtimeRoot)
    .filter((name) => name.includes('release-signing.') && name.endsWith('.quarantine'));
  assert.equal(quarantines.length, 1);
  assert.equal(
    fs.readFileSync(path.join(selected.runtimeRoot, quarantines[0], 'concurrent-marker'), 'utf8'),
    'preserve me\n',
  );
});

test('public-key loading binds the selected key-root directory identity', (t) => {
  const selected = fixture(t);
  const paths = writePair(selected.runtimeRoot);
  const replacementParent = path.join(selected.root, 'public-replacement-runtime');
  fs.mkdirSync(replacementParent, { mode: 0o700 });
  const replacement = writePair(replacementParent);
  const heldRoot = path.join(selected.runtimeRoot, 'release-signing-public-held');
  let injected = false;
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'readdirSync') {
        return (candidate, ...args) => {
          const result = target.readdirSync(candidate, ...args);
          if (!injected && candidate === paths.keyRoot) {
            injected = true;
            target.renameSync(paths.keyRoot, heldRoot);
            target.renameSync(replacement.keyRoot, paths.keyRoot);
          }
          return result;
        };
      }
      return target[property];
    },
  });
  assert.throws(() => loadExistingLocalReleaseIntegritySigningKey(
    selected.runtimeRoot,
    { fileSystem: racingFs },
  ), /release_integrity_directory_chain_changed/);
});

test('status and signing zero temporary private-key buffers', (t) => {
  const selected = fixture(t);
  provisionLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
    execute: true,
  });
  const observed = [];
  const observingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'readFileSync') {
        return (...args) => {
          const bytes = target.readFileSync(...args);
          if (Buffer.isBuffer(bytes)
            && bytes.includes(Buffer.from('PRIVATE KEY'))) observed.push(bytes);
          return bytes;
        };
      }
      return target[property];
    },
  });
  assert.equal(inspectLocalReleaseIntegrityKey({
    runtimeRoot: selected.runtimeRoot,
    fileSystem: observingFs,
  }).ready, true);
  assert.equal(releaseIntegrityEvidence.signReleasePayload(
    { version: 1 },
    selected.runtimeRoot,
    {
      environment: NON_ISOLATED_TEST_ENVIRONMENT,
      fileSystem: observingFs,
    },
  ).kind, 'ReleaseIntegritySignature');
  assert.equal(observed.length, 2);
  for (const bytes of observed) assert.equal(bytes.every((value) => value === 0), true);
});

test('signing defaults to existing-key-only and never provisions as a side effect', (t) => {
  const selected = fixture(t);
  assert.throws(
    () => releaseIntegrityEvidence.signReleasePayload(
      { version: 1 },
      selected.runtimeRoot,
      { environment: NON_ISOLATED_TEST_ENVIRONMENT },
    ),
    /ENOENT|release_integrity_key_not_provisioned/,
  );
  assert.equal(fs.existsSync(keyPaths(selected.runtimeRoot).keyRoot), false);
});

test('private signing remains forbidden in an isolated runtime with an existing key', (t) => {
  const selected = fixture(t);
  writePair(selected.runtimeRoot);
  assert.throws(
    () => releaseIntegrityEvidence.signReleasePayload(
      { version: 1 },
      selected.runtimeRoot,
      { environment: { HEPTA_PAPER_RUNTIME_ISOLATED: '1' } },
    ),
    /release_integrity_key_access_forbidden_in_isolated_runtime/,
  );
});

test('identity-mismatched cleanup preserves concurrent bytes after deterministic rename race', (t) => {
  const selected = fixture(t);
  const candidate = path.join(selected.runtimeRoot, 'artifact.json');
  const concurrentSource = path.join(selected.runtimeRoot, 'concurrent-source.json');
  fs.writeFileSync(candidate, 'owned\n', { mode: 0o444 });
  fs.writeFileSync(concurrentSource, 'concurrent\n', { mode: 0o444 });
  const owned = fs.lstatSync(candidate);
  let injected = false;
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return (source, destination) => {
          if (!injected && source === candidate) {
            injected = true;
            target.unlinkSync(candidate);
            target.renameSync(concurrentSource, candidate);
          }
          return target.renameSync(source, destination);
        };
      }
      return target[property];
    },
  });
  assert.equal(releaseIntegrityEvidence.removeExactPublishedFile({
    path: candidate,
    identity: { dev: owned.dev, ino: owned.ino },
    preexisting: false,
  }, {
    fileSystem: racingFs,
    randomBytes: () => Buffer.alloc(12, 1),
  }), false);
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'concurrent\n');
});

test('write failure cleanup never deletes a deterministic concurrent replacement', (t) => {
  const selected = fixture(t);
  const candidate = path.join(selected.runtimeRoot, 'failed-artifact.json');
  const concurrentSource = path.join(selected.runtimeRoot, 'concurrent-artifact.json');
  fs.writeFileSync(concurrentSource, 'concurrent artifact\n', { mode: 0o444 });
  assert.throws(() => releaseIntegrityEvidence.writeNoClobberJsonFile(
    candidate,
    { owner: 'official-writer' },
    {
      beforePostimageInspection() {
        fs.unlinkSync(candidate);
        fs.renameSync(concurrentSource, candidate);
        throw new Error('injected_postwrite_failure');
      },
    },
  ), /release_evidence_output_rollback_incomplete:injected_postwrite_failure/);
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'concurrent artifact\n');
});

test('official artifact publishers serialize on the pointer parent lock', (t) => {
  const selected = fixture(t);
  const currentRoot = path.join(selected.runtimeRoot, 'current');
  fs.mkdirSync(currentRoot, { mode: 0o700 });
  const pointerPath = path.join(currentRoot, 'CURRENT.json');
  const outerArtifact = path.join(currentRoot, 'outer.json');
  const innerArtifact = path.join(currentRoot, 'inner.json');
  const result = releaseIntegrityEvidence.publishJsonArtifactSet({
    entries: [{ path: outerArtifact, value: { writer: 'outer' } }],
    pointerPath,
    pointerValue: { writer: 'outer' },
    beforePointer() {
      assert.throws(() => releaseIntegrityEvidence.publishJsonArtifactSet({
        entries: [{ path: innerArtifact, value: { writer: 'inner' } }],
        pointerPath,
        pointerValue: { writer: 'inner' },
      }), /release_evidence_publication_locked/);
    },
  });
  assert.equal(result.artifacts.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(pointerPath, 'utf8')), { writer: 'outer' });
  assert.equal(fs.existsSync(innerArtifact), false);
  assert.equal(fs.existsSync(path.join(currentRoot, '.release-integrity-publication.lock')), false);
});

test('pointer staging cleanup preserves a concurrent replacement and rolls back the pointer', (t) => {
  const selected = fixture(t);
  const currentRoot = path.join(selected.runtimeRoot, 'current-staging-race');
  fs.mkdirSync(currentRoot, { mode: 0o700 });
  const pointerPath = path.join(currentRoot, 'CURRENT.json');
  const concurrentSource = path.join(currentRoot, 'concurrent-source');
  fs.writeFileSync(concurrentSource, 'concurrent staging bytes\n', { mode: 0o444 });
  assert.throws(() => releaseIntegrityEvidence.publishJsonArtifactSet({
    entries: [],
    pointerPath,
    pointerValue: { writer: 'official' },
    pointerHooks: {
      beforeStagingCleanup(staging) {
        fs.unlinkSync(staging.path);
        fs.renameSync(concurrentSource, staging.path);
      },
    },
  }), /release_evidence_pointer_staging_cleanup_incomplete/);
  assert.equal(fs.existsSync(pointerPath), false);
  const staging = fs.readdirSync(currentRoot)
    .filter((name) => name.endsWith('.staging'));
  assert.equal(staging.length, 1);
  assert.equal(fs.readFileSync(path.join(currentRoot, staging[0]), 'utf8'), 'concurrent staging bytes\n');
});

test('parent directory swaps are rejected by shared no-follow readers', (t) => {
  const selected = fixture(t);
  const parent = path.join(selected.runtimeRoot, 'receipts');
  const held = path.join(selected.runtimeRoot, 'receipts-held');
  const candidate = path.join(parent, 'receipt.json');
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.writeFileSync(candidate, '{"value":"original"}\n', { mode: 0o444 });
  assert.throws(() => releaseIntegrityEvidence.readRegularFileNoFollow(candidate, {
    beforeOpen() {
      fs.renameSync(parent, held);
      fs.mkdirSync(parent, { mode: 0o700 });
      fs.writeFileSync(candidate, '{"value":"replacement"}\n', { mode: 0o444 });
    },
  }), /release_integrity_directory_chain_changed/);
  assert.equal(fs.readFileSync(path.join(held, 'receipt.json'), 'utf8'), '{"value":"original"}\n');
  assert.equal(fs.readFileSync(candidate, 'utf8'), '{"value":"replacement"}\n');
});

test('private directory creation rejects a runtime-root replacement before returning', (t) => {
  const selected = fixture(t);
  const held = path.join(selected.root, 'runtime-directory-held');
  const candidate = path.join(selected.runtimeRoot, 'release-evidence', 'current');
  assert.throws(() => releaseIntegrityEvidence.ensurePrivateDirectoryWithinRuntime(
    selected.runtimeRoot,
    candidate,
    {
      beforeRevalidation() {
        fs.renameSync(selected.runtimeRoot, held);
        fs.mkdirSync(selected.runtimeRoot, { mode: 0o700 });
      },
    },
  ), /release_integrity_directory_chain_changed/);
  assert.equal(fs.existsSync(path.join(held, 'release-evidence', 'current')), true);
  assert.equal(fs.existsSync(path.join(selected.runtimeRoot, 'release-evidence')), false);
});

test('private evidence directories are exact 0700 under a permissive umask', (t) => {
  const selected = fixture(t);
  const candidate = path.join(selected.runtimeRoot, 'release-evidence', 'current');
  const previousUmask = process.umask(0o000);
  try {
    assert.equal(releaseIntegrityEvidence.ensurePrivateDirectoryWithinRuntime(
      selected.runtimeRoot,
      candidate,
    ), candidate);
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(fs.lstatSync(path.dirname(candidate)).mode & 0o7777, 0o700);
  assert.equal(fs.lstatSync(candidate).mode & 0o7777, 0o700);
  assert.equal(fs.lstatSync(candidate).uid, fs.lstatSync(selected.runtimeRoot).uid);
});

test('pre-existing permissive or foreign-owned evidence directories are rejected without repair', (t) => {
  const selected = fixture(t);
  const permissive = path.join(selected.runtimeRoot, 'release-evidence');
  fs.mkdirSync(permissive, { mode: 0o700 });
  fs.chmodSync(permissive, 0o777);
  const nested = path.join(permissive, 'current');
  assert.throws(() => releaseIntegrityEvidence.ensurePrivateDirectoryWithinRuntime(
    selected.runtimeRoot,
    nested,
  ), /release_evidence_output_directory_unsafe/);
  assert.equal(fs.lstatSync(permissive).mode & 0o7777, 0o777);
  assert.equal(fs.existsSync(nested), false);

  fs.chmodSync(permissive, 0o700);
  const realLstat = fs.lstatSync.bind(fs);
  const foreignOwnedFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'lstatSync') {
        return (candidate, ...args) => {
          const stat = realLstat(candidate, ...args);
          if (candidate !== permissive) return stat;
          return new Proxy(stat, {
            get(selectedStat, field) {
              if (field === 'uid') return Number(selectedStat.uid) + 1;
              const value = Reflect.get(selectedStat, field, selectedStat);
              return typeof value === 'function' ? value.bind(selectedStat) : value;
            },
          });
        };
      }
      return target[property];
    },
  });
  assert.throws(() => releaseIntegrityEvidence.ensurePrivateDirectoryWithinRuntime(
    selected.runtimeRoot,
    nested,
    { fileSystem: foreignOwnedFs },
  ), /release_evidence_output_directory_unsafe/);
  assert.equal(fs.existsSync(nested), false);
});
